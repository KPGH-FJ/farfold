use super::*;
fn id(device: u64, inode: u128) -> Identity {
    Identity { device, inode }
}
fn name(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}
fn add(t: &mut Topology, file: &Identity, links: u64, path: &str) {
    t.observe(file, links, &name(path), &AtomicBool::new(false))
        .unwrap();
}
fn done(t: &mut Topology) -> Observation {
    t.finish(&AtomicBool::new(false)).unwrap()
}

#[test]
fn full128_and_volume_membership_is_not_a_count_or_low64_key() {
    let same_low = [id(9, 7), id(9, (1u128 << 100) | 7), id(10, 7)];
    let mut distinct = Topology::new(3);
    for (i, file) in same_low.iter().enumerate() {
        add(&mut distinct, file, 1, &format!("member{i}"));
    }
    let observed = done(&mut distinct);
    assert_eq!(
        (observed.objects, observed.names, observed.aliases),
        (3, 3, 0)
    );
    let mut linked = Topology::new(3);
    add(&mut linked, &same_low[0], 2, "member0");
    add(&mut linked, &same_low[0], 2, "member1");
    add(&mut linked, &same_low[2], 1, "member2");
    let other = done(&mut linked);
    assert_eq!((other.objects, other.names, other.aliases), (2, 3, 1));
    assert_ne!(other.sha256, observed.sha256);
}
#[test]
fn raw_name_set_and_identity_edges_are_order_independent_but_not_interchangeable() {
    let a = id(1, 100);
    let b = id(1, 200);
    let mut one = Topology::new(3);
    let mut reverse = Topology::new(3);
    add(&mut one, &a, 2, "Case/中文");
    add(&mut one, &b, 1, "other");
    add(&mut one, &a, 2, "case/中文");
    add(&mut reverse, &a, 2, "case/中文");
    add(&mut reverse, &a, 2, "Case/中文");
    add(&mut reverse, &b, 1, "other");
    let first = done(&mut one);
    assert_eq!(first, done(&mut reverse));
    let mut rewired = Topology::new(3);
    add(&mut rewired, &a, 2, "Case/中文");
    add(&mut rewired, &b, 1, "case/中文");
    add(&mut rewired, &a, 2, "other");
    assert_ne!(first.sha256, done(&mut rewired).sha256);
    let mut raw_a = Topology::new(1);
    let mut raw_b = Topology::new(1);
    // Private representation is lossless; current native child admission may
    // refuse an unpaired surrogate before this component is reached.
    raw_a
        .observe(&a, 1, &[0xd800], &AtomicBool::new(false))
        .unwrap();
    raw_b
        .observe(&a, 1, &[0xfffd], &AtomicBool::new(false))
        .unwrap();
    assert_ne!(done(&mut raw_a).sha256, done(&mut raw_b).sha256);
}
#[test]
fn missing_outside_or_excluded_names_cannot_be_satisfied_by_duplicate_paths() {
    let file = id(1, 2);
    let mut missing = Topology::new(4);
    add(&mut missing, &file, 2, "inside");
    assert_eq!(
        missing.finish(&AtomicBool::new(false)),
        Err(Failure::UnaccountedLinks)
    );
    let mut repeat = Topology::new(4);
    add(&mut repeat, &file, 2, "inside");
    assert_eq!(
        repeat.observe(&file, 2, &name("inside"), &AtomicBool::new(false)),
        Err(Failure::Changed)
    );
    assert_eq!(
        repeat.finish(&AtomicBool::new(false)),
        Err(Failure::UnaccountedLinks)
    );
    let mut reused = Topology::new(4);
    add(&mut reused, &file, 1, "inside");
    assert_eq!(
        reused.observe(&id(1, 3), 1, &name("inside"), &AtomicBool::new(false)),
        Err(Failure::Changed)
    );
}
#[test]
fn link_count_drift_overobservations_and_zero_identity_are_not_complete() {
    let file = id(1, 20);
    let cancel = AtomicBool::new(false);
    let mut drift = Topology::new(4);
    add(&mut drift, &file, 2, "a");
    assert_eq!(
        drift.observe(&file, 3, &name("b"), &cancel),
        Err(Failure::Changed)
    );
    let mut over = Topology::new(4);
    add(&mut over, &file, 1, "a");
    assert_eq!(
        over.observe(&file, 1, &name("b"), &cancel),
        Err(Failure::Changed)
    );
    let mut bad = Topology::new(4);
    assert_eq!(
        bad.observe(&id(1, 0), 1, &name("a"), &cancel),
        Err(Failure::Changed)
    );
    assert_eq!(
        bad.observe(&file, 0, &name("a"), &cancel),
        Err(Failure::Changed)
    );
}
#[test]
fn existing_entry_bound_limits_fixed_size_members_and_finish_retires_them() {
    let cancel = AtomicBool::new(false);
    let mut t = Topology::new(2);
    add(&mut t, &id(1, 1), 1, "a");
    add(&mut t, &id(1, 2), 1, "b");
    assert_eq!(t.names.len(), 2);
    assert_eq!(t.groups.len(), 2);
    assert_eq!(
        t.observe(&id(1, 3), 1, &name("c"), &cancel),
        Err(Failure::Limit)
    );
    assert_eq!(done(&mut t).names, 2);
    assert!(t.names.is_empty());
    assert!(t.groups.is_empty());
    assert_eq!(t.finish(&cancel), Err(Failure::Changed));
    assert_eq!(
        t.observe(&id(1, 1), 1, &name("a"), &cancel),
        Err(Failure::Changed)
    );
    let mut huge_declared = Topology::new(2);
    assert_eq!(
        huge_declared.observe(&id(1, 1), 3, &name("a"), &cancel),
        Err(Failure::Limit)
    );
    let mut incomplete = Topology::new(2);
    add(&mut incomplete, &id(1, 1), 2, "a");
    assert_eq!(incomplete.finish(&cancel), Err(Failure::UnaccountedLinks));
    assert!(incomplete.names.is_empty());
    assert!(incomplete.groups.is_empty());
}
#[test]
fn cancellation_and_invalid_relative_names_never_add_members() {
    let mut t = Topology::new(4);
    let file = id(1, 2);
    assert_eq!(
        t.observe(&file, 1, &name("a"), &AtomicBool::new(true)),
        Err(Failure::Cancelled)
    );
    for value in ["", "/a", "a/", "a//b", ".", "a/../b", "a\\b", "a:ads", "a."] {
        assert_eq!(
            t.observe(&file, 1, &name(value), &AtomicBool::new(false)),
            Err(Failure::InvalidName)
        );
    }
    assert!(t.names.is_empty());
    assert!(t.groups.is_empty());
    add(&mut t, &file, 1, "a");
    assert_eq!(t.finish(&AtomicBool::new(true)), Err(Failure::Cancelled));
    assert!(t.names.is_empty());
    assert!(t.groups.is_empty());
}
