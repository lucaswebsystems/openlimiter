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
        });
    };

    let headroom = 100_u8.saturating_sub(whole_percent(worst_usage));
    Ok(View {
        pressure: pressure_of(Some(worst_usage)),
        title: format!("{headroom}% left"),
        tooltip: format!("OpenLimiter: {headroom}% headroom"),
        summary: format!("{headroom}% headroom"),
        providers,
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
    menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
    Ok(menu)
}

pub fn update<R: Runtime>(app: &AppHandle<R>, statuses: Vec<ProviderStatus>) -> Result<(), String> {
    let view = view(statuses).map_err(str::to_string)?;
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

    #[test]
    fn invalid_input_is_refused() {
        assert!(view(vec![status("OTHER", Some(10.0))]).is_err());
        assert!(view(vec![status("MANUAL", Some(10.0))]).is_err());
        assert!(view(vec![status("CODEX", Some(101.0))]).is_err());
        assert!(view(vec![status("CODEX", None), status("codex", None)]).is_err());
    }
}
