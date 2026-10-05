use super::*;
#[cfg(unix)]
use std::os::unix::fs::symlink;

fn autohand(root: &Path) -> AgentRow {
    tests::official_row(
        root,
        "registry:autohand",
        "@autohandai/autohand-acp",
        "0.2.1",
    )
}

#[test]
fn scoped_official_component_has_its_companion_without_inventing_a_minimum() {
    let root = tempfile::tempdir().unwrap();
    let row = autohand(root.path());
    assert_eq!(component_version(&row).as_deref(), Some("0.2.1"));
    let declarations = verified_for(&row);
    assert_eq!(declarations.len(), 1);
    assert_eq!(declarations[0].id, "autohand-cli");
    assert_eq!(declarations[0].program_env, "AUTOHAND_CMD");
    assert!(declarations[0].support.is_none());
    assert!(matches!(
        declarations[0].command_delivery,
        DependencyCommandDelivery::SearchPath
    ));
    assert!(declarations[0].home_bin_dir.is_none());
    assert!(matches!(
        declarations[0].distribution,
        DependencyDistribution::Npm {
            package: "autohand-cli",
            bin: "autohand"
        }
    ));
}

#[test]
fn changed_or_unknown_component_version_stays_diagnostic_only() {
    let root = tempfile::tempdir().unwrap();
    let mut row = autohand(root.path());
    assert_eq!(declared_for(&row).len(), 1);
    row.version = None;
    assert_eq!(declared_for(&row).len(), 1);
    assert!(verified_for(&row).is_empty());
    row.version = Some("0.2.2".into());
    assert_eq!(declared_for(&row).len(), 1);
    assert!(verified_for(&row).is_empty());
    row.version = Some("0.2.1".into());
    let manifest = Path::new(&row.args[0])
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("package.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    value["version"] = "0.2.2".into();
    std::fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(component_version(&row).as_deref(), Some("0.2.2"));
    assert_eq!(declared_for(&row).len(), 1);
    assert!(verified_for(&row).is_empty());
}

#[test]
fn scope_source_argv_manifest_and_declared_entry_are_required() {
    let root = tempfile::tempdir().unwrap();
    let mut row = autohand(root.path());
    row.source = "custom".into();
    assert!(declared_for(&row).is_empty());
    row.source = "registry".into();
    row.args.push("--other".into());
    assert!(declared_for(&row).is_empty());
    row.args.pop();
    let entry = Path::new(&row.args[0]);
    let package = entry.parent().unwrap().parent().unwrap();
    let manifest = package.join("package.json");
    std::fs::write(
        &manifest,
        serde_json::to_vec(&serde_json::json!({
            "name":"@other/autohand-acp","version":"0.2.1","bin":{"autohand-acp":"dist/index.js"}
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(declared_for(&row).is_empty());
    std::fs::write(&manifest, serde_json::to_vec(&serde_json::json!({
        "name":"@autohandai/autohand-acp","version":"0.2.1","bin":{"autohand-acp":"dist/other.js"}
    })).unwrap()).unwrap();
    assert!(declared_for(&row).is_empty());
    std::fs::write(
        &manifest,
        serde_json::to_vec(&serde_json::json!({
            "name":"@autohandai/autohand-acp","version":"0.2.1","bin":{"unrelated":"dist/index.js"}
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(declared_for(&row).is_empty());
}

#[cfg(unix)]
#[test]
fn package_or_entry_symlink_cannot_escape_the_node_modules_tree() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let row = autohand(root.path());
    let package = root.path().join("node_modules/@autohandai/autohand-acp");
    let moved = outside.path().join("autohand-acp");
    std::fs::rename(&package, &moved).unwrap();
    symlink(&moved, &package).unwrap();
    assert!(declared_for(&row).is_empty());
    std::fs::remove_file(&package).unwrap();
    std::fs::rename(&moved, &package).unwrap();
    let entry = Path::new(&row.args[0]);
    std::fs::remove_file(entry).unwrap();
    let external_entry = outside.path().join("external.js");
    std::fs::write(&external_entry, "// external entry").unwrap();
    symlink(&external_entry, entry).unwrap();
    assert!(declared_for(&row).is_empty());
}

#[test]
fn an_unscoped_lookalike_does_not_gain_the_scoped_companion() {
    let root = tempfile::tempdir().unwrap();
    let row = tests::official_row(root.path(), "registry:autohand", "autohand-acp", "0.2.1");
    assert!(declared_for(&row).is_empty());
}
