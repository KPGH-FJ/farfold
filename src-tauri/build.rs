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

fn compile_macos() {
    // These are Cargo's build inputs, not product/Agent runtime configuration.
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").expect("Cargo target architecture");
    assert!(
        target_arch == "aarch64",
        "the browser workspace currently supports macOS arm64 only"
    );
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"));
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo build output directory"));
    let observation = std::fs::read_to_string(root.join("native/browser_observation.js"))
        .expect("browser observation script");
    let literals: String = observation
        .split_inclusive('\n')
        .map(|line| {
            format!(
                "@\"{}\"\n",
                line.replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('\r', "\\r")
                    .replace('\n', "\\n")
            )
        })
        .collect();
    std::fs::write(output.join("BrowserObservation.inc"), literals)
        .expect("browser observation include");
    for name in [
        "BrowserWorkspace",
        "DesktopNotifications",
        "AppQuit",
        "AudioPreview",
    ] {
        let source = root.join(format!("native/{name}.m"));
        let object = output.join(format!("{name}.o"));
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
                OsStr::new("-I"),
                output.as_os_str(),
                OsStr::new("-c"),
                source.as_os_str(),
                OsStr::new("-o"),
                object.as_os_str(),
            ],
        );
    }
    let archive = output.join("libfarfold_browser_workspace.a");
    run_xcrun(
        "ar",
        &[
            OsStr::new("rcs"),
            archive.as_os_str(),
            output.join("BrowserWorkspace.o").as_os_str(),
            output.join("DesktopNotifications.o").as_os_str(),
            output.join("AppQuit.o").as_os_str(),
            output.join("AudioPreview.o").as_os_str(),
        ],
    );
    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-lib=static=farfold_browser_workspace");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=framework=WebKit");
    println!("cargo:rustc-link-lib=framework=UserNotifications");
    println!("cargo:rustc-link-lib=framework=AudioToolbox");
}

fn compile_windows_launcher() {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"));
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo build output directory"));
    let target = env::var("TARGET").expect("Cargo target");
    let mut command = Command::new(env::var_os("RUSTC").expect("Cargo Rust compiler"));
    command
        .arg(root.join("native/NodeLauncher.rs"))
        .args([
            "--edition=2024",
            "--target",
            &target,
            "-C",
            "opt-level=z",
            "-C",
            "panic=abort",
            "-C",
            "strip=symbols",
        ])
        .arg("-o")
        .arg(output.join("launch-program-template.exe"));
    let key = format!(
        "CARGO_TARGET_{}_LINKER",
        target.replace('-', "_").to_ascii_uppercase()
    );
    println!("cargo:rerun-if-env-changed={key}");
    if let Some(linker) = env::var_os(key) {
        command
            .arg("-C")
            .arg(format!("linker={}", linker.to_string_lossy()));
    }
    assert!(
        command
            .status()
            .expect("Windows program launcher compiler")
            .success(),
        "Windows program launcher compilation failed"
    );
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=native/BrowserWorkspace.h");
    println!("cargo:rerun-if-changed=native/BrowserWorkspace.m");
    println!("cargo:rerun-if-changed=native/browser_observation.js");
    println!("cargo:rerun-if-changed=native/NodeLauncher.rs");
    println!("cargo:rerun-if-changed=native/DesktopNotifications.h");
    println!("cargo:rerun-if-changed=native/DesktopNotifications.m");
    println!("cargo:rerun-if-changed=native/AppQuit.h");
    println!("cargo:rerun-if-changed=native/AppQuit.m");
    println!("cargo:rerun-if-changed=native/AudioPreview.h");
    println!("cargo:rerun-if-changed=native/AudioPreview.m");
    match env::var("CARGO_CFG_TARGET_OS")
        .expect("Cargo target OS")
        .as_str()
    {
        "macos" => compile_macos(),
        // WebView2/WinRT and system credential APIs are linked by their Rust
        // platform modules. Never invoke the macOS toolchain for this target.
        "windows" => compile_windows_launcher(),
        other => panic!("unsupported Farfold desktop platform: {other}"),
    }
    tauri_build::build();
}
