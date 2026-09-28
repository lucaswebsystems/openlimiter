use super::{
    contract::*,
    process::{started_before, Probe},
    storage::Directory,
    ActivityDisplayRecord,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    path::Path,
};

const CHECKPOINT: &str = "activity-desktop-v1.json";
const CHECKPOINT_BYTES: u64 = 16 * 1024 * 1024;
pub(super) const MAX_SEEN: usize = 65_536;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    pub session_id: String,
    pub agent: String,
    pub account_alias: Option<String>,
    pub state: String,
    pub confidence: String,
    pub outcome: Option<String>,
    pub first_observed_at: String,
    pub observed_at: String,
    pub state_changed_at: String,
    pub ended_at: Option<String>,
    pub sequence: u64,
    pub process: Option<Process>,
    pub awaiting_input: bool,
    pub identity_lost: bool,
}

impl Session {
    pub fn display(&self) -> ActivityDisplayRecord {
        ActivityDisplayRecord {
            session_id: session_key(&self.agent, &self.session_id),
            agent: self.agent.clone(),
            state: self.state.clone(),
            confidence: self.confidence.clone(),
            outcome: self.outcome.clone(),
            first_observed_at: self.first_observed_at.clone(),
            observed_at: self.observed_at.clone(),
            state_changed_at: self.state_changed_at.clone(),
            user_project_label: None,
        }
    }

    fn ended(&mut self, at: &str) {
        if self.state != "unknown" {
            self.state_changed_at = at.into();
        }
        self.state = "unknown".into();
        self.confidence = "inferred".into();
        self.awaiting_input = false;
        self.ended_at.get_or_insert_with(|| at.into());
        self.observed_at = at.into();
    }

    fn retire(&self, now: i64) -> bool {
        self.ended_at
            .as_deref()
            .or_else(|| (self.state == "idle").then_some(self.state_changed_at.as_str()))
            .and_then(instant)
            .is_some_and(|since| now.saturating_sub(since) >= DAY)
    }
}

/// Frozen NotificationSubmission. Consumed locally, with no entitlement input.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSubmission {
    pub kind: String,
    pub dedupe_key: String,
    pub provider: String,
    pub account: Option<String>,
    pub local_channel: &'static str,
    pub remote_channel: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub session: ActivityDisplayRecord,
    pub notification: NotificationSubmission,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Engine {
    version: u8,
    pub sessions: BTreeMap<String, Session>,
    seen: BTreeMap<String, i64>,
    retired: BTreeMap<String, (u64, i64)>,
    #[serde(skip, default)]
    seen_order: BTreeSet<(i64, String)>,
    #[serde(skip, default)]
    retired_order: BTreeSet<(i64, String)>,
    #[serde(skip, default = "yes")]
    cold: bool,
}
fn yes() -> bool {
    true
}

impl Default for Engine {
    fn default() -> Self {
        Self {
            version: 1,
            sessions: BTreeMap::new(),
            seen: BTreeMap::new(),
            retired: BTreeMap::new(),
            seen_order: BTreeSet::new(),
            retired_order: BTreeSet::new(),
            cold: true,
        }
    }
}

