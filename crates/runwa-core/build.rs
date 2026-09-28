fn main() {
    // macOS-only: link ApplicationServices for the AX (Accessibility) C API we
    // use to enumerate and raise windows across all Spaces. AppKit is needed
    // for NSWorkspace.runningApplications (to iterate PIDs without shelling
    // out to osascript).
    //
    // Link directives travel with the rlib, so whichever shell links this
    // crate — the napi addon or the Tauri binary — picks them up.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
        println!("cargo:rustc-link-lib=framework=AppKit");
    }
}
