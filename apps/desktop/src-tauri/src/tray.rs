use std::collections::HashSet;

use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Runtime};

pub const ID: &str = "openlimiter-tray";

const PROVIDER_LIMIT: usize = 8;

const ICON_UNKNOWN: &[u8] = include_bytes!("../icons/tray-unknown-32.png");
const ICON_OK: &[u8] = include_bytes!("../icons/tray-ok-32.png");
const ICON_WATCH: &[u8] = include_bytes!("../icons/tray-watch-32.png");
const ICON_HIGH: &[u8] = include_bytes!("../icons/tray-high-32.png");
const ICON_CRITICAL: &[u8] = include_bytes!("../icons/tray-critical-32.png");

/// One configured provider and its worst window reading, delivered by the webview.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ProviderStatus {
    pub provider: String,
    pub usage_percent: Option<f64>,
}

/// Where the trial entry sends somebody, and where the phone entry does.
///
/// Both open the hub in the browser rather than a window here, because both
/// end in a place only the hub can be: a trial is granted by the service, and
/// a phone is paired by a page the phone itself can open.
pub const TRIAL_URL: &str = "https://openlimiter.com/app?trial=1";
pub const PAIR_URL: &str = "https://openlimiter.com/app/pair";

/// The trial entry, offered only while no entitlement is active.
///
/// It disappears the moment there is something to lose by showing it. A menu
/// that keeps offering a trial to somebody already paying is a menu that reads
/// as an advertisement rather than as a control.
const TRIAL_LABEL: &str = "Start Pro free for 30 days (No credit card needed)";

/// The phone entry, always present, because pairing is what a person reaches
/// for when they are away from this machine and the tray is the fastest way in.
const PHONE_LABEL: &str = "Open on your phone";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pressure {
    Unknown,
    Ok,
    Watch,
    High,
    Critical,
}

#[derive(Clone, Debug, PartialEq)]
struct ProviderLine {
    code: &'static str,
    name: &'static str,
    usage_percent: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct View {
    pressure: Pressure,
    title: String,
    tooltip: String,
    summary: String,
    providers: Vec<ProviderLine>,
    /// Whether the trial entry belongs in this menu.
    trial_offered: bool,
}

fn provider(code: &str) -> Option<(&'static str, &'static str)> {
    match code.to_ascii_uppercase().as_str() {
        "CLAUDE" => Some(("CLAUDE", "Claude")),
        "OPENROUTER" => Some(("OPENROUTER", "OpenRouter")),
        "CODEX" => Some(("CODEX", "Codex")),
        "ANTIGRAVITY" => Some(("ANTIGRAVITY", "Antigravity")),
        "GEMINI_CLI" => Some(("GEMINI_CLI", "Gemini CLI")),
        "OPENCODE" => Some(("OPENCODE", "OpenCode")),
        "GROK" => Some(("GROK", "Grok")),
        "KIMI" => Some(("KIMI", "Kimi")),
        _ => None,
    }
}

fn pressure_of(percent: Option<f64>) -> Pressure {
    match percent {
        None => Pressure::Unknown,
        Some(value) if value >= 90.0 => Pressure::Critical,
        Some(value) if value >= 80.0 => Pressure::High,
        Some(value) if value >= 60.0 => Pressure::Watch,
        Some(_) => Pressure::Ok,
    }
}

fn whole_percent(value: f64) -> u8 {
    value.floor() as u8
}

fn reading(value: Option<f64>) -> String {
    value
        .map(|percent| format!("{}%", whole_percent(percent)))
        .unwrap_or_else(|| "\u{2014}".to_string())
}

pub fn view(statuses: Vec<ProviderStatus>) -> Result<View, &'static str> {
    view_with_trial(statuses, true)
}

