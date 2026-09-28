//! IPC surface — the Tauri side of `window.electronAPI`.
//!
//! One command per channel of `src/main/ipc/handlers.ts` that the ported
//! modules need; the renderer reaches them through
//! `src/renderer/src/lib/tauri-bridge.ts`. Commands are synchronous on
//! purpose: Tauri runs those on the main thread, which is where the
//! Electron main process made every one of these native calls.
//!
//! Capability checks mirror `assertSenderWindow`: a command that only the
//! palette or only Settings may use rejects calls from any other window.

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::app::{settings_changed, AppState};
use crate::modules::window_switcher::window_row_id;
use crate::settings::Settings;
use crate::types::{
    AppInfo, ExecuteResult, NewWindowIgnoreRule, PaletteItem, PaletteShowPayload, PermissionFlags,
    PermissionName, SearchRequest, SearchResult, WindowIgnoreRule, WindowIgnoreScope,
};
use crate::{palette, settings_window, window_list};

type CommandResult<T> = Result<T, String>;

fn require_palette(window: &WebviewWindow, capability: &str) -> CommandResult<()> {
    if palette::is_palette_label(window.label()) {
        Ok(())
    } else {
        Err(format!("{capability} is not available from this window."))
    }
}

fn require_settings(window: &WebviewWindow, capability: &str) -> CommandResult<()> {
    if window.label() == settings_window::LABEL {
        Ok(())
    } else {
        Err(format!("{capability} is not available from this window."))
    }
}

/// Node's `process.platform` names — what the renderer compares against.
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

// ─── App ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn app_info(app: AppHandle, state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        // `tauri build` output is the packaged app; `tauri dev` is not.
        is_packaged: !cfg!(debug_assertions),
        platform: node_platform(),
        version: app.package_info().version.to_string(),
        name: state.paths.app_name.clone(),
        user_data_path: state.paths.user_data.to_string_lossy().into_owned(),
    }
}

#[tauri::command]
pub fn reveal_in_folder(path: String) {
    if path.is_empty() {
        return;
    }
    if let Err(err) = tauri_plugin_opener::reveal_item_in_dir(&path) {
        log::warn!("[reveal] {path}: {err}");
    }
}

/// Auto-update isn't ported yet (see docs/tauri-migration.md); the About
/// pane shows the same "disabled" state the Electron dev build does.
#[tauri::command]
pub fn update_status() -> Value {
    json!({ "state": "disabled", "reason": "dev-build" })
}

// ─── Modules ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn modules_list(state: State<'_, AppState>) -> Vec<Value> {
    state.registry.manifests(&state.settings.get())
}

#[tauri::command]
pub fn modules_search(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    req: SearchRequest,
) -> CommandResult<SearchResult> {
    require_palette(&window, "Module search")?;
    let settings = state.settings.get();
    let focus = &state.focus;
    Ok(state
        .registry
        .search(&app, &settings, &req, &|| focus.get()))
}

/// Searches run synchronously on the main thread, so by the time a cancel
/// arrives the search it names has already answered.
#[tauri::command]
pub fn modules_cancel_search(window: WebviewWindow, request_id: f64) -> CommandResult<()> {
    let _ = request_id;
    require_palette(&window, "Module search")
}

#[tauri::command]
pub fn modules_execute(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    item: PaletteItem,
) -> CommandResult<ExecuteResult> {
    require_palette(&window, "Module execution")?;
    let result = state.registry.execute(&app, &item);
    if result.dismiss_palette {
        palette::hide(&app, false);
    }
    Ok(result)
}

#[tauri::command]
pub fn modules_action(
    app: AppHandle,
    state: State<'_, AppState>,
    module_id: String,
    action_key: String,
) {
    state.registry.action(&app, &module_id, &action_key);
}

// ─── Settings ─────────────────────────────────────────────────────────────

