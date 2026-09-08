/*!
Phone pairing, from this window's side.

The desktop is the device that already holds an account and an entitlement, so
it is the device that starts a pairing and the device that approves one. The
phone only scans and claims. That order is the whole security property: a code
on a screen is not an authorisation, an approval on the machine that owns the
account is.

Everything below is the state machine around six server actions and nothing
else. It never mints a token, never trusts a phone's word about itself beyond
a bounded name, and never keeps a code after the pairing it belongs to has
ended. The one hundred and twenty second life of a code is server truth: the
countdown drawn in the window is derived from the expiry the server returned,
so a slow machine shows less time rather than more.

The parsers and the transition guard are pure and are the unit under test.
Every function that touches the network is a thin call around them.
*/

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::credentials::{KeyringStore, SecretStore};
use crate::pro::ProFailure;

/// Seconds a code lives. The server decides; this is the ceiling used to
/// refuse an expiry that could not have come from the contract.
pub const PAIRING_TTL_SECONDS: i64 = 120;

/// The unambiguous alphabet the server draws a code from. No zero, no capital
/// O, no one, no capital I, because a person reads this off a screen.
const PAIRING_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// Codes are always this long.
const PAIRING_CODE_LENGTH: usize = 8;

/// The one address a pairing code may ever be carried in. The code travels in
/// the fragment so it never reaches a server log, and a URL that does not
/// start exactly here is not this product's pairing page.
const PAIRING_URL_PREFIX: &str = "https://openlimiter.com/app/pair#code=";

/// Bounds on what a phone may call itself, mirroring the server's own limits.
const MAX_DEVICE_NAME_CHARS: usize = 80;
const MAX_DEVICE_PLATFORM_CHARS: usize = 40;

/// Clock slack allowed when checking a returned expiry against local time.
const EXPIRY_TOLERANCE_SECONDS: i64 = 300;

/// Where one pairing has got to.
///
/// These are the server's own statuses plus `Expired`, which the server does
/// not send: it lets a row lapse. A window that cannot say "this code ran out"
/// leaves a person staring at a QR code that stopped working silently.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PairingPhase {
    Pending,
    Claimed,
    /* Not a server status. It is the moment between a person pressing Approve
    and the service answering, and it exists so that moment has a name: a
    second press, or a second window, finds a pairing that is already being
    decided rather than one that still looks decidable. */
    Deciding,
    Approved,
    Denied,
    Delivered,
    Expired,
}

impl PairingPhase {
    fn from_status(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "claimed" => Some(Self::Claimed),
            "approved" => Some(Self::Approved),
            "denied" => Some(Self::Denied),
            "delivered" => Some(Self::Delivered),
            _ => None,
        }
    }

    /// Whether anything more can happen to this pairing.
    fn settled(self) -> bool {
        matches!(
            self,
            Self::Approved | Self::Denied | Self::Delivered | Self::Expired
        )
    }

    /// Whether a status poll would tell this window anything.
    ///
    /// A settled pairing cannot change again. A pairing being decided is
    /// already waiting on an answer, and polling it would be worse than
    /// useless: the server still reports it as claimed, and writing that back
    /// would erase the transition that is holding a second approval off.
    fn quiet(self) -> bool {
        self.settled() || matches!(self, Self::Deciding)
    }
}

/// One pairing, as the window draws it.
///
/// `seconds_remaining` is derived rather than stored so a session read twice a
/// second apart counts down without the interface doing arithmetic on an
/// instant it did not produce.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingSession {
    pub code: String,
    pub url: String,
    pub expires_at: i64,
    pub seconds_remaining: i64,
    pub phase: PairingPhase,
    pub device_name: Option<String>,
    pub device_platform: Option<String>,
}

/// The pairing in flight, if any. One at a time, on purpose: two live codes
/// for one desktop is two things a person has to keep apart on a phone screen.
#[derive(Default)]
pub struct PairingRuntime {
    session: Mutex<Option<PairingSession>>,
}