impl Engine {
    pub fn load(root: &Path, now: i64) -> io::Result<Self> {
        let directory = Directory::root(root)?;
        match directory.read(CHECKPOINT, CHECKPOINT_BYTES) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e),
            Ok(bytes) => {
                let mut engine: Self =
                    serde_json::from_slice(&bytes).map_err(|_| super::storage::unsafe_path())?;
                engine.rebuild_indexes();
                if !engine.valid(now) {
                    return Err(super::storage::unsafe_path());
                }
                Ok(engine)
            }
        }
    }

    pub fn save(&self, root: &Path) -> io::Result<()> {
        let bytes = serde_json::to_vec(self).map_err(|_| super::storage::unsafe_path())?;
        if bytes.len() as u64 > CHECKPOINT_BYTES {
            return Err(super::storage::unsafe_path());
        }
        Directory::root(root)?.write(CHECKPOINT, &bytes)
    }

    fn valid(&self, now: i64) -> bool {
        let hash = |v: &str| {
            v.len() == 64
                && v.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        self.version == 1
            && self.sessions.len() <= LIVE_SESSIONS
            && self.seen.len() <= MAX_SEEN
            && self.retired.len() <= MAX_SEEN
            && self
                .seen
                .iter()
                .all(|(key, at)| hash(key) && *at <= now && *at >= 0)
            && self
                .retired
                .iter()
                .all(|(key, (seq, at))| hash(key) && *seq <= SAFE_INTEGER && *at <= now && *at >= 0)
            && self.sessions.iter().all(|(key, s)| {
                let Some(at) = instant(&s.observed_at) else {
                    return false;
                };
                key == &session_key(&s.agent, &s.session_id)
                    && instant(&s.first_observed_at).is_some()
                    && instant(&s.state_changed_at).is_some()
                    && s.first_observed_at <= s.state_changed_at
                    && s.state_changed_at <= s.observed_at
                    && s.ended_at
                        .as_deref()
                        .is_none_or(|v| instant(v).is_some() && v <= s.observed_at.as_str())
                    && at <= now
                    && (!s.awaiting_input || s.state == "waiting")
                    && Event {
                        version: 1,
                        event_id: "checkpoint".into(),
                        session_id: s.session_id.clone(),
                        sequence: s.sequence,
                        agent: s.agent.clone(),
                        account_alias: s.account_alias.clone(),
                        observed_at: s.observed_at.clone(),
                        state: s.state.clone(),
                        outcome: s.outcome.clone(),
                        source: "registry".into(),
                        confidence: s.confidence.clone(),
                        process: s.process.clone(),
                        signal: None,
                        parent_session_id: None,
                        is_sidechain: None,
                    }
                    .valid(at)
            })
    }

    pub fn displays(&self) -> Vec<ActivityDisplayRecord> {
        self.sessions.values().map(Session::display).collect()
    }

    fn rebuild_indexes(&mut self) {
        self.seen_order = self
            .seen
            .iter()
            .map(|(key, at)| (*at, key.clone()))
            .collect();
        self.retired_order = self
            .retired
            .iter()
            .map(|(key, (_, at))| (*at, key.clone()))
            .collect();
    }

    pub fn maintain(&mut self, now: i64, probe: &impl Fn(u64) -> Probe) {
        for session in self.sessions.values_mut() {
            let at = timestamp(now.max(instant(&session.observed_at).unwrap_or(now)));
            if session.ended_at.is_some() {
                continue;
            }
            if let Some(process) = &session.process {
                if let (Some(pid), Some(start)) = (process.pid, &process.started_at) {
                    match probe(pid) {
                        Probe::Alive(actual) if &actual == start => {}
                        Probe::Unavailable => {
                            session.ended(&at);
                        }
                        _ => {
                            session.identity_lost = true;
                            session.ended(&at);
                        }
                    }
                }
            }
        }
        while let Some((at, key)) = self.seen_order.iter().next().cloned() {
            if now.saturating_sub(at) <= DAY {
                break;
            }
            self.seen.remove(&key);
            self.seen_order.remove(&(at, key));
        }
        while let Some((at, key)) = self.retired_order.iter().next().cloned() {
            if now.saturating_sub(at) <= DAY {
                break;
            }
            self.retired.remove(&key);
            self.retired_order.remove(&(at, key));
        }
        let retiring: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, s)| s.retire(now))
            .map(|(k, _)| k.clone())
            .collect();
        for key in retiring {
            let session = self.sessions.remove(&key).unwrap();
            if self.retired.len() >= MAX_SEEN {
                let (oldest_at, oldest_key) = self.retired_order.iter().next().cloned().unwrap();
                self.retired.remove(&oldest_key);
                self.retired_order.remove(&(oldest_at, oldest_key));
            }
            self.retired.insert(key.clone(), (session.sequence, now));
            self.retired_order.insert((now, key));
        }
    }

    pub fn apply(
        &mut self,
        mut events: Vec<Event>,
        now: i64,
        probe: &impl Fn(u64) -> Probe,
    ) -> Vec<Transition> {
        self.maintain(now, probe);
        let existing: BTreeSet<String> = self.sessions.keys().cloned().collect();
        events.sort_by(|a, b| {
            a.sequence
                .cmp(&b.sequence)
                .then(a.observed_at.cmp(&b.observed_at))
                .then(a.event_id.cmp(&b.event_id))
        });
        let mut transitions = Vec::new();
        for event in events {
            if !event.valid(now) {
                continue;
            }
            let id = digest(event.event_id.as_bytes());
            if self.seen.contains_key(&id) {
                continue;
            }
            if self.seen.len() >= MAX_SEEN {
                let (oldest_at, oldest_id) = self.seen_order.iter().next().cloned().unwrap();
                self.seen.remove(&oldest_id);
                self.seen_order.remove(&(oldest_at, oldest_id));
            }
            let observed_at = instant(&event.observed_at).unwrap();
            self.seen.insert(id.clone(), observed_at);
            self.seen_order.insert((observed_at, id));
            let key = session_key(&event.agent, &event.session_id);
            if self.retired.contains_key(&key) {
                continue;
            }
            // Session ids belong to one provider, matching nextSessionState.
            if self
                .sessions
                .values()
                .any(|s| s.session_id == event.session_id && s.agent != event.agent)
            {
                continue;
            }
            if !self.sessions.contains_key(&key) && self.sessions.len() == LIVE_SESSIONS {
                continue;
            }
            let previous = self.sessions.get(&key).cloned();
            if previous
                .as_ref()
                .is_some_and(|s| event.sequence <= s.sequence || event.observed_at < s.observed_at)
            {
                continue;
            }
            let mut session = previous.clone().unwrap_or_else(|| Session {
                session_id: event.session_id.clone(),
                agent: event.agent.clone(),
                account_alias: event.account_alias.clone(),
                state: "unknown".into(),
                confidence: "inferred".into(),
                outcome: None,
                first_observed_at: event.observed_at.clone(),
                observed_at: event.observed_at.clone(),
                state_changed_at: event.observed_at.clone(),
                ended_at: None,
                sequence: event.sequence,
                process: None,
                awaiting_input: false,
                identity_lost: false,
            });
            let old_state = session.state.clone();
            session.sequence = event.sequence;
            session.observed_at = event.observed_at.clone();
            if event.is_sidechain == Some(true) {
                self.sessions.insert(key, session);
                continue;
            }
            let mut process = event.process.clone().unwrap_or_default();
            if let Some(known) = &session.process {
                if process.pid.is_none() && process.ppid.is_none_or(|ppid| Some(ppid) == known.pid)
                {
                    process.pid = known.pid;
                    process.started_at = known.started_at.clone();
                }
            }
            let mut lost = session.identity_lost;
            let mut unavailable = false;
            if process.pid.is_none() {
                if let Some(pid) = process.ppid {
                    match probe(pid) {
                        Probe::Alive(start) if started_before(&start, &event.observed_at) => {
                            process.pid = Some(pid);
                            process.started_at = Some(start);
                        }
                        Probe::Alive(_) | Probe::Missing => lost = true,
                        Probe::Unavailable => unavailable = true,
                    }
                }
            }
            if let Some(known) = &session.process {
                if known.pid.is_some()
                    && process.pid.is_some()
                    && (known.pid != process.pid || known.started_at != process.started_at)
                {
                    lost = true;
                }
            }
            if let (Some(pid), Some(start)) = (process.pid, &process.started_at) {
                match probe(pid) {
                    Probe::Alive(actual) if &actual == start => {}
                    Probe::Unavailable => unavailable = true,
                    _ => lost = true,
                }
            }
            let vanished = lost
                || unavailable
                || matches!(
                    event.signal.as_deref(),
                    Some("process_vanished" | "session_ended")
                );
            if !vanished
                && previous.is_some()
                && session.confidence == "explicit"
                && event.confidence == "inferred"
            {
                self.sessions.insert(key, session);
                continue;
            }
            session.state = event.state.clone();
            session.confidence = event.confidence.clone();
            if event.signal.as_deref() == Some("user_question") {
                session.state = "waiting".into();
                session.awaiting_input = true;
            }
            if event.signal.as_deref() == Some("claude_stop") && session.awaiting_input {
                session.state = "waiting".into();
            }
            if session.state != "waiting" {
                session.awaiting_input = false;
            }
            session.outcome = event.outcome.clone();
            if session.state != old_state {
                session.state_changed_at = event.observed_at.clone();
            }
            let ending = vanished || session.state == "done" || session.outcome.is_some();
            session.ended_at = if ending {
                previous
                    .as_ref()
                    .filter(|s| s.state == session.state && s.outcome == session.outcome)
                    .and_then(|s| s.ended_at.clone())
                    .or_else(|| Some(event.observed_at.clone()))
            } else {
                None
            };
            session.process = (process != Process::default()).then_some(process);
            session.identity_lost = lost;
            if vanished {
                session.ended(&event.observed_at);
            }
            if !self.cold
                && existing.contains(&key)
                && previous.is_some()
                && session.state != old_state
                && session.outcome.is_none()
                && session.confidence == "explicit"
                && ["waiting", "done"].contains(&session.state.as_str())
            {
                let kind = if session.state == "waiting" {
                    "agent_waiting"
                } else {
                    "agent_done"
                };
                let provider = provider(&session.agent).unwrap();
                let account = session.account_alias.clone();
                let dedupe_key = format!(
                    "activity:{}",
                    serde_json::json!([provider, account, key, session.sequence, kind])
                );
                transitions.push(Transition {
                    session: session.display(),
                    notification: NotificationSubmission {
                        kind: kind.into(),
                        dedupe_key,
                        provider: provider.into(),
                        account,
                        local_channel: "popup",
                        remote_channel: false,
                    },
                });
            }
            self.sessions.insert(key, session);
        }
        self.cold = false;
        transitions
    }
}
