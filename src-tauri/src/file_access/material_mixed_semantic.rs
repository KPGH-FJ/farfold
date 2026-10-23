//! Logical material identity excludes source FileIDs and the caller's root name.
//! It includes every admitted native byte and metadata field restored by this profile.
use super::material_mixed_tree_records::{Kind, Node, ROOT};
use super::{
    ea_records::WorkBudget,
    material_carrier_records::{Error, Result, charge, check},
};
use crate::worktrees::MaterialContent;
use sha2::{Digest, Sha256};
use std::sync::atomic::AtomicBool;

pub(super) fn summarize(
    nodes: &[Node],
    count: usize,
    native_hash: impl Fn(usize) -> [u8; 32],
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<MaterialContent> {
    if count == 0
        || count > nodes.len()
        || nodes[0].kind != Kind::Directory
        || nodes[0].parent != ROOT
    {
        return Err(Error::Invalid);
    }
    // The optional suffix is exactly one controlled .git tree, never a second
    // user-material namespace. This check is repeated from actual carrier bytes.
    if count < nodes.len() {
        let git = &nodes[count];
        if git.kind != Kind::Directory
            || git.parent != 0
            || git.metadata.raw_leaf != [46, 103, 105, 116]
        {
            return Err(Error::Invalid);
        }
        for node in &nodes[count + 1..] {
            if (node.parent as usize) < count {
                return Err(Error::Invalid);
            }
        }
    }
    let mut hash = Sha256::new();
    hash.update(b"FFMATSEM1");
    hash.update((count as u64).to_le_bytes());
    let mut bytes = 0u64;
    for (index, node) in nodes[..count].iter().enumerate() {
        check(cancel)?;
        let leaf = if index == 0 {
            &[][..]
        } else {
            node.metadata.raw_leaf.as_slice()
        };
        charge(work, 128 + leaf.len() * 2)?;
        if index != 0 && node.parent as usize >= index {
            return Err(Error::Invalid);
        }
        hash.update([node.kind as u8]);
        hash.update(node.parent.to_le_bytes());
        hash.update((leaf.len() as u64).to_le_bytes());
        for value in leaf {
            hash.update(value.to_le_bytes());
        }
        hash.update(node.metadata.created.to_le_bytes());
        hash.update(node.metadata.accessed.to_le_bytes());
        hash.update(node.metadata.modified.to_le_bytes());
        hash.update(node.metadata.attributes.to_le_bytes());
        hash.update(node.native_bytes.to_le_bytes());
        hash.update(native_hash(index));
        bytes = bytes.checked_add(node.native_bytes).ok_or(Error::Limit)?;
    }
    Ok(MaterialContent {
        nodes: count as u32,
        bytes,
        sha256: hash.finalize().into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_access::material_mixed_tree_records::Metadata;
    fn node(parent: u32, name: &str, id: u128) -> Node {
        Node {
            kind: Kind::Directory,
            parent,
            metadata: Metadata {
                raw_leaf: name.encode_utf16().collect(),
                source_volume: 4,
                source_id: id,
                created: 1,
                accessed: 2,
                modified: 3,
                attributes: 16,
            },
            typed_start: 0,
            typed_bytes: 100,
            native_start: 0,
            native_bytes: 70,
            native_sha256: [8; 32],
            record_sha256: [9; 32],
            ordinary_security: None,
        }
    }
    fn summary(nodes: &[Node], count: usize) -> Result<MaterialContent> {
        summarize(
            nodes,
            count,
            |index| nodes[index].native_sha256,
            &mut WorkBudget::new(65536),
            &AtomicBool::new(false),
        )
    }
    #[test]
    fn new_target_identity_and_root_name_preserve_material_but_every_payload_field_matters() {
        let original = vec![node(ROOT, "old-root", 1), node(0, "child", 2)];
        let expected = summary(&original, 2).unwrap();
        let mut restored = original.clone();
        for n in &mut restored {
            n.metadata.source_id += 400;
            n.metadata.source_volume += 8;
            n.typed_start += 800;
        }
        restored[0].metadata.raw_leaf = "new-target".encode_utf16().collect();
        assert_eq!(summary(&restored, 2).unwrap(), expected);
        for change in 0..7 {
            let mut changed = restored.clone();
            match change {
                0 => changed[1].metadata.raw_leaf.push(65),
                1 => changed[1].native_sha256[0] ^= 1,
                2 => changed[1].native_bytes += 1,
                3 => changed[1].metadata.created += 1,
                4 => changed[1].metadata.accessed += 1,
                5 => changed[1].metadata.modified += 1,
                _ => changed[1].metadata.attributes ^= 1,
            }
            assert_ne!(summary(&changed, 2).unwrap(), expected, "change {change}");
        }
    }
    #[test]
    fn controlled_git_suffix_cannot_hide_other_root_material() {
        let mut nodes = vec![
            node(ROOT, "root", 1),
            node(0, "user", 2),
            node(0, ".git", 3),
            node(2, "objects", 4),
        ];
        assert_eq!(
            summary(&nodes, 2).unwrap(),
            summary(&nodes[..2], 2).unwrap()
        );
        nodes[3].parent = 0;
        assert!(summary(&nodes, 2).is_err());
        nodes[3].parent = 2;
        nodes[2].metadata.raw_leaf = "hidden-user".encode_utf16().collect();
        assert!(summary(&nodes, 2).is_err());
    }
}