impl PairingRuntime {
    fn read(&self) -> Result<Option<PairingSession>, ProFailure> {
        self.session
            .lock()
            .map(|held| held.clone())
            .map_err(|_| ProFailure::Storage)
    }

    fn write(&self, session: Option<PairingSession>) -> Result<(), ProFailure> {
        let mut held = self.session.lock().map_err(|_| ProFailure::Storage)?;
        *held = session;
        Ok(())
    }

    /// Claim the pairing for a decision, and say what it was before.
    ///
    /// The check and the transition happen under ONE lock. Reading, deciding
    /// the pairing is decidable, and then writing under a second lock leaves a
    /// window in which a second press reads the same claimed pairing, reaches
    /// the same answer, and sends a second approval for a code a person only
    /// approved once. Writing the deciding phase here closes that window: the
    /// second caller finds a pairing that is already being decided and is
    /// refused by the same guard that let the first one through.
    fn begin_decision(&self, now: i64) -> Result<PairingSession, ProFailure> {
        let mut held = self.session.lock().map_err(|_| ProFailure::Storage)?;
        let session = held.as_ref().ok_or(ProFailure::InvalidInput)?.clone();
        guard_decision(&session, now)?;
        *held = Some(PairingSession {
            phase: PairingPhase::Deciding,
            ..session.clone()
        });
        Ok(session)
    }

    /// Write a decided pairing back, onto the pairing it was decided about.
    ///
    /// An approval can be in flight while a person closes the panel or starts
    /// a new pairing, and the answer arriving afterwards must not put the old
    /// one back on screen. So the write only lands when the runtime still
    /// holds the same code; the answer is still returned to the caller either
    /// way, because it is true, it is just no longer what is on screen.
    fn settle(&self, decided: &PairingSession) -> Result<bool, ProFailure> {
        let mut held = self.session.lock().map_err(|_| ProFailure::Storage)?;
        let current = held
            .as_ref()
            .is_some_and(|current| current.code == decided.code);
        if current {
            *held = Some(decided.clone());
        }
        Ok(current)
    }

    /// Put a pairing back the way it was when its decision could not be sent.
    ///
    /// Same rule as settling: only onto the pairing it belongs to, and only
    /// while that pairing is still the one being decided. A failure that
    /// restored a cancelled pairing would be the resurrection this guards
    /// against, arriving through the error path instead of the success one.
    fn abandon_decision(&self, claimed: &PairingSession) -> Result<(), ProFailure> {
        let mut held = self.session.lock().map_err(|_| ProFailure::Storage)?;
        let restorable = held.as_ref().is_some_and(|current| {
            current.code == claimed.code && current.phase == PairingPhase::Deciding
        });
        if restorable {
            *held = Some(claimed.clone());
        }
        Ok(())
    }
}

fn valid_code(value: &str) -> bool {
    value.chars().count() == PAIRING_CODE_LENGTH
        && value
            .chars()
            .all(|letter| PAIRING_ALPHABET.contains(letter))
}

fn bounded_text(value: Option<&Value>, maximum: usize) -> Option<String> {
    let text = value?.as_str()?;
    let count = text.chars().count();
    if count == 0 || count > maximum || text.chars().any(char::is_control) {
        return None;
    }
    Some(text.to_string())
}

fn remaining(expires_at: i64, now: i64) -> i64 {
    expires_at.saturating_sub(now).max(0)
}

/// The expiry a `create` may return.
///
/// It has to be in the future and inside one code lifetime plus clock slack.
/// An expiry further out than the contract allows is not a longer code, it is
/// a response this window does not understand, and it is refused as one.
fn valid_expiry(expires_at: i64, now: i64) -> bool {
    expires_at > now && expires_at - now <= PAIRING_TTL_SECONDS + EXPIRY_TOLERANCE_SECONDS
}

