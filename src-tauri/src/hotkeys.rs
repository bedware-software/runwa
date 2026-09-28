//! Global hotkeys — the press-only half of `src/main/hotkey-manager.ts`.
//!
//! Every enabled, ported module with a direct-launch hotkey gets one global
//! shortcut; the whole set is re-registered on every settings change.
//! Accelerators stay in Electron's format in settings (that's what the
//! renderer's hotkey recorder produces and what the Electron build reads),
//! and are translated for `tauri-plugin-global-shortcut` here.
//!
//! Not ported yet: key-up delivery for push-to-talk (uiohook-napi in the
//! Electron build), which arrives with the Groq transcription module.

use parking_lot::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::app::AppState;
use crate::palette;
use crate::settings::Settings;

const MODIFIER_TOKENS: &[&str] = &[
    "ctrl",
    "control",
    "cmdorctrl",
    "commandorcontrol",
    "alt",
    "option",
    "shift",
    "super",
    "meta",
    "cmd",
    "command",
    "win",
];

/// Two or more modifiers and nothing else (`Ctrl+Super`). Such chords used
/// to be allowed for push-to-talk but fired on any synthetic chord sharing
/// the prefix; they are rejected with a migration hint.
fn looks_modifier_only(accelerator: &str) -> bool {
    let parts: Vec<String> = accelerator
        .split('+')
        .map(|p| p.trim().to_lowercase())
        .filter(|p| !p.is_empty())
        .collect();
    parts.len() >= 2 && parts.iter().all(|p| MODIFIER_TOKENS.contains(&p.as_str()))
}

/// Electron accelerator → the key names `global-hotkey` parses (W3C `code`
/// names such as `KeyW`, `Digit1`, `Backquote`).
fn translate_token(token: &str) -> Option<String> {
    let lower = token.to_lowercase();
    let mapped = match lower.as_str() {
        "ctrl" | "control" => "Control",
        "alt" | "option" => "Alt",
        "shift" => "Shift",
        "super" | "meta" | "cmd" | "command" | "win" => "Super",
        "cmdorctrl" | "commandorcontrol" | "commandorctrl" | "cmdorcontrol" => "CommandOrControl",
        "return" | "enter" => "Enter",
        "esc" | "escape" => "Escape",
        // Electron's `Plus` is the `=+` key (VK_OEM_PLUS), not Shift+=.
        "plus" | "=" => "Equal",
        "space" => "Space",
        "up" => "ArrowUp",
        "down" => "ArrowDown",
        "left" => "ArrowLeft",
        "right" => "ArrowRight",
        "," => "Comma",
        "." => "Period",
        "/" => "Slash",
        ";" => "Semicolon",
        "'" => "Quote",
        "[" => "BracketLeft",
        "]" => "BracketRight",
        "\\" => "Backslash",
        "`" => "Backquote",
        "-" => "Minus",
        _ => {
            let mut chars = token.chars();
            return match (chars.next(), chars.next()) {
                (Some(c), None) if c.is_ascii_alphabetic() => {
                    Some(format!("Key{}", c.to_ascii_uppercase()))
                }
                (Some(c), None) if c.is_ascii_digit() => Some(format!("Digit{c}")),
                (Some(_), None) => None,
                (None, _) => None,
                // F1–F24, Tab, Backspace, Delete, Home, End, PageUp, PageDown,
                // Insert, Pause, ScrollLock, PrintScreen, NumLock, CapsLock
                // share their names between the two vocabularies.
                _ => Some(token.to_owned()),
            };
        }
    };
    Some(mapped.to_owned())
}

pub fn parse_accelerator(accelerator: &str) -> Option<Shortcut> {
    let tokens: Option<Vec<String>> = accelerator
        .split('+')
        .map(str::trim)
        .map(|t| {
            if t.is_empty() {
                None
            } else {
                translate_token(t)
            }
        })
        .collect();
    tokens?.join("+").parse::<Shortcut>().ok()
}

