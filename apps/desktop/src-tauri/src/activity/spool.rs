use super::{
    contract::{Event, EVENT_BYTES, SPOOL_BYTES},
    storage::{Directory, Entries},
};
use std::path::{Path, PathBuf};

pub const FILES_PER_TICK: usize = 256;
const MAX_ENTRIES: usize = 65_536;

#[derive(Default)]
pub struct Scan {
    pub events: Vec<Event>,
    pub skipped: usize,
    pub complete: bool,
    pub inspected: usize,
}

struct Sweep {
    directory: Directory,
    entries: Entries,
    events: Vec<Event>,
    skipped: usize,
    count: usize,
    bytes: u64,
}

pub struct Reader {
    root: PathBuf,
    sweep: Option<Sweep>,
}

fn event_name(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() == 58
        && b[..16].iter().all(u8::is_ascii_digit)
        && b[16] == b'-'
        && b[17..53]
            .iter()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(v) || *v == b'-')
        && &b[53..] == b".json"
}

impl Reader {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.into(),
            sweep: None,
        }
    }

    /// One tick opens at most FILES_PER_TICK entries. A sweep is sorted before
    /// application, so filesystem enumeration order cannot announce old work.
    pub fn tick(&mut self, now: i64) -> Scan {
        if self.sweep.is_none() {
            let opened = Directory::root(&self.root)
                .and_then(Directory::activity)
                .and_then(|directory| {
                    Ok(Sweep {
                        entries: directory.entries()?,
                        directory,
                        events: Vec::new(),
                        skipped: 0,
                        count: 0,
                        bytes: 0,
                    })
                });
            match opened {
                Ok(sweep) => self.sweep = Some(sweep),
                Err(e) => {
                    return Scan {
                        complete: true,
                        skipped: usize::from(e.kind() != std::io::ErrorKind::NotFound),
                        ..Default::default()
                    }
                }
            }
        }
        let sweep = self.sweep.as_mut().unwrap();
        let mut inspected = 0;
        let mut complete = false;
        for _ in 0..FILES_PER_TICK {
            let Some(entry) = sweep.entries.next() else {
                complete = true;
                break;
            };
            inspected += 1;
            sweep.count += 1;
            if sweep.count > MAX_ENTRIES {
                sweep.events.clear();
                sweep.skipped += 1;
                complete = true;
                break;
            }
            let Ok(entry) = entry else {
                sweep.skipped += 1;
                continue;
            };
            let Some(name) = entry.to_str().map(str::to_owned) else {
                sweep.skipped += 1;
                continue;
            };
            if name == ".writer" {
                if sweep.directory.metadata(&name, true).is_err() {
                    sweep.skipped += 1;
                }
                continue;
            }
            if cfg!(windows) && name == ".acl-verified" {
                if sweep.directory.read(&name, EVENT_BYTES as u64).is_err() {
                    sweep.skipped += 1;
                }
                continue;
            }
            if !event_name(&name) {
                sweep.skipped += 1;
                continue;
            }
            let mut accounted = 0;
            let result = sweep
                .directory
                .metadata(&name, false)
                .and_then(|meta| {
                    accounted = meta.len();
                    sweep.bytes = sweep.bytes.saturating_add(meta.len());
                    if sweep.bytes > SPOOL_BYTES {
                        return Err(super::storage::unsafe_path());
                    }
                    sweep.directory.read(&name, EVENT_BYTES as u64)
                })
                .ok()
                .and_then(|bytes| {
                    // Account for growth or replacement between metadata and open.
                    sweep.bytes = sweep
                        .bytes
                        .saturating_add((bytes.len() as u64).saturating_sub(accounted));
                    if sweep.bytes > SPOOL_BYTES {
                        None
                    } else {
                        Event::read(&bytes, now)
                    }
                });
            if let Some(event) = result {
                sweep.events.push(event);
            } else {
                sweep.skipped += 1;
            }
        }
        if !complete {
            return Scan {
                inspected,
                ..Default::default()
            };
        }
        let mut sweep = self.sweep.take().unwrap();
        if sweep.bytes > SPOOL_BYTES {
            sweep.events.clear();
        }
        // A long sweep may have crossed the age boundary since an early tick.
        sweep.events.retain(|event| {
            let valid = event.valid(now);
            if !valid {
                sweep.skipped += 1;
            }
            valid
        });
        sweep.events.sort_by(|a, b| {
            a.sequence
                .cmp(&b.sequence)
                .then(a.observed_at.cmp(&b.observed_at))
                .then(a.event_id.cmp(&b.event_id))
        });
        Scan {
            events: sweep.events,
            skipped: sweep.skipped,
            complete,
            inspected,
        }
    }
}
