#[path = "../src/data_rules.rs"]
mod data_rules;
// Use the production Rail and its dependencies, as in lane_plugins.
#[path = "../src/activity.rs"]
mod activity;
#[path = "../src/antigravity_credential.rs"]
mod antigravity_credential;
#[path = "../src/antigravity_local.rs"]
mod antigravity_local;
#[path = "../src/cache_write.rs"]
mod cache_write;
#[path = "../src/connections.rs"]
mod connections;
#[path = "../src/credentials.rs"]
mod credentials;
#[path = "../src/fsx.rs"]
mod fsx;
#[path = "../src/native_opencode.rs"]
mod native_opencode;
#[path = "../src/native_readers.rs"]
mod native_readers;
#[path = "../src/native_snapshot.rs"]
mod native_snapshot;
#[path = "../src/native_time.rs"]
mod native_time;
#[path = "../src/net.rs"]
mod net;
#[path = "../src/poll_identity.rs"]
mod poll_identity;
#[path = "../src/provider_detection.rs"]
mod provider_detection;
#[path = "../src/provider_switches.rs"]
mod provider_switches;
#[path = "../src/rail.rs"]
mod rail;
#[path = "../src/reader_registry.rs"]
mod reader_registry;
#[path = "../src/request_policy.rs"]
mod request_policy;
#[path = "../src/state.rs"]
mod state;
#[path = "../src/test_support.rs"]
mod test_support;

use std::{
    fs,
    process::{Child, Command},
    thread,
    time::{Duration, Instant},
};
use tauri::test::{mock_builder, mock_context, noop_assets};

const CHILD_ROOT: &str = "OPENLIMITER_RAIL_LIFECYCLE_ROOT";

// A failed assertion must also stop the child, including a deadlocked runtime.
struct SupervisedChild(Child);

impl Drop for SupervisedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn rail_ready_reaches_app_callback() {
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        let signal = std::path::PathBuf::from(root).join("ready");
        mock_builder()
            .plugin(rail::init())
            .build(mock_context(noop_assets()))
            .expect("Rail initializes without a saved profile")
            .run(move |_, event| {
                if matches!(event, tauri::RunEvent::Ready) {
                    fs::write(&signal, b"ready").expect("signal the supervisor");
                    // The mock event loop is intentionally endless. Exit without
                    // waiting for native Rail configuration or background workers.
                    std::process::exit(0);
                }
            });
        panic!("the mock lifecycle returned before Ready");
    }

    let root = test_support::TempDir::new();
    let signal = root.path().join("ready");
    let mut command = Command::new(std::env::current_exe().expect("test executable"));
    command
        .args(["--exact", "rail_ready_reaches_app_callback", "--nocapture"])
        .env(CHILD_ROOT, root.path())
        // Exercise the Windows startup path on macOS and Linux too.
        .env("OPENLIMITER_RAIL_PREVIEW", "1");
    for key in [
        "HOME",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "XDG_RUNTIME_DIR",
    ] {
        command.env(key, root.path());
    }
    let started = Instant::now();
    let mut child = SupervisedChild(command.spawn().expect("spawn isolated mock lifecycle"));
    loop {
        if signal.is_file() {
            return;
        }
        if let Some(status) = child.0.try_wait().expect("check mock lifecycle") {
            assert!(
                signal.is_file(),
                "Rail exited before the app received Ready: {status}"
            );
            return;
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "Rail blocked the app Ready callback for 5 seconds"
        );
        thread::sleep(Duration::from_millis(10));
    }
}
