//! Platform-agnostic re-exports. The actual key-synthesis helpers live in
//! the per-platform hook modules (`windows.rs` / `macos.rs`) since each
//! needs its own OS-specific call (`SendInput` vs `CGEventPost`) and there's
//! no benefit to a generic trait.
//!
//! This module just exists so the `mod remap::synth` path compiles on every
//! target and so future shared helpers (e.g. logging) have a home.

#[allow(dead_code)]
pub const INJECT_TAG: usize = 0x52554E57; // "RUNW"
