//! Own local Git fixtures through the production inspect/adopt/preparation path.
use super::*;
use crate::worktrees::{git, tests::op};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

fn fixture_git(root: &Path, args: &[&str]) {
    let hooks = root.join(".fixture-no-hooks");
    fs::write(&hooks, "").unwrap();
    let mut command = Command::new("git.exe");
    command
        .arg("-C")
        .arg(root)
        .args([
            "--no-pager",
            "--no-replace-objects",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "maintenance.auto=false",
            "-c",
            "gc.auto=0",
            "-c",
            "credential.helper=",
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
        ])
        .arg("-c")
        .arg(format!("core.hooksPath={}", hooks.display()))
        .args(args)
        .stdin(Stdio::null());
    let output =
        git::execute_command(command, &AtomicBool::new(false), Duration::from_secs(10)).unwrap();
    assert!(output.success, "owned Git fixture command failed");
}

struct Fixture {
    _root: tempfile::TempDir,
    path: PathBuf,
    manager: Worktrees,
    store: MetaStore,
    location: Location,
}
impl Fixture {
    fn new(linked: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let main = root.path().join("main repository");
        fs::create_dir(&main).unwrap();
        fixture_git(&main, &["init", "-q"]);
        fs::write(main.join("owned.txt"), "unchanged\n").unwrap();
        fixture_git(&main, &["add", "owned.txt"]);
        fixture_git(&main, &["commit", "-qm", "fixture"]);
        let path = if linked {
            let path = root.path().join("linked tree");
            fixture_git(
                &main,
                &[
                    "worktree",
                    "add",
                    "-qb",
                    "fixture-linked",
                    path.to_str().unwrap(),
                ],
            );
            path
        } else {
            main
        };
        let manager = Worktrees::default();
        let store = crate::worktrees::tests::store();
        let inspection = manager.inspect(&store, path.to_str().unwrap()).unwrap();
        let selected = crate::worktrees::inspect::canonical(&path).unwrap();
        let location = op(manager
            .adopt(
                &store,
                crate::worktrees::tests::OP,
                &inspection.inspection_id,
                &selected,
            )
            .unwrap())
        .location
        .unwrap();
        Self {
            _root: root,
            path,
            manager,
            store,
            location,
        }
    }
    fn saved(&self) -> SavedLocation {
        self.manager
            .lock()
            .unwrap()
            .doc
            .locations
            .iter()
            .find(|v| v.location.id == self.location.id)
            .unwrap()
            .clone()
    }
}

#[test]
fn windows_preparation_inspects_and_validates_main_and_linked_without_persisting_readiness() {
    for linked in [false, true] {
        let fixture = Fixture::new(linked);
        fs::create_dir_all(fixture.path.join("packages/app")).unwrap();
        fs::write(
            fixture.path.join("packages/app/package.json"),
            "PRIVATE_BODY_NOT_JSON",
        )
        .unwrap();
        fs::create_dir(fixture.path.join("packages/app/node_modules")).unwrap();
        let before = fixture.store.worktree_raw().unwrap();
        let receipt = fixture
            .manager
            .preparation_inspect(
                &fixture.store,
                &fixture.location.id,
                fixture.location.revision,
                "packages/app",
            )
            .unwrap();
        assert_eq!(
            receipt.project_path,
            format!("{}/packages/app", fixture.location.path)
        );
        assert_eq!(receipt.project_relative_path, "packages/app");
        assert_eq!(receipt.location, fixture.location);
        assert_eq!(receipt.coverage.checked_names, 22);
        assert!(receipt.coverage.complete);
        assert_eq!(receipt.git.kind, if linked { "linked" } else { "main" });
        assert_eq!(receipt.facts.len(), 22);
        let kind = |name: &str| {
            receipt
                .facts
                .iter()
                .find(|f| f.name == name)
                .unwrap()
                .node_kind
        };
        assert_eq!(kind("package.json"), PreparationNodeKind::File);
        assert_eq!(kind("node_modules"), PreparationNodeKind::Directory);
        assert_eq!(kind("go.mod"), PreparationNodeKind::Missing);
        let wire = serde_json::to_string(&receipt).unwrap();
        assert!(!wire.contains("PRIVATE_BODY_NOT_JSON"));
        assert!(
            fixture
                .manager
                .preparation_validate(&fixture.store, &receipt.inspection_id)
                .unwrap()
                .valid
        );
        assert_eq!(fixture.store.worktree_raw().unwrap(), before);
    }
}

#[test]
fn windows_preparation_detects_leaf_replacement_without_blocking_namespace_changes() {
    let fixture = Fixture::new(false);
    let path = fixture.path.join("package.json");
    fs::write(&path, "before").unwrap();
    let receipt = fixture
        .manager
        .preparation_inspect(
            &fixture.store,
            &fixture.location.id,
            fixture.location.revision,
            "",
        )
        .unwrap();
    // Rename remains possible. FILE_SHARE_DELETE means this alone cannot prove
    // that no handle exists; the ticket's data-only types establish that scope.
    fs::rename(&path, fixture.path.join("previous-package")).unwrap();
    fs::write(&path, "before").unwrap();
    assert_eq!(
        fixture
            .manager
            .preparation_validate(&fixture.store, &receipt.inspection_id)
            .unwrap_err()
            .code,
        "changed"
    );
    assert_eq!(
        fixture
            .manager
            .preparation_validate(&fixture.store, &receipt.inspection_id)
            .unwrap_err()
            .code,
        "inspectionExpired"
    );
    for initially_present in [false, true] {
        if path.exists() {
            fs::remove_file(&path).unwrap();
        }
        if initially_present {
            fs::write(&path, "before").unwrap();
        }
        let result = preparation::collect_with(&fixture.saved(), "", || {
            if initially_present {
                fs::rename(&path, fixture.path.join("replaced-package")).unwrap();
            }
            fs::write(&path, "after!").unwrap();
        });
        assert_eq!(result.unwrap_err().code, "changed");
    }
}

#[test]
fn windows_preparation_preserves_unknown_revision_publication_and_expiry_guards() {
    let fixture = Fixture::new(false);
    let location = &fixture.location;
    assert_eq!(
        fixture
            .manager
            .preparation_inspect(&fixture.store, &location.id, location.revision + 1, "",)
            .unwrap_err()
            .code,
        "changed"
    );
    let cold = Worktrees::default();
    assert_eq!(
        cold.preparation_inspect(&fixture.store, &location.id, location.revision, "",)
            .unwrap_err()
            .code,
        "changed"
    );
    let receipt = fixture
        .manager
        .preparation_inspect(&fixture.store, &location.id, location.revision, "")
        .unwrap();
    fixture
        .manager
        .lock()
        .unwrap()
        .preparation_tickets
        .get_mut(&receipt.inspection_id)
        .unwrap()
        .created -= TICKET_TTL;
    assert_eq!(
        fixture
            .manager
            .preparation_validate(&fixture.store, &receipt.inspection_id)
            .unwrap_err()
            .code,
        "inspectionExpired"
    );
    let result = fixture.manager.preparation_inspect_with(
        &fixture.store,
        &location.id,
        location.revision,
        "",
        || {
            fixture.manager.lock().unwrap().doc.locations[0]
                .location
                .availability = "unknown".into();
        },
    );
    assert_eq!(result.unwrap_err().code, "changed");
    assert!(
        fixture
            .manager
            .lock()
            .unwrap()
            .preparation_tickets
            .is_empty()
    );
}
