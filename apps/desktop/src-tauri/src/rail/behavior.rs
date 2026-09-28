use std::time::{Duration, Instant};

pub const LEAVE_GRACE: Duration = Duration::from_millis(300);

#[derive(Default)]
pub struct Behavior {
    pub unfolded: bool,
    pub card_anchor: Option<f64>,
    pub keyboard: bool,
    pub suppressed: bool,
    last_inside: Option<Instant>,
}

impl Behavior {
    pub fn tick(
        &mut self,
        now: Instant,
        inside: bool,
        fullscreen: bool,
        visible: bool,
        keep: bool,
    ) {
        self.suppressed = fullscreen;
        if fullscreen || !visible {
            self.unfolded = false;
            self.card_anchor = None;
            self.keyboard = false;
            self.last_inside = None;
            return;
        }
        if inside {
            self.last_inside = Some(now);
        }
        let grace = self
            .last_inside
            .is_some_and(|last| now.saturating_duration_since(last) < LEAVE_GRACE);
        self.unfolded = keep || self.keyboard || inside || grace;
        if !self.unfolded {
            self.card_anchor = None;
        }
    }
    pub fn close_card(&mut self) {
        self.card_anchor = None;
        self.keyboard = false;
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
        b.tick(now + Duration::from_millis(600), false, false, true, false);
        assert!(!b.unfolded && b.card_anchor.is_none());
    }
    #[test]
    fn fullscreen_overrides_keep_open_but_restores_preference_afterwards() {
        let now = Instant::now();
        let mut b = Behavior::default();
        b.tick(now, true, true, true, true);
        assert!(b.suppressed && !b.unfolded);
        b.tick(now, false, false, true, true);
        assert!(!b.suppressed && b.unfolded);
        b.tick(now, true, false, false, true);
        assert!(!b.unfolded);
    }
}
