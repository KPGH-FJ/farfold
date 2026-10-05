//! Windows self-contained launcher tests use only the synthetic process fixture.
use super::*;
use std::io::Write;
use std::process::{Command, Stdio};

struct Fixture {
    directory: tempfile::TempDir,
    launcher: PathBuf,
    entry: PathBuf,
    launch: NodeLaunch,
    release: ProgramRelease,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let node = directory.path().join("node with spaces.exe");
        let executable = crate::windows_process::helper_executable().unwrap();
        std::fs::copy(executable, &node).unwrap();
        let package = directory.path().join("node_modules/fixture-package");
        std::fs::create_dir_all(&package).unwrap();
        let entry = package.join("entry.ff-node-fixture");
        std::fs::write(&entry, "synthetic entry").unwrap();
        std::fs::write(package.join("package.json"), r#"{"name":"fixture-package","version":"1.0.0","bin":{"fixture":"entry.ff-node-fixture"},"engines":{"node":">=22.19.0"}}"#).unwrap();
        let (launcher, launch) = create(directory.path(), &node, &entry, "22.20.0").unwrap();
        Self {
            directory,
            launcher,
            entry,
            launch,
            release: ProgramRelease {
                package: "fixture-package".into(),
                version: "1.0.0".into(),
                published_at: "2026-08-01T00:00:00Z".into(),
                source_url: "https://registry.npmjs.org/fixture-package".into(),
                node_engine: ">=22.19.0".into(),
                bin: "fixture".into(),
            },
        }
    }
}
#[test]
fn generated_pe_preserves_argv_stdio_cwd_environment_and_exit_status() {
    let f = Fixture::new();
    let mut child = Command::new(&f.launcher)
        .args([
            "argv",
            "",
            "& %PATH% literal",
            "space value",
            "quote\"value",
        ])
        .current_dir(f.directory.path())
        .env("FIXTURE_LITERAL", "preserved")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"synthetic input")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(23));
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        value["args"],
        serde_json::json!(["", "& %PATH% literal", "space value", "quote\"value"])
    );
    assert_eq!(
        PathBuf::from(value["entry"].as_str().unwrap()),
        f.entry.canonicalize().unwrap()
    );
    assert_eq!(value["env"], "preserved");
    assert_eq!(value["input"], "synthetic input");
}
#[test]
fn selection_checks_versions_and_rejects_changed_generated_pe() {
    let f = Fixture::new();
    assert_eq!(
        validate(
            f.directory.path(),
            &f.launcher,
            &f.launch,
            &f.release,
            || Ok(())
        )
        .unwrap(),
        "1.0.0"
    );
    std::fs::OpenOptions::new()
        .append(true)
        .open(&f.launcher)
        .unwrap()
        .write_all(b"changed")
        .unwrap();
    assert!(
        validate(
            f.directory.path(),
            &f.launcher,
            &f.launch,
            &f.release,
            || Ok(())
        )
        .is_err()
    );
    assert_eq!(
        Command::new(&f.launcher).status().unwrap().code(),
        Some(126)
    );
}
#[test]
fn generated_pe_refuses_non_absolute_or_oversized_paths() {
    let valid = Path::new(r"C:\Programs\node.exe");
    assert!(launcher_bytes(Path::new("relative.exe"), valid).is_err());
    assert!(launcher_bytes(valid, Path::new(&format!("C:\\{}", "a".repeat(32769)))).is_err());
    assert!(launcher_bytes(valid, Path::new("C:\\bad\nentry.js")).is_err());
}
