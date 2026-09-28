use super::contract::{instant, timestamp};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Probe {
    Alive(String),
    Missing,
    Unavailable,
}

/// Only pid and creation time are read. No command line, environment or text.
pub fn probe(pid: u64) -> Probe {
    let Ok(pid) = u32::try_from(pid) else {
        return Probe::Unavailable;
    };
    if pid == 0 {
        return Probe::Unavailable;
    }
    native(pid)
}

#[cfg(windows)]
fn native(pid: u32) -> Probe {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, FILETIME},
        System::Threading::{
            GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return if GetLastError() == 87 {
                Probe::Missing
            } else {
                Probe::Unavailable
            };
        }
        let mut created = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exit = created;
        let mut kernel = created;
        let mut user = created;
        let mut code = 0;
        let result = if GetExitCodeProcess(handle, &mut code) == 0 {
            Probe::Unavailable
        } else if code != 259 {
            Probe::Missing
        } else if GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user) == 0 {
            Probe::Unavailable
        } else {
            let ticks =
                (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
            Probe::Alive(timestamp((ticks / 10_000) as i64 - 11_644_473_600_000))
        };
        CloseHandle(handle);
        result
    }
}

#[cfg(target_os = "linux")]
fn native(pid: u32) -> Probe {
    let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(v) => v,
        Err(e) => {
            return if e.kind() == std::io::ErrorKind::NotFound {
                Probe::Missing
            } else {
                Probe::Unavailable
            }
        }
    };
    let parse = || -> Option<String> {
        let fields: Vec<&str> = stat
            .get(stat.rfind(')')? + 2..)?
            .split_whitespace()
            .collect();
        let ticks: i64 = fields.get(19)?.parse().ok()?;
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if hz <= 0 {
            return None;
        }
        let boot: i64 = std::fs::read_to_string("/proc/stat")
            .ok()?
            .lines()
            .find_map(|line| line.strip_prefix("btime ").and_then(|v| v.parse().ok()))?;
        Some(timestamp(
            boot.checked_mul(1000)?
                .checked_add(ticks.checked_mul(1000)? / hz)?,
        ))
    };
    parse().map_or(Probe::Unavailable, Probe::Alive)
}

#[cfg(target_os = "macos")]
fn native(pid: u32) -> Probe {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let result = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if result != size {
        return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            Probe::Missing
        } else {
            Probe::Unavailable
        };
    }
    Probe::Alive(timestamp(
        info.pbi_start_tvsec as i64 * 1000 + info.pbi_start_tvusec as i64 / 1000,
    ))
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn native(_: u32) -> Probe {
    Probe::Unavailable
}

pub fn started_before(start: &str, observation: &str) -> bool {
    instant(start)
        .zip(instant(observation))
        .is_some_and(|(a, b)| a <= b)
}