#[derive(Default)]
pub struct HotkeyManager {
    registered: Mutex<Vec<Shortcut>>,
}

impl HotkeyManager {
    /// Re-register every module hotkey from `settings`. Failures are logged,
    /// never fatal: bad accelerators and chords owned by another app are
    /// common, and the user fixes them in Settings.
    pub fn refresh(&self, app: &AppHandle, settings: &Settings) {
        let shortcuts = app.global_shortcut();
        let mut registered = self.registered.lock();
        for shortcut in registered.drain(..) {
            let _ = shortcuts.unregister(shortcut);
        }

        let state = app.state::<AppState>();
        for module in state.registry.iter() {
            let manifest = module.manifest();
            if !settings.module_enabled(&manifest.id, manifest.default_enabled) {
                continue;
            }
            let Some(accelerator) = settings.module_hotkey(&manifest.id) else {
                continue;
            };
            let label = format!("module:{}", manifest.id);
            if looks_modifier_only(&accelerator) {
                log::warn!(
                    "[hotkey] {label}: modifier-only hotkey \"{accelerator}\" is no longer supported — too easy to trigger by accident. Rebind to a chord that includes a regular key (e.g. Ctrl+Alt+Super+D) or a function key (F13–F19) in Settings."
                );
                continue;
            }
            let Some(shortcut) = parse_accelerator(&accelerator) else {
                log::warn!("[hotkey] {label}: cannot parse \"{accelerator}\"");
                continue;
            };

            let module_id = manifest.id.clone();
            let second_press = manifest.direct_launch_second_press.unwrap_or_default();
            let result = shortcuts.on_shortcut(shortcut, move |app, _shortcut, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                // Window work belongs on the main thread; post it there even
                // on platforms that already deliver hotkeys on it.
                let handle = app.clone();
                let module_id = module_id.clone();
                let _ = app
                    .run_on_main_thread(move || palette::toggle(&handle, &module_id, second_press));
            });
            match result {
                Ok(()) => {
                    log::info!("[hotkey] {label}: registered {accelerator}");
                    registered.push(shortcut);
                }
                Err(err) => log::warn!(
                    "[hotkey] {label}: registering \"{accelerator}\" failed — another app (the Electron build of runwa, if it's running) may own this chord: {err}"
                ),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_global_shortcut::{Code, Modifiers};

    #[test]
    fn detects_modifier_only_chords() {
        assert!(looks_modifier_only("Ctrl+Super"));
        assert!(looks_modifier_only("alt + shift"));
        assert!(!looks_modifier_only("Ctrl+Alt+W"));
        assert!(!looks_modifier_only("Super"));
        assert!(!looks_modifier_only("F13"));
    }

    #[test]
    fn parses_electron_accelerators() {
        let s = parse_accelerator("Ctrl+Alt+Super+W").unwrap();
        assert_eq!(
            s,
            Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER),
                Code::KeyW
            )
        );
        let s = parse_accelerator("Shift+F5").unwrap();
        assert_eq!(s, Shortcut::new(Some(Modifiers::SHIFT), Code::F5));
        let s = parse_accelerator("Super+Alt+Space").unwrap();
        assert_eq!(
            s,
            Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::Space)
        );
        let s = parse_accelerator("Ctrl+`").unwrap();
        assert_eq!(s, Shortcut::new(Some(Modifiers::CONTROL), Code::Backquote));
        let s = parse_accelerator("Alt+1").unwrap();
        assert_eq!(s, Shortcut::new(Some(Modifiers::ALT), Code::Digit1));
        let s = parse_accelerator("Ctrl+Return").unwrap();
        assert_eq!(s, Shortcut::new(Some(Modifiers::CONTROL), Code::Enter));
        let s = parse_accelerator("F13").unwrap();
        assert_eq!(s, Shortcut::new(None, Code::F13));
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_accelerator("").is_none());
        assert!(parse_accelerator("Ctrl+").is_none());
        assert!(parse_accelerator("Ctrl+NotAKey").is_none());
    }
}