/// The view, told whether the trial entry belongs in it.
///
/// The entitlement is not something this module can read, so it is passed in
/// rather than guessed at. Offering a trial to somebody already paying for one
/// is the kind of small dishonesty that costs more trust than the click is
/// worth, so the default is only used where the entitlement is genuinely not
/// known yet, which is the first paint before any reading has arrived.
pub fn view_with_trial(
    statuses: Vec<ProviderStatus>,
    trial_offered: bool,
) -> Result<View, &'static str> {
    if statuses.len() > PROVIDER_LIMIT {
        return Err("the tray provider list is over its bound");
    }

    let mut seen = HashSet::with_capacity(statuses.len());
    let mut providers = Vec::with_capacity(statuses.len());
    for status in statuses {
        let Some((code, name)) = provider(&status.provider) else {
            return Err("the tray provider id is not recognized");
        };
        if !seen.insert(code) {
            return Err("the tray provider list contains a duplicate");
        }
        if let Some(value) = status.usage_percent {
            if !value.is_finite() || !(0.0..=100.0).contains(&value) {
                return Err("the tray percentage is outside its bound");
            }
        }
        providers.push(ProviderLine {
            code,
            name,
            usage_percent: status.usage_percent,
        });
    }

    providers.sort_by_key(|entry| match entry.code {
        "CLAUDE" => 0,
        "OPENROUTER" => 1,
        "CODEX" => 2,
        "ANTIGRAVITY" => 3,
        "GEMINI_CLI" => 4,
        "OPENCODE" => 5,
        "GROK" => 6,
        "KIMI" => 7,
        _ => usize::MAX,
    });

    let worst = providers
        .iter()
        .filter_map(|entry| entry.usage_percent)
        .max_by(f64::total_cmp);

    let Some(worst_usage) = worst else {
        return Ok(View {
            pressure: Pressure::Unknown,
            title: "OpenLimiter".to_string(),
            tooltip: "OpenLimiter: \u{2014} headroom".to_string(),
            summary: "\u{2014} headroom".to_string(),
            providers,
            trial_offered,
        });
    };

    let headroom = 100_u8.saturating_sub(whole_percent(worst_usage));
    Ok(View {
        pressure: pressure_of(Some(worst_usage)),
        title: format!("{headroom}% left"),
        tooltip: format!("OpenLimiter: {headroom}% headroom"),
        summary: format!("{headroom}% headroom"),
        providers,
        trial_offered,
    })
}

pub fn icon(view: &View) -> tauri::Result<Image<'static>> {
    let bytes = match view.pressure {
        Pressure::Unknown => ICON_UNKNOWN,
        Pressure::Ok => ICON_OK,
        Pressure::Watch => ICON_WATCH,
        Pressure::High => ICON_HIGH,
        Pressure::Critical => ICON_CRITICAL,
    };
    Image::from_bytes(bytes)
}

