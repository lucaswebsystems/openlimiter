use super::{
    contract::*,
    engine::Engine,
    process::{self, Probe},
    spool::{Reader, FILES_PER_TICK},
    storage::Directory,
};
use serde_json::json;
use std::{fs, path::PathBuf};

const NOW: i64 = 1_790_596_800_000;

struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("activity-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("activity")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.join("activity"), fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self { root }
    }
    fn file(&self, name: &str, bytes: &[u8]) {
        let path = self.root.join("activity").join(name);
        fs::write(&path, bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
    fn event(&self, event: &Event) {
        self.file(
            &format!("{:016}-{}.json", event.sequence, uuid::Uuid::new_v4()),
            &serde_json::to_vec(event).unwrap(),
        );
    }
    fn scan(&self) -> super::spool::Scan {
        let mut reader = Reader::new(&self.root);
        loop {
            let scan = reader.tick(NOW);
            assert!(scan.inspected <= FILES_PER_TICK);
            if scan.complete {
                return scan;
            }
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn event(sequence: u64, state: &str) -> Event {
    Event {
        version: 1,
        event_id: format!("event-{sequence}"),
        session_id: "session".into(),
        sequence,
        agent: "claude_code".into(),
        account_alias: None,
        observed_at: timestamp(NOW - 1000 + sequence as i64),
        state: state.into(),
        outcome: None,
        source: "hook".into(),
        confidence: "explicit".into(),
        process: None,
        signal: None,
        parent_session_id: None,
        is_sidechain: None,
    }
}
fn event_at(sequence: u64, state: &str, observed_at: i64) -> Event {
    let mut event = event(sequence, state);
    event.observed_at = timestamp(observed_at);
    event
}
fn unavailable(_: u64) -> Probe {
    Probe::Unavailable
}
fn apply(engine: &mut Engine, events: Vec<Event>) -> Vec<super::engine::Transition> {
    engine.apply(events, NOW, &unavailable)
}
fn checkpoint_lengths(fixture: &Fixture) -> (usize, usize) {
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.root.join("activity-desktop-v1.json")).unwrap())
            .unwrap();
    (
        value["seen"].as_object().unwrap().len(),
        value["retired"].as_object().unwrap().len(),
    )
}
fn session(engine: &Engine) -> &super::engine::Session {
    engine.sessions.values().next().unwrap()
}

#[test]
fn contract_rejects_hostile_and_noncanonical_records() {
    let valid = serde_json::to_value(event(1, "busy")).unwrap();
    for (field, bad) in [
        ("version", json!(2)),
        ("sequence", json!(-1)),
        ("sequence", json!(SAFE_INTEGER + 1)),
        ("observedAt", json!("2026-02-30T00:00:00.000Z")),
        ("observedAt", json!(timestamp(NOW + 1))),
        ("observedAt", json!(timestamp(NOW - DAY - 1))),
        ("eventId", json!("bad\n")),
        ("accountAlias", json!(null)),
        (
            "process",
            json!({"pid": 2, "startedAt": timestamp(NOW-1000)}),
        ),
        ("process", json!({"ppid":null})),
        ("process", json!({"ppid":0})),
        ("prompt", json!("private text")),
        ("state", json!("success")),
        ("parentSessionId", json!("session")),
        ("isSidechain", json!(1)),
    ] {
        let mut value = valid.clone();
        value[field] = bad;
        assert!(
            Event::read(&serde_json::to_vec(&value).unwrap(), NOW).is_none(),
            "{field}"
        );
    }
    assert!(Event::read(&serde_json::to_vec(&valid).unwrap(), NOW).is_some());
    assert!(Event::read(&vec![b' '; EVENT_BYTES + 1], NOW).is_none());
    assert!(Event::read(&[0xff], NOW).is_none());
    let mut inferred = event(1, "done");
    inferred.confidence = "inferred".into();
    assert!(!inferred.valid(NOW));
    let mut failed = event(1, "done");
    failed.outcome = Some("failed".into());
    assert!(!failed.valid(NOW));
}

#[test]
fn baseline_sweep_never_announces_historical_completion() {
    for state in ["busy", "waiting", "done", "idle", "unknown"] {
        let mut engine = Engine::default();
        assert!(apply(&mut engine, vec![event(1, state)]).is_empty());
        assert_eq!(session(&engine).state, state);
    }
    let mut engine = Engine::default();
    assert!(apply(&mut engine, vec![event(2, "done"), event(1, "busy")]).is_empty());
    assert_eq!(session(&engine).state, "done");
}

#[test]
fn permutations_duplicates_and_replays_emit_one_transition() {
    // Exhaust all 120 permutations, injecting duplicate ids and sequences.
    fn permutations(values: &mut [Event], at: usize, check: &mut impl FnMut(&[Event])) {
        if at == values.len() {
            check(values);
            return;
        }
        for i in at..values.len() {
            values.swap(at, i);
            permutations(values, at + 1, check);
            values.swap(at, i);
        }
    }
    let mut repeated_sequence = event(2, "waiting");
    repeated_sequence.event_id = "second-id".into();
    let mut values = vec![
        event(1, "busy"),
        event(2, "waiting"),
        event(2, "waiting"),
        repeated_sequence,
        event(3, "waiting"),
    ];
    permutations(&mut values, 0, &mut |events| {
        let mut engine = Engine::default();
        apply(&mut engine, vec![event(0, "busy")]);
        let transitions = apply(&mut engine, events.to_vec());
        assert_eq!(transitions.len(), 1);
        assert_eq!(transitions[0].notification.kind, "agent_waiting");
        assert!(apply(&mut engine, events.to_vec()).is_empty());
        assert_eq!(session(&engine).sequence, 3);
    });
    // Across ticks the monotonic sequence rejects a late earlier state.
    let mut engine = Engine::default();
    apply(&mut engine, vec![event(0, "busy")]);
    assert_eq!(apply(&mut engine, vec![event(4, "done")]).len(), 1);
    assert!(apply(&mut engine, vec![event(2, "waiting"), event(3, "busy")]).is_empty());
    assert_eq!(session(&engine).state, "done");
}

#[test]
fn explicit_question_beats_recency_and_claude_stop() {
    let mut engine = Engine::default();
    apply(&mut engine, vec![event(0, "busy")]);
    let mut question = event(1, "busy");
    question.signal = Some("user_question".into());
    assert_eq!(apply(&mut engine, vec![question]).len(), 1);
    let mut recency = event(2, "busy");
    recency.confidence = "inferred".into();
    recency.source = "editor_state".into();
    assert!(apply(&mut engine, vec![recency]).is_empty());
    let mut stop = event(3, "done");
    stop.signal = Some("claude_stop".into());
    assert!(apply(&mut engine, vec![stop]).is_empty());
    assert_eq!(session(&engine).state, "waiting");
    apply(&mut engine, vec![event(4, "busy")]);
    assert!(!session(&engine).awaiting_input);
    assert_eq!(apply(&mut engine, vec![event(5, "done")]).len(), 1);
}

#[test]
fn outcomes_and_end_signals_never_report_success() {
    for outcome in [None, Some("failed"), Some("cancelled")] {
        for signal in ["process_vanished", "session_ended"] {
            let mut engine = Engine::default();
            apply(&mut engine, vec![event(0, "busy")]);
            let mut end = event(1, "unknown");
            end.outcome = outcome.map(str::to_owned);
            end.signal = Some(signal.into());
            assert!(apply(&mut engine, vec![end]).is_empty());
            assert_eq!(session(&engine).state, "unknown");
            assert_eq!(session(&engine).outcome.as_deref(), outcome);
            assert!(session(&engine).ended_at.is_some());
        }
    }
}

#[test]
fn process_resolution_loss_and_pid_reuse_are_honest() {
    for probe in [
        Probe::Missing,
        Probe::Unavailable,
        Probe::Alive(timestamp(NOW - 500)),
    ] {
        let original = timestamp(NOW - 2000);
        let mut engine = Engine::default();
        let mut initial = event(0, "busy");
        initial.process = Some(Process {
            ppid: Some(42),
            ..Default::default()
        });
        engine.apply(vec![initial], NOW, &|_| Probe::Alive(original.clone()));
        assert_eq!(session(&engine).process.as_ref().unwrap().pid, Some(42));
        engine.maintain(NOW, &|_| probe.clone());
        assert_eq!(session(&engine).state, "unknown");
        assert!(session(&engine).ended_at.is_some());
        assert!(engine
            .apply(vec![event(1, "done")], NOW, &|_| probe.clone())
            .is_empty());
    }
    let mut engine = Engine::default();
    let mut initial = event(0, "done");
    initial.process = Some(Process {
        ppid: Some(42),
        ..Default::default()
    });
    engine.apply(vec![initial], NOW, &|_| Probe::Alive(timestamp(NOW - 500)));
    assert_eq!(
        session(&engine).state,
        "unknown",
        "pid started after observation cannot own it"
    );
}

#[test]
fn explicit_changed_process_identity_is_never_completion() {
    let mut engine = Engine::default();
    let make = |sequence, state, start| {
        let mut e = event(sequence, state);
        e.source = "registry".into();
        e.process = Some(Process {
            ppid: None,
            pid: Some(42),
            started_at: Some(timestamp(start)),
        });
        e
    };
    engine.apply(vec![make(0, "busy", NOW - 3000)], NOW, &|_| {
        Probe::Alive(timestamp(NOW - 3000))
    });
    assert!(engine
        .apply(vec![make(1, "done", NOW - 2000)], NOW, &|_| Probe::Alive(
            timestamp(NOW - 2000)
        ))
        .is_empty());
    assert_eq!(session(&engine).state, "unknown");
}

#[test]
fn child_completion_and_sidechain_never_complete_parent() {
    let mut engine = Engine::default();
    apply(&mut engine, vec![event(0, "busy")]);
    let mut child = event(1, "busy");
    child.session_id = "child".into();
    child.parent_session_id = Some("session".into());
    assert!(apply(&mut engine, vec![child.clone()]).is_empty());
    child.sequence = 2;
    child.event_id = "child-done".into();
    child.state = "done".into();
    assert_eq!(apply(&mut engine, vec![child]).len(), 1);
    let parent = session_key("claude_code", "session");
    assert_eq!(engine.sessions[&parent].state, "busy");
    let mut sidechain = event(3, "done");
    sidechain.is_sidechain = Some(true);
    assert!(apply(&mut engine, vec![sidechain]).is_empty());
    assert_eq!(engine.sessions[&parent].state, "busy");
}

#[test]
fn retirement_uses_state_time_and_bounds_sessions() {
    for state in ["idle", "done", "unknown"] {
        let mut engine = Engine::default();
        let mut initial = event(0, state);
        if state == "unknown" {
            initial.signal = Some("session_ended".into());
        }
        apply(&mut engine, vec![initial.clone()]);
        let mut repeated = initial.clone();
        repeated.event_id = "later-poll".into();
        repeated.sequence = 1;
        repeated.observed_at = timestamp(NOW + DAY - 1001);
        engine.apply(vec![repeated.clone()], NOW + DAY - 1001, &unavailable);
        assert_eq!(engine.sessions.len(), 1);
        engine.maintain(NOW + DAY - 1000, &unavailable);
        assert!(engine.sessions.is_empty());
        assert!(engine
            .apply(vec![repeated], NOW + DAY, &unavailable)
            .is_empty());
        assert!(
            engine.sessions.is_empty(),
            "retired spool entries cannot resurrect it"
        );
    }
    let mut engine = Engine::default();
    let events = (0..128)
        .map(|n| {
            let mut e = event(n, "busy");
            e.session_id = format!("s{n}");
            e
        })
        .collect();
    apply(&mut engine, events);
    assert_eq!(engine.sessions.len(), LIVE_SESSIONS);
}

#[test]
fn seen_capacity_evicts_oldest_and_keeps_recent_duplicates_suppressed() {
    let fixture = Fixture::new();
    let mut engine = Engine::default();
    let start = NOW - super::engine::MAX_SEEN as i64 - 10;
    let events = (0..super::engine::MAX_SEEN as u64)
        .map(|sequence| {
            let mut event = event_at(sequence, "busy", start + sequence as i64);
            event.event_id = format!("seen-{sequence}");
            event
        })
        .collect();
    apply(&mut engine, events);

    let mut newest = event_at(
        super::engine::MAX_SEEN as u64,
        "waiting",
        start + super::engine::MAX_SEEN as i64,
    );
    newest.event_id = "seen-newest".into();
    newest.signal = Some("user_question".into());
    assert_eq!(apply(&mut engine, vec![newest]).len(), 1);
    assert_eq!(session(&engine).state, "waiting");

    let mut recent_duplicate = event_at(
        super::engine::MAX_SEEN as u64 + 1,
        "done",
        start + super::engine::MAX_SEEN as i64 + 1,
    );
    recent_duplicate.event_id = format!("seen-{}", super::engine::MAX_SEEN - 1);
    assert!(apply(&mut engine, vec![recent_duplicate]).is_empty());
    assert_eq!(session(&engine).state, "waiting");

    let mut next = event_at(
        super::engine::MAX_SEEN as u64 + 2,
        "done",
        start + super::engine::MAX_SEEN as i64 + 2,
    );
    next.event_id = "seen-next".into();
    assert_eq!(apply(&mut engine, vec![next]).len(), 1);
    assert_eq!(session(&engine).state, "done");

    let mut evicted_duplicate = event_at(
        super::engine::MAX_SEEN as u64 + 3,
        "waiting",
        start + super::engine::MAX_SEEN as i64 + 3,
    );
    evicted_duplicate.event_id = "seen-0".into();
    evicted_duplicate.signal = Some("user_question".into());
    assert_eq!(apply(&mut engine, vec![evicted_duplicate]).len(), 1);
    assert_eq!(session(&engine).state, "waiting");

    let mut recent_duplicate = event_at(
        super::engine::MAX_SEEN as u64 + 4,
        "done",
        start + super::engine::MAX_SEEN as i64 + 4,
    );
    recent_duplicate.event_id = "seen-next".into();
    assert!(apply(&mut engine, vec![recent_duplicate]).is_empty());
    assert_eq!(session(&engine).state, "waiting");

    engine.save(&fixture.root).unwrap();
    let (seen, retired) = checkpoint_lengths(&fixture);
    assert_eq!(seen, super::engine::MAX_SEEN);
    assert_eq!(retired, 0);
    let mut restored = Engine::load(&fixture.root, NOW).unwrap();
    let mut restored_duplicate = event_at(
        super::engine::MAX_SEEN as u64 + 5,
        "done",
        start + super::engine::MAX_SEEN as i64 + 5,
    );
    restored_duplicate.event_id = "seen-next".into();
    assert!(apply(&mut restored, vec![restored_duplicate]).is_empty());
}

#[test]
fn retired_capacity_evicts_oldest_and_keeps_new_sessions_trackable() {
    let fixture = Fixture::new();
    let mut engine = Engine::default();
    let mut sequence = 0_u64;
    let mut now = NOW;
    while sequence < super::engine::MAX_SEEN as u64 {
        let batch_end = (sequence + LIVE_SESSIONS as u64).min(super::engine::MAX_SEEN as u64);
        let events = (sequence..batch_end)
            .map(|sequence| {
                let mut event = event_at(sequence, "done", now - DAY);
                event.event_id = format!("retired-{sequence}");
                event.session_id = format!("retired-session-{sequence}");
                event
            })
            .collect();
        assert_eq!(engine.apply(events, now, &unavailable).len(), 0);
        assert_eq!(engine.sessions.len(), (batch_end - sequence) as usize);
        engine.maintain(now, &unavailable);
        assert!(engine.sessions.is_empty());
        sequence = batch_end;
        now += 1;
    }

    let mut new_session = event_at(sequence, "busy", now - DAY);
    new_session.event_id = "retired-new-session".into();
    new_session.session_id = "new-session".into();
    assert!(engine
        .apply(vec![new_session], now, &unavailable)
        .is_empty());
    assert!(engine
        .sessions
        .contains_key(&session_key("claude_code", "new-session")));

    let mut finish = event_at(sequence + 1, "done", now - DAY);
    finish.event_id = "retired-new-session-done".into();
    finish.session_id = "new-session".into();
    assert_eq!(
        engine.apply(vec![finish.clone()], now, &unavailable).len(),
        1
    );
    engine.maintain(now, &unavailable);
    assert!(engine.sessions.is_empty());

    engine.save(&fixture.root).unwrap();
    let (seen, retired) = checkpoint_lengths(&fixture);
    assert!(seen <= super::engine::MAX_SEEN);
    assert_eq!(retired, super::engine::MAX_SEEN);
    let mut restored = Engine::load(&fixture.root, now).unwrap();
    let mut resurrect = finish;
    resurrect.event_id = "retired-new-session-resurrect".into();
    resurrect.sequence += 1;
    resurrect.state = "busy".into();
    assert!(engine
        .apply(vec![resurrect.clone()], now, &unavailable)
        .is_empty());
    assert!(restored
        .apply(vec![resurrect], now, &unavailable)
        .is_empty());
    assert!(restored.sessions.is_empty());
}

#[test]
fn restart_persists_dedupe_and_never_reannounces() {
    let fixture = Fixture::new();
    let mut engine = Engine::default();
    apply(&mut engine, vec![event(0, "busy")]);
    assert_eq!(apply(&mut engine, vec![event(1, "done")]).len(), 1);
    engine.save(&fixture.root).unwrap();
    let mut restored = Engine::load(&fixture.root, NOW).unwrap();
    assert!(apply(&mut restored, vec![event(0, "busy"), event(1, "done")]).is_empty());
    apply(&mut restored, vec![event(2, "busy")]);
    assert_eq!(apply(&mut restored, vec![event(3, "done")]).len(), 1);
    let mut duplicate = event(4, "waiting");
    duplicate.event_id = "event-1".into();
    assert!(apply(&mut restored, vec![duplicate]).is_empty());
    assert_eq!(session(&restored).state, "done");
    restored.save(&fixture.root).unwrap();
    // Use the production atomic replacement path. The sandbox deliberately
    // cannot truncate a file after its inherited broad write ACEs are removed.
    Directory::root(&fixture.root)
        .unwrap()
        .write("activity-desktop-v1.json", b"{broken")
        .unwrap();
    assert!(Engine::load(&fixture.root, NOW).is_err());
}

#[cfg(windows)]
#[test]
fn windows_checkpoint_acl_is_protected_and_owned_by_current_user() {
    use std::{os::windows::process::CommandExt, process::Command};
    let fixture = Fixture::new();
    Engine::default().save(&fixture.root).unwrap();
    let script = "$a = Get-Acl -LiteralPath $env:ACTIVITY_TEST_CHECKPOINT; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $allowed = @($sid,'S-1-5-18','S-1-5-32-544'); $r = @($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); $bad = @($r | Where-Object {$allowed -notcontains $_.IdentityReference.Value -or $_.IsInherited -or $_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne 'FullControl'}); if (!$a.AreAccessRulesProtected -or $r.Count -ne 3 -or @($r | Where-Object {$_.IdentityReference.Value -eq $sid}).Count -ne 1 -or $bad.Count -ne 0 -or $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid) { Write-Output ('protected={0}; count={1}; owner={2}; sid={3}; userRules={4}; bad={5}' -f $a.AreAccessRulesProtected,$r.Count,$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value,$sid,@($r | Where-Object {$_.IdentityReference.Value -eq $sid}).Count,$bad.Count); $r | ForEach-Object { Write-Output ('rule={0}; inherited={1}; rights={2}; type={3}' -f $_.IdentityReference.Value,$_.IsInherited,$_.FileSystemRights,$_.AccessControlType) }; exit 2 }";
    let result = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env(
            "ACTIVITY_TEST_CHECKPOINT",
            fixture.root.join("activity-desktop-v1.json"),
        )
        .env_remove("PSModulePath")
        .creation_flags(0x0800_0000)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "checkpoint ACL is not protected owner and allowlist: stdout={} stderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn json_integer_spellings_match_typescript_validation() {
    let serialized = serde_json::to_string(&event(100, "busy"))
        .unwrap()
        .replace("\"version\":1", "\"version\":1.0")
        .replace("\"sequence\":100", "\"sequence\":1e2");
    assert_eq!(
        Event::read(serialized.as_bytes(), NOW).unwrap().sequence,
        100
    );
}

#[test]
fn changed_hook_parent_pid_cannot_complete_existing_session() {
    let mut engine = Engine::default();
    let mut initial = event(0, "busy");
    initial.process = Some(Process {
        ppid: Some(42),
        ..Default::default()
    });
    engine.apply(vec![initial], NOW, &|_| Probe::Alive(timestamp(NOW - 2000)));
    let mut done = event(1, "done");
    done.process = Some(Process {
        ppid: Some(43),
        ..Default::default()
    });
    assert!(engine
        .apply(vec![done], NOW, &|_| Probe::Alive(timestamp(NOW - 2000)))
        .is_empty());
    assert_eq!(session(&engine).state, "unknown");
}

#[test]
fn display_and_notification_match_frozen_allowlists() {
    let mut engine = Engine::default();
    let mut initial = event(0, "busy");
    initial.account_alias = Some("local-account".into());
    apply(&mut engine, vec![initial]);
    let transition = apply(&mut engine, vec![event(1, "done")]).remove(0);
    let display = serde_json::to_value(&transition.session).unwrap();
    assert_eq!(display.as_object().unwrap().len(), 7);
    for forbidden in [
        "process",
        "session",
        "accountAlias",
        "parentSessionId",
        "sequence",
        "seenEventIds",
    ] {
        assert!(display.get(forbidden).is_none());
    }
    assert_eq!(display["sessionId"], session_key("claude_code", "session"));
    assert_eq!(
        display["sessionId"],
        "a97a9ab551fd2d87a7168f801c5da93c7a2ca8facd3b0d44eaaf7b7f669c9338"
    );
    let notify = serde_json::to_value(transition.notification).unwrap();
    assert_eq!(
        notify,
        json!({"kind":"agent_done", "provider":"CLAUDE", "account":"local-account", "localChannel":"popup", "remoteChannel":false,
        "dedupeKey":format!("activity:{}",json!(["CLAUDE","local-account",session_key("claude_code","session"),1,"agent_done"]))})
    );
    for agent in [
        "claude_code",
        "codex",
        "muse",
        "gemini_cli",
        "cursor",
        "kimi",
        "grok",
        "antigravity",
    ] {
        assert!(provider(agent).is_some());
    }
}

#[test]
fn spool_sorts_and_counts_hostile_files() {
    let fixture = Fixture::new();
    for n in (0..5).rev() {
        fixture.event(&event(n, "busy"));
    }
    fixture.file("unexpected.json", b"{}");
    fixture.file(
        &format!("{:016}-{}.json", 10, uuid::Uuid::new_v4()),
        b"{partial",
    );
    fixture.file(
        &format!("{:016}-{}.json", 11, uuid::Uuid::new_v4()),
        &vec![b' '; EVENT_BYTES + 1],
    );
    let mut stale = event(12, "busy");
    stale.observed_at = timestamp(NOW - DAY - 1);
    fixture.event(&stale);
    let scan = fixture.scan();
    assert_eq!(scan.skipped, 4);
    assert_eq!(
        scan.events.iter().map(|e| e.sequence).collect::<Vec<_>>(),
        vec![0, 1, 2, 3, 4]
    );
}

#[test]
fn spool_work_cap_makes_progress_across_ticks() {
    let fixture = Fixture::new();
    for n in 0..(FILES_PER_TICK + 7) {
        fixture.event(&event(n as u64, "busy"));
    }
    let mut reader = Reader::new(&fixture.root);
    let first = reader.tick(NOW);
    assert!(!first.complete);
    assert_eq!(first.inspected, FILES_PER_TICK);
    assert!(first.events.is_empty());
    let second = reader.tick(NOW);
    assert!(second.complete);
    assert_eq!(second.events.len(), FILES_PER_TICK + 7);
}

#[test]
fn spool_refuses_hardlinks_directories_and_escape_roots() {
    let fixture = Fixture::new();
    let name = format!("{:016}-{}.json", 1, uuid::Uuid::new_v4());
    fixture.file(&name, &serde_json::to_vec(&event(1, "busy")).unwrap());
    fs::hard_link(
        fixture.root.join("activity").join(&name),
        fixture.root.join("hardlink"),
    )
    .unwrap();
    fs::create_dir(fixture.root.join("activity").join(format!(
        "{:016}-{}.json",
        2,
        uuid::Uuid::new_v4()
    )))
    .unwrap();
    let scan = fixture.scan();
    assert!(scan.events.is_empty());
    assert_eq!(scan.skipped, 2);
    assert!(Directory::root(&fixture.root.join("..")).is_err());
    assert!(Directory::root(std::path::Path::new("relative")).is_err());
}

#[test]
fn checkpoint_refuses_hardlink_destination() {
    let fixture = Fixture::new();
    let path = fixture.root.join("activity-desktop-v1.json");
    fs::write(&path, b"untouched").unwrap();
    fs::hard_link(&path, fixture.root.join("other")).unwrap();
    assert!(Engine::default().save(&fixture.root).is_err());
    assert_eq!(fs::read(fixture.root.join("other")).unwrap(), b"untouched");
}

#[cfg(windows)]
#[test]
fn windows_junctions_are_allowed_only_for_state_root() {
    use std::{os::windows::process::CommandExt, process::Command};
    let fixture = Fixture::new();
    let outside = Fixture::new();
    let junction = |link: &std::path::Path, target: &std::path::Path| {
        let result = Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "temporary junction creation failed"
        );
    };
    junction(&fixture.root.join("alias"), &outside.root);
    assert!(Directory::root(&fixture.root.join("alias"))
        .unwrap()
        .activity()
        .is_ok());
    fs::remove_dir(fixture.root.join("alias")).unwrap();
    fs::remove_dir(fixture.root.join("activity")).unwrap();
    junction(
        &fixture.root.join("activity"),
        &outside.root.join("activity"),
    );
    let scan = fixture.scan();
    assert!(scan.events.is_empty());
    assert_eq!(scan.skipped, 1);
    fs::remove_dir(fixture.root.join("activity")).unwrap();
    fs::create_dir(fixture.root.join("activity")).unwrap();
    let name = format!("{:016}-{}.json", 1, uuid::Uuid::new_v4());
    junction(&fixture.root.join("activity").join(&name), &outside.root);
    assert_eq!(fixture.scan().skipped, 1);
    fs::remove_dir(fixture.root.join("activity").join(name)).unwrap();
}

#[test]
fn spool_total_byte_limit_discards_overfull_sweep() {
    let fixture = Fixture::new();
    fixture.event(&event(0, "busy"));
    for n in 0..=SPOOL_BYTES / EVENT_BYTES as u64 {
        let name = format!("{:016}-{}.json", n + 1, uuid::Uuid::new_v4());
        fixture.file(&name, &vec![b' '; EVENT_BYTES]);
    }
    let scan = fixture.scan();
    assert!(scan.events.is_empty());
    assert!(scan.skipped > 2048);
}

#[test]
fn event_id_dedupe_is_global_and_timestamp_regression_is_ignored() {
    let mut engine = Engine::default();
    apply(&mut engine, vec![event(0, "busy")]);
    let mut other = event(0, "done");
    other.session_id = "other".into();
    assert!(apply(&mut engine, vec![other]).is_empty());
    assert_eq!(engine.sessions.len(), 1);
    let mut regressed = event(2, "done");
    regressed.observed_at = timestamp(NOW - 2000);
    assert!(apply(&mut engine, vec![regressed]).is_empty());
    assert_eq!(session(&engine).state, "busy");
}

#[cfg(unix)]
#[test]
fn unix_spool_refuses_links_fifo_and_broad_modes() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let fixture = Fixture::new();
    symlink(&fixture.root, fixture.root.join("alias")).unwrap();
    assert!(Directory::root(&fixture.root.join("alias"))
        .unwrap()
        .activity()
        .is_ok());
    let name = format!("{:016}-{}.json", 1, uuid::Uuid::new_v4());
    symlink(
        fixture.root.join("missing"),
        fixture.root.join("activity").join(&name),
    )
    .unwrap();
    let fifo =
        fixture
            .root
            .join("activity")
            .join(format!("{:016}-{}.json", 2, uuid::Uuid::new_v4()));
    use std::os::unix::ffi::OsStrExt;
    let fifo = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert_eq!(fixture.scan().skipped, 2);
    fs::set_permissions(
        fixture.root.join("activity"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    assert_eq!(fixture.scan().skipped, 1);
    fs::remove_dir_all(fixture.root.join("activity")).unwrap();
    symlink(&fixture.root, fixture.root.join("activity")).unwrap();
    assert!(fixture.scan().events.is_empty());
    assert_eq!(fixture.scan().skipped, 1);
}

#[test]
fn native_process_probe_identifies_current_process() {
    let Probe::Alive(start) = process::probe(u64::from(std::process::id())) else {
        panic!("current process creation time unavailable");
    };
    assert!(instant(&start).is_some());
    assert_eq!(
        process::probe(u64::from(std::process::id())),
        Probe::Alive(start)
    );
    assert_eq!(process::probe(u64::MAX), Probe::Unavailable);
}

#[test]
fn consumer_persists_before_handoff_and_failed_write_retries_once() {
    let fixture = Fixture::new();
    fixture.event(&event(0, "busy"));
    let mut consumer = super::runtime::Consumer::new(&fixture.root);
    assert!(consumer
        .tick(NOW, &unavailable)
        .unwrap()
        .transitions
        .is_empty());
    let checkpoint = fixture.root.join("activity-desktop-v1.json");
    // A directory planted at the checkpoint destination forces a real failed
    // write without requiring the sandbox to edit a protected file's ACL.
    fs::remove_file(&checkpoint).unwrap();
    fs::create_dir(&checkpoint).unwrap();
    fixture.event(&event(1, "done"));
    assert!(
        consumer.tick(NOW, &unavailable).is_err(),
        "failed persistence returns no transition"
    );
    fs::remove_dir(&checkpoint).unwrap();
    let tick = consumer.tick(NOW, &unavailable).unwrap();
    assert_eq!(tick.transitions.len(), 1);
    assert_eq!(
        session(&Engine::load(&fixture.root, NOW).unwrap()).state,
        "done"
    );
    assert!(consumer
        .tick(NOW, &unavailable)
        .unwrap()
        .transitions
        .is_empty());
    let mut restarted = super::runtime::Consumer::new(&fixture.root);
    assert!(restarted
        .tick(NOW, &unavailable)
        .unwrap()
        .transitions
        .is_empty());
}

#[test]
fn native_transition_handoff_and_populated_ipc_use_sanitized_records() {
    use tauri::{
        ipc::{CallbackFn, InvokeBody},
        test::{get_ipc_response, mock_builder, INVOKE_KEY},
        webview::InvokeRequest,
        Listener, WebviewWindowBuilder,
    };
    let fixture = Fixture::new();
    fixture.event(&event(0, "busy"));
    let mut consumer = super::runtime::Consumer::new(&fixture.root);
    consumer.tick(NOW, &unavailable).unwrap();
    fixture.event(&event(1, "done"));
    let tick = consumer.tick(NOW, &unavailable).unwrap();
    let app = mock_builder()
        .plugin(super::init())
        .build(tauri::generate_context!(test = true))
        .unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    app.listen("activity-transition", move |event| {
        sender.send(event.payload().to_owned()).unwrap();
    });
    super::runtime::publish(app.handle(), tick);
    let payload: serde_json::Value = serde_json::from_str(
        &receiver
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(payload["notification"]["kind"], "agent_done");
    assert_eq!(payload["notification"]["remoteChannel"], false);
    assert_eq!(
        payload["session"]["sessionId"],
        session_key("claude_code", "session")
    );
    let window = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let response = get_ipc_response(
        &window,
        InvokeRequest {
            cmd: "plugin:activity|activity_sessions".into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: InvokeBody::default(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .unwrap()
    .deserialize::<serde_json::Value>()
    .unwrap();
    assert_eq!(response, json!([payload["session"].clone()]));
}

#[test]
fn locate_targets_keep_completed_tasks_but_drop_ended_sessions() {
    let fixture = Fixture::new();
    let mut first = event(0, "busy");
    first.process = Some(Process {
        pid: None,
        started_at: None,
        ppid: Some(42),
    });
    fixture.event(&first);
    let probe = |_| Probe::Alive(timestamp(NOW - 10_000));
    let mut consumer = super::runtime::Consumer::new(&fixture.root);
    let tick = consumer.tick(NOW, &probe).unwrap();
    assert_eq!(tick.targets.len(), 1);
    fixture.event(&event(1, "done"));
    let tick = consumer.tick(NOW, &probe).unwrap();
    assert_eq!(tick.sessions[0].state, "done");
    assert_eq!(
        tick.targets.len(),
        1,
        "a completed task can still own a live terminal"
    );
    let mut end = event(2, "unknown");
    end.signal = Some("session_ended".into());
    fixture.event(&end);
    assert!(consumer.tick(NOW, &probe).unwrap().targets.is_empty());
}

#[test]
fn unreadable_process_and_clock_regression_do_not_invent_success() {
    let mut engine = Engine::default();
    let mut initial = event(0, "done");
    initial.process = Some(Process {
        ppid: Some(42),
        ..Default::default()
    });
    apply(&mut engine, vec![initial]);
    assert_eq!(session(&engine).state, "unknown");
    let mut engine = Engine::default();
    let mut initial = event(0, "busy");
    initial.process = Some(Process {
        ppid: Some(42),
        ..Default::default()
    });
    engine.apply(vec![initial], NOW, &|_| Probe::Alive(timestamp(NOW - 2000)));
    engine.maintain(NOW - 1500, &|_| Probe::Missing);
    assert_eq!(session(&engine).state, "unknown");
    assert!(session(&engine).state_changed_at >= session(&engine).first_observed_at);
}
