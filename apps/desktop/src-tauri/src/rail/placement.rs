//! All inputs and outputs are physical pixels except persisted logical offsets.
use serde::{Deserialize, Serialize};

pub const TAB_WIDTH: f64 = 24.0;
pub const LENGTH: f64 = 44.0;
pub const PANEL_WIDTH: f64 = 360.0;
/// The panel's height until it reports its own content height.
pub const PANEL_HEIGHT: f64 = 480.0;
/// The shortest panel: its header, one limit line and its footer.
pub const MIN_PANEL_HEIGHT: f64 = 160.0;
/// The tallest panel, as a share of the work area. Beyond it the panel scrolls.
pub const MAX_PANEL_SHARE: f64 = 0.9;

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

pub fn select<'a>(monitors: &'a [Monitor], _legacy_id: &str) -> Option<&'a Monitor> {
    let mut connected = monitors
        .iter()
        .filter(|m| m.work.width > 0 && m.work.height > 0 && m.scale.is_finite() && m.scale > 0.0);
    connected
        .clone()
        .find(|m| m.primary)
        .or_else(|| connected.next())
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

pub fn place(monitor: &Monitor, _edge: Edge, _offset: f64, _unfolded: bool) -> Rect {
    let work = monitor.work;
    // The top of the tab is 70% down the usable display, independent of DPI.
    fit(
        work,
        work.x,
        work.y
            .saturating_add((work.height as f64 * 0.7).round() as i32),
        pixels(TAB_WIDTH, monitor.scale),
        pixels(LENGTH, monitor.scale),
    )
}

/// The panel beside the tab, `height` logical pixels tall: the height its own
/// content asked for, never shorter than MIN_PANEL_HEIGHT and never taller
/// than MAX_PANEL_SHARE of the work area.
pub fn card(monitor: &Monitor, _edge: Edge, rail: Rect, _anchor: f64, height: f64) -> Rect {
    let gap = pixels(4.0, monitor.scale);
    let requested = if height.is_finite() {
        height.max(MIN_PANEL_HEIGHT)
    } else {
        PANEL_HEIGHT
    };
    let tallest = (monitor.work.height as f64 * MAX_PANEL_SHARE).floor() as i32;
    fit(
        monitor.work,
        rail.x + rail.width + gap,
        rail.y,
        pixels(PANEL_WIDTH, monitor.scale),
        pixels(requested, monitor.scale).min(tallest),
    )
}

/// Include the corridor even if bottom clamping shifts the panel above the tab.
pub fn inside(tab: Rect, panel: Option<Rect>, x: i32, y: i32) -> bool {
    if tab.contains(x, y) {
        return true;
    }
    panel.is_some_and(|panel| {
        let top = tab.y.max(panel.y);
        let bottom = (tab.y + tab.height).min(panel.y + panel.height);
        panel.contains(x, y)
            || Rect {
                x: tab.x + tab.width,
                y: top,
                width: (panel.x - tab.x - tab.width).max(0),
                height: (bottom - top).max(0),
            }
            .contains(x, y)
    })
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
    fn seventy_percent_position_and_logical_size_at_every_dpi() {
        for scale in [1.0, 1.5, 2.0] {
            let m = monitor(scale);
            for unfolded in [false, true] {
                let r = place(&m, Edge::Left, 100.0, unfolded);
                assert_eq!(r.x, -2520);
                assert_eq!(r.y, -200 + 980);
                assert_eq!(r.width, (24.0 * scale) as i32);
                assert_eq!(r.height, (44.0 * scale) as i32);
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
        let mut monitors = [secondary, primary];
        assert_eq!(select(&monitors, "right").unwrap().scale, 1.0);
        monitors[0].primary = true;
        monitors[1].primary = false;
        let right = place(select(&monitors, "left").unwrap(), Edge::Left, 42.0, true);
        assert_eq!((right.x, right.y, right.width), (0, 1456, 48));
        let monitors = [monitors[1].clone()];
        assert_eq!(select(&monitors, "removed").unwrap().id, "left");
        assert!(select(&[], "left").is_none());
        let invalid = Monitor {
            work: Rect::default(),
            ..monitor(1.0)
        };
        assert!(select(&[invalid], "left").is_none());
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
                        let c = card(&m, edge, r, 300.0, PANEL_HEIGHT);
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
            let detail = card(&m, Edge::Left, rail, 52.0, PANEL_HEIGHT);
            assert_eq!(detail.x, rail.x + rail.width + (4.0 * scale) as i32);
            assert!(inside(
                rail,
                Some(detail),
                rail.x + rail.width + 1,
                rail.y + 1
            ));
            assert!(!inside(rail, None, rail.x + rail.width + 1, rail.y + 1));
            assert!(!inside(rail, Some(detail), rail.x - 1, rail.y));
            let bottom = place(&m, Edge::Left, 100000.0, true);
            let detail = card(&m, Edge::Left, bottom, 300.0, PANEL_HEIGHT);
            assert_eq!(detail.y + detail.height, m.work.y + m.work.height);
        }
    }

    #[test]
    fn card_height_follows_its_content_between_the_minimum_and_ninety_percent() {
        for scale in [1.0, 1.5, 2.0] {
            let m = monitor(scale);
            let rail = place(&m, Edge::Left, 0.0, true);
            let px = |logical: f64| (logical * scale).round() as i32;
            // Content that fits: the panel is exactly as tall as it asked.
            let fits = card(&m, Edge::Left, rail, 0.0, 300.0);
            assert_eq!(fits.height, px(300.0));
            assert_eq!(fits.width, px(PANEL_WIDTH));
            // A tiny report never shrinks the panel below its header and footer.
            assert_eq!(card(&m, Edge::Left, rail, 0.0, 20.0).height, px(MIN_PANEL_HEIGHT));
            // A tall report stops at 90% of the work area and the panel scrolls.
            let tall = card(&m, Edge::Left, rail, 0.0, 99_999.0);
            assert_eq!(tall.height, (m.work.height as f64 * 0.9).floor() as i32);
            assert!(m.work.contains(tall.x, tall.y));
            assert!(m.work.contains(tall.x + tall.width - 1, tall.y + tall.height - 1));
            // No report yet, or a nonsense one, keeps the default.
            assert_eq!(card(&m, Edge::Left, rail, 0.0, f64::NAN).height, px(PANEL_HEIGHT));
        }
    }

    #[test]
    fn a_short_panel_starts_at_the_tab_and_a_long_one_rises_to_stay_on_screen() {
        let m = monitor(1.0);
        let rail = place(&m, Edge::Left, 0.0, true);
        let short = card(&m, Edge::Left, rail, 0.0, 200.0);
        assert_eq!(short.y, rail.y);
        let long = card(&m, Edge::Left, rail, 0.0, 900.0);
        assert!(long.y < rail.y);
        assert_eq!(long.y + long.height, m.work.y + m.work.height);
        // The pointer path from the tab to either panel still counts as inside.
        for panel in [short, long] {
            assert!(inside(rail, Some(panel), rail.x + rail.width + 1, rail.y + 1));
        }
    }
}
