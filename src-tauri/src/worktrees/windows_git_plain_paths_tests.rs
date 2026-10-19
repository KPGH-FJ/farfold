//! Real production paths and admission controls, not the five-call observer.
use super::*;
use crate::worktrees::windows_git::ReadContext;
use std::{
    fs,
    path::{Component, Prefix},
};

struct Repository {
    _temporary: tempfile::TempDir,
    root: PathBuf,
}
impl Repository {
    fn new(config: &[u8]) -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let git = root.join(".git");
        fs::create_dir_all(git.join("objects")).unwrap();
        fs::create_dir_all(git.join("refs/heads")).unwrap();
        fs::write(git.join("HEAD"), b"ref: refs/heads/owned\n").unwrap();
        fs::write(git.join("config"), config).unwrap();
        Self {
            _temporary: temporary,
            root,
        }
    }
    fn unchanged(&self, config: &[u8]) {
        assert_eq!(fs::read(self.root.join(".git/config")).unwrap(), config);
        assert_eq!(
            fs::read(self.root.join(".git/HEAD")).unwrap(),
            b"ref: refs/heads/owned\n"
        );
        assert!(
            fs::read_dir(self.root.join(".git/objects"))
                .unwrap()
                .next()
                .is_none()
        );
        assert!(
            fs::read_dir(self.root.join(".git/refs/heads"))
                .unwrap()
                .next()
                .is_none()
        );
    }
}

#[test]
fn real_read_context_command_roles_are_strict_plain_and_same_held_full_objects() {
    let config = b"[core]\n repositoryformatversion = 0\n bare = false\n";
    let repository = Repository::new(config);
    let source = ReadContext::open(&repository.root).unwrap();
    let pins = [
        source.selected_program(),
        &source.scope.root,
        &source.scope.git,
        &source.scope.common,
    ];
    let paths = Paths::new(&pins).unwrap();
    for pin in pins {
        let path = paths.path(pin).unwrap();
        assert!(!path.to_str().unwrap().starts_with(r"\\?\"));
        assert!(
            matches!(path.components().next(), Some(Component::Prefix(value)) if matches!(value.kind(), Prefix::Disk(_)))
        );
        let before = stamp(pin.file()).unwrap();
        let fresh = if before.regular {
            PinnedPath::regular(path)
        } else {
            PinnedPath::git_directory(path)
        }
        .unwrap();
        assert_eq!(fresh.guid_path, pin.guid_path);
        assert_eq!(stamp(fresh.file()).unwrap(), before);
    }
    assert_eq!(source.config("core.worktree", false).unwrap(), None);
    assert_eq!(
        source.config("core.bare", true).unwrap().as_deref(),
        Some("false")
    );
    assert_eq!(
        source.text(&["rev-parse", "--is-bare-repository"]).unwrap(),
        "false"
    );
    paths.verify().unwrap();
    source.scope.verify().unwrap();
    source.selected_program().verify().unwrap();
    repository.unchanged(config);
}

#[test]
fn a_configured_worktree_is_rejected_by_the_real_read_context_instead_of_becoming_absent() {
    let config = b"[core]\n repositoryformatversion = 0\n bare = false\n worktree = .\n";
    let repository = Repository::new(config);
    assert_eq!(
        ReadContext::open(&repository.root).err().unwrap().code,
        "unsupportedGit"
    );
    repository.unchanged(config);
}

#[test]
fn a_real_bare_configuration_is_rejected_instead_of_becoming_absent() {
    let config = b"[core]\n repositoryformatversion = 0\n bare = true\n";
    let repository = Repository::new(config);
    assert_eq!(
        ReadContext::open(&repository.root).err().unwrap().code,
        "bare"
    );
    repository.unchanged(config);
}

#[test]
fn alternate_or_normalized_pin_spellings_cannot_mint_a_plain_path_authority() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    fs::write(root.join("owned-unicode-🙂.bin"), b"same held bytes").unwrap();
    let mut selected = PinnedPath::regular(&root.join("owned-unicode-🙂.bin")).unwrap();
    let original = selected.path.clone();
    let plain = original.strip_prefix(r"\\?\").unwrap().to_owned();
    let candidates = [
        plain,
        original.replace('\\', "/"),
        original.replace("owned-unicode-", ".\\owned-unicode-"),
        original.replace("owned-unicode-", "..\\owned-unicode-"),
        original.replace("owned-unicode-", "\\owned-unicode-"),
        format!("{original}."),
        format!("{original} "),
        format!("{original}:named"),
        selected.guid_path.to_str().unwrap().to_owned(),
        r"\\?\UNC\server\share\owned.bin".to_owned(),
        r"\\.\C:\owned.bin".to_owned(),
        r"\\?\C:owned.bin".to_owned(),
    ];
    for (index, candidate) in candidates.into_iter().enumerate() {
        selected.path = candidate;
        let code = Paths::new(&[&selected]).err().map(|value| value.code);
        assert_eq!(
            code,
            Some("changed"),
            "alternate spelling {index} must refuse"
        );
        selected.verify().unwrap();
    }
    selected.path = original;
    let paths = Paths::new(&[&selected]).unwrap();
    paths.verify().unwrap();
    assert_eq!(stamp(selected.file()).unwrap(), paths.pairs[0].before);
}
