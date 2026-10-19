//! Actual grouping/closure core with explicit synthetic identity/count inputs.
//! These cases do not substitute for the Windows held-tree producer controls.
use super::*;
#[test]
fn full128_identity_not_equal_low64_decides_group_membership() {
    let mut groups = Vec::with_capacity(MAX);
    let a = Identity {
        device: 7,
        inode: (1 << 100) | 9,
    };
    let b = Identity {
        device: 7,
        inode: (2 << 100) | 9,
    };
    group_name(&mut groups, &a, 1, 0).unwrap();
    group_name(&mut groups, &b, 1, 1).unwrap();
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0].identity, a);
    assert_eq!(groups[1].identity, b);
    assert_eq!(groups[0].members, [0]);
    assert_eq!(groups[1].members, [1]);
    counts_closed(&groups).unwrap();
}
#[test]
fn observed_name_count_must_equal_reported_count_for_every_group() {
    for (names, links) in [(2, 3), (3, 2)] {
        let group = AliasGroup {
            identity: Identity {
                device: 7,
                inode: 99,
            },
            members: (0..names).collect(),
            reported_links: links,
        };
        assert_eq!(
            counts_closed(&[group]),
            Err(AliasFailure::Incomplete {
                group: 0,
                known_names: names,
                reported_links: links
            })
        );
    }
    let mut groups = Vec::with_capacity(MAX);
    let id = Identity {
        device: 7,
        inode: 99,
    };
    group_name(&mut groups, &id, 2, 0).unwrap();
    group_name(&mut groups, &id, 2, 1).unwrap();
    counts_closed(&groups).unwrap();
}
#[test]
fn conflicting_actual_counts_zero_and_overbound_indices_never_mint_closed_group() {
    let mut groups = Vec::with_capacity(MAX);
    let id = Identity {
        device: 7,
        inode: 99,
    };
    group_name(&mut groups, &id, 2, 0).unwrap();
    assert_eq!(
        group_name(&mut groups, &id, 3, 1),
        Err(AliasFailure::Changed)
    );
    assert_eq!(
        group_name(&mut groups, &id, 0, 1),
        Err(AliasFailure::Unsupported)
    );
    assert_eq!(
        group_name(&mut groups, &id, 2, MAX as u32),
        Err(AliasFailure::Unsupported)
    );
    assert_eq!(groups[0].members, [0]);
    assert_eq!(
        counts_closed(&groups),
        Err(AliasFailure::Incomplete {
            group: 0,
            known_names: 1,
            reported_links: 2
        })
    );
}
