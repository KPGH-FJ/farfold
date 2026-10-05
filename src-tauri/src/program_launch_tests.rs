#![cfg(unix)]
use crate::npm_release::ProgramRelease;
use crate::program_launch::{NodeLaunch, create, validate};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};

struct Fixture {
    temporary: tempfile::TempDir,
    root: PathBuf,
    package: PathBuf,
    node: PathBuf,
    entry: PathBuf,
    launcher: PathBuf,
    launch: NodeLaunch,
    release: ProgramRelease,
}

fn executable(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn quoted(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"))
}

fn node_fixture(path: &Path, version: &str) {
    executable(
        path,
        &format!(
            "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '%s\\n' 'v{version}'; exit 0; fi\nexec /bin/sh \"$@\"\n"
        ),
    );
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("managed ' program");
        let package = root.join("node_modules/fixture-package");
        std::fs::create_dir_all(&package).unwrap();
        let node = temporary.path().join("node ' fixture");
        node_fixture(&node, "22.20.0");
        let entry = package.join("entry.js");
        std::fs::write(
            &entry,
            "if [ \"$1\" = --version ]; then printf '%s\\n' '1.0.0'; else exit 9; fi\n",
        )
        .unwrap();
        let manifest = serde_json::json!({
            "name": "fixture-package",
            "version": "1.0.0",
            "bin": { "fixture": "entry.js" },
            "engines": { "node": ">=22.19.0" }
        });
        std::fs::write(
            package.join("package.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let (launcher, launch) = create(&root, &node, &entry, "22.20.0").unwrap();
        let release = ProgramRelease {
            package: "fixture-package".into(),
            version: "1.0.0".into(),
            published_at: "2026-08-01T00:00:00Z".into(),
            source_url: "https://registry.npmjs.org/fixture-package".into(),
            node_engine: ">=22.19.0".into(),
            bin: "fixture".into(),
        };
        Self {
            temporary,
            root,
            package,
            node,
            entry,
            launcher,
            launch,
            release,
        }
    }

    fn validate(&self) -> Result<String, String> {
        validate(
            &self.root,
            &self.launcher,
            &self.launch,
            &self.release,
            || Ok(()),
        )
    }
}

#[test]
fn selected_program_checks_actual_node_and_program_versions() {
    let fixture = Fixture::new();
    assert_eq!(fixture.validate().unwrap(), "1.0.0");
    node_fixture(&fixture.node, "22.18.0");
    assert!(fixture.validate().unwrap_err().contains("Node"));
}

#[test]
fn updated_node_remains_usable_when_it_still_meets_the_official_engine_range() {
    let fixture = Fixture::new();
    assert_eq!(fixture.launch.node_version, "22.20.0");
    node_fixture(&fixture.node, "22.21.0");
    assert_eq!(fixture.validate().unwrap(), "1.0.0");
}

#[test]
fn selection_rechecks_missing_node_and_entrypoint() {
    let fixture = Fixture::new();
    std::fs::remove_file(&fixture.node).unwrap();
    assert!(fixture.validate().is_err());
    node_fixture(&fixture.node, "22.20.0");
    std::fs::remove_file(&fixture.entry).unwrap();
    assert!(fixture.validate().is_err());
}

#[test]
fn selected_program_cannot_escape_its_package_through_an_entry_symlink() {
    let fixture = Fixture::new();
    let outside = fixture.temporary.path().join("outside-entry.js");
    std::fs::rename(&fixture.entry, &outside).unwrap();
    symlink(&outside, &fixture.entry).unwrap();
    assert!(fixture.validate().is_err());
}

#[test]
fn selected_program_cannot_escape_the_managed_root_through_a_package_symlink() {
    let fixture = Fixture::new();
    let outside = fixture.temporary.path().join("outside-package");
    std::fs::rename(&fixture.package, &outside).unwrap();
    symlink(&outside, &fixture.package).unwrap();
    // Even an otherwise consistent launcher and package must remain inside the
    // owned root; canonicalizing the package alone is not a containment check.
    executable(
        &fixture.launcher,
        &format!(
            "#!/bin/sh\nexec {} {} \"$@\"\n",
            quoted(&fixture.node.canonicalize().unwrap()),
            quoted(&outside.join("entry.js").canonicalize().unwrap())
        ),
    );
    assert!(fixture.validate().is_err());
}

#[test]
fn selected_program_rejects_changed_manifest_identity_version_or_bin() {
    for (field, replacement) in [
        ("name", serde_json::json!("different-package")),
        ("version", serde_json::json!("2.0.0")),
        ("engines", serde_json::json!({"node":">=24.0.0"})),
        ("bin", serde_json::json!({ "other": "entry.js" })),
        ("bin", serde_json::json!({ "fixture": "other.js" })),
    ] {
        let fixture = Fixture::new();
        std::fs::copy(&fixture.entry, fixture.package.join("other.js")).unwrap();
        let path = fixture.package.join("package.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        manifest[field] = replacement;
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(
            fixture.validate().is_err(),
            "changed {field} must be checked"
        );
    }
}

#[test]
fn selected_program_rejects_changed_launcher_and_program_output() {
    let fixture = Fixture::new();
    let original = std::fs::read(&fixture.launcher).unwrap();
    executable(&fixture.launcher, "#!/bin/sh\nprintf '%s\\n' '1.0.0'\n");
    assert!(fixture.validate().is_err());
    std::fs::write(&fixture.launcher, original).unwrap();
    std::fs::write(&fixture.entry, "printf '%s\\n' '1.0.1'\n").unwrap();
    assert!(fixture.validate().is_err());
}

#[test]
fn cancelled_selection_does_not_start_program_version_check() {
    let fixture = Fixture::new();
    let node_checked = fixture.temporary.path().join("node-checked");
    let program_checked = fixture.temporary.path().join("program-checked");
    executable(
        &fixture.node,
        &format!(
            "#!/bin/sh\nif [ \"$1\" = --version ]; then : > {}; printf '%s\\n' 'v22.20.0'; exit 0; fi\nexec /bin/sh \"$@\"\n",
            quoted(&node_checked)
        ),
    );
    std::fs::write(
        &fixture.entry,
        format!(": > {}\nprintf '%s\\n' '1.0.0'\n", quoted(&program_checked)),
    )
    .unwrap();
    let cancelled = "fixture selection cancelled";
    assert_eq!(
        validate(
            &fixture.root,
            &fixture.launcher,
            &fixture.launch,
            &fixture.release,
            || Err(cancelled.into()),
        )
        .unwrap_err(),
        cancelled
    );
    assert!(!node_checked.exists());
    assert_eq!(
        validate(
            &fixture.root,
            &fixture.launcher,
            &fixture.launch,
            &fixture.release,
            || if node_checked.exists() {
                Err(cancelled.into())
            } else {
                Ok(())
            },
        )
        .unwrap_err(),
        cancelled
    );
    assert!(node_checked.exists());
    assert!(!program_checked.exists());
}
