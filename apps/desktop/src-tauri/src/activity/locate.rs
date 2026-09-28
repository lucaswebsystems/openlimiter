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
    let mut chain = Vec::new();
    let mut current = pid;
    for _ in 0..64 {
        if current == 0 || chain.iter().any(|(seen, _)| *seen == current) {
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
    chain
}

#[cfg(any(windows, test))]
fn activate_or_flash(activate: impl FnOnce() -> bool, flash: impl FnOnce()) -> LocateResult {
    if activate() {
        LocateResult::Focused
    } else {
        flash();
        LocateResult::Flashed
    }
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

// Tests exercise policy and IPC, never change focus on the developer's desktop.
#[cfg(all(windows, test))]
fn native(_: u32, _: &str) -> LocateResult {
    LocateResult::Unavailable
}

#[cfg(all(windows, not(test)))]
fn native(pid: u32, expected: &str) -> LocateResult {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HWND, INVALID_HANDLE_VALUE, LPARAM},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        UI::WindowsAndMessaging::{
            EnumWindows, FlashWindowEx, GetAncestor, GetShellWindow, GetWindowThreadProcessId,
            IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow, FLASHWINFO, FLASHW_TRAY,
            GA_ROOT, SW_RESTORE,
        },
    };
    struct Search {
        pid: u32,
        window: HWND,
    }
    unsafe extern "system" fn visit(window: HWND, data: LPARAM) -> i32 {
        let search = &mut *(data as *mut Search);
        let mut owner = 0;
        GetWindowThreadProcessId(window, &mut owner);
        if owner == search.pid && IsWindowVisible(window) != 0 && window != GetShellWindow() {
            search.window = GetAncestor(window, GA_ROOT);
            return 0;
        }
        1
    }
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return LocateResult::Unavailable;
        }
        let mut parents = std::collections::BTreeMap::new();
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry);
        while more != 0 {
            parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
            more = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        let chain = process_chain(pid, expected, &parents, &process::probe);
        let mut shell_pid = 0;
        GetWindowThreadProcessId(GetShellWindow(), &mut shell_pid);
        for (index, (current, _)) in chain.iter().enumerate() {
            // Explorer can launch a terminal, but its folder windows do not own it.
            if *current == shell_pid {
                break;
            }
            let mut search = Search {
                pid: *current,
                window: std::ptr::null_mut(),
            };
            EnumWindows(Some(visit), (&mut search as *mut Search) as LPARAM);
            if !search.window.is_null() {
                if chain[..=index]
                    .iter()
                    .any(|(id, time)| process::probe((*id).into()) != Probe::Alive(time.clone()))
                {
                    return LocateResult::Unavailable;
                }
                let mut owner = 0;
                GetWindowThreadProcessId(search.window, &mut owner);
                if owner != *current {
                    return LocateResult::Unavailable;
                }
                if IsIconic(search.window) != 0 {
                    ShowWindow(search.window, SW_RESTORE);
                }
                let flash = FLASHWINFO {
                    cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
                    hwnd: search.window,
                    dwFlags: FLASHW_TRAY,
                    uCount: 3,
                    dwTimeout: 0,
                };
                return activate_or_flash(
                    || SetForegroundWindow(search.window) != 0,
                    || {
                        FlashWindowEx(&flash);
                    },
                );
            }
        }
    }
    LocateResult::Unavailable
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
        assert_eq!(
            chain.iter().map(|(pid, _)| *pid).collect::<Vec<_>>(),
            vec![42, 21]
        );
        let reused = process_chain(42, parent, &parents, &|pid| {
            Probe::Alive(if pid == 42 { parent } else { child }.into())
        });
        assert_eq!(reused.len(), 1);
        assert!(process_chain(42, parent, &parents, &|_| Probe::Alive(child.into())).is_empty());
        assert!(process_chain(42, child, &parents, &|_| Probe::Missing).is_empty());
    }

    #[test]
    fn refused_focus_flashes_once_and_success_does_not_flash() {
        let count = std::cell::Cell::new(0);
        assert_eq!(
            activate_or_flash(|| false, || count.set(count.get() + 1)),
            LocateResult::Flashed
        );
        assert_eq!(count.get(), 1);
        assert_eq!(
            activate_or_flash(|| true, || panic!("must not flash")),
            LocateResult::Focused
        );
    }
    #[cfg(not(windows))]
    #[test]
    fn unsupported_platform_is_honest() {
        assert_eq!(native(42, "start"), LocateResult::NotSupportedYet);
    }
}
