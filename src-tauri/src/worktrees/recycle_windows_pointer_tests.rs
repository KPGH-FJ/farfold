//! Git's on-disk pointer syntax on owned disposable Windows repositories.
use super::*;
use crate::worktrees::{read_context::Reader, tests, windows_git};

#[test]
fn pointer_text_keeps_plain_drive_unicode_and_rejects_other_namespaces() {
    let path = Path::new(r"C:\owned space\资料🙂\worktree\.git");
    assert_eq!(
        pointer_text("", path).unwrap(),
        "C:/owned space/资料🙂/worktree/.git\n".as_bytes()
    );
    assert_eq!(
        pointer_text(
            "gitdir: ",
            Path::new(r"D:\owned main\.git\worktrees\linked")
        )
        .unwrap(),
        b"gitdir: D:/owned main/.git/worktrees/linked\n"
    );
    for invalid in [
        "relative/.git",
        r"C:relative\.git",
        r"\\server\share\worktree\.git",
        r"\\?\C:\owned\worktree\.git",
        "C:\\owned\\line\nbreak\\.git",
    ] {
        assert_eq!(
            pointer_text("", Path::new(invalid)).unwrap_err().code,
            "unsafePath"
        );
    }
}

#[test]
fn official_git_lists_original_root_only_after_owned_back_pointer_uses_git_separators() {
    let repository = tests::Repo::new();
    let linked = repository._dir.path().join("owned linked 资料");
    tests::git(
        &repository.root,
        &[
            "worktree",
            "add",
            "-b",
            "pointer-format-owned",
            linked.to_str().unwrap(),
        ],
    );
    let original = inspect::snapshot(&linked).unwrap();
    assert!(original.blockers.is_empty());
    let (root, private) = {
        let context = windows_git::ReadContext::open(&linked).unwrap();
        let paths =
            windows_git::paths::Paths::new(&[&context.scope.root, &context.scope.git]).unwrap();
        (
            paths.path(&context.scope.root).unwrap().to_path_buf(),
            paths.path(&context.scope.git).unwrap().to_path_buf(),
        )
    };
    let back = private.join("gitdir");
    let forward = root.join(".git");
    let back_id = PinnedPath::regular(&back).unwrap().identity().clone();
    let forward_id = PinnedPath::regular(&forward).unwrap().identity().clone();
    let back_native = root.join(".git");
    let old_text = format!("{}\n", back_native.display());
    assert!(old_text.ends_with("\\.git\n"));
    fs::write(&back, old_text).unwrap();
    {
        // The backslash form still resolves to the SAME .git object under the
        // Windows scope rules. The defect is specifically Git's listing syntax.
        let reader = Reader::open(&root).unwrap();
        let listed = reader
            .read(&root, &["worktree", "list", "--porcelain", "-z"])
            .unwrap();
        let wrong_root = format!("worktree {}", back_native.display());
        assert!(
            listed
                .split(|byte| *byte == 0)
                .any(|field| field == wrong_root.as_bytes())
        );
        let observed = inspect::observe_with_reader(&root, &reader).unwrap();
        assert_eq!(observed.root_stamp, original.root_stamp);
        assert!(observed.blockers.iter().any(|code| code == "unavailable"));
        assert!(!observed.trees.iter().any(|tree| tree.path == original.root));
    }
    // Replace only these two fixture FILE CONTENTS, preserving both actual
    // object identities, using the same formatter as Archive and Restore.
    fs::write(&forward, pointer_text("gitdir: ", &private).unwrap()).unwrap();
    fs::write(&back, pointer_text("", &back_native).unwrap()).unwrap();
    assert_eq!(PinnedPath::regular(&back).unwrap().identity(), &back_id);
    assert_eq!(
        PinnedPath::regular(&forward).unwrap().identity(),
        &forward_id
    );
    let reader = Reader::open(&root).unwrap();
    let actual = inspect::observe_with_reader(&root, &reader).unwrap();
    assert!(actual.blockers.is_empty());
    assert_eq!(actual.root, original.root);
    assert_eq!(actual.root_stamp, original.root_stamp);
    assert_eq!(actual.git_stamp, original.git_stamp);
    assert_eq!(actual.common_stamp, original.common_stamp);
    assert_eq!(actual.head, original.head);
    assert_eq!(actual.branch, original.branch);
    assert_eq!(actual.repository_root(), original.repository_root());
    assert_eq!(
        actual
            .trees
            .iter()
            .filter(|tree| tree.path == original.root)
            .count(),
        1
    );
    assert_eq!(
        reader.text(&root, &["rev-parse", "HEAD"]).unwrap(),
        original.head.unwrap()
    );
}
