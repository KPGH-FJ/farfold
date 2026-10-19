use super::*;
use std::panic::{AssertUnwindSafe, catch_unwind};

#[test]
fn ordinary_pin_can_never_mint_full_coverage_even_if_the_process_happens_to_be_privileged() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let pin = PinnedPath::directory(&root).unwrap();
    assert_eq!(
        observation(&pin, &mut WorkBudget::new(65536), &AtomicBool::new(false)),
        Err(Failure::Record(RecordFailure::Unsupported))
    );
    assert!(!pin.full_security_purpose());
}
#[test]
fn exact_current_token_error_codes_retain_the_combined_requested_access_without_guessing() {
    for code in [5, 1314] {
        assert_eq!(
            Failure::native("fullSecurityOpen", io::Error::from_raw_os_error(code)),
            Failure::AccessCondition {
                phase: "fullSecurityOpen",
                code,
                required_access: READ_CONTROL | ACCESS_SYSTEM_SECURITY
            }
        );
    }
    assert_eq!(
        Failure::native("fullSecurityOpen", io::Error::from_raw_os_error(3)),
        Failure::Record(RecordFailure::Io {
            phase: "fullSecurityOpen",
            code: Some(3)
        })
    );
}
// Manual strict positive, not a skipped-success on ordinary Windows CI. The
// external caller must already have granted/enabled SeSecurity; this test never
// changes a token, account, DACL/SACL, privilege, environment, or user object.
#[test]
#[ignore = "requires current-token ACCESS_SYSTEM_SECURITY already granted; never enables it"]
fn current_token_full_security_root_and_child_share_qualified_data_objects_and_real_work_budget() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    std::fs::write(root.join("owned.txt"), b"same-body").unwrap();
    let pin = PinnedPath::directory_full_security(&root).expect("full-security condition required");
    let child = pin
        .child(&"owned.txt".encode_utf16().collect::<Vec<_>>(), false)
        .unwrap();
    assert!(pin.full_security_purpose());
    assert!(child.full_security_purpose());
    let cancel = AtomicBool::new(false);
    for pin in [&pin, &child] {
        let identity = stamp(pin.file()).unwrap().identity;
        let mut budget = WorkBudget::new(2 * QUERY_BYTES as u64);
        let first = observation(pin, &mut budget, &cancel).unwrap();
        assert_eq!(first.requested_information(), BACKUP_SECURITY_INFORMATION);
        assert_eq!(observation(pin, &mut budget, &cancel).unwrap(), first);
        assert_eq!(stamp(pin.file()).unwrap().identity, identity);
        assert_eq!(
            2 * QUERY_BYTES as u64 - budget.remaining(),
            2 * first.returned_bytes()
        );
        let owner = pin.try_observation_owner().unwrap();
        assert_eq!(
            observation(pin, &mut WorkBudget::new(65536), &cancel),
            Err(Failure::Record(RecordFailure::Busy))
        );
        drop(owner);
        assert_eq!(
            observation(pin, &mut WorkBudget::new(19), &cancel),
            Err(Failure::Record(RecordFailure::Limit))
        );
        assert_eq!(
            observation(pin, &mut WorkBudget::new(65536), &AtomicBool::new(true)),
            Err(Failure::Record(RecordFailure::Cancelled))
        );
    }
    assert!(
        catch_unwind(AssertUnwindSafe(|| {
            let _owner = child.try_observation_owner().unwrap();
            panic!("owned full-security poison control");
        }))
        .is_err()
    );
    assert_eq!(
        observation(&child, &mut WorkBudget::new(65536), &cancel),
        Err(Failure::Record(RecordFailure::Poisoned))
    );
    // Ordinary file reader still uses the exact held strong child's FileObject.
    use std::io::Read;
    let mut bytes = Vec::new();
    let mut data = child.file();
    data.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"same-body");
}
