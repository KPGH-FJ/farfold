//! Owned private Git tree, frozen after the final official graph check. It can
//! only be consumed by the complete material carrier; it is not path authority.
use super::*;
use crate::file_access::{EaWorkBudget, MATERIAL_WORK_LIMIT};
use std::path::PathBuf;
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY;
struct Node {
    parent: Option<usize>,
    leaf: Vec<u16>,
    pin: PinnedPath,
    directory: bool,
    relative: String,
}
fn allowed(path: &str, directory: bool, graph: &Graph, attributes: bool) -> bool {
    if directory {
        return matches!(
            path,
            "objects"
                | "objects/info"
                | "objects/pack"
                | "refs"
                | "refs/heads"
                | "refs/tags"
                | "refs/heads/recovery"
        ) || (attributes && path == "info");
    }
    if matches!(path, "HEAD" | "config" | "index" | "packed-refs")
        || (attributes && path == "info/attributes")
    {
        return true;
    }
    if let Some(number) = path.strip_prefix("refs/heads/recovery/root-") {
        return number.len() == 4
            && number.bytes().all(|b| b.is_ascii_digit())
            && number
                .parse::<usize>()
                .is_ok_and(|n| n < graph.roots.commits.len());
    }
    let Some(pack) = path.strip_prefix("objects/pack/pack-") else {
        return false;
    };
    let Some((object, extension)) = pack.rsplit_once('.') else {
        return false;
    };
    object.len() == graph.roots.head.len()
        && oid(object)
        && matches!(extension, "pack" | "idx" | "rev")
}
pub(in crate::worktrees) struct Frozen {
    nodes: Vec<Node>,
}
impl Frozen {
    pub(super) fn capture(
        root: &PinnedPath,
        graph: &Graph,
        attributes: bool,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        let mut work = EaWorkBudget::new(MATERIAL_WORK_LIMIT);
        let mut nodes = vec![Node {
            parent: None,
            leaf: ".git".encode_utf16().collect(),
            pin: PinnedPath::git_directory(&root.guid_path)
                .map_err(|_| error("recoveryChanged"))?,
            directory: true,
            relative: String::new(),
        }];
        if nodes[0].pin.identity() != root.identity() {
            return Err(error("recoveryChanged"));
        }
        let mut index = 0;
        while index < nodes.len() {
            cancelled(cancel)?;
            if nodes[index].directory {
                let entries = crate::file_access::directory_entries_with_work(
                    &nodes[index].pin,
                    (64 - nodes.len()) as u64,
                    cancel,
                    &mut work,
                )
                .map_err(|_| error("recoveryChanged"))?;
                for (name, found) in entries {
                    if found.reparse_tag.is_some() || nodes.len() == 64 {
                        return Err(error("unsupportedMaterial"));
                    }
                    let directory = found.attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
                    let leaf = String::from_utf16(&name).map_err(|_| error("recoveryInvalid"))?;
                    let relative = if nodes[index].relative.is_empty() {
                        leaf
                    } else {
                        format!("{}/{}", nodes[index].relative, leaf)
                    };
                    if !allowed(&relative, directory, graph, attributes) {
                        return Err(error("recoveryInvalid"));
                    }
                    let pin = nodes[index]
                        .pin
                        .child(&name, directory)
                        .map_err(|_| error("recoveryChanged"))?;
                    if pin.identity() != &found.identity
                        || crate::file_access::stamp(pin.file())
                            .map_err(|_| error("recoveryChanged"))?
                            .links
                            != 1
                        || nodes.iter().any(|n| n.pin.identity() == pin.identity())
                    {
                        return Err(error("unsupportedMaterial"));
                    }
                    nodes.push(Node {
                        parent: Some(index),
                        leaf: name,
                        pin,
                        directory,
                        relative,
                    });
                }
            }
            index += 1;
        }
        let result = Self { nodes };
        result.verify(cancel)?;
        Ok(result)
    }
    pub(in crate::worktrees) fn capture_manifest(
        root: &PinnedPath,
        manifest: &super::super::Manifest,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        use super::super::graph::GraphSource;
        let graph = manifest.graph()?;
        Self::capture(root, &graph, !manifest.attributes.is_empty(), cancel)
    }
    pub(in crate::worktrees) fn verify(&self, cancel: &AtomicBool) -> Result<()> {
        let mut work = EaWorkBudget::new(MATERIAL_WORK_LIMIT);
        self.verify_with(cancel, &mut work)
    }
    pub(in crate::worktrees) fn verify_with(
        &self,
        cancel: &AtomicBool,
        work: &mut EaWorkBudget,
    ) -> Result<()> {
        for (index, node) in self.nodes.iter().enumerate() {
            cancelled(cancel)?;
            node.pin.verify().map_err(|_| error("recoveryChanged"))?;
            if node.directory {
                let observed =
                    crate::file_access::directory_entries_with_work(&node.pin, 64, cancel, work)
                        .map_err(|_| error("recoveryChanged"))?;
                let children = self.nodes.iter().filter(|n| n.parent == Some(index));
                if observed.len() != children.clone().count() {
                    return Err(error("recoveryChanged"));
                }
                for child in children {
                    let entry = observed.get(&child.leaf).ok_or(error("recoveryChanged"))?;
                    if entry.identity != *child.pin.identity()
                        || entry.reparse_tag.is_some()
                        || (entry.attributes & FILE_ATTRIBUTE_DIRECTORY != 0) != child.directory
                    {
                        return Err(error("recoveryChanged"));
                    }
                }
            }
        }
        Ok(())
    }
}
pub(crate) struct PreparedRecoveryGit {
    frozen: Frozen,
    _root: PinnedPath,
    _temp: tempfile::TempDir,
}
impl PreparedRecoveryGit {
    pub(super) fn new(frozen: Frozen, root: PinnedPath, temp: tempfile::TempDir) -> Self {
        Self {
            frozen,
            _root: root,
            _temp: temp,
        }
    }
    pub(crate) fn verify(&self, cancel: &AtomicBool) -> Result<()> {
        self._root.verify().map_err(|_| error("recoveryChanged"))?;
        self.frozen.verify(cancel)
    }
    pub(crate) fn full_root(&self, cancel: &AtomicBool) -> Result<PinnedPath> {
        self.verify(cancel)?;
        let root = &self.frozen.nodes[0].pin;
        let pin = PinnedPath::directory_full_security(&PathBuf::from(&root.path))
            .map_err(|_| error("unsupportedMaterial"))?;
        if pin.identity() != root.identity() {
            return Err(error("recoveryChanged"));
        }
        self.verify(cancel)?;
        Ok(pin)
    }
}
