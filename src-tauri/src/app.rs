//! App assembly — the counterpart of `src/main/index.ts`.

use tauri::{AppHandle, Emitter, Manager, RunEvent};

use crate::focus::FocusContext;
use crate::hotkeys::HotkeyManager;
use crate::icons::IconCache;
use crate::modules::window_switcher::WindowSwitcher;
use crate::modules::ModuleRegistry;
use crate::palette::{self, PaletteController};
use crate::paths::Paths;
use crate::settings::{Settings, SettingsStore, SETTINGS_FILE};
use crate::stores::{FullscreenBypassStore, WindowIgnoreStore, BYPASS_FILE, IGNORE_FILE};
use crate::tray::{self, TrayController};
use crate::{commands, settings_window};

/// Everything the app holds for its lifetime. Pieces with mutable state
/// guard it internally, so the whole struct can live in Tauri's state.
pub struct AppState {
    pub paths: Paths,
    pub settings: SettingsStore,
    pub registry: ModuleRegistry,
    pub window_ignore: WindowIgnoreStore,
    pub fullscreen_bypass: FullscreenBypassStore,
    pub focus: FocusContext,
    pub icons: IconCache,
    pub palette: PaletteController,
    pub hotkeys: HotkeyManager,
    pub tray: TrayController,
}

/// Fan a settings change out to everything derived from it — hotkeys, the
/// tray, the Settings window chrome — and to the renderers, as
/// `wireSettingsBroadcast` and the store's `change` listeners did.
pub fn settings_changed(app: &AppHandle, settings: &Settings) {
    let state = app.state::<AppState>();
    state.hotkeys.refresh(app, settings);
    tray::refresh(app, settings);
    settings_window::apply_theme(app, settings.theme());
    if let Some(win) = palette::window(app) {
        let _ = win.emit_to(win.label(), "settings:changed", settings);
    }
    let _ = app.emit_to(settings_window::LABEL, "settings:changed", settings);
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // A background launcher: no Dock icon, and the Screen Recording /
    // Accessibility prompts fired on every start so TCC binds manual grants
    // to this binary (see the Electron build's startup notes).
    #[cfg(target_os = "macos")]
    {
        app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        runwa_core::request_screen_recording_permission();
        runwa_core::request_accessibility_permission();
        log::info!(
            "[main] permissions: screen_recording={} accessibility={}",
            runwa_core::is_screen_recording_granted(),
            runwa_core::is_accessibility_trusted()
        );
    }

    let handle = app.handle().clone();
    let paths = Paths::resolve(&handle);
    log::info!("[main] user data: {}", paths.user_data.display());

    let settings = SettingsStore::load(paths.file(SETTINGS_FILE));
    let window_ignore = WindowIgnoreStore::load(paths.file(IGNORE_FILE));
    let fullscreen_bypass = FullscreenBypassStore::load(paths.file(BYPASS_FILE));
    // Registration order is the settings sidebar order. Modules are added
    // here as they are ported from src/main/modules.
    let registry = ModuleRegistry::new(vec![Box::new(WindowSwitcher::new())], &settings);

    app.manage(AppState {
        paths,
        settings,
        registry,
        window_ignore,
        fullscreen_bypass,
        focus: FocusContext::default(),
        icons: IconCache::default(),
        palette: PaletteController::default(),
        hotkeys: HotkeyManager::default(),
        tray: TrayController::default(),
    });

    // Build the palette hidden up front, so the first hotkey press doesn't
    // wait on a cold renderer.
    palette::create(&handle)?;
    tray::init(&handle)?;

    let state = handle.state::<AppState>();
    state.hotkeys.refresh(&handle, &state.settings.get());
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        // Must come first: a second launch just opens Settings in the
        // running instance — the most useful recovery destination for
        // someone who couldn't find runwa in the tray.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            log::info!("[main] second launch — opening Settings");
            // Delivered on the plugin's IPC thread (D-Bus on Linux); window
            // work belongs on the main thread.
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || settings_window::open(&handle, None));
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(setup)
        .on_window_event(|window, event| {
            if palette::is_palette_label(window.label()) {
                palette::on_window_event(window, event);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::reveal_in_folder,
            commands::update_status,
            commands::modules_list,
            commands::modules_search,
            commands::modules_cancel_search,
            commands::modules_execute,
            commands::modules_action,
            commands::settings_get,
            commands::settings_set,
            commands::settings_set_module,
            commands::settings_set_module_config,
            commands::settings_set_module_alias,
            commands::settings_set_module_elevated,
            commands::palette_hide,
            commands::palette_open_settings,
            commands::palette_ready,
            commands::palette_listening,
            commands::palette_start_move,
            commands::palette_move_by,
            commands::palette_end_move,
            commands::window_switcher_close_window,
            commands::window_switcher_ignore_item,
            commands::window_switcher_list_ignore_rules,
            commands::window_switcher_add_ignore_rule,
            commands::window_switcher_remove_ignore_rule,
            commands::keyboard_remap_fullscreen_bypass_item_state,
            commands::keyboard_remap_fullscreen_bypass_toggle_item,
            commands::keyboard_remap_list_fullscreen_bypass,
            commands::keyboard_remap_remove_fullscreen_bypass,
            commands::permissions_get,
            commands::permissions_request,
            commands::permissions_open_system_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error while building runwa")
        .run(|_app, event| {
            // A background launcher keeps running when its last window
            // closes; only an explicit exit (tray → Quit) ends it.
            if let RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
            }
        });
}
