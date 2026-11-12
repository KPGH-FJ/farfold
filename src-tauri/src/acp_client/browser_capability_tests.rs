use super::*;
use serde_json::json;
#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::path::PathBuf;

fn fixture() -> AgentRow {
    AgentRow {
        id: "codex".into(),
        name: "Codex".into(),
        source: "registry".into(),
        command: if cfg!(windows) {
            r"C:\controlled\registry\codex-acp.exe".into()
        } else {
            "/controlled/registry/codex-acp".into()
        },
        args: vec![],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    }
}

struct NodeFixture {
    _directory: tempfile::TempDir,
    root: PathBuf,
    package: PathBuf,
    entry: PathBuf,
    row: AgentRow,
}

impl NodeFixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let package = root.join("node_modules").join(PACKAGE);
        let entry = package.join("dist/index.js");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, "// synthetic public JavaScript bin\n").unwrap();
        let mut row = fixture();
        row.command = root
            .join(if cfg!(windows) { "node.exe" } else { "node" })
            .to_string_lossy()
            .into_owned();
        row.args = vec![entry.to_string_lossy().into_owned()];
        let result = Self {
            _directory: directory,
            root,
            package,
            entry,
            row,
        };
        result.manifest(json!({"name":PACKAGE,"bin":{BIN:"dist/index.js"}}));
        result
    }

    fn manifest(&self, value: serde_json::Value) {
        std::fs::write(
            self.package.join("package.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn reviewed_registry_binary_accepts_both_ids_without_version_pin() {
    let mut row = fixture();
    assert_eq!(reviewed_launch(&row), Some(LaunchKind::Binary));
    assert!(eligible(&row));
    row.id = "registry:codex-acp".into();
    row.version = Some("a-later-version-is-not-a-pin-failure".into());
    assert_eq!(reviewed_launch(&row), Some(LaunchKind::Binary));
}

fn opencode_fixture() -> AgentRow {
    let mut row = fixture();
    row.id = "opencode".into();
    row.source = "discovered".into();
    row.command = if cfg!(windows) {
        r"C:\controlled\opencode.exe".into()
    } else {
        "/controlled/.opencode/bin/opencode".into()
    };
    row.args = vec!["acp".into()];
    row
}

#[test]
fn reviewed_opencode_stdio_shape_is_separate_from_codex_and_not_version_pinned() {
    let mut row = opencode_fixture();
    for version in [None, Some("future-unpinned-release".to_owned())] {
        row.version = version;
        let launch = reviewed_launch(&row);
        assert!(
            launch.is_some(),
            "the reviewed discovered ACP shape is eligible"
        );
        assert_eq!(launch, Some(LaunchKind::OpenCode));
        assert_ne!(launch, Some(LaunchKind::Binary));
        assert_ne!(launch, Some(LaunchKind::Node));
    }
}

#[test]
fn opencode_stdio_review_does_not_admit_unreviewed_sources_wrappers_or_flags() {
    for source in ["custom", "registry", ""] {
        let mut row = opencode_fixture();
        row.source = source.into();
        assert_eq!(reviewed_launch(&row), None);
    }
    for id in ["registry:opencode", "self-named-opencode", "codex"] {
        let mut row = opencode_fixture();
        row.id = id.into();
        assert_eq!(reviewed_launch(&row), None);
    }
    for args in [
        vec![],
        vec!["serve"],
        vec!["acp", "--print-logs"],
        vec!["--", "acp"],
    ] {
        let mut row = opencode_fixture();
        row.args = args.into_iter().map(str::to_owned).collect();
        assert_eq!(reviewed_launch(&row), None);
    }
    for command in ["opencode", "/controlled/wrapper", "/bin/sh"] {
        let mut row = opencode_fixture();
        row.command = command.into();
        assert_eq!(reviewed_launch(&row), None);
    }
}

#[test]
fn reviewed_node_accepts_both_ids_and_manifest_versions_do_not_pin() {
    let mut sample = NodeFixture::new();
    assert_eq!(reviewed_launch(&sample.row), Some(LaunchKind::Node));
    sample.row.id = "registry:codex-acp".into();
    sample.row.version = Some("another-installed-version".into());
    sample.manifest(json!({"name":PACKAGE,"version":"any-future-version",
        "bin":{BIN:"./dist/index.js"},"other":{"preserved":true}}));
    assert_eq!(reviewed_launch(&sample.row), Some(LaunchKind::Node));
    assert!(eligible(&sample.row));
}

#[test]
fn custom_discovered_and_unknown_ids_cannot_borrow_either_launch() {
    let sample = NodeFixture::new();
    for original in [fixture(), sample.row.clone()] {
        for source in ["custom", "discovered", ""] {
            let mut row = original.clone();
            row.source = source.into();
            assert_eq!(reviewed_launch(&row), None);
        }
        let mut row = original;
        row.id = "self-named-codex".into();
        assert_eq!(reviewed_launch(&row), None);
    }
}

#[test]
fn relative_commands_wrappers_and_extra_arguments_are_not_reviewed() {
    let sample = NodeFixture::new();
    for command in ["node", "codex-acp", "/controlled/codex", "/bin/sh"] {
        let mut row = sample.row.clone();
        row.command = command.into();
        assert_eq!(reviewed_launch(&row), None);
    }
    let mut binary = fixture();
    binary.args.push("--unknown-wrapper-mode".into());
    assert_eq!(reviewed_launch(&binary), None);
    let mut node = sample.row.clone();
    node.args.clear();
    assert_eq!(reviewed_launch(&node), None);
    node.args = vec!["dist/index.js".into()];
    assert_eq!(reviewed_launch(&node), None);
    node.args = vec![sample.entry.to_string_lossy().into_owned(), "--acp".into()];
    assert_eq!(reviewed_launch(&node), None);
}

#[test]
fn package_name_named_bin_and_selected_entry_must_match() {
    let sample = NodeFixture::new();
    for manifest in [
        json!({"name":"other-package","bin":{BIN:"dist/index.js"}}),
        json!({"name":PACKAGE,"bin":{"other":"dist/index.js"}}),
        json!({"name":PACKAGE,"bin":"dist/index.js"}),
        json!({"name":PACKAGE,"bin":{BIN:42}}),
        json!({"name":PACKAGE,"bin":{BIN:""}}),
        json!({"name":PACKAGE}),
    ] {
        sample.manifest(manifest);
        assert_eq!(reviewed_launch(&sample.row), None);
    }
    std::fs::write(sample.package.join("dist/other.js"), "// other").unwrap();
    sample.manifest(json!({"name":PACKAGE,"bin":{BIN:"dist/other.js"}}));
    assert_eq!(reviewed_launch(&sample.row), None);
}

#[test]
fn absolute_and_parent_traversing_manifest_bins_are_rejected() {
    let sample = NodeFixture::new();
    for bin in [
        sample.entry.to_string_lossy().into_owned(),
        "dist/../dist/index.js".into(),
        "../codex-acp/dist/index.js".into(),
    ] {
        sample.manifest(json!({"name":PACKAGE,"bin":{BIN:bin}}));
        assert_eq!(reviewed_launch(&sample.row), None);
    }
}

#[test]
#[cfg(unix)]
fn normal_node_and_package_local_bin_links_remain_usable() {
    let sample = NodeFixture::new();
    let node_target = sample.root.join("selected-node");
    std::fs::write(&node_target, "synthetic executable placeholder").unwrap();
    symlink(&node_target, &sample.row.command).unwrap();
    symlink("index.js", sample.package.join("dist/cli.js")).unwrap();
    sample.manifest(json!({"name":PACKAGE,"bin":{BIN:"dist/cli.js"}}));
    assert_eq!(reviewed_launch(&sample.row), Some(LaunchKind::Node));
}

#[test]
#[cfg(unix)]
fn bin_or_entry_link_cannot_escape_the_named_package() {
    let sample = NodeFixture::new();
    let outside = sample.root.join("other.js");
    std::fs::write(&outside, "// outside").unwrap();
    symlink(&outside, sample.package.join("dist/cli.js")).unwrap();
    sample.manifest(json!({"name":PACKAGE,"bin":{BIN:"dist/cli.js"}}));
    assert_eq!(reviewed_launch(&sample.row), None);
    std::fs::remove_file(&sample.entry).unwrap();
    symlink(&outside, &sample.entry).unwrap();
    sample.manifest(json!({"name":PACKAGE,"bin":{BIN:"dist/index.js"}}));
    assert_eq!(reviewed_launch(&sample.row), None);
}

#[test]
#[cfg(unix)]
fn package_directory_link_cannot_select_an_unrelated_package() {
    let sample = NodeFixture::new();
    let relocated = sample.package.with_file_name("other-package");
    std::fs::rename(&sample.package, &relocated).unwrap();
    symlink(&relocated, &sample.package).unwrap();
    assert_eq!(reviewed_launch(&sample.row), None);
}

#[test]
#[cfg(unix)]
fn ordinary_directory_alias_above_node_modules_is_canonicalized() {
    let mut sample = NodeFixture::new();
    let alias = sample.root.join("install-alias");
    symlink(&sample.root, &alias).unwrap();
    sample.row.args = vec![
        alias
            .join("node_modules")
            .join(PACKAGE)
            .join("dist/index.js")
            .to_string_lossy()
            .into_owned(),
    ];
    assert_eq!(reviewed_launch(&sample.row), Some(LaunchKind::Node));
}

#[test]
fn missing_malformed_and_oversized_manifests_are_rejected() {
    let sample = NodeFixture::new();
    let path = sample.package.join("package.json");
    std::fs::remove_file(&path).unwrap();
    assert_eq!(reviewed_launch(&sample.row), None);
    std::fs::write(&path, "not json").unwrap();
    assert_eq!(reviewed_launch(&sample.row), None);
    let mut oversized = serde_json::to_vec(&json!({"name":PACKAGE,
        "bin":{BIN:"dist/index.js"}}))
    .unwrap();
    oversized.resize(MAX_MANIFEST_BYTES as usize + 1, b' ');
    std::fs::write(&path, oversized).unwrap();
    assert_eq!(reviewed_launch(&sample.row), None);
}

#[test]
fn exactly_bounded_manifest_remains_valid() {
    let sample = NodeFixture::new();
    let mut bytes = std::fs::read(sample.package.join("package.json")).unwrap();
    bytes.resize(MAX_MANIFEST_BYTES as usize, b' ');
    std::fs::write(sample.package.join("package.json"), bytes).unwrap();
    assert_eq!(reviewed_launch(&sample.row), Some(LaunchKind::Node));
}

#[test]
#[cfg(unix)]
fn manifest_links_are_not_read() {
    let sample = NodeFixture::new();
    let path = sample.package.join("package.json");
    let target = sample.root.join("outside-manifest.json");
    std::fs::rename(&path, &target).unwrap();
    symlink(&target, &path).unwrap();
    assert_eq!(reviewed_launch(&sample.row), None);
}

#[test]
fn manifest_and_entry_directories_are_not_read() {
    let sample = NodeFixture::new();
    let path = sample.package.join("package.json");
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert_eq!(reviewed_launch(&sample.row), None);
    std::fs::remove_dir(&path).unwrap();
    sample.manifest(json!({"name":PACKAGE,"bin":{BIN:"dist/index.js"}}));
    std::fs::remove_file(&sample.entry).unwrap();
    std::fs::create_dir(&sample.entry).unwrap();
    assert_eq!(reviewed_launch(&sample.row), None);
}

#[test]
#[cfg(unix)]
fn fifo_manifest_is_rejected_without_opening_a_writer() {
    let sample = NodeFixture::new();
    let manifest = sample.package.join("package.json");
    std::fs::remove_file(&manifest).unwrap();
    let c_path = std::ffi::CString::new(manifest.as_os_str().as_encoded_bytes()).unwrap();
    // SAFETY: the owned CString stays alive and names only this temporary fixture.
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    assert_eq!(reviewed_launch(&sample.row), None);
}

#[test]
fn node_entry_outside_the_registry_npm_layout_is_unreviewed() {
    let mut sample = NodeFixture::new();
    let other = sample.root.join("plain-entry.js");
    std::fs::write(&other, "// another entry").unwrap();
    sample.row.args = vec![other.to_string_lossy().into_owned()];
    assert_eq!(reviewed_launch(&sample.row), None);
}
