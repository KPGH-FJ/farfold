//! Official program delivery at the final launch boundary. Never persists an
//! alternate command, edits Agent configuration, or changes the parent process.
use std::collections::HashMap;
use std::path::Path;

#[cfg(test)]
#[path = "dependency_environment_tests.rs"]
mod launch_tests;

#[cfg(all(test, windows))]
#[path = "dependency_environment_windows_tests.rs"]
mod windows_tests;

pub(crate) fn is_command_name(value: &str) -> bool {
    !value.is_empty()
        && !matches!(value, "." | "..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
}

fn search_path_program(
    selected: &Path,
    variable: &str,
    environment: &mut HashMap<String, String>,
) -> Result<(), String> {
    let invalid = || "所选程序的位置不能用于此次连接，请在程序管理中检查或安装所需程序".to_string();
    let name = selected
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(invalid)?;
    let parent = selected
        .parent()
        .and_then(|parent| parent.to_str())
        .ok_or_else(invalid)?;
    if !selected.is_absolute()
        || !is_command_name(name)
        || parent.contains(['\n', '\r', '\0'])
        || (cfg!(unix) && parent.contains(':'))
        || !crate::process_platform::executable(selected)
    {
        return Err(invalid());
    }
    // Preserve an explicitly empty PATH (including its cwd semantics). If the
    // merged environment has no entry, Command would inherit the process PATH.
    let previous = environment
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok());
    let mut paths = vec![std::path::PathBuf::from(parent)];
    if let Some(previous) = previous {
        paths.extend(std::env::split_paths(&previous));
    }
    let path = std::env::join_paths(paths).map_err(|_| invalid())?;
    environment.insert("PATH".into(), path.to_string_lossy().into_owned());
    environment.insert(variable.into(), name.into());
    Ok(())
}

