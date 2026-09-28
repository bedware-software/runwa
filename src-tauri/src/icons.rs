//! Palette row icons as `data:image/png` URLs — the part of
//! `src/main/icon-cache.ts` the Window Switcher needs.
//!
//! Two layers, both memoised for the life of the process (a `None` entry
//! means "tried, nothing usable" and is cached too, so bad paths and
//! iconless windows aren't retried on every keystroke):
//!
//!  1. Window-scoped: the HWND's own icon via `runwa-core` (Windows). Wins
//!     for UWP apps, Edge PWAs and shared-exe Electron apps, whose exe icon
//!     is a generic host glyph.
//!  2. Executable-scoped: the icon resource of the exe (Windows,
//!     `ExtractIconExW`) or the `.icns` a bundle's Info.plist names (macOS).
//!
//! Electron's `app.getFileIcon` / QuickLook paths have no direct equivalent
//! yet; rows that resolve nothing fall back to a Lucide glyph in the module.

use std::collections::HashMap;

use base64::Engine;
use parking_lot::Mutex;

#[derive(Default)]
pub struct IconCache {
    windows: Mutex<HashMap<String, Option<String>>>,
    files: Mutex<HashMap<String, Option<String>>>,
}

impl IconCache {
    pub fn window_icon(&self, window_id: &str) -> Option<String> {
        if let Some(cached) = self.windows.lock().get(window_id) {
            return cached.clone();
        }
        let url = match runwa_core::get_window_icon(window_id) {
            Ok(Some(icon)) => bgra_to_data_url(&icon),
            Ok(None) => None,
            Err(err) => {
                log::warn!("[icon-cache] get_window_icon({window_id}) failed: {err}");
                None
            }
        };
        self.windows
            .lock()
            .insert(window_id.to_owned(), url.clone());
        url
    }

    pub fn file_icon(&self, path: Option<&str>) -> Option<String> {
        let path = path.filter(|p| !p.is_empty())?;
        if let Some(cached) = self.files.lock().get(path) {
            return cached.clone();
        }
        let url = resolve_file_icon(path);
        self.files.lock().insert(path.to_owned(), url.clone());
        url
    }
}

#[cfg(target_os = "windows")]
fn resolve_file_icon(path: &str) -> Option<String> {
    match runwa_core::get_file_icon(path, 0) {
        Ok(Some(icon)) => bgra_to_data_url(&icon),
        Ok(None) => None,
        Err(err) => {
            log::warn!("[icon-cache] get_file_icon({path}) failed: {err}");
            None
        }
    }
}

#[cfg(target_os = "macos")]
fn resolve_file_icon(path: &str) -> Option<String> {
    mac::bundle_icon(std::path::Path::new(path))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn resolve_file_icon(_path: &str) -> Option<String> {
    None
}

fn png_data_url(png: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    )
}

/// `runwa-core` hands back premultiplied BGRA (what `DrawIconEx` leaves in
/// a 32bpp DIB, and what Electron's `nativeImage.createFromBitmap` took).
/// PNG wants straight RGBA, so swap the channels and undo the
/// premultiplication.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn bgra_to_data_url(icon: &runwa_core::WindowIcon) -> Option<String> {
    let len = (icon.width as usize)
        .checked_mul(icon.height as usize)?
        .checked_mul(4)?;
    if len == 0 || icon.bgra.len() < len {
        return None;
    }
    let mut rgba = icon.bgra[..len].to_vec();
    for px in rgba.chunks_exact_mut(4) {
        px.swap(0, 2);
        let alpha = u32::from(px[3]);
        if alpha != 0 && alpha != 255 {
            for channel in &mut px[..3] {
                *channel = ((u32::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
            }
        }
    }

    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, icon.width, icon.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&rgba).ok()?;
    }
    Some(png_data_url(&png))
}

#[cfg(target_os = "macos")]
mod mac {
    use std::fs::File;
    use std::io::BufReader;
    use std::path::Path;

    use super::png_data_url;

    /// Resolve a `.app` bundle's icon from `Contents/Info.plist` +
    /// `Contents/Resources/<icon>.icns`. Asset-catalog-only apps (no
    /// `.icns`) come back `None`; the Electron build fell back to QuickLook
    /// for those.
    pub fn bundle_icon(bundle: &Path) -> Option<String> {
        if bundle.extension().and_then(|e| e.to_str()) != Some("app") {
            return None;
        }
        let info = plist::Value::from_file(bundle.join("Contents").join("Info.plist")).ok()?;
        let dict = info.as_dictionary()?;
        let name = ["CFBundleIconFile", "CFBundleIconName"]
            .iter()
            .find_map(|key| dict.get(key).and_then(|v| v.as_string()))
            .filter(|name| !name.is_empty())?;

        // CFBundleIconFile is written with and without the extension.
        let resources = bundle.join("Contents").join("Resources");
        let base = name.strip_suffix(".icns").unwrap_or(name);
        for candidate in [resources.join(name), resources.join(format!("{base}.icns"))] {
            if let Some(url) = icns_to_data_url(&candidate) {
                return Some(url);
            }
        }
        let png = std::fs::read(resources.join(format!("{base}.png"))).ok()?;
        Some(png_data_url(&png))
    }

    /// Pick the smallest representation that's still crisp in the palette's
    /// 32 pt tile on Retina (64 px), falling back to whatever decodes.
    fn icns_to_data_url(path: &Path) -> Option<String> {
        let file = File::open(path).ok()?;
        let family = icns::IconFamily::read(BufReader::new(file)).ok()?;
        let mut types = family.available_icons();
        types.sort_by_key(|t| t.pixel_width());
        let preferred = types.iter().filter(|t| t.pixel_width() >= 64);
        let smaller = types.iter().rev().filter(|t| t.pixel_width() < 64);
        for icon_type in preferred.chain(smaller) {
            let Ok(image) = family.get_icon_with_type(*icon_type) else {
                continue;
            };
            let mut png = Vec::new();
            if image.write_png(&mut png).is_ok() {
                return Some(png_data_url(&png));
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn premultiplied_bgra_becomes_straight_rgba_png() {
        // One opaque blue pixel, one half-transparent premultiplied red pixel.
        let icon = runwa_core::WindowIcon {
            width: 2,
            height: 1,
            bgra: vec![255, 0, 0, 255, 0, 0, 128, 128],
        };
        let url = bgra_to_data_url(&icon).unwrap();
        let b64 = url.strip_prefix("data:image/png;base64,").unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (2, 1));
        assert_eq!(&buf[..4], &[0, 0, 255, 255]);
        assert_eq!(&buf[4..8], &[255, 0, 0, 128]);
    }

    #[test]
    fn short_buffers_are_rejected() {
        let icon = runwa_core::WindowIcon {
            width: 4,
            height: 4,
            bgra: vec![0; 8],
        };
        assert!(bgra_to_data_url(&icon).is_none());
    }
}
