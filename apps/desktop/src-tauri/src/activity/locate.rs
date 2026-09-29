use super::{
    contract::Process,
    process::{self, Probe},
};
use serde::Serialize;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocateResult {
    Focused,
    Flashed,
    Unavailable,
    NotSupportedYet,
}

#[cfg(any(windows, test))]
fn process_chain(
    pid: u32,
    expected: &str,
    parents: &std::collections::BTreeMap<u32, u32>,
    probe: &impl Fn(u64) -> Probe,
) -> Vec<(u32, String)> {
    let mut seen = std::collections::BTreeSet::new();
    let mut ancestor = pid;
    while ancestor != 0 {
        if !seen.insert(ancestor) || seen.len() > 64 {
            return vec![];
        }
        let Some(parent) = parents.get(&ancestor) else {
            break;
        };
        ancestor = *parent;
    }
    let mut chain = Vec::new();
    let mut current = pid;
    for _ in 0..64 {
        if chain.iter().any(|(seen, _)| *seen == current) {
            return vec![];
        }
        if current == 0 {
            break;
        }
        let Probe::Alive(start) = probe(current.into()) else {
            break;
        };
        if current == pid && start != expected {
            return vec![];
        }
        // A reused parent PID cannot own its supposed older child.
        if chain
            .last()
            .is_some_and(|(_, child): &(u32, String)| !process::started_before(&start, child))
        {
            break;
        }
        chain.push((current, start));
        let Some(parent) = parents.get(&current) else {
            break;
        };
        current = *parent;
    }
    // A bounded walk must not accept a prefix of an unvalidated lineage.
    if chain.len() == 64 && current != 0 {
        return vec![];
    }
    chain
}

#[cfg(any(windows, test))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity {
    pid: u32,
    started: String,
    process_ticks: u64,
    tid: u32,
    thread_ticks: u64,
}

#[cfg(any(windows, test))]
struct Bound<P> {
    identity: Identity,
    // Native process and thread handles stay open throughout activation.
    _pin: P,
}

#[cfg(any(windows, test))]
#[derive(Clone)]
struct Window {
    handle: usize,
    pid: u32,
    visible: bool,
    owned: bool,
    tool: bool,
    caption: bool,
    area: u64,
}

#[cfg(any(windows, test))]
trait WindowSystem {
    type Pin;
    fn parents(&self) -> Option<std::collections::BTreeMap<u32, u32>>;
    fn probe(&self, pid: u64) -> Probe;
    fn shell_pid(&self) -> u32;
    fn windows(&self) -> Option<Vec<Window>>;
    fn bind(&self, window: usize) -> Option<Bound<Self::Pin>>;
    fn restore(&self, window: usize);
    fn foreground(&self, window: usize) -> bool;
    fn flash(&self, window: usize) -> bool;
}

#[cfg(any(windows, test))]
fn locate_with(system: &impl WindowSystem, pid: u32, expected: &str) -> LocateResult {
    let Some(parents) = system.parents() else {
        return LocateResult::Unavailable;
    };
    let chain = process_chain(pid, expected, &parents, &|id| system.probe(id));
    if chain.is_empty() {
        return LocateResult::Unavailable;
    }
    let Some(windows) = system.windows() else {
        return LocateResult::Unavailable;
    };
    let shell = system.shell_pid();
    for (index, (current, start)) in chain.iter().enumerate() {
        // Explorer can launch a terminal, but its folder windows do not own it.
        if *current == shell {
            break;
        }
        // Prefer the largest captioned application frame, then the lowest HWND
        // for equal areas. This is deterministic, independent of EnumWindows order.
        let candidate = windows
            .iter()
            .filter(|w| w.pid == *current && w.visible && !w.owned && !w.tool && w.caption)
            .max_by_key(|w| (w.area, std::cmp::Reverse(w.handle)));
        let Some(window) = candidate else { continue };
        let Some(bound) = system.bind(window.handle) else {
            return LocateResult::Unavailable;
        };
        if bound.identity.pid != *current
            || bound.identity.started != *start
            || chain[..=index]
                .iter()
                .any(|(id, time)| system.probe((*id).into()) != Probe::Alive(time.clone()))
        {
            return LocateResult::Unavailable;
        }
        system.restore(window.handle);
        // Restore can dispatch messages. Rebind AFTER it, immediately before
        // foregrounding, comparing full process and thread creation identities.
        let Some(current) = system.bind(window.handle) else {
            return LocateResult::Unavailable;
        };
        if current.identity != bound.identity {
            return LocateResult::Unavailable;
        }
        if system.foreground(window.handle) {
            return LocateResult::Focused;
        }
        let Some(current) = system.bind(window.handle) else {
            return LocateResult::Unavailable;
        };
        if current.identity != bound.identity {
            return LocateResult::Unavailable;
        }
        if system.flash(window.handle)
            && system
                .bind(window.handle)
                .is_some_and(|v| v.identity == bound.identity)
        {
            return LocateResult::Flashed;
        }
        return LocateResult::Unavailable;
    }
    LocateResult::Unavailable
}

