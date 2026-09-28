//! The Settings window — port of `src/main/settings-window.ts`.
//!
//! Created on demand, destroyed on close. The initial tab rides in the URL
//! hash so the first render already shows it; later deep links to an open
//! window (tray "About", "Check for updates") go over `settings:open-tab`.
//!
//! Chrome differs from the Electron build for now: native decorations on
//! Windows and Linux (Electron drew a custom title bar with
//! `titleBarOverlay`), an overlay title bar on macOS.

use tauri::{AppHandle, Emitter, Manager, Theme, WebviewUrl, WebviewWindowBuilder};

use crate::app::AppState;

pub const LABEL: &str = "settings";

/// `encodeURIComponent` for the tab id (`module:window-switcher`).
fn encode_component(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn window_theme(theme: &str) -> Option<Theme> {
    match theme {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    }
}

/// Show Settings, creating the window if needed. Must not run inside a
/// synchronous command: building a window there deadlocks WebView2 on
/// Windows — post it with `run_on_main_thread` instead.
pub fn open(app: &AppHandle, tab: Option<&str>) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        if let Some(tab) = tab {
            let _ = app.emit_to(LABEL, "settings:open-tab", tab);
        }
        return;
    }

    let state = app.state::<AppState>();
    let settings = state.settings.get();
    let hash = match tab {
        Some(tab) => format!("settings?tab={}", encode_component(tab)),
        None => "settings".to_owned(),
    };

    let builder = WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App(format!("index.html#{hash}").into()),
    )
    .title(format!("{} — Settings", state.paths.app_name))
    .inner_size(960.0, 640.0)
    .min_inner_size(720.0, 480.0)
    .center()
    .theme(window_theme(settings.theme()));

    // macOS: content under a transparent title bar with the traffic lights
    // inset, the Electron `titleBarStyle: 'hiddenInset'` look.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    log::info!("[settings-window] opening #{hash}");
    match builder.build() {
        Ok(win) => {
            let _ = win.set_focus();
        }
        Err(err) => log::error!("[settings-window] cannot open: {err}"),
    }
}

/// Keep the native chrome in step with the theme setting.
pub fn apply_theme(app: &AppHandle, theme: &str) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.set_theme(window_theme(theme));
    }
}

#[cfg(test)]
mod tests {
    use super::encode_component;

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(encode_component("about"), "about");
        assert_eq!(
            encode_component("module:window-switcher"),
            "module%3Awindow-switcher"
        );
        assert_eq!(encode_component("a b/é"), "a%20b%2F%C3%A9");
    }
}
