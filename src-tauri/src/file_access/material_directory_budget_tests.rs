use super::*;
use crate::file_access::{directory_page::HEADER, material_carrier_records::Error};
use std::{
    cell::{Cell, RefCell},
    sync::atomic::Ordering,
};

// Independent documented wire fixture, not a copy of the collector algorithm.
fn record(name: &[u16], id: u128) -> Vec<u8> {
    let mut b = vec![0u8; HEADER + 2 * name.len()];
    b[60..64].copy_from_slice(&(2 * name.len() as u32).to_le_bytes());
    b[72..88].copy_from_slice(&id.to_le_bytes());
    for (out, unit) in b[HEADER..].chunks_exact_mut(2).zip(name) {
        out.copy_from_slice(&unit.to_le_bytes());
    }
    b
}
fn run(
    resident: &Resident,
    pages: Vec<Result<Option<Vec<u8>>, Failure>>,
    remaining: usize,
) -> Result<MaterialEntries, Failure> {
    let mut pages = pages.into_iter();
    collect(17, remaining, &AtomicBool::new(false), resident, || {
        pages.next().expect("exact fixture EOF/query count")
    })
}
#[test]
fn zero_pool_refuses_before_query_while_legacy_collector_keeps_its_original_contract() {
    let cancel = AtomicBool::new(false);
    let calls = Cell::new(0);
    let native = || {
        calls.set(calls.get() + 1);
        Ok(None)
    };
    assert_eq!(
        collect(17, 0, &cancel, &Resident::new(QUERY_BYTES - 1), native),
        Err(Failure::Limit)
    );
    assert_eq!(calls.get(), 0);
    let mut pages = vec![Some(record(&[65], 9)), None].into_iter();
    let old = directory_page::collect(17, 1, &cancel, || Ok(pages.next().unwrap())).unwrap();
    assert_eq!(old.len(), 1);
    assert_eq!(old[&vec![65]].identity.inode, 9);
}
#[test]
fn record_reservation_precedes_name_and_map_allocation_in_the_real_shared_parser() {
    let mut offered = Vec::new();
    let result = directory_page::page_reserved(
        &record(&[65, 0xd800], 9),
        17,
        &AtomicBool::new(false),
        |name_bytes| {
            offered.push(name_bytes);
            Err(Failure::Limit)
        },
    );
    assert_eq!(offered, vec![4]);
    assert_eq!(result, Err(Failure::Limit));
}
#[test]
fn long_page_does_not_bypass_resident_by_having_only_one_native_page() {
    let name = vec![65; 255];
    let resident = Resident::new(QUERY_BYTES + entry_bytes(510).unwrap() - 1);
    assert_eq!(
        run(&resident, vec![Ok(Some(record(&name, 1)))], 1),
        Err(Failure::Limit)
    );
    // All failed-operation reservations retire, not merely its final map.
    assert!(
        resident
            .lease(QUERY_BYTES + entry_bytes(510).unwrap() - 1)
            .is_ok()
    );
}
#[test]
fn retained_parent_listing_blocks_child_until_the_last_real_map_is_dropped() {
    let one = entry_bytes(2).unwrap();
    // One result can finish (page + result overlap); a second cannot while
    // that first result is still owned, modeling nested retained listings.
    let resident = Resident::new(QUERY_BYTES + 2 * one);
    let first = run(&resident, vec![Ok(Some(record(&[65], 1))), Ok(None)], 1).unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(
        run(&resident, vec![Ok(Some(record(&[66], 2)))], 1),
        Err(Failure::Limit)
    );
    assert_eq!(first[&vec![65]].identity.inode, 1);
    drop(first);
    let second = run(&resident, vec![Ok(Some(record(&[66], 2))), Ok(None)], 1).unwrap();
    assert_eq!(second.keys().cloned().collect::<Vec<_>>(), vec![vec![66]]);
    drop(second);
    assert!(resident.lease(QUERY_BYTES + 2 * one).is_ok());
}
#[test]
fn success_releases_query_storage_but_retains_exact_logical_map_reservation() {
    let one = entry_bytes(2).unwrap();
    let limit = QUERY_BYTES + 2 * one;
    let resident = Resident::new(limit);
    let values = run(&resident, vec![Ok(Some(record(&[65], 1))), Ok(None)], 1).unwrap();
    let rest = resident.lease(limit - one).unwrap();
    assert!(matches!(resident.lease(1), Err(Error::Limit)));
    assert!(values.contains_key(&[65]));
    drop(rest);
    drop(values);
    assert!(resident.lease(limit).is_ok());
}
#[test]
fn same_pool_growth_is_atomic_and_foreign_or_overflow_does_not_mutate_either_pool() {
    let resident = Resident::new(10);
    let other = Resident::new(10);
    let mut own = resident.lease(3).unwrap();
    resident.grow(&mut own, 4).unwrap();
    assert_eq!(other.grow(&mut own, 1), Err(Error::Invalid));
    assert_eq!(resident.grow(&mut own, usize::MAX), Err(Error::Limit));
    assert_eq!(resident.grow(&mut own, 4), Err(Error::Limit));
    let rest = resident.lease(3).unwrap();
    assert!(matches!(resident.lease(1), Err(Error::Limit)));
    assert!(other.lease(10).is_ok());
    drop((own, rest));
    assert!(resident.lease(10).is_ok());
}
#[test]
fn duplicates_dot_repeats_entry_limit_bad_wire_and_query_error_preserve_original_failure() {
    let io = Failure::Io {
        phase: "ownedQuery",
        code: Some(5),
        nt_status: None,
    };
    let cases = vec![
        (
            vec![Ok(Some(record(&[65], 1))), Ok(Some(record(&[65], 1)))],
            2,
            Failure::Changed,
        ),
        (
            vec![Ok(Some(record(&[46], 1))), Ok(Some(record(&[46], 1)))],
            0,
            Failure::Changed,
        ),
        (vec![Ok(Some(record(&[65], 1)))], 0, Failure::Limit),
        (vec![Ok(Some(vec![]))], 1, Failure::InvalidRecord),
        (vec![Ok(Some(record(&[65], 1))), Err(io.clone())], 2, io),
    ];
    for (pages, remaining, expected) in cases {
        let resident = Resident::new(1_000_000);
        assert_eq!(run(&resident, pages, remaining), Err(expected));
        assert!(resident.lease(1_000_000).is_ok());
    }
}
#[test]
fn full128_and_counted_unpaired_utf16_are_preserved_without_new_admission() {
    let cancel = AtomicBool::new(false);
    let page = record(&[0xd800, 65], (1 << 120) | 11);
    let mut old_pages = vec![Some(page.clone()), None].into_iter();
    let old = directory_page::collect(17, 1, &cancel, || Ok(old_pages.next().unwrap())).unwrap();
    let new = run(&Resident::new(1_000_000), vec![Ok(Some(page)), Ok(None)], 1).unwrap();
    assert_eq!(new.as_entries(), &old);
    assert_eq!(new.iter().next().unwrap().0, &vec![0xd800, 65]);
    assert_eq!(new[&vec![0xd800, 65]].identity.inode, (1 << 120) | 11);
}
#[test]
fn pre_and_post_query_cancel_do_not_publish_partial_maps_or_leak_budget() {
    let cancel = AtomicBool::new(true);
    let resident = Resident::new(1_000_000);
    let calls = Cell::new(0);
    let result = collect(17, 1, &cancel, &resident, || {
        calls.set(1);
        Ok(None)
    });
    assert_eq!(result, Err(Failure::Cancelled));
    assert_eq!(calls.get(), 0);
    cancel.store(false, Ordering::SeqCst);
    let result = collect(17, 1, &cancel, &resident, || {
        calls.set(calls.get() + 1);
        cancel.store(true, Ordering::SeqCst);
        Ok(Some(record(&[65], 1)))
    });
    assert_eq!(result, Err(Failure::Cancelled));
    assert_eq!(calls.get(), 1);
    assert!(resident.lease(1_000_000).is_ok());
}
#[test]
fn unwind_drops_query_captures_before_releasing_their_logical_buffer_lease() {
    struct Capture<'a> {
        resident: &'a Resident,
        result: &'a RefCell<Option<bool>>,
    }
    impl Drop for Capture<'_> {
        fn drop(&mut self) {
            *self.result.borrow_mut() = Some(self.resident.lease(1).is_err());
        }
    }
    let resident = Resident::new(QUERY_BYTES);
    let observed = RefCell::new(None);
    let capture = Capture {
        resident: &resident,
        result: &observed,
    };
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = collect(17, 1, &AtomicBool::new(false), &resident, move || {
            let _keep = &capture;
            panic!("owned query panic");
        });
    }));
    assert!(panic.is_err());
    assert_eq!(*observed.borrow(), Some(true));
    assert!(resident.lease(QUERY_BYTES).is_ok());
}
#[test]
fn exact_empty_eof_can_return_a_zero_charged_map_without_losing_its_owner() {
    let resident = Resident::new(QUERY_BYTES);
    let values = run(&resident, vec![Ok(None)], 0).unwrap();
    assert!(values.is_empty());
    assert!(resident.lease(QUERY_BYTES).is_ok());
    drop(values);
}
