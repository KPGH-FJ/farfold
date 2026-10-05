//! Windows PATH/selection checks do not execute the selected program.
use super::*;

#[test]
fn drive_paths_with_spaces_are_delivered_without_shell_or_lost_path_entries() {
    let root = tempfile::tempdir().unwrap();
    let selected = root.path().join("Programs with spaces/launch-program.exe");
    std::fs::create_dir_all(selected.parent().unwrap()).unwrap();
    std::fs::write(&selected, "fixture not executed").unwrap();
    let selected = selected.canonicalize().unwrap();
    let previous = std::env::join_paths([Path::new(r"C:\Other Programs"), Path::new("")]).unwrap();
    let mut env = HashMap::from([("PATH".into(), previous.to_string_lossy().into_owned())]);
    search_path_program(&selected, "PROGRAM", &mut env).unwrap();
    assert_eq!(env["PROGRAM"], "launch-program.exe");
    let paths: Vec<_> = std::env::split_paths(&env["PATH"]).collect();
    assert_eq!(
        paths,
        [
            selected.parent().unwrap().to_path_buf(),
            r"C:\Other Programs".into(),
            "".into()
        ]
    );
}

#[test]
fn an_invalid_windows_selection_never_mutates_environment() {
    let root = tempfile::tempdir().unwrap();
    let unsupported = root.path().join("launch.ps1");
    std::fs::write(&unsupported, "fixture").unwrap();
    for selected in [
        Path::new(r"relative\program.exe"),
        root.path(),
        unsupported.as_path(),
    ] {
        let mut env = HashMap::from([("PATH".into(), r"C:\Previous".into())]);
        let before = env.clone();
        assert!(search_path_program(selected, "PROGRAM", &mut env).is_err());
        assert_eq!(env, before);
    }
}
