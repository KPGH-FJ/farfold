use super::*;

fn descriptor() -> WindowsMaterial {
    WindowsMaterial {
        content: MaterialContent {
            nodes: 1,
            bytes: 100,
            sha256: [1; 32],
        },
        version: 1,
        volume: 7,
        file_id: [9; 16],
        bytes: 1024,
        sha256: [1; 32],
        tree_sha256: [2; 32],
        nodes: vec![MaterialNode {
            kind: MaterialKind::Directory,
            source_volume: 7,
            source_file_id: [3; 16],
            semantic_sha256: [6; 32],
            streams: vec![],
            ea: MaterialEa {
                count: 0,
                logical_bytes: 0,
                sha256: [4; 32],
            },
            security: MaterialSecurity {
                aces: 0,
                returned_bytes: 20,
                sha256: [5; 32],
            },
        }],
    }
}

#[test]
fn descriptor_roundtrip_retains_full_file_ids_and_literal_utf16_streams() {
    let mut value = descriptor();
    let mut file = value.nodes[0].clone();
    file.kind = MaterialKind::Regular;
    file.source_file_id[15] = 0x80;
    file.streams = vec![
        MaterialStream {
            name: vec![],
            bytes: 0,
        },
        MaterialStream {
            name: vec![58, 65, 0xd800, 58, 36, 68, 65, 84, 65],
            bytes: 17,
        },
    ];
    value.nodes.push(file);
    assert!(value.validate());
    let encoded = serde_json::to_vec(&value).unwrap();
    let decoded: WindowsMaterial = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(decoded, value);
    assert!(decoded.validate());
}

#[test]
fn descriptor_rejects_duplicate_identity_partial_default_and_unbounded_fields() {
    let value = descriptor();
    for change in 0..9 {
        let mut invalid = value.clone();
        match change {
            0 => invalid.version = 2,
            1 => invalid.file_id = [0; 16],
            2 => invalid.nodes.push(invalid.nodes[0].clone()),
            3 => invalid.nodes[0].streams.push(MaterialStream {
                name: vec![],
                bytes: 0,
            }),
            4 => invalid.nodes[0].security.returned_bytes = 65_537,
            5 => invalid.nodes[0].ea.logical_bytes = 65_537,
            6 => invalid.nodes[0].security.aces = 3,
            7 => invalid.bytes = MAX_CARRIER + 1,
            _ => invalid.nodes.clear(),
        }
        assert!(!invalid.validate(), "mutation {change}");
    }
}

#[test]
fn descriptor_unknown_fields_and_null_are_not_a_version_downgrade() {
    let mut json = serde_json::to_value(descriptor()).unwrap();
    json["ignored"] = serde_json::json!(true);
    assert!(serde_json::from_value::<WindowsMaterial>(json).is_err());
    assert!(serde_json::from_str::<WindowsMaterial>("null").is_err());
}

#[test]
fn larger_descriptor_keeps_all_nodes_within_the_original_aggregate_budget() {
    let mut value = descriptor();
    for ordinal in 1..=128u128 {
        let mut node = value.nodes[0].clone();
        node.source_file_id = ordinal.to_le_bytes();
        value.nodes.push(node);
    }
    value.content.nodes = value.nodes.len() as u32;
    assert!(value.validate());
    let encoded = serde_json::to_vec(&value).unwrap();
    let decoded: WindowsMaterial = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(decoded, value);
    assert!(decoded.validate());
    for ordinal in 129..=2048u128 {
        let mut node = value.nodes[0].clone();
        node.source_file_id = ordinal.to_le_bytes();
        value.nodes.push(node);
    }
    // Every minimum descriptor already needs 4096 bytes. A larger format
    // count cannot turn the unchanged 8 MiB aggregate bound into success.
    assert_eq!(value.nodes.len(), 2049);
    assert!(!value.validate());
}

#[test]
#[cfg(windows)]
fn complete_manifest_requires_its_exact_user_prefix_digest_and_controlled_git_suffix() {
    use crate::worktrees::{
        recovery_pack::{Manifest, validate},
        recovery_roots::Roots,
        recycle_types::{MaterialProfile, MaterialSummary},
    };
    let mut value = descriptor();
    let mut git = value.nodes[0].clone();
    git.source_file_id = [42; 16];
    value.nodes.push(git);
    let head = "a".repeat(40);
    let manifest = Manifest {
        version: 2,
        roots: Roots {
            head: head.clone(),
            format: "sha1".into(),
            commits: vec![head.clone()],
            files: Vec::new(),
        },
        objects: vec![head],
        content: MaterialSummary {
            profile: Some(MaterialProfile::WindowsRetainedTreeV1),
            entries: value.content.nodes as u64,
            bytes: value.content.bytes,
            sha256: crate::worktrees::material_scan::hex(value.content.sha256),
        },
        configs: Vec::new(),
        attributes: Vec::new(),
        windows_material: Some(value),
    };
    validate(&manifest).unwrap();
    let bytes = serde_json::to_vec(&manifest).unwrap();
    assert_eq!(
        serde_json::from_slice::<Manifest>(&bytes).unwrap(),
        manifest
    );
    for mutation in 0..7 {
        let mut changed = manifest.clone();
        match mutation {
            0 => changed.version = 1,
            1 => changed.content.entries += 1,
            2 => changed.content.bytes += 1,
            3 => changed.content.sha256 = "c".repeat(64),
            4 => changed.content.profile = None,
            5 => changed.windows_material = None,
            _ => {
                changed.windows_material.as_mut().unwrap().nodes.pop();
            }
        }
        assert!(validate(&changed).is_err(), "mutation {mutation}");
    }
}
