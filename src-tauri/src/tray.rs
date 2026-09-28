//! System tray — port of `src/main/tray.ts`.
//!
//! The icon shows the current virtual desktop number (1–10, `+` above) when
//! the Keyboard Remap module's "show desktop number" option is on. Updates
//! are pushed, never polled: `runwa-core`'s keyboard hook reports every
//! workspace switch it performs, and the startup number is read once.

use parking_lot::Mutex;
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager};

use crate::app::AppState;
use crate::settings::Settings;
use crate::settings_window;

const TRAY_ID: &str = "runwa";

/// `showDesktopNumberInTray` lives in the Keyboard Remap module's config.
const SHOW_NUMBER_MODULE: &str = "keyboard-remap";
const SHOW_NUMBER_KEY: &str = "showDesktopNumberInTray";
const SHOW_NUMBER_DEFAULT: bool = true;

/// One 44×44 PNG per desktop, then `+` for 11 and up.
const DESKTOP_ICONS: [&[u8]; 11] = [
    include_bytes!("../../resources/tray-icons/black-on-white/1.png"),
    include_bytes!("../../resources/tray-icons/black-on-white/2.png"),
    include_bytes!("../../resources/tray-icons/black-on-white/3.png"),
    include_bytes!("../../resources/tray-icons/black-on-white/4.png"),
    include_bytes!("../../resources/tray-icons/black-on-white/5.png"),
    include_bytes!("../../resources/tray-icons/black-on-white/6.png"),
    include_bytes!("../../resources/tray-icons/black-on-white/7.png"),
    include_bytes!("../../resources/tray-icons/black-on-white/8.png"),
    include_bytes!("../../resources/tray-icons/black-on-white/9.png"),
    include_bytes!("../../resources/tray-icons/black-on-white/10.png"),
    include_bytes!("../../resources/tray-icons/black-on-white/+.png"),
];

#[derive(Default)]
struct State {
    desktop: u32,
    show_number: bool,
}

#[derive(Default)]
pub struct TrayController {
    state: Mutex<State>,
}

fn read_show_number(settings: &Settings) -> bool {
    settings
        .module_config(SHOW_NUMBER_MODULE)
        .get(SHOW_NUMBER_KEY)
        .and_then(|v| v.as_bool())
        .unwrap_or(SHOW_NUMBER_DEFAULT)
}

fn icon_for(app: &AppHandle, desktop: u32, show_number: bool) -> Option<Image<'static>> {
    if show_number {
        let index = (desktop as usize).min(DESKTOP_ICONS.len() - 1);
        match Image::from_bytes(DESKTOP_ICONS[index]) {
            Ok(image) => return Some(image),
            Err(err) => log::warn!("[tray] desktop icon {} unreadable: {err}", index + 1),
        }
    }
    app.default_window_icon()
        .map(|icon| icon.clone().to_owned())
}

fn tooltip_for(app_name: &str, desktop: u32, show_number: bool) -> String {
    if show_number && cfg!(target_os = "windows") {
        format!("{app_name} — desktop {}", desktop + 1)
    } else {
        app_name.to_owned()
    }
}

pub fn init(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let state = app.state::<AppState>();
    // Native addon hiccup → desktop 1 rather than no tray at all.
    let desktop = runwa_core::get_current_desktop_number().unwrap_or(0);
    let show_number = read_show_number(&state.settings.get());
    {
        let mut tray = state.tray.state.lock();
        tray.desktop = desktop;
        tray.show_number = show_number;
    }

    let version = app.package_info().version.to_string();
    let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let updates_item = MenuItem::with_id(
        app,
        "check-updates",
        "Check for updates",
        true,
        None::<&str>,
    )?;
    let about_item = MenuItem::with_id(
        app,
        "about",
        format!("About {} {version}", state.paths.app_name),
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &settings_item,
            &PredefinedMenuItem::separator(app)?,
            &updates_item,
            &about_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tooltip_for(&state.paths.app_name, desktop, show_number))
        .menu(&menu)
        // Windows and Linux open the menu on right click, like Electron's
        // context menu; a macOS status item opens it on any click.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(on_menu_event);
    if let Some(icon) = icon_for(app, desktop, show_number) {
        builder = builder.icon(icon);
    }
    let tray = builder.build(app)?;

    // Desktop switches come from the keyboard hook thread: hand them to the
    // main thread, where tray icons may be touched, and return at once.
    let handle = app.clone();
    runwa_core::set_desktop_change_callback(move |desktop| {
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || set_desktop(&app, desktop));
    });

    Ok(tray)
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "settings" => settings_window::open(app, None),
        // The About tab shows live update status; the check itself isn't
        // ported yet, so this lands on the same pane either way.
        "check-updates" | "about" => settings_window::open(app, Some("about")),
        "quit" => app.exit(0),
        _ => {}
    }
}

fn set_desktop(app: &AppHandle, desktop: u32) {
    let state = app.state::<AppState>();
    {
        let mut tray = state.tray.state.lock();
        if tray.desktop == desktop {
            return;
        }
        tray.desktop = desktop;
    }
    apply(app);
}

/// Re-read the "show desktop number" toggle after a settings change.
pub fn refresh(app: &AppHandle, settings: &Settings) {
    let state = app.state::<AppState>();
    let next = read_show_number(settings);
    {
        let mut tray = state.tray.state.lock();
        if tray.show_number == next {
            return;
        }
        tray.show_number = next;
    }
    apply(app);
}

fn apply(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let state = app.state::<AppState>();
    let (desktop, show_number) = {
        let tray = state.tray.state.lock();
        (tray.desktop, tray.show_number)
    };
    let _ = tray.set_icon(icon_for(app, desktop, show_number));
    let _ = tray.set_tooltip(Some(tooltip_for(
        &state.paths.app_name,
        desktop,
        show_number,
    )));
}
