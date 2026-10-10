use super::tests::{OP, Repo, git, input, op, store, wait};
use super::*;
#[test]
fn actual_worktree_wire_and_linked_source_material_root() {
    let r = Repo::new();
    let s = store();
    let m = Worktrees::default();
    let inspection = m.inspect(&s, r.root.to_str().unwrap()).unwrap();
    let refs = m.refs(&inspection.inspection_id, None).unwrap();
    let args = Create {
        inspection_id: inspection.inspection_id.clone(),
        parent_path: r
            ._dir
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
        directory_name: "wire-created".into(),
        branch: Branch::New {
            name: "wire-created".into(),
            start_oid: inspection.head.oid.clone().unwrap(),
        },
    };
    let prepared = m.prepare(&s, OP, args).unwrap();
    m.start(&s, OP).unwrap();
    let ready = wait(&m, &s);
    assert_eq!(ready.state, "ready");
    let list = m.list(&s).unwrap();
    let unknown = m
        .status(&s, "ffffffff-ffff-4fff-8fff-ffffffffffff")
        .unwrap();
    let linked = m
        .inspect(&s, &ready.location.as_ref().unwrap().path)
        .unwrap();
    assert_ne!(linked.root, linked.repository_root);
    assert_eq!(linked.repository_root, inspection.repository_root);
    let second = "42345678-1234-4123-8123-123456789abc";
    let args = Create {
        inspection_id: linked.inspection_id.clone(),
        parent_path: r
            ._dir
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
        directory_name: "wire-unresolved".into(),
        branch: Branch::New {
            name: "wire-unresolved".into(),
            start_oid: linked.head.oid.clone().unwrap(),
        },
    };
    m.prepare(&s, second, args).unwrap();
    drop(m);
    let cold = Worktrees::default();
    let before_ack = cold.list(&s).unwrap();
    let acknowledged = cold.acknowledge(&s, second).unwrap();
    let material_list = cold.list(&s).unwrap();
    assert_eq!(
        material_list.materials[0].repository_root,
        inspection.repository_root
    );
    let bad = input(
        &cold,
        &s,
        &r,
        Branch::New {
            name: "refused".into(),
            start_oid: git(&r.root, &["rev-parse", "HEAD"]),
        },
        "repo",
    );
    let failed = cold
        .prepare(&s, "52345678-1234-4123-8123-123456789abc", bad)
        .unwrap();
    assert_eq!(op(failed.clone()).state, "failed");
    println!(
        "WORKTREE_WIRE:{}",
        serde_json::json!({"inspection":inspection,"refs":refs,"prepared":prepared,"ready":ready,"list":list,"unknown":unknown,"linkedInspection":linked,"beforeAcknowledge":before_ack,"acknowledged":acknowledged,"materialList":material_list,"failed":failed})
    );
}
