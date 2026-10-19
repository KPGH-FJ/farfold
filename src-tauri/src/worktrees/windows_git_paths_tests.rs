use super::*;
use std::fs;

#[test]
fn actual_held_dos_spellings_pair_full_identity_and_stamp_without_searching_a_program() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    fs::write(root.join("owned.txt"), b"public controlled bytes").unwrap();
    let directory = PinnedPath::directory(&root).unwrap();
    let file = PinnedPath::regular(&root.join("owned.txt")).unwrap();
    let forms = Paths::new(&[&directory, &file]).unwrap();
    assert_eq!(forms.path(&directory).unwrap(), Path::new(&directory.path));
    assert_eq!(forms.path(&file).unwrap(), Path::new(&file.path));
    assert_eq!(forms.pairs[1].before, stamp(file.file()).unwrap());
    assert_eq!(forms.pairs[1].alias.identity(), file.identity());
    assert!(fs::write(root.join("owned.txt"), b"must not replace").is_err());
    forms.verify().unwrap();
}

#[test]
fn an_existing_different_dos_file_cannot_be_substituted_for_the_original_held_identity() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    fs::write(root.join("first.txt"), b"same length").unwrap();
    fs::write(root.join("other.txt"), b"same length").unwrap();
    let mut selected = PinnedPath::regular(&root.join("first.txt")).unwrap();
    let other = PinnedPath::regular(&root.join("other.txt")).unwrap();
    assert_ne!(selected.identity(), other.identity());
    // A test-local spelling mismatch, not a production setter or a new path API.
    selected.path = other.path.clone();
    assert_eq!(Paths::new(&[&selected]).err().unwrap().code, "changed");
}

#[test]
fn a_private_directory_may_change_metadata_while_the_dos_alias_stays_the_same_held_object() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let directory = PinnedPath::directory(&root).unwrap();
    let forms = Paths::new(&[&directory]).unwrap();
    fs::create_dir(root.join("private-child")).unwrap();
    forms.verify().unwrap();
    assert_eq!(forms.pairs[0].alias.identity(), directory.identity());
}

#[test]
fn real_read_context_accepts_missing_worktree_and_reads_allowed_boolean_with_original_selected_program()
 {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let git = root.join(".git");
    fs::create_dir_all(git.join("objects")).unwrap();
    fs::create_dir_all(git.join("refs/heads")).unwrap();
    fs::write(git.join("HEAD"), b"ref: refs/heads/owned\n").unwrap();
    fs::write(
        git.join("config"),
        b"[core]\n repositoryformatversion = 0\n bare = false\n",
    )
    .unwrap();
    let source = crate::worktrees::windows_git::ReadContext::open(&root).unwrap();
    assert_eq!(source.config("core.worktree", false).unwrap(), None);
    assert_eq!(
        source.config("core.bare", true).unwrap().as_deref(),
        Some("false")
    );
    assert_eq!(
        source
            .text(&["rev-parse", "--show-object-format"])
            .unwrap_err()
            .code,
        "unsupportedGit"
    );
    assert_eq!(
        source.text(&["rev-parse", "--is-bare-repository"]).unwrap(),
        "false"
    );
    source.scope.verify().unwrap();
    source.selected_program().verify().unwrap();
}
