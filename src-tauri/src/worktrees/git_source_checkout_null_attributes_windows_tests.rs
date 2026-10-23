//! Selected official-Git controls; only the child receives an owned XDG root.
use super::*;
use std::{ffi::OsStr, time::Instant};

const CHILD: &str = "worktrees::git::source_roots::profile::tests::null_attributes::owned_xdg_global_attributes_child";
const OWNER: &[u8] = b"Farfold owned null-attributes regression v1\n";

fn local_setting(f: &Fixture, raw: &str) {
    let quoted = raw.replace('\\', "\\\\").replace('"', "\\\"");
    configure(f, &format!("\n[core]\n attributesFile = \"{quoted}\"\n"));
}

fn selected_attributes(f: &Fixture) -> Snapshot {
    for (id, bytes) in [
        (CACHED_ATTRIBUTES_BLOB, CACHED_ATTRIBUTES_BLOB_LOOSE),
        (CACHED_ATTRIBUTES_TREE, CACHED_ATTRIBUTES_TREE_LOOSE),
        (CACHED_ATTRIBUTES_COMMIT, CACHED_ATTRIBUTES_COMMIT_LOOSE),
    ] {
        let directory = common(f).join("objects").join(&id[..2]);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(&id[2..]), bytes).unwrap();
    }
    fs::write(
        common(f).join("refs/heads/public"),
        format!("{CACHED_ATTRIBUTES_COMMIT}\n"),
    )
    .unwrap();
    fs::write(
        f.root.join(".gitattributes"),
        b"owned.txt -text eol=crlf filter=must-not-run\n",
    )
    .unwrap();
    fs::create_dir(common(f).join("info")).unwrap();
    fs::write(
        common(f).join("info/attributes"),
        b"owned.txt farfoldinfo=held\n",
    )
    .unwrap();
    let mut snapshot = f.snapshot();
    snapshot.head = Some(CACHED_ATTRIBUTES_COMMIT.into());
    snapshot
}

fn policy(
    evaluator: &evaluator::Evaluator<'_>,
    external: Option<inputs::GlobalAttributes<'_>>,
    expected_system_suppressed: bool,
    expected_global: Option<&str>,
) {
    let command = evaluator
        .attribute_command_policy(external, &AtomicBool::new(false))
        .unwrap();
    let system = command
        .environment
        .iter()
        .find(|(k, _)| k == OsStr::new("GIT_ATTR_NOSYSTEM"));
    assert_eq!(system.is_some(), expected_system_suppressed);
    if let Some((_, value)) = system {
        assert_eq!(value.as_deref(), Some(OsStr::new("1")));
    }
    // Config isolation must not be mistaken for suppression of system attributes.
    for (key, expected) in [
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_CONFIG_GLOBAL", "/dev/null"),
    ] {
        let value = command
            .environment
            .iter()
            .find(|(k, _)| k == OsStr::new(key))
            .unwrap();
        assert_eq!(value.1.as_deref(), Some(OsStr::new(expected)));
    }
    let globals = command
        .arguments
        .windows(2)
        .filter(|pair| pair[0] == OsStr::new("-c"))
        .filter_map(|pair| {
            pair[1]
                .to_str()
                .and_then(|v| v.strip_prefix("core.attributesFile="))
        })
        .collect::<Vec<_>>();
    assert_eq!(globals, expected_global.into_iter().collect::<Vec<_>>());
}

#[test]
fn actual_attribute_command_keeps_system_policy_separate_and_file_pin_live() {
    let f = Fixture::new();
    let configured = f.root.join("owned.attributes");
    fs::write(&configured, b"owned.txt farfoldexplicit=file\n").unwrap();
    local_setting(&f, "owned.attributes");
    let cancel = AtomicBool::new(false);
    let graph = SourceGraph::capture(&f.snapshot(), &cancel).unwrap();
    let observed = inputs::Inputs::capture(graph.owner.as_ref(), &cancel).unwrap();
    let inputs::GlobalAttributes::File(source) = observed.attr_source().unwrap() else {
        panic!("an explicit existing file must retain its held source");
    };
    let evaluator =
        evaluator::Evaluator::new(graph.owner.as_ref(), &observed.configs, &cancel).unwrap();
    policy(
        &evaluator,
        Some(inputs::GlobalAttributes::Default),
        false,
        None,
    );
    policy(
        &evaluator,
        Some(inputs::GlobalAttributes::Disabled),
        false,
        Some("/dev/null"),
    );
    policy(&evaluator, None, true, Some("/dev/null"));
    let paths = crate::worktrees::windows_git::paths::Paths::new(&[source.anchor()]).unwrap();
    let held_path = source.git_path(&paths).unwrap();
    policy(
        &evaluator,
        Some(inputs::GlobalAttributes::File(source)),
        false,
        Some(held_path.to_str().unwrap()),
    );
    assert!(
        fs::OpenOptions::new()
            .write(true)
            .open(&configured)
            .is_err()
    );
    paths.verify().unwrap();
    source.verify().unwrap();
    observed.verify(graph.owner.as_ref(), &cancel).unwrap();
}

