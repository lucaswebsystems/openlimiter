use std::time::{Duration, Instant};

pub const LEAVE_GRACE: Duration = Duration::from_millis(400);

/// What holds the panel open: a block being dragged, or a block's reorder menu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hold {
    Drag,
    Menu,
}

#[derive(Default)]
pub struct Behavior {
    pub unfolded: bool,
    pub card_anchor: Option<f64>,
    pub keyboard: bool,
    pub suppressed: bool,
    last_inside: Option<Instant>,
    dismissed: bool,
    /// The panel holds itself open while a block is dragged or its reorder
    /// menu is open, so the pointer may leave it without closing it.
    held: Option<Hold>,
}

impl Behavior {
    pub fn tick(
        &mut self,
        now: Instant,
        inside: bool,
        fullscreen: bool,
        visible: bool,
        _legacy_keep: bool,
    ) -> bool {
        self.suppressed = fullscreen;
        if fullscreen || !visible {
            self.unfolded = false;
            self.card_anchor = None;
            self.keyboard = false;
            self.last_inside = None;
            self.dismissed = false;
            self.held = None;
            return false;
        }
        // Escape must not reopen the panel until the pointer has left it.
        if self.dismissed {
            if !inside {
                self.dismissed = false;
            }
            return false;
        }
        if inside {
            self.last_inside = Some(now);
        }
        let grace = self
            .last_inside
            .is_some_and(|last| now.saturating_duration_since(last) < LEAVE_GRACE);
        self.unfolded = inside || grace || (self.held.is_some() && self.card_anchor.is_some());
        self.card_anchor = self.unfolded.then_some(0.0);
        if !self.unfolded {
            self.held = None;
        }
        false
    }
    pub fn close_card(&mut self) {
        self.card_anchor = None;
        self.keyboard = false;
        self.unfolded = false;
        self.last_inside = None;
        self.dismissed = true;
        self.held = None;
    }
    /// Hold an open panel open, or let it go. A closed panel is never held,
    /// and a released one keeps the usual grace from the moment it is let go.
    pub fn hold(&mut self, hold: Option<Hold>, now: Instant) {
        let open = self.card_anchor.is_some();
        if self.held.is_some() && hold.is_none() && open {
            self.last_inside = Some(now);
        }
        self.held = if open { hold } else { None };
    }
    /// Escape. While held it ends the interaction instead (true: tell the
    /// panel), so only a second Escape closes the panel.
    pub fn escape(&mut self, now: Instant) -> bool {
        if self.held.is_some() {
            self.hold(None, now);
            return true;
        }
        self.close_card();
        false
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

    /// A drag or the reorder menu holds the panel open while the pointer is
    /// away; once released it lingers for the usual grace, then closes.
    #[test]
    fn a_held_panel_stays_open_away_from_the_pointer_and_lingers_after_release() {
        let now = Instant::now();
        let at = |ms| now + Duration::from_millis(ms);
        let mut b = Behavior::default();
        b.tick(now, true, false, true, false);
        b.hold(Some(Hold::Drag), at(100));
        for ms in [500, 2_000, 30_000] {
            b.tick(at(ms), false, false, true, false);
            assert!(b.unfolded && b.card_anchor.is_some(), "closed while held at {ms}");
        }
        b.hold(None, at(30_000));
        b.tick(at(30_399), false, false, true, false);
        assert!(b.unfolded, "a released panel keeps the usual grace");
        b.tick(at(30_400), false, false, true, false);
        assert!(!b.unfolded && b.card_anchor.is_none());
    }

    #[test]
    fn a_hold_never_opens_a_closed_panel() {
        let now = Instant::now();
        let mut b = Behavior::default();
        b.hold(Some(Hold::Drag), now);
        b.tick(now, false, false, true, false);
        assert!(!b.unfolded && b.card_anchor.is_none());
        // Opening it later starts without a hold.
        b.tick(now, true, false, true, false);
        b.tick(now + Duration::from_millis(500), false, false, true, false);
        assert!(!b.unfolded);
    }

    /// The panel hiding (fullscreen, the tab switched off) or closing ends a hold.
    #[test]
    fn hiding_or_closing_the_panel_releases_the_hold() {
        let now = Instant::now();
        let later = now + Duration::from_millis(5_000);
        for end in 0..3 {
            let mut b = Behavior::default();
            b.tick(now, true, false, true, false);
            b.hold(Some(Hold::Drag), now);
            match end {
                0 => _ = b.tick(now, false, true, true, false),
                1 => _ = b.tick(now, false, false, false, false),
                _ => b.close_card(),
            }
            b.tick(later, true, false, true, false);
            b.tick(later + Duration::from_millis(500), false, false, true, false);
            assert!(!b.unfolded, "a hold survived end {end}");
        }
    }

    /// Escape while held ends the drag or closes the menu and keeps the panel;
    /// only the second Escape closes it.
    #[test]
    fn escape_while_held_goes_to_the_panel_first() {
        let now = Instant::now();
        let mut b = Behavior::default();
        b.tick(now, true, false, true, false);
        b.hold(Some(Hold::Drag), now);
        assert!(b.escape(now), "the first Escape belongs to the panel");
        assert!(b.card_anchor.is_some(), "and leaves it open");
        assert!(!b.escape(now), "the second Escape closes it");
        assert!(b.card_anchor.is_none());
        b.tick(now, true, false, true, false);
        assert!(!b.unfolded, "and it stays closed until the pointer leaves");
    }

    /// A menu left open with the pointer away (a click in another app the
    /// panel cannot see) lets go after its grace: the panel is told to close
    /// the menu, and the usual leave grace then closes the panel.
    #[test]
    fn a_menu_left_open_with_the_pointer_away_lets_go_and_the_panel_then_closes() {
        let now = Instant::now();
        let at = |ms| now + Duration::from_millis(ms);
        let mut b = Behavior::default();
        b.tick(now, true, false, true, false);
        b.hold(Some(Hold::Menu), now);
        assert!(!b.tick(at(100), false, false, true, false), "the pointer leaves");
        assert!(!b.tick(at(1_000), false, false, true, false));
        assert!(!b.tick(at(1_200), true, false, true, false), "and comes back");
        assert!(!b.tick(at(1_300), false, false, true, false), "away again, from here");
        assert!(!b.tick(at(2_799), false, false, true, false));
        assert!(b.unfolded, "still held");
        assert!(b.tick(at(2_800), false, false, true, false), "away for its grace: the menu lets go");
        assert!(!b.tick(at(2_900), false, false, true, false), "once");
        assert!(b.unfolded, "the panel keeps the usual leave grace");
        b.tick(at(3_200), false, false, true, false);
        assert!(!b.unfolded && b.card_anchor.is_none(), "then closes");
    }

    /// A drag holds as long as it lasts, wherever the pointer goes.
    #[test]
    fn a_drag_never_lets_go_while_the_pointer_is_away() {
        let now = Instant::now();
        let mut b = Behavior::default();
        b.tick(now, true, false, true, false);
        b.hold(Some(Hold::Drag), now);
        for ms in [100, 1_600, 30_000] {
            assert!(!b.tick(now + Duration::from_millis(ms), false, false, true, false));
            assert!(b.unfolded, "a drag let go at {ms}");
        }
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