fn validated(target: Option<&Process>, probe: &impl Fn(u64) -> Probe) -> Option<u32> {
    let target = target?;
    let pid = target.pid?;
    let start = target.started_at.as_ref()?;
    (probe(pid) == Probe::Alive(start.clone()))
        .then(|| u32::try_from(pid).ok())
        .flatten()
}

pub fn locate(target: Option<&Process>) -> LocateResult {
    let Some(pid) = validated(target, &process::probe) else {
        return LocateResult::Unavailable;
    };
    native(pid, target.and_then(|p| p.started_at.as_deref()).unwrap())
}

#[cfg(not(windows))]
fn native(_: u32, _: &str) -> LocateResult {
    LocateResult::NotSupportedYet
}

#[cfg(windows)]
fn native(pid: u32, expected: &str) -> LocateResult {
    locate_with(&win::Native, pid, expected)
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME, HANDLE, HWND, INVALID_HANDLE_VALUE, LPARAM, RECT},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                GetExitCodeProcess, GetExitCodeThread, GetProcessIdOfThread, GetProcessTimes,
                GetThreadTimes, OpenProcess, OpenThread, PROCESS_QUERY_LIMITED_INFORMATION,
                THREAD_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::WindowsAndMessaging::{
            EnumWindows, FlashWindowEx, GetShellWindow, GetWindow, GetWindowLongW, GetWindowRect,
            GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow,
            FLASHWINFO, FLASHW_TRAY, GWL_EXSTYLE, GWL_STYLE, GW_OWNER, SW_RESTORE, WS_CAPTION,
            WS_EX_TOOLWINDOW,
        },
    };
    pub(super) struct Native;
    pub(super) struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    unsafe extern "system" fn visit(window: HWND, data: LPARAM) -> i32 {
        let windows = &mut *(data as *mut Vec<Window>);
        let mut pid = 0;
        GetWindowThreadProcessId(window, &mut pid);
        let mut rect: RECT = std::mem::zeroed();
        let area = if GetWindowRect(window, &mut rect) != 0 {
            (i64::from(rect.right) - i64::from(rect.left)).max(0) as u64
                * (i64::from(rect.bottom) - i64::from(rect.top)).max(0) as u64
        } else {
            0
        };
        windows.push(Window {
            handle: window as usize,
            pid,
            visible: IsWindowVisible(window) != 0 && window != GetShellWindow(),
            owned: !GetWindow(window, GW_OWNER).is_null(),
            tool: GetWindowLongW(window, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW != 0,
            caption: GetWindowLongW(window, GWL_STYLE) as u32 & WS_CAPTION == WS_CAPTION,
            area,
        });
        1
    }
    impl WindowSystem for Native {
        type Pin = (Handle, Handle);
        fn parents(&self) -> Option<std::collections::BTreeMap<u32, u32>> {
            unsafe {
                let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
                if snapshot == INVALID_HANDLE_VALUE {
                    return None;
                }
                let snapshot = Handle(snapshot);
                let mut parents = std::collections::BTreeMap::new();
                let mut entry: PROCESSENTRY32W = std::mem::zeroed();
                entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                let mut more = Process32FirstW(snapshot.0, &mut entry);
                if more == 0 {
                    return None;
                }
                while more != 0 {
                    parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                    more = Process32NextW(snapshot.0, &mut entry);
                }
                Some(parents)
            }
        }
        fn probe(&self, pid: u64) -> Probe {
            process::probe(pid)
        }
        fn shell_pid(&self) -> u32 {
            unsafe {
                let mut pid = 0;
                GetWindowThreadProcessId(GetShellWindow(), &mut pid);
                pid
            }
        }
        fn windows(&self) -> Option<Vec<Window>> {
            unsafe {
                let mut windows = Vec::new();
                (EnumWindows(Some(visit), (&mut windows as *mut Vec<Window>) as LPARAM) != 0)
                    .then_some(windows)
            }
        }
        fn bind(&self, window: usize) -> Option<Bound<Self::Pin>> {
            unsafe {
                let mut pid = 0;
                let tid = GetWindowThreadProcessId(window as HWND, &mut pid);
                if tid == 0 || pid == 0 {
                    return None;
                }
                let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if process.is_null() {
                    return None;
                }
                let process = Handle(process);
                let thread = OpenThread(THREAD_QUERY_LIMITED_INFORMATION, 0, tid);
                if thread.is_null() {
                    return None;
                }
                let thread = Handle(thread);
                let mut created: FILETIME = std::mem::zeroed();
                let mut thread_created = created;
                let mut exit = created;
                let mut kernel = created;
                let mut user = created;
                let mut code = 0;
                if GetProcessIdOfThread(thread.0) != pid
                    || GetExitCodeProcess(process.0, &mut code) == 0
                    || code != 259
                    || GetExitCodeThread(thread.0, &mut code) == 0
                    || code != 259
                    || GetProcessTimes(process.0, &mut created, &mut exit, &mut kernel, &mut user)
                        == 0
                    || GetThreadTimes(
                        thread.0,
                        &mut thread_created,
                        &mut exit,
                        &mut kernel,
                        &mut user,
                    ) == 0
                {
                    return None;
                }
                let ticks =
                    |t: FILETIME| (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime);
                let mut final_pid = 0;
                if GetWindowThreadProcessId(window as HWND, &mut final_pid) != tid
                    || final_pid != pid
                {
                    return None;
                }
                Some(Bound {
                    identity: Identity {
                        pid,
                        tid,
                        started: super::super::contract::timestamp(
                            (ticks(created) / 10_000) as i64 - 11_644_473_600_000,
                        ),
                        process_ticks: ticks(created),
                        thread_ticks: ticks(thread_created),
                    },
                    _pin: (process, thread),
                })
            }
        }
        fn restore(&self, window: usize) {
            unsafe {
                if IsIconic(window as HWND) != 0 {
                    ShowWindow(window as HWND, SW_RESTORE);
                }
            }
        }
        fn foreground(&self, window: usize) -> bool {
            unsafe { SetForegroundWindow(window as HWND) != 0 }
        }
        fn flash(&self, window: usize) -> bool {
            let flash = FLASHWINFO {
                cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
                hwnd: window as HWND,
                dwFlags: FLASHW_TRAY,
                uCount: 3,
                dwTimeout: 0,
            };
            // The API returns the previous caption state, not a success flag.
            // Conservatively never claim a flash after a zero return.
            unsafe { FlashWindowEx(&flash) != 0 }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locate_requires_matching_live_pid_and_start() {
        let target = Process {
            pid: Some(42),
            started_at: Some("start".into()),
            ppid: None,
        };
        assert_eq!(
            validated(Some(&target), &|_| Probe::Alive("start".into())),
            Some(42)
        );
        for result in [
            Probe::Missing,
            Probe::Unavailable,
            Probe::Alive("reused".into()),
        ] {
            assert_eq!(validated(Some(&target), &|_| result.clone()), None);
        }
        assert_eq!(validated(None, &|_| panic!("no probe")), None);
        assert_eq!(
            validated(Some(&Process::default()), &|_| panic!("no probe")),
            None
        );
    }

    #[test]
    fn process_tree_rejects_reused_parents_and_cycles() {
        let child = "2026-09-28T12:00:00.000Z";
        let parent = "2026-09-28T11:00:00.000Z";
        let parents = std::collections::BTreeMap::from([(42, 21), (21, 42)]);
        let chain = process_chain(42, child, &parents, &|pid| {
            Probe::Alive(if pid == 42 { child } else { parent }.into())
        });
        assert!(chain.is_empty());
        let parents = std::collections::BTreeMap::from([(42, 21)]);
        let reused = process_chain(42, parent, &parents, &|pid| {
            Probe::Alive(if pid == 42 { parent } else { child }.into())
        });
        assert_eq!(reused.len(), 1);
        assert!(process_chain(42, parent, &parents, &|_| Probe::Alive(child.into())).is_empty());
        assert!(process_chain(42, child, &parents, &|_| Probe::Missing).is_empty());
    }

    #[test]
    fn refused_focus_flashes_once_and_success_does_not_flash() {
        let mut fake = Fake::new();
        fake.focused = false;
        assert_eq!(locate_with(&fake, 42, CHILD), LocateResult::Flashed);
        assert_eq!(
            &*fake.calls.borrow(),
            &[("restore", 10), ("foreground", 10), ("flash", 10)]
        );
        fake.calls.borrow_mut().clear();
        fake.focused = true;
        assert_eq!(locate_with(&fake, 42, CHILD), LocateResult::Focused);
        assert_eq!(
            &*fake.calls.borrow(),
            &[("restore", 10), ("foreground", 10)]
        );
    }

    const CHILD: &str = "2026-09-28T12:00:00.000Z";
    const PARENT: &str = "2026-09-28T11:00:00.000Z";
    struct Fake {
        parents: std::collections::BTreeMap<u32, u32>,
        windows: Vec<Window>,
        focused: bool,
        flashed: bool,
        shell: u32,
        fail_windows: bool,
        // Replace the selected identity on a particular bind (before restore,
        // before focus, or before flash), including a vanished window.
        changed: Option<(usize, Option<Identity>)>,
        binds: std::cell::Cell<usize>,
        calls: std::cell::RefCell<Vec<(&'static str, usize)>>,
        stale_child: bool,
        probes: std::cell::Cell<usize>,
    }
    fn identity() -> Identity {
        Identity {
            pid: 21,
            started: PARENT.into(),
            process_ticks: 100,
            tid: 7,
            thread_ticks: 200,
        }
    }
    fn window(handle: usize, area: u64) -> Window {
        Window {
            handle,
            pid: 21,
            visible: true,
            owned: false,
            tool: false,
            caption: true,
            area,
        }
    }
    impl Fake {
        fn new() -> Self {
            Self {
                parents: [(42, 21), (21, 0)].into(),
                windows: vec![window(10, 100)],
                focused: true,
                flashed: true,
                shell: 99,
                fail_windows: false,
                changed: None,
                binds: 0.into(),
                calls: Default::default(),
                stale_child: false,
                probes: 0.into(),
            }
        }
    }
    impl WindowSystem for Fake {
        type Pin = ();
        fn parents(&self) -> Option<std::collections::BTreeMap<u32, u32>> {
            Some(self.parents.clone())
        }
        fn probe(&self, pid: u64) -> Probe {
            let n = self.probes.get();
            self.probes.set(n + 1);
            if self.stale_child && n >= 2 && pid == 42 {
                return Probe::Missing;
            }
            Probe::Alive(if pid == 42 { CHILD } else { PARENT }.into())
        }
        fn shell_pid(&self) -> u32 {
            self.shell
        }
        fn windows(&self) -> Option<Vec<Window>> {
            (!self.fail_windows).then(|| self.windows.clone())
        }
        fn bind(&self, _: usize) -> Option<Bound<()>> {
            let n = self.binds.get() + 1;
            self.binds.set(n);
            let value = match &self.changed {
                Some((at, value)) if n >= *at => value.clone(),
                _ => Some(identity()),
            }?;
            Some(Bound {
                identity: value,
                _pin: (),
            })
        }
        fn restore(&self, w: usize) {
            self.calls.borrow_mut().push(("restore", w));
        }
        fn foreground(&self, w: usize) -> bool {
            self.calls.borrow_mut().push(("foreground", w));
            self.focused
        }
        fn flash(&self, w: usize) -> bool {
            self.calls.borrow_mut().push(("flash", w));
            self.flashed
        }
    }

    #[test]
    fn primary_frame_selection_excludes_helpers_and_is_order_independent() {
        let mut fake = Fake::new();
        let mut owned = window(1, 1000);
        owned.owned = true;
        let mut tool = window(2, 1000);
        tool.tool = true;
        let mut hidden = window(3, 1000);
        hidden.visible = false;
        let mut splash = window(4, 1000);
        splash.caption = false;
        let mut unrelated = window(5, 1000);
        unrelated.pid = 55;
        fake.windows = vec![
            owned,
            tool,
            hidden,
            splash,
            unrelated,
            window(8, 50),
            window(11, 100),
            window(10, 100),
        ];
        for _ in 0..2 {
            fake.calls.borrow_mut().clear();
            assert_eq!(locate_with(&fake, 42, CHILD), LocateResult::Focused);
            assert_eq!(fake.calls.borrow()[1], ("foreground", 10));
            fake.windows.reverse();
        }
    }

    #[test]
    fn identity_changes_or_disappearance_before_focus_fail_closed() {
        let mut mismatches = vec![None];
        for field in 0..5 {
            let mut value = identity();
            match field {
                0 => value.pid += 1,
                1 => value.started = CHILD.into(),
                2 => value.process_ticks += 1,
                3 => value.tid += 1,
                _ => value.thread_ticks += 1,
            }
            mismatches.push(Some(value));
        }
        for replacement in mismatches {
            let mut fake = Fake::new();
            fake.changed = Some((2, replacement));
            assert_eq!(locate_with(&fake, 42, CHILD), LocateResult::Unavailable);
            assert_eq!(&*fake.calls.borrow(), &[("restore", 10)]);
        }
    }

    #[test]
    fn failed_flash_or_changed_identity_never_reports_flashed() {
        for at in [0, 3, 4] {
            let mut fake = Fake::new();
            fake.focused = false;
            if at == 0 {
                fake.flashed = false;
            } else {
                fake.changed = Some((at, None));
            }
            assert_eq!(locate_with(&fake, 42, CHILD), LocateResult::Unavailable);
            assert_eq!(
                fake.calls
                    .borrow()
                    .iter()
                    .filter(|(call, _)| *call == "flash")
                    .count(),
                usize::from(at != 3)
            );
        }
    }

    #[test]
    fn cycles_shell_windows_missing_candidates_and_stale_lineage_do_not_activate() {
        for case in 0..6 {
            let mut fake = Fake::new();
            match case {
                0 => {
                    fake.parents.insert(21, 42);
                }
                1 => fake.shell = 21,
                2 => fake.windows.clear(),
                3 => fake.fail_windows = true,
                4 => fake.stale_child = true,
                _ => fake.changed = Some((1, None)),
            }
            assert_eq!(locate_with(&fake, 42, CHILD), LocateResult::Unavailable);
            assert!(fake.calls.borrow().is_empty());
        }
    }

    #[cfg(windows)]
    #[test]
    fn real_windows_queries_are_safe_without_activation() {
        let system = win::Native;
        assert!(system.parents().unwrap().contains_key(&std::process::id()));
        assert!(matches!(
            system.probe(std::process::id().into()),
            Probe::Alive(_)
        ));
        // A restricted desktop can deny EnumWindows. That is a supported
        // unavailable result, not a reason to bypass the production adapter.
        let _ = system.windows();
        assert!(system.bind(0).is_none());
        assert_eq!(native(0, "missing"), LocateResult::Unavailable);
        // Deliberately query only. Never call restore, foreground or flash.
    }
    #[cfg(not(windows))]
    #[test]
    fn unsupported_platform_is_honest() {
        assert_eq!(native(42, "start"), LocateResult::NotSupportedYet);
    }
}
