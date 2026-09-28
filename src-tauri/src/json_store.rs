//! Tiny JSON file persistence, format-compatible with `electron-store`.
//!
//! The Electron build keeps each store as one pretty-printed JSON object per
//! file (`runwa-settings.json`, `runwa-window-switcher-ignore.json`, …) under
//! the user-data folder. Reading and writing the same shape here means both
//! shells can open the same folder during the migration.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

use serde::Serialize;
use serde_json::{Map, Value};

/// Read a store file as a JSON object. Missing files are the normal
/// first-run case and come back as `None` quietly; unreadable or non-object
/// content is logged and also treated as empty, so a hand-edit gone wrong
/// degrades to defaults instead of taking the app down.
pub fn read_object(path: &Path) -> Option<Map<String, Value>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return None,
        Err(err) => {
            log::warn!("[store] reading {} failed: {err}", path.display());
            return None;
        }
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(map)) => Some(map),
        Ok(_) => {
            log::warn!(
                "[store] {} is not a JSON object — ignoring it",
                path.display()
            );
            None
        }
        Err(err) => {
            log::warn!(
                "[store] {} is not valid JSON ({err}) — ignoring it",
                path.display()
            );
            None
        }
    }
}

/// Write `value` to `path` via a sibling temp file and a rename, so a crash
/// mid-write can't leave a truncated store behind. Tab-indented like
/// electron-store's output.
pub fn write_atomic(path: &Path, value: &impl Serialize) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut bytes = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"\t");
    let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, formatter);
    value
        .serialize(&mut serializer)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;

    let tmp = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips_an_object() {
        let dir = std::env::temp_dir().join(format!("runwa-store-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("store.json");
        write_atomic(&path, &json!({ "b": 1, "a": [true, "x"] })).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("\t\"b\": 1"),
            "tab-indented like electron-store: {text}"
        );
        let map = read_object(&path).unwrap();
        // preserve_order keeps the file's key order.
        assert_eq!(map.keys().collect::<Vec<_>>(), vec!["b", "a"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_or_broken_files_read_as_empty() {
        let dir = std::env::temp_dir().join(format!("runwa-store-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        assert!(read_object(&dir.join("absent.json")).is_none());
        let broken = dir.join("broken.json");
        fs::write(&broken, "{ not json").unwrap();
        assert!(read_object(&broken).is_none());
        let array = dir.join("array.json");
        fs::write(&array, "[1, 2]").unwrap();
        assert!(read_object(&array).is_none());
        fs::remove_dir_all(dir).unwrap();
    }
}
