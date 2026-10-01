use super::*;
use std::os::unix::fs::PermissionsExt;

fn autohand(root: &Path, version: &str) -> AgentRow {
    let mut row = super::super::recipes::tests::official_row(
        root,
        "registry:autohand",
        "@autohandai/autohand-acp",
        "0.2.1",
    );
    let program = root.join("selected-program");
    std::fs::write(&program, format!("#!/bin/sh\nprintf '%s\\n' '{version}'\n")).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    row.env
        .push(("AUTOHAND_CMD".into(), program.display().to_string()));
    row
}

#[test]
fn npm_companion_versions_and_candidate_are_visible_without_a_minimum() {
    let root = tempfile::tempdir().unwrap();
    let row = autohand(root.path(), "0.9.8");
    let info = preparation_info(&row.id, Some(&row), root.path()).unwrap();
    assert_eq!(info.dependencies.len(), 1);
    let dependency = &info.dependencies[0];
    assert_eq!(dependency.status, DependencyStatus::Ready);
    assert!(dependency.required_for_use);
    let diagnostic = dependency.version_diagnostic.as_ref().unwrap();
    assert_eq!(diagnostic.program_version.as_deref(), Some("0.9.8"));
    assert_eq!(diagnostic.component_version.as_deref(), Some("0.2.1"));
    assert!(diagnostic.version_requirement.is_none());
    assert!(diagnostic.can_install_candidate);
    let value = serde_json::to_value(dependency).unwrap();
    assert_eq!(value["versionRequirement"], serde_json::Value::Null);
    assert_eq!(value["canInstallCandidate"], true);
    assert!(dependency.managed_location.contains("companion-programs"));
    assert!(!dependency.managed_location.contains("registry:autohand"));
}

#[test]
fn unverified_scoped_component_has_no_install_or_use_gate_or_environment_supplement() {
    let root = tempfile::tempdir().unwrap();
    let mut row = autohand(root.path(), "0.9.8");
    row.version = Some("0.2.2".into());
    row.env.clear();
    row.env.push((
        "AUTOHAND_CMD".into(),
        root.path().join("missing").display().to_string(),
    ));
    let original = row.clone();
    apply_dependency_env(&mut row);
    assert_eq!(row, original);
    assert!(require_dependencies(&row).is_ok());
    let info = preparation_info(&row.id, Some(&row), root.path()).unwrap();
    assert_eq!(info.dependencies.len(), 1);
    let dependency = &info.dependencies[0];
    assert!(!dependency.installable);
    assert!(!dependency.required_for_use);
    let diagnostic = dependency.version_diagnostic.as_ref().unwrap();
    assert!(diagnostic.version_requirement.is_none());
    assert!(!diagnostic.can_install_candidate);
}

#[test]
fn selected_missing_autohand_never_uses_another_program_or_mutates_the_selection() {
    let root = tempfile::tempdir().unwrap();
    let mut row = autohand(root.path(), "0.9.8");
    row.env[0].1 = root
        .path()
        .join("missing-selected-program")
        .display()
        .to_string();
    let original = row.clone();
    apply_dependency_env(&mut row);
    assert_eq!(row, original);
    assert!(require_dependencies(&row).is_err());
    let declaration = &dependencies(&row.id)[0];
    assert_eq!(
        resolve_in(
            declaration,
            Some(&row),
            &[root.path().into()],
            None,
            Some("/bin/sh")
        ),
        Some(PathBuf::from(&original.env[0].1))
    );
    let info = preparation_info(&row.id, Some(&row), root.path()).unwrap();
    assert_eq!(info.dependencies[0].status, DependencyStatus::Failed);
    assert!(!info.dependencies[0].installable);
    assert!(
        info.dependencies[0]
            .version_diagnostic
            .as_ref()
            .unwrap()
            .can_install_candidate
    );
}

#[test]
fn search_path_commands_use_the_explicit_path_without_falling_back_to_the_declared_name() {
    let root = tempfile::tempdir().unwrap();
    let mut row = autohand(root.path(), "0.9.8");
    let command = root.path().join("custom-command");
    std::fs::copy(&row.env[0].1, &command).unwrap();
    row.env[0].1 = "custom-command".into();
    row.env
        .push(("PATH".into(), root.path().display().to_string()));
    let declaration = &dependencies(&row.id)[0];
    assert_eq!(
        resolve_dependency(declaration, Some(&row)),
        Some(command.clone())
    );
    assert!(require_dependencies(&row).is_ok());
    assert_eq!(
        resolve_in(
            declaration,
            None,
            &[root.path().into()],
            None,
            Some("custom-command")
        ),
        Some(command)
    );
    let fallback = root.path().join("autohand");
    std::fs::write(&fallback, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&fallback, std::fs::Permissions::from_mode(0o755)).unwrap();
    row.env[0].1 = "missing-selected-command".into();
    assert_eq!(
        resolve_dependency(declaration, Some(&row)),
        Some(PathBuf::from("missing-selected-command"))
    );
    assert!(require_dependencies(&row).is_err());
    row.env[0].1 = "custom-command".into();
    row.env[1].1.clear();
    assert_eq!(
        resolve_dependency(declaration, Some(&row)),
        Some(PathBuf::from("custom-command"))
    );
}

#[test]
fn unknown_npm_component_never_claims_an_install_candidate() {
    let root = tempfile::tempdir().unwrap();
    let mut row = autohand(root.path(), "0.9.8");
    row.version = None;
    let info = preparation_info(&row.id, Some(&row), root.path()).unwrap();
    assert!(!info.dependencies[0].installable);
    assert!(!info.dependencies[0].required_for_use);
    assert!(
        !info.dependencies[0]
            .version_diagnostic
            .as_ref()
            .unwrap()
            .can_install_candidate
    );
    assert!(require_dependencies(&row).is_ok());
}
