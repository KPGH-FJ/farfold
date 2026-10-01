use super::*;
use crate::acp_client::recipes::{self, tests::official_row};

fn autohand_row(root: &Path, version: &str) -> AgentRow {
    let row = official_row(
        root,
        "registry:autohand",
        "@autohandai/autohand-acp",
        version,
    );
    std::fs::write(
        root.join("node_modules/@autohandai/autohand-acp/package.json"),
        serde_json::to_vec(&serde_json::json!({
            "name":"@autohandai/autohand-acp", "version":version,
            "bin":{"autohand-acp":"./dist/index.js"}
        }))
        .unwrap(),
    )
    .unwrap();
    row
}

#[test]
fn verified_npm_companion_without_a_minimum_does_not_invent_one() {
    let data = tempfile::tempdir().unwrap();
    let row = autohand_row(data.path(), "0.2.1");
    let declaration = dependencies(&row.id)
        .iter()
        .find(|declaration| declaration.id == "autohand-cli")
        .expect("the verified official companion recipe is present");
    assert!(
        recipes::verified_for(&row)
            .iter()
            .any(|item| item.id == declaration.id)
    );
    assert!(declaration.support.is_none());
    assert_eq!(
        npm_requirement(
            declaration,
            &row,
            recipes::component_version(&row).as_deref()
        )
        .unwrap(),
        None,
    );
}

#[test]
fn npm_installation_still_requires_the_current_verified_component() {
    let data = tempfile::tempdir().unwrap();
    let row = autohand_row(data.path(), "0.2.1");
    let declaration = dependencies(&row.id)
        .iter()
        .find(|declaration| declaration.id == "autohand-cli")
        .unwrap();
    let mut custom = row.clone();
    custom.source = "custom".into();
    let mut extra_args = row.clone();
    extra_args.args.push("--unverified".into());
    let mut mismatched_version = row.clone();
    mismatched_version.version = Some("0.2.2".into());
    for changed in [custom, extra_args, mismatched_version] {
        assert!(npm_requirement(declaration, &changed, Some("0.2.1")).is_err());
    }
    let unsupported = autohand_row(data.path(), "0.2.2");
    assert!(npm_requirement(declaration, &unsupported, Some("0.2.2")).is_err());
}

#[test]
fn declared_minimum_is_preserved_and_unknown_components_fail_before_staging() {
    let data = tempfile::tempdir().unwrap();
    let row = official_row(data.path(), "registry:pi-acp", "pi-acp", "0.0.34");
    let declaration = &dependencies(&row.id)[0];
    assert_eq!(
        npm_requirement(declaration, &row, Some("0.0.34")).unwrap(),
        Some(">=0.81.0"),
    );
    assert!(npm_requirement(declaration, &row, None).is_err());
    let unknown = official_row(data.path(), "registry:pi-acp", "pi-acp", "0.0.35");
    let store = MetaStore::open(&data.path().join("meta.db")).unwrap();
    store.insert_agent(&unknown).unwrap();
    let lease = crate::install_job::begin(
        "companion-unverified-before-staging",
        Channel::new(|_| Ok(())),
    )
    .unwrap();
    assert!(
        prepare_with_mode(
            &unknown.id,
            declaration.id,
            &store,
            data.path(),
            &lease.job,
            DependencyInstallMode::PrepareCandidate,
            &crate::node_runtime::NodeRuntimeState::new(data.path().into()),
        )
        .is_err()
    );
    assert_eq!(store.get_agent(&unknown.id).unwrap(), Some(unknown.clone()));
    assert!(store.get_setting("installations.v1").unwrap().is_none());
    assert!(!crate::managed_programs::parent(data.path(), &unknown.id).exists());
}
