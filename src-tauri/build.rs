use std::{env, ffi::OsStr, path::PathBuf, process::Command};

fn run_xcrun(tool: &str, arguments: &[&OsStr]) {
    let status = Command::new("/usr/bin/xcrun")
        .arg("--sdk")
        .arg("macosx")
        .arg(tool)
        .args(arguments)
        .status()
        .unwrap_or_else(|error| panic!("failed to start the macOS {tool} tool: {error}"));
    assert!(status.success(), "macOS {tool} failed: {status}");
}

fn compile_browser_workspace() {
    // These are Cargo's build inputs, not product/Agent runtime configuration.
    let target_os = env::var("CARGO_CFG_TARGET_OS").expect("Cargo target OS");
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").expect("Cargo target architecture");
    assert!(
        target_os == "macos" && target_arch == "aarch64",
        "the browser workspace currently supports macOS arm64 only"
    );
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"));
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo build output directory"));
    let source = root.join("native/BrowserWorkspace.m");
    let object = output.join("BrowserWorkspace.o");
    let archive = output.join("libfarfold_browser_workspace.a");
    run_xcrun(
        "clang",
        &[
            OsStr::new("-arch"),
            OsStr::new("arm64"),
            OsStr::new("-fobjc-arc"),
            // WKContentWorld/evaluateJavaScript(inContentWorld:) require 11.0.
            OsStr::new("-mmacosx-version-min=11.0"),
            OsStr::new("-Wall"),
            OsStr::new("-Wextra"),
            OsStr::new("-Werror"),
            OsStr::new("-Wno-unused-parameter"),
            OsStr::new("-c"),
            source.as_os_str(),
            OsStr::new("-o"),
            object.as_os_str(),
        ],
    );
    run_xcrun(
        "ar",
        &[OsStr::new("rcs"), archive.as_os_str(), object.as_os_str()],
    );
    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-lib=static=farfold_browser_workspace");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=framework=WebKit");
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=native/BrowserWorkspace.h");
    println!("cargo:rerun-if-changed=native/BrowserWorkspace.m");
    compile_browser_workspace();
    tauri_build::build();
}
