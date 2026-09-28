use super::placement::Edge;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Write},
    path::Path,
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub edge: Edge,
    pub monitor_id: String,
    /// Logical pixels from the work area's start, separately for each display.
    pub offsets: BTreeMap<String, f64>,
    pub visible: bool,
    pub keep_open: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            edge: Edge::Left,
            monitor_id: String::new(),
            offsets: BTreeMap::new(),
            visible: true,
            keep_open: false,
        }
    }
}

impl Preferences {
    pub fn offset(&self, monitor: &str) -> f64 {
        self.offsets.get(monitor).copied().unwrap_or(120.0)
    }
    pub fn validate(&self) -> io::Result<()> {
        if self.monitor_id.len() > 256
            || self.offsets.len() > 64
            || self
                .offsets
                .iter()
                .any(|(id, n)| id.len() > 256 || !n.is_finite() || !(0.0..=100000.0).contains(n))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid Rail preferences",
            ));
        }
        Ok(())
    }
}

pub fn load(path: &Path) -> io::Result<Preferences> {
    if fs::metadata(path)?.len() > 32768 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Rail preferences are too large",
        ));
    }
    let value: Preferences = serde_json::from_slice(&fs::read(path)?)?;
    value.validate()?;
    Ok(value)
}

/// Same-directory rename replaces atomically, including on Windows (MoveFileExW
/// in std::fs). A failed write leaves the previous document intact.
pub fn save(path: &Path, value: &Preferences) -> io::Result<()> {
    value.validate()?;
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("missing config directory"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".rail-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&serde_json::to_vec(value)?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip_replaces_existing_file_and_keeps_each_monitor_offset() {
        let dir =
            std::env::temp_dir().join(format!("openlimiter-rail-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("rail.json");
        let mut prefs = Preferences::default();
        save(&path, &prefs).unwrap();
        prefs.monitor_id = "second".into();
        prefs.edge = Edge::Bottom;
        prefs.offsets.insert("first".into(), 12.5);
        prefs.offsets.insert("second".into(), 420.0);
        prefs.visible = false;
        prefs.keep_open = true;
        save(&path, &prefs).unwrap();
        assert_eq!(load(&path).unwrap(), prefs);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        prefs.offsets.insert("invalid".into(), f64::NAN);
        assert!(save(&path, &prefs).is_err());
        assert_eq!(load(&path).unwrap().offset("second"), 420.0);
        fs::remove_file(path).unwrap();
        fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn malformed_preferences_are_rejected() {
        let prefs: Preferences = serde_json::from_str(r#"{"offsets":{"display":-1}}"#).unwrap();
        assert!(prefs.validate().is_err());
        assert!(serde_json::from_str::<Preferences>(r#"{"edge":"right"}"#).is_err());
    }
}
