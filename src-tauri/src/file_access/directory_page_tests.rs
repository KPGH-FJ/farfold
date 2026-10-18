use super::*;
fn record(name: &[u16], id: u128) -> Vec<u8> {
    let mut b = vec![0u8; HEADER + name.len() * 2];
    b[60..64].copy_from_slice(&(name.len() as u32 * 2).to_le_bytes());
    b[72..88].copy_from_slice(&id.to_le_bytes());
    for (out, unit) in b[HEADER..].chunks_exact_mut(2).zip(name) {
        out.copy_from_slice(&unit.to_le_bytes());
    }
    b
}
fn chain(mut a: Vec<u8>, b: Vec<u8>) -> Vec<u8> {
    a.resize(a.len().next_multiple_of(8), 0);
    let next = a.len() as u32;
    a[..4].copy_from_slice(&next.to_le_bytes());
    a.extend(b);
    a
}
#[test]
fn full_identity_raw_utf16_and_reparse_are_observations_not_authority() {
    let cancel = AtomicBool::new(false);
    let mut b = record(&[0xd800, 0x61], (1 << 120) | 7);
    b[56..60].copy_from_slice(&0x400u32.to_le_bytes());
    b[68..72].copy_from_slice(&0xa000000cu32.to_le_bytes());
    let values = page(&b, u64::MAX - 1, &cancel).unwrap();
    let v = &values[&vec![0xd800, 0x61]];
    assert_eq!(
        v.identity,
        Identity {
            device: u64::MAX - 1,
            inode: (1 << 120) | 7
        }
    );
    assert_eq!(v.reparse_tag, Some(0xa000000c));
    b[56..60].copy_from_slice(&0u32.to_le_bytes());
    assert_eq!(
        page(&b, 1, &cancel)
            .unwrap()
            .values()
            .next()
            .unwrap()
            .reparse_tag,
        None
    );
}
#[test]
fn malformed_offsets_lengths_ids_and_nonterminal_padding_never_return_partial_success() {
    let good = record(&[65], 1);
    let cancel = AtomicBool::new(false);
    let mut bad = vec![
        vec![],
        good[..HEADER - 1].to_vec(),
        good[..good.len() - 1].to_vec(),
    ];
    for length in [0, 1, 512, u32::MAX] {
        let mut b = good.clone();
        b[60..64].copy_from_slice(&length.to_le_bytes());
        bad.push(b);
    }
    for next in [1, 88, 96, u32::MAX] {
        let mut b = good.clone();
        b[..4].copy_from_slice(&next.to_le_bytes());
        bad.push(b);
    }
    for name in [[0], [47], [92]] {
        bad.push(record(&name, 1));
    }
    let mut tail = good.clone();
    tail.extend([0u8; 8]);
    bad.push(tail);
    let mut negative = good.clone();
    negative[40..48].copy_from_slice(&(-1i64).to_le_bytes());
    bad.push(negative);
    for b in bad {
        assert!(page(&b, 1, &cancel).is_err());
    }
    assert_eq!(
        page(&record(&[65], 0), 1, &cancel),
        Err(Failure::Unsupported)
    );
    assert_eq!(
        page(&chain(good.clone(), good), 1, &cancel),
        Err(Failure::Changed)
    );
}
#[test]
fn complete_eof_budget_and_repeat_controls_preserve_all_names() {
    let cancel = AtomicBool::new(false);
    let a = record(&[65], 1);
    let b = record(&[66], 2);
    let run = |pages: Vec<Result<Option<Vec<u8>>, Failure>>, remaining| {
        let mut iter = pages.into_iter();
        collect(9, remaining, &cancel, || {
            iter.next().expect("no extra API call")
        })
    };
    assert_eq!(
        run(vec![Ok(Some(chain(a.clone(), b.clone()))), Ok(None)], 2)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        run(vec![Ok(Some(a.clone())), Ok(Some(b))], 1),
        Err(Failure::Limit)
    );
    assert_eq!(
        run(vec![Ok(Some(a.clone())), Ok(Some(a.clone()))], 2),
        Err(Failure::Changed)
    );
    assert_eq!(
        run(
            vec![Ok(Some(record(&[46], 1))), Ok(Some(record(&[46], 1)))],
            0
        ),
        Err(Failure::Changed)
    );
    assert_eq!(
        run(
            vec![
                Ok(Some(a)),
                Err(Failure::Io {
                    phase: "query",
                    code: Some(5),
                    nt_status: None
                })
            ],
            2
        ),
        Err(Failure::Io {
            phase: "query",
            code: Some(5),
            nt_status: None
        })
    );
    assert!(run(vec![Ok(None)], 0).unwrap().is_empty());
    assert_eq!(run(vec![Ok(Some(vec![]))], 1), Err(Failure::InvalidRecord));
}
#[test]
fn cancellation_is_checked_before_and_after_every_query_without_an_extra_call() {
    let cancel = AtomicBool::new(true);
    let mut calls = 0;
    assert_eq!(
        collect(1, 1, &cancel, || {
            calls += 1;
            Ok(None)
        }),
        Err(Failure::Cancelled)
    );
    assert_eq!(calls, 0);
    cancel.store(false, Ordering::SeqCst);
    assert_eq!(
        collect(1, 1, &cancel, || {
            calls += 1;
            cancel.store(true, Ordering::SeqCst);
            Ok(Some(record(&[65], 1)))
        }),
        Err(Failure::Cancelled)
    );
    assert_eq!(calls, 1);
}
#[test]
fn the_original_100k_global_entry_limit_is_not_raised_by_remaining() {
    let cancel = AtomicBool::new(false);
    let mut next = 0usize;
    let outcome = collect(1, usize::MAX, &cancel, || {
        next += 1;
        let name = format!("entry-{next}").encode_utf16().collect::<Vec<_>>();
        Ok(Some(record(&name, next as u128)))
    });
    assert_eq!(outcome, Err(Failure::Limit));
    assert_eq!(next, MAX_ENTRIES + 1);
}
