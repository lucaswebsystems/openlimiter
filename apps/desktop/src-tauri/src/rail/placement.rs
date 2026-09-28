//! All inputs and outputs are physical pixels except persisted logical offsets.
use serde::{Deserialize, Serialize};

pub const SPINE: f64 = 8.0;
pub const HOVER: f64 = 12.0;
pub const TABS: f64 = 56.0;
pub const LENGTH: f64 = 320.0;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    #[default]
    Left,
    Top,
    Bottom,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub fn contains(self, x: i32, y: i32) -> bool {
        x >= self.x
            && y >= self.y
            && (x as i64) < self.x as i64 + self.width as i64
            && (y as i64) < self.y as i64 + self.height as i64
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Monitor {
    pub id: String,
    pub bounds: Rect,
    pub work: Rect,
    pub scale: f64,
    pub primary: bool,
}

pub fn select<'a>(monitors: &'a [Monitor], id: &str) -> Option<&'a Monitor> {
    monitors
        .iter()
        .find(|m| m.id == id)
        .or_else(|| monitors.iter().find(|m| m.primary))
        .or_else(|| monitors.first())
}

fn pixels(value: f64, scale: f64) -> i32 {
    (value * scale).round() as i32
}

fn fit(work: Rect, x: i32, y: i32, width: i32, height: i32) -> Rect {
    let width = width.clamp(1, work.width.max(1));
    let height = height.clamp(1, work.height.max(1));
    Rect {
        x: x.clamp(work.x, work.x.saturating_add(work.width - width)),
        y: y.clamp(work.y, work.y.saturating_add(work.height - height)),
        width,
        height,
    }
}

pub fn place(monitor: &Monitor, edge: Edge, offset: f64, unfolded: bool) -> Rect {
    let work = monitor.work;
    let thickness = pixels(if unfolded { TABS } else { SPINE + HOVER }, monitor.scale);
    let length = pixels(LENGTH, monitor.scale);
    let offset = pixels(
        if offset.is_finite() {
            offset.max(0.0)
        } else {
            0.0
        },
        monitor.scale,
    );
    match edge {
        Edge::Left => fit(
            work,
            work.x,
            work.y.saturating_add(offset),
            thickness,
            length,
        ),
        Edge::Top => fit(
            work,
            work.x.saturating_add(offset),
            work.y,
            length,
            thickness,
        ),
        Edge::Bottom => fit(
            work,
            work.x.saturating_add(offset),
            work.y
                .saturating_add(work.height - thickness.min(work.height)),
            length,
            thickness,
        ),
    }
}

pub fn card(monitor: &Monitor, edge: Edge, rail: Rect, anchor: f64) -> Rect {
    let width = pixels(320.0, monitor.scale);
    let height = pixels(240.0, monitor.scale);
    let anchor = pixels(anchor, monitor.scale);
    let (x, y) = match edge {
        Edge::Left => (rail.x + rail.width, rail.y.saturating_add(anchor)),
        Edge::Top => (rail.x.saturating_add(anchor), rail.y + rail.height),
        Edge::Bottom => (rail.x.saturating_add(anchor), rail.y - height),
    };
    fit(monitor.work, x, y, width, height)
}

pub fn covers_monitor(foreground: Option<Rect>, monitor: Rect) -> bool {
    foreground.is_some_and(|r| {
        r.width > 0
            && r.height > 0
            && r.x <= monitor.x
            && r.y <= monitor.y
            && r.x as i64 + r.width as i64 >= monitor.x as i64 + monitor.width as i64
            && r.y as i64 + r.height as i64 >= monitor.y as i64 + monitor.height as i64
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn monitor(scale: f64) -> Monitor {
        Monitor {
            id: "left".into(),
            bounds: Rect {
                x: -2560,
                y: -200,
                width: 2560,
                height: 1440,
            },
            work: Rect {
                x: -2520,
                y: -200,
                width: 2520,
                height: 1400,
            },
            scale,
            primary: true,
        }
    }
    #[test]
    fn logical_sizes_and_offsets_at_every_supported_dpi() {
        for scale in [1.0, 1.5, 2.0] {
            let m = monitor(scale);
            for unfolded in [false, true] {
                let r = place(&m, Edge::Left, 100.0, unfolded);
                assert_eq!(r.x, -2520);
                assert_eq!(r.y, -200 + (100.0 * scale) as i32);
                assert_eq!(
                    r.width,
                    ((if unfolded { 56.0 } else { 20.0 }) * scale) as i32
                );
                assert_eq!(r.height, (320.0 * scale) as i32);
            }
        }
    }
    #[test]
    fn removal_falls_back_to_primary_and_empty_topology_is_safe() {
        let primary = monitor(1.0);
        let secondary = Monitor {
            id: "right".into(),
            primary: false,
            bounds: Rect {
                x: 0,
                y: 0,
                width: 3840,
                height: 2160,
            },
            work: Rect {
                x: 0,
                y: 0,
                width: 3840,
                height: 2080,
            },
            ..monitor(2.0)
        };
        let monitors = [secondary, primary];
        assert_eq!(select(&monitors, "right").unwrap().scale, 2.0);
        let right = place(select(&monitors, "right").unwrap(), Edge::Left, 42.0, true);
        assert_eq!((right.x, right.y, right.width), (0, 84, 112));
        assert_eq!(select(&monitors, "removed").unwrap().id, "left");
        assert!(select(&[], "left").is_none());
    }
    #[test]
    fn all_edges_clamp_to_work_area_including_tiny_displays() {
        for scale in [1.0, 1.5, 2.0] {
            let mut m = monitor(scale);
            for work in [
                m.work,
                Rect {
                    x: 20,
                    y: 30,
                    width: 10,
                    height: 12,
                },
            ] {
                m.work = work;
                for edge in [Edge::Left, Edge::Top, Edge::Bottom] {
                    for offset in [-100.0, 0.0, 999999.0, f64::NAN] {
                        let r = place(&m, edge, offset, true);
                        assert!(work.contains(r.x, r.y));
                        assert!(work.contains(r.x + r.width - 1, r.y + r.height - 1));
                        let c = card(&m, edge, r, 300.0);
                        assert!(work.contains(c.x + c.width - 1, c.y + c.height - 1));
                    }
                }
            }
        }
    }
    #[test]
    fn fullscreen_uses_monitor_bounds_not_work_area() {
        let m = monitor(1.5);
        assert!(covers_monitor(Some(m.bounds), m.bounds));
        assert!(!covers_monitor(Some(m.work), m.bounds));
        assert!(!covers_monitor(None, m.bounds));
        assert!(!covers_monitor(Some(Rect { x: 0, ..m.bounds }), m.bounds));
        assert!(covers_monitor(
            Some(Rect {
                x: -2561,
                y: -201,
                width: 2562,
                height: 1442
            }),
            m.bounds
        ));
    }

    #[test]
    fn card_is_adjacent_to_tab_at_each_dpi_and_clamps_at_the_bottom() {
        for scale in [1.0, 1.5, 2.0] {
            let m = monitor(scale);
            let rail = place(&m, Edge::Left, 40.0, true);
            let detail = card(&m, Edge::Left, rail, 52.0);
            assert_eq!(detail.x, rail.x + rail.width);
            assert_eq!(detail.y, rail.y + (52.0 * scale) as i32);
            let bottom = place(&m, Edge::Left, 100000.0, true);
            let detail = card(&m, Edge::Left, bottom, 300.0);
            assert_eq!(detail.y + detail.height, m.work.y + m.work.height);
        }
    }
}