pub(crate) fn apply(
    row: &crate::meta_store::AgentRow,
    cwd: &Path,
    environment: &mut HashMap<String, String>,
) -> Result<(), String> {
    for declaration in super::recipes::verified_for(row) {
        if !matches!(
            declaration.command_delivery,
            super::recipes::DependencyCommandDelivery::SearchPath
        ) {
            continue;
        }
        if let Some(selected) = environment.get(declaration.program_env).cloned() {
            let path = if is_command_name(&selected) {
                let search = environment
                    .get("PATH")
                    .cloned()
                    .or_else(|| std::env::var("PATH").ok());
                let directories = search
                    .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
                    .unwrap_or_default();
                crate::agent_discovery::find_binary(&selected, &directories)
                    .unwrap_or_else(|| selected.into())
            } else {
                selected.into()
            };
            if declaration.reject_cwd_name_collision
                && let Some(name) = path.file_name().and_then(|name| name.to_str())
                && is_command_name(name)
            {
                // This component interprets a cwd-relative namesake as a test
                // program. Check only existence; never inspect or alter it.
                match std::fs::metadata(cwd.join(name)) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Ok(_) => return Err("当前工作位置存在与所选程序同名的条目，无法确认账号状态；请更换工作位置后重试".into()),
                    Err(_) => return Err("无法检查当前工作位置，请确认可访问后重试".into()),
                }
            }
            search_path_program(&path, declaration.program_env, environment)?;
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn program(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            "#!/bin/sh\nprintf '%s\\n' \"$1\" \"$PUBLIC_MARKER\"\n",
        )
        .unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn registered_row(root: &Path) -> crate::meta_store::AgentRow {
        let row = super::super::recipes::tests::official_row(
            root,
            "registry:autohand",
            "@autohandai/autohand-acp",
            "0.2.1",
        );
        std::fs::write(root.join("node_modules/@autohandai/autohand-acp/package.json"), r#"{"name":"@autohandai/autohand-acp","version":"0.2.1","bin":{"autohand-acp":"dist/index.js"}}"#).unwrap();
        row
    }

    #[test]
    fn only_verified_components_resolve_a_command_against_the_final_path() {
        let directory = tempfile::tempdir().unwrap();
        let row = registered_row(directory.path());
        let selected = directory.path().join("Explicit Programs/launch-program");
        program(&selected);
        let path = format!("{}:/usr/bin:/bin", selected.parent().unwrap().display());
        let initial = HashMap::from([
            ("AUTOHAND_CMD".into(), "launch-program".into()),
            ("PATH".into(), path.clone()),
        ]);
        let mut unknown = row.clone();
        unknown.version = Some("0.2.2".into());
        let mut unchanged = initial.clone();
        apply(&unknown, directory.path(), &mut unchanged).unwrap();
        assert_eq!(unchanged, initial);
        let mut environment = initial;
        apply(&row, directory.path(), &mut environment).unwrap();
        assert_eq!(environment["AUTOHAND_CMD"], "launch-program");
        assert_eq!(
            environment["PATH"],
            format!("{}:{path}", selected.parent().unwrap().display())
        );
        assert!(row.env.is_empty());
    }

    #[test]
    fn final_explicit_missing_selection_cannot_use_a_path_namesake() {
        let directory = tempfile::tempdir().unwrap();
        let row = registered_row(directory.path());
        program(&directory.path().join("launch-program"));
        let mut environment = HashMap::from([
            (
                "AUTOHAND_CMD".into(),
                directory
                    .path()
                    .join("missing/launch-program")
                    .display()
                    .to_string(),
            ),
            ("PATH".into(), directory.path().display().to_string()),
        ]);
        let before = environment.clone();
        assert!(apply(&row, directory.path(), &mut environment).is_err());
        assert_eq!(environment, before);
    }

    #[test]
    fn selected_program_under_spaces_is_the_command_for_all_invocations() {
        let directory = tempfile::tempdir().unwrap();
        let selected = directory
            .path()
            .join("Application Support/selected/launch-program");
        program(&selected);
        let mut environment = HashMap::from([
            ("AUTOHAND_CMD".into(), selected.display().to_string()),
            ("PATH".into(), "/explicit/bin::/usr/bin:/bin".into()),
            ("PUBLIC_MARKER".into(), "fixture-only".into()),
        ]);
        search_path_program(&selected, "AUTOHAND_CMD", &mut environment).unwrap();
        assert_eq!(environment["AUTOHAND_CMD"], "launch-program");
        assert_eq!(
            environment["PATH"],
            format!(
                "{}:/explicit/bin::/usr/bin:/bin",
                selected.parent().unwrap().display()
            )
        );
        for argument in ["--version", "--prompt", "--resume"] {
            let output = std::process::Command::new(&environment["AUTOHAND_CMD"])
                .arg(argument)
                .envs(&environment)
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                format!("{argument}\nfixture-only\n")
            );
        }
    }

    #[test]
    fn cwd_namesake_cannot_trigger_the_components_stub_account_bypass() {
        let directory = tempfile::tempdir().unwrap();
        let row = registered_row(directory.path());
        let selected = directory.path().join("owned/launch-program");
        program(&selected);
        for kind in ["file", "directory", "symlink"] {
            let cwd = directory.path().join(kind);
            std::fs::create_dir(&cwd).unwrap();
            let collision = cwd.join("launch-program");
            match kind {
                "file" => std::fs::write(&collision, "public fixture").unwrap(),
                "directory" => std::fs::create_dir(&collision).unwrap(),
                _ => std::os::unix::fs::symlink(&selected, &collision).unwrap(),
            }
            let mut environment = HashMap::from([
                ("AUTOHAND_CMD".into(), selected.display().to_string()),
                ("PATH".into(), "/usr/bin:/bin".into()),
            ]);
            let before = environment.clone();
            assert!(apply(&row, &cwd, &mut environment).is_err(), "{kind}");
            assert_eq!(environment, before);
            assert!(collision.exists());
        }
    }

    #[test]
    fn explicit_empty_path_is_preserved_after_the_selected_directory() {
        let directory = tempfile::tempdir().unwrap();
        let selected = directory.path().join("launch-program");
        program(&selected);
        let mut environment = HashMap::from([("PATH".into(), String::new())]);
        search_path_program(&selected, "PROGRAM", &mut environment).unwrap();
        assert_eq!(
            environment["PATH"],
            format!("{}:", directory.path().display())
        );
    }

    #[test]
    fn invalid_selection_never_falls_back_or_partially_changes_environment() {
        let directory = tempfile::tempdir().unwrap();
        for suffix in [
            "space name",
            "quote'name",
            "double\"name",
            "back\\name",
            "line\nname",
            "colon:directory/launch-program",
        ] {
            let selected = directory.path().join(suffix);
            program(&selected);
            let mut environment = HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]);
            let before = environment.clone();
            assert!(
                search_path_program(&selected, "PROGRAM", &mut environment).is_err(),
                "{suffix}"
            );
            assert_eq!(environment, before);
        }
        for selected in [
            Path::new("relative/program"),
            directory.path(),
            &directory.path().join("missing"),
        ] {
            let mut environment = HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]);
            let before = environment.clone();
            assert!(search_path_program(selected, "PROGRAM", &mut environment).is_err());
            assert_eq!(environment, before);
        }
    }

    #[test]
    fn non_executable_selected_program_is_rejected_before_lookup() {
        let directory = tempfile::tempdir().unwrap();
        let selected = directory.path().join("launch-program");
        program(&selected);
        std::fs::set_permissions(&selected, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(search_path_program(&selected, "PROGRAM", &mut HashMap::new()).is_err());
    }
}