#[test]
fn actual_null_lookalikes_keep_rooted_and_drive_relative_paths_rejected() {
    for raw in ["/DEV/NULL", "/dev/null/", "\\dev\\null", "C:NUL", "NUL:"] {
        let f = Fixture::new();
        local_setting(&f, raw);
        let before = f.bytes();
        let config_before = fs::read(common(&f).join("config")).unwrap();
        let cancel = AtomicBool::new(false);
        let graph = SourceGraph::capture(&f.snapshot(), &cancel).unwrap();
        assert_eq!(
            inputs::Inputs::capture(graph.owner.as_ref(), &cancel)
                .err()
                .unwrap()
                .code,
            "unsafePath",
            "{raw:?}"
        );
        assert_eq!(f.bytes(), before);
        assert_eq!(fs::read(common(&f).join("config")).unwrap(), config_before);
    }
}

#[test]
fn actual_owned_xdg_defaults_disabled_missing_file_and_raw_changes() {
    // Do not mutate the process-global environment or create a private HOME.
    // The fixed child is the only process with this owned standard XDG input.
    let temp = tempfile::Builder::new()
        .prefix("farfold-null-attributes-")
        .tempdir()
        .unwrap();
    let xdg = temp.path().canonicalize().unwrap().join("xdg");
    fs::create_dir_all(xdg.join("git")).unwrap();
    fs::write(xdg.join("owner"), OWNER).unwrap();
    fs::write(xdg.join("git/config"), b"").unwrap();
    fs::write(xdg.join("git/attributes"), b"owned.txt farfoldglobal=xdg\n").unwrap();
    let mut log = tempfile::tempfile().unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            CHILD,
            "--exact",
            "--ignored",
            "--test-threads=1",
            "--nocapture",
        ])
        .env("XDG_CONFIG_HOME", &xdg)
        .stdout(log.try_clone().unwrap())
        .stderr(log.try_clone().unwrap())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(240);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(cause) => {
                let _ = child.kill();
                let _ = temp.keep();
                panic!("owned XDG child completion unknown: {cause}");
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            // Forced termination is not proof that all child work settled.
            // Retain this exact owned directory for runner-job cleanup.
            let _ = temp.keep();
            // Only observe the original child for a bounded termination grace.
            let grace = Instant::now() + Duration::from_secs(2);
            while matches!(child.try_wait(), Ok(None)) && Instant::now() < grace {
                std::thread::sleep(Duration::from_millis(10));
            }
            panic!("owned XDG attribute child deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    log.rewind().unwrap();
    let mut text = String::new();
    (&mut log).take(262_144).read_to_string(&mut text).unwrap();
    assert!(
        log.metadata().unwrap().len() <= 262_144,
        "owned child log exceeded read bound"
    );
    assert!(
        status.success() && text.contains("FARFOLD_NULL_ATTRIBUTES_CHILD_COMPLETED"),
        "{status}: {text}"
    );
    eprintln!("{text}");
}

#[test]
#[ignore = "Fixed child of actual_owned_xdg_defaults_disabled_missing_file_and_raw_changes"]
fn owned_xdg_global_attributes_child() {
    let xdg = PathBuf::from(std::env::var_os("XDG_CONFIG_HOME").expect("owned XDG child required"));
    assert!(xdg.is_absolute());
    assert_eq!(xdg.file_name().unwrap(), "xdg");
    let parent = xdg.parent().unwrap();
    assert!(
        parent
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("farfold-null-attributes-")
    );
    assert_eq!(
        parent.parent().unwrap().canonicalize().unwrap(),
        std::env::temp_dir().canonicalize().unwrap()
    );
    assert!(!fs::symlink_metadata(&xdg).unwrap().file_type().is_symlink());
    assert_eq!(fs::read(xdg.join("owner")).unwrap(), OWNER);
    assert_eq!(fs::read(xdg.join("git/config")).unwrap(), b"");
    let global_before = fs::read(xdg.join("git/attributes")).unwrap();
    assert_eq!(global_before, b"owned.txt farfoldglobal=xdg\n");
    git::environment().unwrap();
    let cancel = AtomicBool::new(false);
    for setting in [
        None,
        Some("/dev/null"),
        Some("NUL"),
        Some("NuL"),
        Some("absent.attributes"),
        Some("owned.attributes"),
    ] {
        let f = Fixture::new();
        let snapshot = selected_attributes(&f);
        fs::write(
            f.root.join("owned.attributes"),
            b"owned.txt farfoldexplicit=file\n",
        )
        .unwrap();
        if let Some(raw) = setting {
            local_setting(&f, raw);
        }
        let before = f.bytes();
        let config_before = fs::read(common(&f).join("config")).unwrap();
        let dirty_before = fs::read(f.root.join(".gitattributes")).unwrap();
        let info_before = fs::read(common(&f).join("info/attributes")).unwrap();
        let graph = SourceGraph::capture(&snapshot, &cancel).unwrap();
        let observed = inputs::Inputs::capture(graph.owner.as_ref(), &cancel).unwrap();
        // Fail explicitly if another effective config shadows the owned fixture.
        assert_eq!(
            observed.attr_path.as_deref(),
            setting,
            "owned config provenance {setting:?}"
        );
        match setting {
            None => assert!(matches!(
                observed.attr_source().unwrap(),
                inputs::GlobalAttributes::Default
            )),
            Some("/dev/null" | "NUL" | "NuL") => assert!(matches!(
                observed.attr_source().unwrap(),
                inputs::GlobalAttributes::Disabled
            )),
            _ => assert!(matches!(
                observed.attr_source().unwrap(),
                inputs::GlobalAttributes::File(_)
            )),
        }
        let (configs, profile) = graph.checkout_profile(&cancel).unwrap();
        // Re-consume the actual profile through the selected official Git.
        let mut mirror =
            evaluator::Evaluator::new(graph.owner.as_ref(), &configs, &cancel).unwrap();
        let paths = mirror.paths(&cancel).unwrap();
        mirror
            .install(evaluator::Role::Mirror, &profile, &cancel)
            .unwrap();
        let attrs = mirror
            .attributes(evaluator::Role::Mirror, &paths, None, &cancel)
            .unwrap();
        let owned = attrs.get(b"owned.txt".as_slice()).unwrap();
        assert_eq!(owned.get("text").map(String::as_str), Some("set"));
        assert_eq!(owned.get("eol").map(String::as_str), Some("lf"));
        assert_eq!(owned.get("filter").map(String::as_str), Some("unset"));
        assert_eq!(owned.get("farfoldinfo").map(String::as_str), Some("held"));
        assert_eq!(
            owned.get("farfoldglobal").map(String::as_str),
            if setting.is_none() { Some("xdg") } else { None }
        );
        assert_eq!(
            owned.get("farfoldexplicit").map(String::as_str),
            if setting == Some("owned.attributes") {
                Some("file")
            } else {
                None
            }
        );
        assert!(!f.root.join("absent.attributes").exists());
        observed.verify(graph.owner.as_ref(), &cancel).unwrap();
        graph.recheck(&cancel).unwrap();
        assert_eq!(f.bytes(), before);
        assert_eq!(fs::read(common(&f).join("config")).unwrap(), config_before);
        assert_eq!(
            fs::read(f.root.join(".gitattributes")).unwrap(),
            dirty_before
        );
        assert_eq!(
            fs::read(common(&f).join("info/attributes")).unwrap(),
            info_before
        );
        assert_eq!(
            fs::read(f.root.join("owned.attributes")).unwrap(),
            b"owned.txt farfoldexplicit=file\n"
        );
        assert_eq!(fs::read(xdg.join("git/attributes")).unwrap(), global_before);
        eprintln!("NULL_ATTRIBUTES_MATRIX:{setting:?}");
    }
    for (before, after) in [
        (Some("/dev/null"), Some("NUL")),
        (Some("NUL"), Some("NuL")),
        (Some("/dev/null"), None),
    ] {
        let contents = |value: Option<&str>| {
            value
                .map(|v| format!("[core]\n attributesFile = {v}\n"))
                .unwrap_or_default()
        };
        fs::write(xdg.join("git/config"), contents(before)).unwrap();
        let f = Fixture::new();
        let graph = SourceGraph::capture(&f.snapshot(), &cancel).unwrap();
        let observed = inputs::Inputs::capture(graph.owner.as_ref(), &cancel).unwrap();
        assert_eq!(observed.attr_path.as_deref(), before);
        observed.verify(graph.owner.as_ref(), &cancel).unwrap();
        // Only the parent's owned XDG config changes; held source files stay pinned.
        fs::write(xdg.join("git/config"), contents(after)).unwrap();
        assert_eq!(
            observed
                .verify(graph.owner.as_ref(), &cancel)
                .unwrap_err()
                .code,
            "changed"
        );
        let fresh = inputs::Inputs::capture(graph.owner.as_ref(), &cancel).unwrap();
        assert_eq!(fresh.attr_path.as_deref(), after);
        fresh.verify(graph.owner.as_ref(), &cancel).unwrap();
        eprintln!("NULL_ATTRIBUTES_RAW_CHANGE:{before:?}->{after:?}");
    }
    fs::write(xdg.join("git/config"), b"").unwrap();
    eprintln!("FARFOLD_NULL_ATTRIBUTES_CHILD_COMPLETED");
}
