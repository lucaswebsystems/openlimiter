use std::time::{Duration, Instant};

pub const LEAVE_GRACE: Duration = Duration::from_millis(400);

#[derive(Default)]
pub struct Behavior {
    pub unfolded: bool,
    pub card_anchor: Option<f64>,
    pub keyboard: bool,
    pub suppressed: bool,
    last_inside: Option<Instant>,
    dismissed: bool,
}

impl Behavior {
    pub fn tick(
        &mut self,
        now: Instant,
        inside: bool,
        fullscreen: bool,
        visible: bool,
        _legacy_keep: bool,
    ) {
        self.suppressed = fullscreen;
        if fullscreen || !visible {
            self.unfolded = false;
            self.card_anchor = None;
            self.keyboard = false;
            self.last_inside = None;
            self.dismissed = false;
            return;
        }
        // Escape must not reopen the panel until the pointer has left it.
        if self.dismissed {
            if !inside {
                self.dismissed = false;
            }
            return;
        }
        if inside {
            self.last_inside = Some(now);
        }
        let grace = self
            .last_inside
            .is_some_and(|last| now.saturating_duration_since(last) < LEAVE_GRACE);
        self.unfolded = inside || grace;
        self.card_anchor = self.unfolded.then_some(0.0);
    }
    pub fn close_card(&mut self) {
        self.card_anchor = None;
        self.keyboard = false;
        self.unfolded = false;
        self.last_inside = None;
        self.dismissed = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pointer_can_cross_to_card_before_grace_expires() {
        let now = Instant::now();
        let mut b = Behavior::default();
        b.tick(now, true, false, true, false);
        b.card_anchor = Some(10.0);
        b.tick(now + Duration::from_millis(200), false, false, true, false);
        assert!(b.unfolded && b.card_anchor.is_some());
        b.tick(now + Duration::from_millis(250), true, false, true, false);
        b.tick(now + Duration::from_millis(649), false, false, true, false);
        assert!(b.unfolded);
        b.tick(now + Duration::from_millis(650), false, false, true, false);
        assert!(!b.unfolded && b.card_anchor.is_none());
    }
    #[test]
    fn fullscreen_and_hidden_close_panel_and_legacy_keep_is_ignored() {
        let now = Instant::now();
        let mut b = Behavior::default();
        b.tick(now, true, true, true, true);
        assert!(b.suppressed && !b.unfolded);
        b.tick(now, false, false, true, true);
        assert!(!b.suppressed && !b.unfolded);
        b.tick(now, true, false, false, true);
        assert!(!b.unfolded);
    }

    #[test]
    fn escape_requires_leave_and_reenter() {
        let now = Instant::now();
        let mut b = Behavior::default();
        b.tick(now, true, false, true, false);
        b.close_card();
        b.tick(now, true, false, true, false);
        assert!(!b.unfolded);
        b.tick(now, false, false, true, false);
        b.tick(now, true, false, true, false);
        assert!(b.unfolded && b.card_anchor.is_some());
    }

    #[test]
    fn corridor_keeps_panel_open_longer_than_grace() {
        use super::super::placement::{inside, Rect};
        let tab = Rect {
            x: -100,
            y: 700,
            width: 24,
            height: 44,
        };
        let panel = Rect {
            x: -72,
            y: 500,
            width: 360,
            height: 480,
        };
        let now = Instant::now();
        let mut b = Behavior::default();
        for (ms, x) in [(0, -90), (1000, -74), (2000, 20), (3000, -74), (4000, -90)] {
            b.tick(
                now + Duration::from_millis(ms),
                inside(tab, b.unfolded.then_some(panel), x, 710),
                false,
                true,
                false,
            );
            assert!(b.unfolded);
        }
        b.tick(now + Duration::from_millis(4400), false, false, true, false);
        assert!(!b.unfolded);
    }
}
