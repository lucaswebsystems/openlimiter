use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

const FALLBACK_WINDOWS_ROOT: &str = r"C:\Windows";

pub(crate) fn from_system_root(root: Option<&OsStr>, segments: &[&str]) -> PathBuf {
    let configured = root.map(PathBuf::from);
    let root = configured
        .filter(|candidate| candidate.is_absolute())
        .unwrap_or_else(|| PathBuf::from(FALLBACK_WINDOWS_ROOT));
    let mut tool = root.join("System32");
    for segment in segments {
        assert!(
            !segment.is_empty()
                && *segment != "."
                && *segment != ".."
                && !segment.contains('/')
                && !segment.contains('\\'),
            "invalid Windows system tool segment"
        );
        tool.push(segment);
    }
    tool
}

fn configured_root() -> Option<OsString> {
    std::env::var_os("SystemRoot").or_else(|| std::env::var_os("SYSTEMROOT"))
}

pub(crate) fn system_directory() -> PathBuf {
    from_system_root(configured_root().as_deref(), &[])
}

pub(crate) fn tool(segments: &[&str]) -> PathBuf {
    from_system_root(configured_root().as_deref(), segments)
}

pub(crate) fn powershell() -> PathBuf {
    tool(&["WindowsPowerShell", "v1.0", "powershell.exe"])
}

pub(crate) fn powershell_module_path() -> PathBuf {
    tool(&["WindowsPowerShell", "v1.0", "Modules"])
}