fn after_change(app: &AppHandle, settings: Settings) -> Settings {
    settings_changed(app, &settings);
    settings
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Settings {
    state.settings.get()
}

#[tauri::command]
pub fn settings_set(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: Map<String, Value>,
) -> Settings {
    after_change(&app, state.settings.patch(patch))
}

#[tauri::command]
pub fn settings_set_module(
    app: AppHandle,
    state: State<'_, AppState>,
    module_id: String,
    patch: Map<String, Value>,
) -> Settings {
    after_change(&app, state.settings.patch_module(&module_id, patch))
}

#[tauri::command]
pub fn settings_set_module_config(
    app: AppHandle,
    state: State<'_, AppState>,
    module_id: String,
    config_patch: Map<String, Value>,
) -> Settings {
    after_change(
        &app,
        state.settings.patch_module_config(&module_id, config_patch),
    )
}

#[tauri::command]
pub fn settings_set_module_alias(
    app: AppHandle,
    state: State<'_, AppState>,
    module_id: String,
    item_id: String,
    alias: Option<String>,
) -> Settings {
    after_change(
        &app,
        state
            .settings
            .patch_module_alias(&module_id, &item_id, alias.as_deref()),
    )
}

#[tauri::command]
pub fn settings_set_module_elevated(
    app: AppHandle,
    state: State<'_, AppState>,
    module_id: String,
    item_id: String,
    elevated: bool,
) -> Settings {
    after_change(
        &app,
        state
            .settings
            .patch_module_elevated(&module_id, &item_id, elevated),
    )
}

// ─── Palette window ───────────────────────────────────────────────────────

#[tauri::command]
pub fn palette_hide(app: AppHandle) {
    palette::hide(&app, true);
}

#[tauri::command]
pub fn palette_open_settings(app: AppHandle) {
    // Building a window inside a synchronous command deadlocks WebView2 on
    // Windows; open it from the event loop once this command has returned.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || settings_window::open(&handle, None));
}

/// Fresh results are on screen. The Electron build revealed the window
/// (opacity 0 → 1) here; this shell shows it straight away for now.
#[tauri::command]
pub fn palette_ready() {}

/// The renderer's `palette:show` listener is live. Returns a show that
/// happened while the window was still booting, so it isn't lost.
#[tauri::command]
pub fn palette_listening(
    app: AppHandle,
    window: WebviewWindow,
) -> CommandResult<Option<PaletteShowPayload>> {
    require_palette(&window, "Palette events")?;
    Ok(palette::renderer_listening(&app))
}

#[tauri::command]
pub fn palette_start_move(app: AppHandle) {
    palette::start_move(&app);
}

#[tauri::command]
pub fn palette_move_by(app: AppHandle, dx: f64, dy: f64) {
    palette::move_by(&app, dx, dy);
}

#[tauri::command]
pub fn palette_end_move(app: AppHandle) {
    palette::end_move(&app);
}

// ─── Window Switcher ──────────────────────────────────────────────────────

/// Close the OS window behind a palette row (Ctrl/Cmd+D). `true` when the
/// close request was delivered — the app may still ask to save.
#[tauri::command]
pub fn window_switcher_close_window(item: PaletteItem) -> bool {
    let Some(id) = window_row_id(&item) else {
        return false;
    };
    let delivered = runwa_core::close_window(id).unwrap_or_else(|err| {
        log::warn!("[window-switcher] close failed: {err}");
        false
    });
    // The listing cache still holds the closing window.
    window_list::invalidate();
    delivered
}

fn broadcast_ignore_rules(app: &AppHandle, rules: &[WindowIgnoreRule]) {
    let _ = app.emit_to(
        settings_window::LABEL,
        "window-switcher:ignore-rules-changed",
        rules,
    );
}

/// Ctrl+K → "Ignore this window". The rule is derived from the row here, so
/// the palette can't author an arbitrary pattern.
#[tauri::command]
pub fn window_switcher_ignore_item(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    item: PaletteItem,
    scope: WindowIgnoreScope,
) -> CommandResult<bool> {
    require_palette(&window, "Window Switcher ignore list")?;
    if window_row_id(&item).is_none() {
        return Ok(false);
    }
    // The row renders the executable name as its subtitle.
    let process_name = item.subtitle.clone().unwrap_or_default();
    let title = match scope {
        WindowIgnoreScope::Process => String::new(),
        WindowIgnoreScope::Window => item.title.clone(),
    };
    if title.trim().is_empty() && process_name.trim().is_empty() {
        return Ok(false);
    }
    let rule = NewWindowIgnoreRule {
        title: Some(Value::String(title.clone())),
        process_name: Some(Value::String(process_name.clone())),
    };
    match state.window_ignore.add(&rule) {
        Ok(rules) => {
            broadcast_ignore_rules(&app, &rules);
            Ok(true)
        }
        // "Already in the list" is the desired end state from the palette's
        // point of view; anything else is reported as a no-op.
        Err(err) => {
            let already = state
                .window_ignore
                .contains(title.trim(), process_name.trim());
            if !already {
                log::warn!("[window-switcher] ignore failed: {err}");
            }
            Ok(already)
        }
    }
}

#[tauri::command]
pub fn window_switcher_list_ignore_rules(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CommandResult<Vec<WindowIgnoreRule>> {
    require_settings(&window, "Window Switcher ignore list")?;
    Ok(state.window_ignore.list())
}

#[tauri::command]
pub fn window_switcher_add_ignore_rule(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    rule: NewWindowIgnoreRule,
) -> CommandResult<Vec<WindowIgnoreRule>> {
    require_settings(&window, "Window Switcher ignore list")?;
    let rules = state.window_ignore.add(&rule)?;
    broadcast_ignore_rules(&app, &rules);
    Ok(rules)
}

#[tauri::command]
pub fn window_switcher_remove_ignore_rule(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    rule_id: String,
) -> CommandResult<Vec<WindowIgnoreRule>> {
    require_settings(&window, "Window Switcher ignore list")?;
    let rules = state.window_ignore.remove(&rule_id)?;
    broadcast_ignore_rules(&app, &rules);
    Ok(rules)
}

// ─── Keyboard Remap: "Disable remapping in fullscreen" ───────────────────

fn bypass_process_name(item: &PaletteItem) -> Option<String> {
    window_row_id(item)?;
    let name = item.subtitle.as_deref()?.trim();
    (!name.is_empty()).then(|| name.to_owned())
}

fn broadcast_bypass(app: &AppHandle, processes: &[String]) {
    let _ = app.emit_to(
        settings_window::LABEL,
        "keyboard-remap:fullscreen-bypass-changed",
        processes,
    );
}

#[tauri::command]
pub fn keyboard_remap_fullscreen_bypass_item_state(
    window: WebviewWindow,
    state: State<'_, AppState>,
    item: PaletteItem,
) -> CommandResult<bool> {
    require_palette(&window, "Fullscreen remap bypass")?;
    Ok(bypass_process_name(&item).is_some_and(|name| state.fullscreen_bypass.has(&name)))
}

#[tauri::command]
pub fn keyboard_remap_fullscreen_bypass_toggle_item(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    item: PaletteItem,
) -> CommandResult<Option<bool>> {
    require_palette(&window, "Fullscreen remap bypass")?;
    let Some(name) = bypass_process_name(&item) else {
        return Ok(None);
    };
    match state.fullscreen_bypass.toggle(&name) {
        Ok((processes, enabled)) => {
            broadcast_bypass(&app, &processes);
            Ok(Some(enabled))
        }
        Err(err) => {
            log::warn!("[keyboard-remap] fullscreen bypass toggle failed: {err}");
            Ok(None)
        }
    }
}

#[tauri::command]
pub fn keyboard_remap_list_fullscreen_bypass(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CommandResult<Vec<String>> {
    require_settings(&window, "Fullscreen remap bypass")?;
    Ok(state.fullscreen_bypass.list())
}

#[tauri::command]
pub fn keyboard_remap_remove_fullscreen_bypass(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    process_name: String,
) -> CommandResult<Vec<String>> {
    require_settings(&window, "Fullscreen remap bypass")?;
    let processes = state.fullscreen_bypass.remove(&process_name);
    broadcast_bypass(&app, &processes);
    Ok(processes)
}

// ─── macOS permissions ────────────────────────────────────────────────────

fn permission_status() -> Option<PermissionFlags> {
    cfg!(target_os = "macos").then(|| PermissionFlags {
        accessibility: runwa_core::is_accessibility_trusted(),
        screen_recording: runwa_core::is_screen_recording_granted(),
    })
}

/// `null` off macOS — the renderer hides the section.
#[tauri::command]
pub fn permissions_get() -> Option<PermissionFlags> {
    permission_status()
}

#[tauri::command]
pub fn permissions_request(name: PermissionName) -> Option<PermissionFlags> {
    if cfg!(target_os = "macos") {
        match name {
            PermissionName::Accessibility => {
                runwa_core::request_accessibility_permission();
            }
            PermissionName::ScreenRecording => {
                runwa_core::request_screen_recording_permission();
            }
        }
    }
    permission_status()
}

#[tauri::command]
pub fn permissions_open_system_settings(name: PermissionName) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let anchor = match name {
        PermissionName::Accessibility => "Privacy_Accessibility",
        PermissionName::ScreenRecording => "Privacy_ScreenCapture",
    };
    let url = format!("x-apple.systempreferences:com.apple.preference.security?{anchor}");
    if let Err(err) = tauri_plugin_opener::open_url(url, None::<&str>) {
        log::warn!("[permissions] opening System Settings failed: {err}");
    }
}