/// Read the `create` answer into a pending session.
pub(crate) fn parse_create(response: &Value, now: i64) -> Result<PairingSession, ProFailure> {
    let code = response
        .get("code")
        .and_then(Value::as_str)
        .filter(|value| valid_code(value))
        .ok_or(ProFailure::Service)?;
    let expires_at = response
        .get("expires_at")
        .and_then(Value::as_i64)
        .filter(|value| valid_expiry(*value, now))
        .ok_or(ProFailure::Service)?;
    let url = response
        .get("url")
        .and_then(Value::as_str)
        .ok_or(ProFailure::Service)?;
    /* The address carries the code that was just handed over, in the fragment,
    and nothing else. A URL naming a different code is a mismatch between two
    halves of one answer, which is exactly the shape a swapped response has. */
    if url != format!("{PAIRING_URL_PREFIX}{code}") {
        return Err(ProFailure::Service);
    }
    Ok(PairingSession {
        code: code.to_string(),
        url: url.to_string(),
        expires_at,
        seconds_remaining: remaining(expires_at, now),
        phase: PairingPhase::Pending,
        device_name: None,
        device_platform: None,
    })
}

/// Read a `status` answer against the session it is supposed to describe.
///
/// The device meta only ever arrives with a claim, so a name that turns up
/// beside a pending status is dropped rather than drawn: "phone wants to pair"
/// is a sentence about a claim, and showing it earlier would be showing a
/// person something that has not happened.
pub(crate) fn parse_status(
    response: &Value,
    session: &PairingSession,
    now: i64,
) -> Result<PairingSession, ProFailure> {
    let phase = response
        .get("status")
        .and_then(Value::as_str)
        .and_then(PairingPhase::from_status)
        .ok_or(ProFailure::Service)?;
    let expires_at = response
        .get("expires_at")
        .and_then(Value::as_i64)
        .unwrap_or(session.expires_at);
    let device = response.get("device");
    let device_name = bounded_text(
        device.and_then(|value| value.get("name")),
        MAX_DEVICE_NAME_CHARS,
    );
    let device_platform = bounded_text(
        device.and_then(|value| value.get("platform")),
        MAX_DEVICE_PLATFORM_CHARS,
    );
    let claimed = matches!(phase, PairingPhase::Claimed);
    let lapsed = !phase.settled() && expires_at <= now;
    Ok(PairingSession {
        code: session.code.clone(),
        url: session.url.clone(),
        expires_at,
        seconds_remaining: remaining(expires_at, now),
        phase: if lapsed { PairingPhase::Expired } else { phase },
        device_name: if claimed { device_name } else { None },
        device_platform: if claimed { device_platform } else { None },
    })
}

/// Whether an approve or deny may be sent at all.
///
/// Only a claimed pairing can be decided. Approving a pending code would be
/// approving a phone that has not asked, and deciding a settled one twice is
/// a request the server will refuse anyway.
pub(crate) fn guard_decision(session: &PairingSession, now: i64) -> Result<(), ProFailure> {
    if session.expires_at <= now {
        return Err(ProFailure::InvalidInput);
    }
    if session.phase != PairingPhase::Claimed {
        return Err(ProFailure::InvalidInput);
    }
    Ok(())
}

/// Read the answer to an approve or a deny.
pub(crate) fn parse_decision(
    response: &Value,
    session: &PairingSession,
    expected: PairingPhase,
    now: i64,
) -> Result<PairingSession, ProFailure> {
    let phase = response
        .get("status")
        .and_then(Value::as_str)
        .and_then(PairingPhase::from_status)
        .ok_or(ProFailure::Service)?;
    if phase != expected {
        return Err(ProFailure::Service);
    }
    Ok(PairingSession {
        phase,
        seconds_remaining: remaining(session.expires_at, now),
        device_name: session.device_name.clone(),
        device_platform: session.device_platform.clone(),
        code: session.code.clone(),
        url: session.url.clone(),
        expires_at: session.expires_at,
    })
}

