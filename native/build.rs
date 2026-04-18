extern crate napi_build;

fn main() {
  napi_build::setup();

  // macOS-only: link ApplicationServices for the AX (Accessibility) C API we
  // use to enumerate and raise windows across all Spaces. AppKit is needed
  // for NSWorkspace.runningApplications (to iterate PIDs without shelling
  // out to osascript).
  #[cfg(target_os = "macos")]
  {
    println!("cargo:rustc-link-lib=framework=ApplicationServices");
    println!("cargo:rustc-link-lib=framework=AppKit");
  }
}
