extern crate napi_build;

fn main() {
    napi_build::setup();
    // The macOS framework links (ApplicationServices, AppKit) come from
    // `runwa-core`'s build script and travel with its rlib.
}