pub fn menu<R: Runtime>(app: &AppHandle<R>, view: &View) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(
        app,
        "summary",
        &view.summary,
        false,
        None::<&str>,
    )?)?;

    for entry in &view.providers {
        let id = format!("provider:{}", entry.code.to_ascii_lowercase());
        let text = format!("{}  {}", entry.name, reading(entry.usage_percent));
        menu.append(&MenuItem::with_id(app, id, text, false, None::<&str>)?)?;
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "open", "Open", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "refresh",
        "Refresh",
        true,
        None::<&str>,
    )?)?;
    /* The two entries that lead somewhere this window cannot go. Both open the
    hub in the browser: a trial is granted by the service, and a phone is
    paired by a page the phone itself opens. */
    if view.trial_offered {
        menu.append(&MenuItem::with_id(
            app,
            "trial",
            TRIAL_LABEL,
            true,
            None::<&str>,
        )?)?;
    }
    menu.append(&MenuItem::with_id(
        app,
        "phone",
        PHONE_LABEL,
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
    Ok(menu)
}

pub fn update<R: Runtime>(
    app: &AppHandle<R>,
    statuses: Vec<ProviderStatus>,
    trial_offered: bool,
) -> Result<(), String> {
    let view = view_with_trial(statuses, trial_offered).map_err(str::to_string)?;
    let tray = app
        .tray_by_id(ID)
        .ok_or_else(|| "the tray is not available".to_string())?;
    let icon = icon(&view).map_err(|_| "the tray icon could not be decoded".to_string())?;
    let menu = menu(app, &view).map_err(|_| "the tray menu could not be built".to_string())?;
    tray.set_icon_with_as_template(Some(icon), false)
        .map_err(|_| "the tray icon could not be updated".to_string())?;
    #[cfg(not(target_os = "linux"))]
    tray.set_tooltip(Some(&view.tooltip))
        .map_err(|_| "the tray tooltip could not be updated".to_string())?;
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    tray.set_title(Some(&view.title))
        .map_err(|_| "the tray title could not be updated".to_string())?;
    tray.set_menu(Some(menu))
        .map_err(|_| "the tray menu could not be updated".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(provider: &str, usage_percent: Option<f64>) -> ProviderStatus {
        ProviderStatus {
            provider: provider.to_string(),
            usage_percent,
        }
    }

    #[test]
    fn worst_provider_drives_headroom_and_pressure() {
        let rendered = view(vec![
            status("CODEX", Some(42.9)),
            status("CLAUDE", Some(91.7)),
        ])
        .expect("valid view");
        assert_eq!(rendered.pressure, Pressure::Critical);
        assert_eq!(rendered.title, "9% left");
        assert_eq!(rendered.tooltip, "OpenLimiter: 9% headroom");
        assert_eq!(rendered.summary, "9% headroom");
    }

    #[test]
    fn provider_rows_are_text_only_and_missing_readings_use_a_dash() {
        let rendered =
            view(vec![status("codex", None), status("claude", Some(12.4))]).expect("valid view");
        assert_eq!(rendered.providers[0].code, "CLAUDE");
        assert_eq!(rendered.providers[1].code, "CODEX");
        assert_eq!(reading(rendered.providers[0].usage_percent), "12%");
        assert_eq!(reading(rendered.providers[1].usage_percent), "\u{2014}");
    }

    #[test]
    fn every_supported_provider_reaches_the_tray() {
        let rendered = view(vec![
            status("CLAUDE", None),
            status("OPENROUTER", None),
            status("CODEX", None),
            status("ANTIGRAVITY", None),
            status("GEMINI_CLI", None),
            status("OPENCODE", None),
            status("GROK", None),
            status("KIMI", None),
        ])
        .expect("every provider is valid");
        assert_eq!(rendered.providers.len(), PROVIDER_LIMIT);
        assert_eq!(rendered.providers[6].name, "Grok");
        assert_eq!(rendered.providers[7].name, "Kimi");
    }

    #[test]
    fn no_reading_stays_unknown() {
        let rendered = view(vec![status("CLAUDE", None)]).expect("valid view");
        assert_eq!(rendered.pressure, Pressure::Unknown);
        assert_eq!(rendered.title, "OpenLimiter");
        assert_eq!(rendered.tooltip, "OpenLimiter: \u{2014} headroom");
        assert_eq!(rendered.summary, "\u{2014} headroom");
    }

    /// The trial entry is offered only while there is nothing to lose by it.
    ///
    /// A menu that keeps offering a trial to somebody already paying reads as
    /// an advertisement rather than as a control, so the entitlement decides
    /// and this module never guesses.
    #[test]
    fn the_trial_entry_disappears_once_an_entitlement_is_active() {
        let offered = view_with_trial(vec![status("CODEX", Some(10.0))], true).expect("a view");
        assert!(offered.trial_offered);
        let entitled = view_with_trial(vec![status("CODEX", Some(10.0))], false).expect("a view");
        assert!(!entitled.trial_offered);
        /* The phone entry is not conditional: pairing is what somebody reaches
        for when they are away from this machine, entitled or not. */
        assert_eq!(PHONE_LABEL, "Open on your phone");
    }

    /// Both entries lead to the hub, and both addresses are constants here.
    #[test]
    fn the_menu_destinations_are_the_hub_and_carry_no_dashes_in_their_labels() {
        assert_eq!(
            TRIAL_LABEL,
            "Start Pro free for 30 days (No credit card needed)"
        );
        assert_eq!(TRIAL_URL, "https://openlimiter.com/app?trial=1");
        assert_eq!(PAIR_URL, "https://openlimiter.com/app/pair");
        for label in [TRIAL_LABEL, PHONE_LABEL] {
            assert!(!label.contains('-'), "{label} carries a dash");
            assert!(!label.contains('\u{2013}'));
            assert!(!label.contains('\u{2014}'));
        }
    }

    #[test]
    fn invalid_input_is_refused() {
        assert!(view(vec![status("OTHER", Some(10.0))]).is_err());
        assert!(view(vec![status("MANUAL", Some(10.0))]).is_err());
        assert!(view(vec![status("CODEX", Some(101.0))]).is_err());
        assert!(view(vec![status("CODEX", None), status("codex", None)]).is_err());
    }
}
