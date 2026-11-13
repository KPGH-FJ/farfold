#![cfg(target_os = "macos")]
use super::*;
use crate::{installations::Installation, meta_store::AgentRow};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
pub(super) struct Fixture {
    pub _root: tempfile::TempDir,
    pub root: PathBuf,
    pub row: AgentRow,
    pub receipt: Installation,
}
fn wrapper(python: &Path, module: &str) -> String {
    format!(
        "#!/bin/sh\n'''exec' '{}' \"$0\" \"$@\"\n' '''\n# -*- coding: utf-8 -*-\nimport sys\nfrom {module} import main\nif __name__ == \"__main__\":\n    sys.exit(main())\n",
        python.display()
    )
}
fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}
impl Fixture {
    pub fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let bin = root.join("venv/bin");
        let python = bin.join("python");
        write(&python, "#!/bin/sh\nexit 0\n");
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
        let command = bin.join("fast-agent-acp");
        write(&command, &wrapper(&python, "fast_agent.cli.commands.acp"));
        let companion = bin.join("fast-agent");
        write(&companion, &wrapper(&python, "fast_agent.cli.__main__"));
        std::fs::set_permissions(&companion, std::fs::Permissions::from_mode(0o755)).unwrap();
        let packages = root.join("venv/lib/python3.12/site-packages");
        let dist = packages.join("fast_agent_mcp-arbitrary.dist-info");
        write(
            &dist.join("METADATA"),
            "Name: fast-agent-mcp\nVersion: arbitrary\n",
        );
        write(
            &dist.join("entry_points.txt"),
            "[console_scripts]\nfast-agent = fast_agent.cli.__main__:main\nfast-agent-acp = fast_agent.cli.commands.acp:main\n",
        );
        write(&root.join("venv/pyvenv.cfg"), "controlled fixture\n");
        for m in [
            "cli/__main__.py",
            "cli/commands/acp.py",
            "cli/commands/export.py",
            "session/trace_exporter.py",
            "session/trace_export_codex.py",
        ] {
            write(
                &packages.join("fast_agent").join(m),
                "# controlled public fixture\n",
            );
        }
        let row = AgentRow {
            id: "registry:fast-agent".into(),
            source: "registry".into(),
            name: "fixture".into(),
            command: command.to_string_lossy().into_owned(),
            args: vec!["-x".into()],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        let receipt = Installation {
            id: "fixture-receipt".into(),
            agent_id: row.id.clone(),
            path: root.to_string_lossy().into_owned(),
            command: row.command.clone(),
            args: row.args.clone(),
            version: None,
            source: "managed".into(),
            managed_root: Some(root.to_string_lossy().into_owned()),
            program_only: false,
            node_launch: None,
            release: None,
        };
        Self {
            _root: tmp,
            root,
            row,
            receipt,
        }
    }
    pub fn source(&self) -> Source {
        Source::capture(&self.row).unwrap()
    }
    fn resolve(&self) -> Result<launch::Resolved> {
        launch::resolve(
            &self.source(),
            &self.row,
            std::slice::from_ref(&self.receipt),
        )
    }
}
#[test]
fn declaration_requires_receipt_and_both_public_console_entries_without_version_gate() {
    let f = Fixture::new();
    assert!(f.resolve().is_ok());
    assert!(launch::resolve(&f.source(), &f.row, &[]).is_err());
    let mut wrong = f.receipt.clone();
    wrong.command = "/other/same-name/fast-agent-acp".into();
    assert!(launch::resolve(&f.source(), &f.row, &[wrong]).is_err());
    let p = f.root.join(
        "venv/lib/python3.12/site-packages/fast_agent_mcp-arbitrary.dist-info/entry_points.txt",
    );
    write(
        &p,
        "[console_scripts]\nfast-agent = another.module:main\nfast-agent-acp = fast_agent.cli.commands.acp:main\n",
    );
    assert!(f.resolve().is_err());
}
#[test]
fn ambiguous_package_duplicate_receipt_or_untrusted_wrapper_are_not_sibling_authority() {
    let f = Fixture::new();
    assert!(launch::resolve(&f.source(), &f.row, &[f.receipt.clone(), f.receipt.clone()]).is_err());
    write(
        &f.root.join("venv/bin/fast-agent"),
        "#!/bin/sh\nexec other-export\n",
    );
    assert!(f.resolve().is_err());
    let f = Fixture::new();
    std::fs::create_dir_all(
        f.root
            .join("venv/lib/python3.12/site-packages/fast_agent_mcp-other.dist-info"),
    )
    .unwrap();
    assert!(f.resolve().is_err());
}
#[test]
fn immutable_launch_rejects_registry_argument_environment_or_file_drift() {
    let f = Fixture::new();
    let source = f.source();
    for row in [
        AgentRow {
            command: "/other/fast-agent-acp".into(),
            ..f.row.clone()
        },
        AgentRow {
            args: vec!["--unreviewed".into()],
            ..f.row.clone()
        },
        AgentRow {
            env: vec![("NEW".into(), "ordinary".into())],
            ..f.row.clone()
        },
    ] {
        assert_eq!(source.current(&row).unwrap_err(), Reason::Changed);
    }
    let resolved = f.resolve().unwrap();
    write(&f.root.join("venv/bin/fast-agent"), "changed");
    assert!(resolved.current().is_err());
}
#[test]
fn companion_symlink_is_rejected_without_reading_its_target() {
    let f = Fixture::new();
    let companion = f.root.join("venv/bin/fast-agent");
    std::fs::remove_file(&companion).unwrap();
    std::os::unix::fs::symlink("/does-not-exist", companion).unwrap();
    assert!(f.resolve().is_err());
}
#[test]
fn source_and_args_are_admission_facts_not_a_basename_guess() {
    let f = Fixture::new();
    assert!(
        Source::capture(&AgentRow {
            source: "custom".into(),
            ..f.row.clone()
        })
        .is_none()
    );
    assert!(
        Source::capture(&AgentRow {
            args: vec![],
            ..f.row.clone()
        })
        .is_none()
    );
    assert!(
        Source::capture(&AgentRow {
            command: "fast-agent-acp".into(),
            ..f.row.clone()
        })
        .is_none()
    );
}

#[test]
fn unknown_inherited_python_injection_is_not_treated_as_an_absent_value() {
    use std::os::unix::ffi::OsStringExt;
    let f = Fixture::new();
    assert!(
        launch::selected_environment(&f.row, Default::default(), |name| (name == "PYTHONPATH")
            .then(|| std::ffi::OsString::from_vec(vec![0xff])))
        .is_err()
    );
    let row = AgentRow {
        env: vec![("TOKEN".into(), crate::auth::KEYCHAIN_MARKER.into())],
        ..f.row.clone()
    };
    assert!(launch::selected_environment(&row, Default::default(), |_| None).is_err());
    let row = AgentRow {
        env: vec![("ORDINARY".into(), "same-value".into())],
        ..f.row.clone()
    };
    let env = launch::selected_environment(&row, Default::default(), |_| None).unwrap();
    assert_eq!(env["ORDINARY"], "same-value");
}

#[test]
fn public_metadata_changed_after_validation_cannot_borrow_a_new_stamp() {
    let f = Fixture::new();
    let path = f.root.join("public-metadata");
    write(&path, "reviewed declaration");
    let mut watched = Vec::new();
    launch::validated(&path, &mut watched, |bytes| {
        assert_eq!(bytes, "reviewed declaration");
        write(&path, "different unreviewed declaration");
        Ok(())
    })
    .unwrap();
    assert_eq!(
        launch::watched_current(&watched).unwrap_err(),
        Reason::Changed
    );
}