fn now_seconds() -> Result<i64, ProFailure> {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| ProFailure::ClockInvalid)?;
    i64::try_from(elapsed.as_secs()).map_err(|_| ProFailure::ClockInvalid)
}

async fn action(
    store: &dyn SecretStore,
    name: &str,
    device_id: &str,
    code: Option<&str>,
) -> Result<Value, ProFailure> {
    let mut payload = json!({ "action": name, "desktop_device_id": device_id });
    if let Some(code) = code {
        if !valid_code(code) {
            return Err(ProFailure::InvalidInput);
        }
        payload
            .as_object_mut()
            .ok_or(ProFailure::InvalidInput)?
            .insert("code".to_string(), Value::String(code.to_string()));
    }
    crate::pro::post_pairing(store, payload).await
}

async fn send_decision(
    store: &dyn SecretStore,
    name: &str,
    claimed: &PairingSession,
    expected: PairingPhase,
) -> Result<PairingSession, ProFailure> {
    let device_id = crate::pro::desktop_device_id(store)?;
    let response = action(store, name, &device_id, Some(&claimed.code)).await?;
    parse_decision(&response, claimed, expected, now_seconds()?)
}

async fn decide(
    store: &dyn SecretStore,
    runtime: &PairingRuntime,
    name: &str,
    expected: PairingPhase,
) -> Result<PairingSession, ProFailure> {
    /* The pairing is claimed for this decision before anything is sent, so a
    second press has nothing left to decide, and it is put back if the send
    fails so one unreachable service does not strand a pairing forever. */
    let claimed = runtime.begin_decision(now_seconds()?)?;
    match send_decision(store, name, &claimed, expected).await {
        Ok(decided) => {
            runtime.settle(&decided)?;
            Ok(decided)
        }
        Err(error) => {
            runtime.abandon_decision(&claimed)?;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn pairing_start(
    store: State<'_, KeyringStore>,
    runtime: State<'_, PairingRuntime>,
) -> Result<PairingSession, ProFailure> {
    let device_id = crate::pro::desktop_device_id(store.inner())?;
    let response = action(store.inner(), "create", &device_id, None).await?;
    let session = parse_create(&response, now_seconds()?)?;
    runtime.write(Some(session.clone()))?;
    Ok(session)
}

#[tauri::command]
pub async fn pairing_status(
    store: State<'_, KeyringStore>,
    runtime: State<'_, PairingRuntime>,
) -> Result<PairingSession, ProFailure> {
    let session = runtime.read()?.ok_or(ProFailure::InvalidInput)?;
    /* A settled pairing is not asked about again. The row is gone from the
    server within ten minutes of delivery, and a poll after that would turn a
    finished pairing into an error message about a code nobody is holding. A
    pairing being decided is left alone for a different reason: its answer is
    already on its way, and the server would still call it claimed. */
    if session.phase.quiet() {
        return Ok(PairingSession {
            seconds_remaining: remaining(session.expires_at, now_seconds()?),
            ..session
        });
    }
    let device_id = crate::pro::desktop_device_id(store.inner())?;
    let response = action(store.inner(), "status", &device_id, Some(&session.code)).await?;
    let updated = parse_status(&response, &session, now_seconds()?)?;
    runtime.write(Some(updated.clone()))?;
    Ok(updated)
}

#[tauri::command]
pub async fn pairing_approve(
    store: State<'_, KeyringStore>,
    runtime: State<'_, PairingRuntime>,
) -> Result<PairingSession, ProFailure> {
    decide(
        store.inner(),
        runtime.inner(),
        "approve",
        PairingPhase::Approved,
    )
    .await
}

#[tauri::command]
pub async fn pairing_deny(
    store: State<'_, KeyringStore>,
    runtime: State<'_, PairingRuntime>,
) -> Result<PairingSession, ProFailure> {
    decide(store.inner(), runtime.inner(), "deny", PairingPhase::Denied).await
}

/// Forget the pairing in flight. Closing the panel ends the pairing as far as
/// this window is concerned; the code lapses on the server on its own.
#[tauri::command]
pub fn pairing_cancel(runtime: State<'_, PairingRuntime>) -> Result<(), ProFailure> {
    runtime.write(None)
}

/// Every device on the account, phones included, with the current one marked.
#[tauri::command]
pub async fn devices_list(store: State<'_, KeyringStore>) -> Result<Value, ProFailure> {
    crate::pro::call_service(
        store.inner(),
        crate::pro::ProServiceInput {
            action: crate::pro::ProAction::DeviceStatus,
            payload: serde_json::Map::new(),
        },
    )
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceRevokeInput {
    pub device_id: String,
}

/// Revoke one device grant. A revoked phone's next read is a 401 and the web
/// application tells it to scan again, which is the whole undo.
#[tauri::command]
pub async fn device_revoke(
    input: DeviceRevokeInput,
    store: State<'_, KeyringStore>,
) -> Result<Value, ProFailure> {
    let mut payload = serde_json::Map::new();
    payload.insert("device_id".to_string(), Value::String(input.device_id));
    crate::pro::call_service(
        store.inner(),
        crate::pro::ProServiceInput {
            action: crate::pro::ProAction::RevokeDevice,
            payload,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;
    const CODE: &str = "AB23CDEF";

    fn created() -> Value {
        json!({
            "code": CODE,
            "expires_at": NOW + PAIRING_TTL_SECONDS,
            "url": format!("{PAIRING_URL_PREFIX}{CODE}"),
        })
    }

    fn pending() -> PairingSession {
        parse_create(&created(), NOW).expect("a well formed create answer")
    }

    #[test]
    fn a_create_answer_becomes_a_pending_session_with_a_countdown() {
        let session = pending();
        assert_eq!(session.code, CODE);
        assert_eq!(session.phase, PairingPhase::Pending);
        assert_eq!(session.seconds_remaining, PAIRING_TTL_SECONDS);
        assert_eq!(session.url, format!("{PAIRING_URL_PREFIX}{CODE}"));
        assert_eq!(session.device_name, None);
    }

    #[test]
    fn the_countdown_runs_down_and_never_below_zero() {
        let session = pending();
        let late = parse_status(&json!({ "status": "pending" }), &session, NOW + 60)
            .expect("a pending status");
        assert_eq!(late.seconds_remaining, 60);
        let lapsed = parse_status(&json!({ "status": "pending" }), &session, NOW + 900)
            .expect("a lapsed status");
        assert_eq!(lapsed.seconds_remaining, 0);
        assert_eq!(lapsed.phase, PairingPhase::Expired);
    }

    #[test]
    fn a_create_answer_whose_url_names_another_code_is_refused() {
        let mut mismatched = created();
        mismatched["url"] = Value::String(format!("{PAIRING_URL_PREFIX}ZZ23ZZZZ"));
        assert_eq!(parse_create(&mismatched, NOW), Err(ProFailure::Service));
    }

    #[test]
    fn a_create_answer_on_another_host_is_refused() {
        let mut elsewhere = created();
        elsewhere["url"] = Value::String(format!("https://example.test/app/pair#code={CODE}"));
        assert_eq!(parse_create(&elsewhere, NOW), Err(ProFailure::Service));
    }

    #[test]
    fn an_ambiguous_alphabet_never_reaches_the_screen() {
        for code in [
            "AB23CDE0", "AB23CDEO", "AB23CDE1", "AB23CDEI", "AB23CDE", "ab23cdef",
        ] {
            let mut wrong = created();
            wrong["code"] = Value::String(code.to_string());
            wrong["url"] = Value::String(format!("{PAIRING_URL_PREFIX}{code}"));
            assert_eq!(
                parse_create(&wrong, NOW),
                Err(ProFailure::Service),
                "{code} should not be accepted"
            );
        }
    }

    #[test]
    fn an_expiry_beyond_one_code_lifetime_is_refused() {
        let mut generous = created();
        generous["expires_at"] = json!(NOW + 86_400);
        assert_eq!(parse_create(&generous, NOW), Err(ProFailure::Service));
        let mut past = created();
        past["expires_at"] = json!(NOW - 1);
        assert_eq!(parse_create(&past, NOW), Err(ProFailure::Service));
    }

    #[test]
    fn a_claim_carries_the_phone_name_the_approval_prompt_says() {
        let session = pending();
        let claimed = parse_status(
            &json!({
                "status": "claimed",
                "expires_at": NOW + PAIRING_TTL_SECONDS,
                "device": { "name": "Lucas iPhone", "platform": "ios" },
            }),
            &session,
            NOW + 5,
        )
        .expect("a claimed status");
        assert_eq!(claimed.phase, PairingPhase::Claimed);
        assert_eq!(claimed.device_name.as_deref(), Some("Lucas iPhone"));
        assert_eq!(claimed.device_platform.as_deref(), Some("ios"));
    }

    #[test]
    fn a_device_name_that_is_absurd_or_carries_control_characters_is_dropped() {
        let session = pending();
        for name in [
            Value::String("x".repeat(MAX_DEVICE_NAME_CHARS + 1)),
            Value::String("phone\u{7}".to_string()),
            Value::String(String::new()),
            Value::Null,
        ] {
            let claimed = parse_status(
                &json!({
                    "status": "claimed",
                    "expires_at": NOW + PAIRING_TTL_SECONDS,
                    "device": { "name": name, "platform": "ios" },
                }),
                &session,
                NOW + 5,
            )
            .expect("a claimed status");
            assert_eq!(claimed.device_name, None);
        }
    }

    #[test]
    fn a_name_arriving_before_a_claim_is_never_drawn() {
        let session = pending();
        let still_pending = parse_status(
            &json!({
                "status": "pending",
                "expires_at": NOW + PAIRING_TTL_SECONDS,
                "device": { "name": "Not yet", "platform": "ios" },
            }),
            &session,
            NOW + 5,
        )
        .expect("a pending status");
        assert_eq!(still_pending.device_name, None);
        assert_eq!(still_pending.device_platform, None);
    }

    #[test]
    fn only_a_claimed_pairing_can_be_approved_or_denied() {
        let session = pending();
        assert_eq!(guard_decision(&session, NOW), Err(ProFailure::InvalidInput));
        let claimed = parse_status(
            &json!({ "status": "claimed", "expires_at": NOW + PAIRING_TTL_SECONDS }),
            &session,
            NOW + 5,
        )
        .expect("a claimed status");
        assert_eq!(guard_decision(&claimed, NOW + 5), Ok(()));
        /* Past the expiry, even a claimed pairing is over. */
        assert_eq!(
            guard_decision(&claimed, NOW + PAIRING_TTL_SECONDS + 1),
            Err(ProFailure::InvalidInput)
        );
    }

    #[test]
    fn an_approved_pairing_cannot_be_decided_twice() {
        let session = pending();
        let claimed = parse_status(
            &json!({ "status": "claimed", "expires_at": NOW + PAIRING_TTL_SECONDS }),
            &session,
            NOW + 5,
        )
        .expect("a claimed status");
        let approved = parse_decision(
            &json!({ "status": "approved" }),
            &claimed,
            PairingPhase::Approved,
            NOW + 6,
        )
        .expect("an approval");
        assert_eq!(approved.phase, PairingPhase::Approved);
        assert!(approved.phase.settled());
        assert_eq!(
            guard_decision(&approved, NOW + 7),
            Err(ProFailure::InvalidInput)
        );
    }

    #[test]
    fn a_denial_ends_the_pairing_and_keeps_the_phone_name_on_screen() {
        let session = pending();
        let claimed = parse_status(
            &json!({
                "status": "claimed",
                "expires_at": NOW + PAIRING_TTL_SECONDS,
                "device": { "name": "Lucas iPhone", "platform": "ios" },
            }),
            &session,
            NOW + 5,
        )
        .expect("a claimed status");
        let denied = parse_decision(
            &json!({ "status": "denied" }),
            &claimed,
            PairingPhase::Denied,
            NOW + 6,
        )
        .expect("a denial");
        assert_eq!(denied.phase, PairingPhase::Denied);
        assert_eq!(denied.device_name.as_deref(), Some("Lucas iPhone"));
    }

    #[test]
    fn a_decision_answering_with_another_status_is_refused() {
        let session = pending();
        let claimed = parse_status(
            &json!({ "status": "claimed", "expires_at": NOW + PAIRING_TTL_SECONDS }),
            &session,
            NOW + 5,
        )
        .expect("a claimed status");
        assert_eq!(
            parse_decision(
                &json!({ "status": "denied" }),
                &claimed,
                PairingPhase::Approved,
                NOW + 6
            ),
            Err(ProFailure::Service)
        );
        assert_eq!(
            parse_decision(
                &json!({ "status": "elsewhere" }),
                &claimed,
                PairingPhase::Approved,
                NOW + 6
            ),
            Err(ProFailure::Service)
        );
    }

    #[test]
    fn a_delivered_pairing_reports_itself_as_finished() {
        let session = pending();
        let delivered = parse_status(
            &json!({ "status": "delivered", "expires_at": NOW + PAIRING_TTL_SECONDS }),
            &session,
            NOW + 700,
        )
        .expect("a delivered status");
        /* Delivered is settled, so a lapsed clock does not rewrite it into an
        expiry: the phone already has its token. */
        assert_eq!(delivered.phase, PairingPhase::Delivered);
        assert_eq!(delivered.seconds_remaining, 0);
    }

    #[test]
    fn an_unknown_status_is_a_service_answer_this_window_refuses() {
        let session = pending();
        assert_eq!(
            parse_status(&json!({ "status": "half" }), &session, NOW + 5),
            Err(ProFailure::Service)
        );
        assert_eq!(
            parse_status(&json!({}), &session, NOW + 5),
            Err(ProFailure::Service)
        );
    }

    fn claimed() -> PairingSession {
        parse_status(
            &json!({
                "status": "claimed",
                "expires_at": NOW + PAIRING_TTL_SECONDS,
                "device": { "name": "Lucas iPhone", "platform": "ios" },
            }),
            &pending(),
            NOW + 5,
        )
        .expect("a claimed status")
    }

    #[test]
    fn a_second_approve_is_refused_while_the_first_is_still_in_flight() {
        /* Both calls used to read, both used to pass the guard, and both used
        to send. Two approvals of one code is two device grants asked for by a
        person who pressed a button once. */
        let runtime = PairingRuntime::default();
        runtime.write(Some(claimed())).expect("a claimed pairing");

        let first = runtime
            .begin_decision(NOW + 6)
            .expect("the first decision is allowed");
        assert_eq!(first.phase, PairingPhase::Claimed);
        assert_eq!(
            runtime.begin_decision(NOW + 6).map(|_| ()),
            Err(ProFailure::InvalidInput),
            "a second decision must be refused while one is in flight"
        );
        /* And the runtime says so out loud rather than still reading claimed. */
        assert_eq!(
            runtime
                .read()
                .expect("the held pairing")
                .map(|value| value.phase),
            Some(PairingPhase::Deciding)
        );
    }

    #[test]
    fn a_status_poll_never_erases_a_decision_in_flight() {
        /* The panel polls every two seconds. A poll landing mid approval used
        to write the server's claimed status back over the transition, which
        handed a second press a pairing that looked decidable again. */
        let runtime = PairingRuntime::default();
        runtime.write(Some(claimed())).expect("a claimed pairing");
        runtime
            .begin_decision(NOW + 6)
            .expect("the decision starts");
        let held = runtime
            .read()
            .expect("the held pairing")
            .expect("a pairing is held");
        assert!(held.phase.quiet(), "a deciding pairing must not be polled");
        assert!(!held.phase.settled(), "and it is not finished either");
        assert!(PairingPhase::Claimed.quiet() == false);
        assert!(PairingPhase::Pending.quiet() == false);
    }

    #[test]
    fn a_decision_that_could_not_be_sent_puts_the_pairing_back() {
        let runtime = PairingRuntime::default();
        runtime.write(Some(claimed())).expect("a claimed pairing");
        let held = runtime
            .begin_decision(NOW + 6)
            .expect("the decision starts");
        runtime
            .abandon_decision(&held)
            .expect("the decision is abandoned");
        assert_eq!(
            runtime
                .read()
                .expect("the held pairing")
                .map(|value| value.phase),
            Some(PairingPhase::Claimed)
        );
        runtime
            .begin_decision(NOW + 7)
            .expect("and the pairing can be decided again");
    }

    #[test]
    fn a_pairing_cancelled_during_an_approval_is_not_resurrected() {
        /* Closing the panel mid approval cleared the pairing, and the answer
        arriving afterwards used to put it straight back on screen, complete
        with a QR code for a code nobody was holding any more. */
        let runtime = PairingRuntime::default();
        runtime.write(Some(claimed())).expect("a claimed pairing");
        let held = runtime
            .begin_decision(NOW + 6)
            .expect("the decision starts");
        runtime.write(None).expect("the panel is closed");

        let decided = parse_decision(
            &json!({ "status": "approved" }),
            &held,
            PairingPhase::Approved,
            NOW + 7,
        )
        .expect("the approval still parses");
        assert_eq!(
            runtime
                .settle(&decided)
                .expect("the write back is attempted"),
            false
        );
        assert_eq!(runtime.read().expect("the runtime"), None);
    }

    #[test]
    fn a_decision_never_lands_on_the_pairing_that_replaced_it() {
        let runtime = PairingRuntime::default();
        runtime.write(Some(claimed())).expect("a claimed pairing");
        let held = runtime
            .begin_decision(NOW + 6)
            .expect("the decision starts");

        let mut replacement = created();
        replacement["code"] = Value::String("ZZ23ZZZZ".to_string());
        replacement["url"] = Value::String(format!("{PAIRING_URL_PREFIX}ZZ23ZZZZ"));
        let newer = parse_create(&replacement, NOW + 7).expect("a second pairing");
        runtime
            .write(Some(newer))
            .expect("the second pairing is held");

        let decided = parse_decision(
            &json!({ "status": "approved" }),
            &held,
            PairingPhase::Approved,
            NOW + 8,
        )
        .expect("the approval still parses");
        assert_eq!(
            runtime
                .settle(&decided)
                .expect("the write back is attempted"),
            false
        );
        assert_eq!(
            runtime.read().expect("the runtime").map(|value| value.code),
            Some("ZZ23ZZZZ".to_string())
        );
    }

    #[test]
    fn the_runtime_holds_one_pairing_at_a_time_and_forgets_on_cancel() {
        let runtime = PairingRuntime::default();
        assert_eq!(runtime.read().expect("an empty runtime"), None);
        runtime.write(Some(pending())).expect("a stored pairing");
        assert_eq!(
            runtime
                .read()
                .expect("the stored pairing")
                .map(|value| value.code),
            Some(CODE.to_string())
        );
        runtime.write(None).expect("a cleared pairing");
        assert_eq!(runtime.read().expect("the cleared runtime"), None);
    }
}
