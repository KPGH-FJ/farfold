use super::*;
use crate::file_access::material_carrier_records::{RESIDENT_LIMIT, WORK_LIMIT};
use std::{
    collections::VecDeque,
    io::{self, Cursor},
    panic::AssertUnwindSafe,
};
#[derive(Default)]
struct Fake {
    input: Cursor<Vec<u8>>,
    written: Vec<u8>,
    steps: VecDeque<usize>,
    aborts: usize,
    abort_fails: bool,
    fail_write: bool,
    panic_read: bool,
    read_error: Option<i32>,
    write_error: Option<i32>,
    abort_error: Option<i32>,
    cancel_after_read: Option<std::sync::Arc<AtomicBool>>,
}
impl Api for Fake {
    fn read(&mut self, _: &File, out: &mut [u8], ctx: &mut *mut c_void) -> io::Result<usize> {
        *ctx = std::ptr::dangling_mut();
        assert!(!self.panic_read, "controlled read panic");
        if let Some(code) = self.read_error {
            return Err(io::Error::from_raw_os_error(code));
        }
        let count = self.input.read(out)?;
        if let Some(cancel) = &self.cancel_after_read {
            cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        Ok(count)
    }
    fn write(&mut self, _: &File, input: &[u8], ctx: &mut *mut c_void) -> io::Result<usize> {
        *ctx = std::ptr::dangling_mut();
        if let Some(code) = self.write_error {
            return Err(io::Error::from_raw_os_error(code));
        }
        if self.fail_write {
            return Err(io::Error::from_raw_os_error(5));
        }
        let n = self.steps.pop_front().unwrap_or(input.len());
        if n <= input.len() {
            self.written.extend_from_slice(&input[..n]);
        }
        Ok(n)
    }
    fn abort(&mut self, _: Mode, _: &File, _: &mut *mut c_void) -> io::Result<()> {
        self.aborts += 1;
        if let Some(code) = self.abort_error {
            return Err(io::Error::from_raw_os_error(code));
        }
        if self.abort_fails {
            Err(io::Error::from_raw_os_error(5))
        } else {
            Ok(())
        }
    }
}
fn source(body: &[u8]) -> File {
    let mut f = tempfile::tempfile().unwrap();
    f.write_all(body).unwrap();
    f
}
#[test]
fn returned_zero_is_real_eof_and_spool_is_exact() {
    let body: Vec<u8> = (0..=255).cycle().take(BLOCK + 100).collect();
    let file = source(&[]);
    let spool = source(&[]);
    let mut api = Fake {
        input: Cursor::new(body.clone()),
        ..Fake::default()
    };
    let mut retired = None;
    {
        let mut s = Session::new(&file, &mut api, Mode::Read, &mut retired);
        assert_eq!(
            capture(
                &mut s,
                &spool,
                &mut WorkBudget::new(WORK_LIMIT),
                &AtomicBool::new(false),
                33,
                &Resident::new(RESIDENT_LIMIT)
            ),
            Ok(body.len() as u64)
        );
    }
    assert_eq!(api.aborts, 1);
    assert!(retired.is_none());
    let mut f = &spool;
    f.seek(SeekFrom::Start(0)).unwrap();
    let mut actual = Vec::new();
    f.read_to_end(&mut actual).unwrap();
    assert_eq!(actual, body);
}
#[test]
fn partial_writes_use_exact_unconsumed_offset_without_duplicate_data() {
    let body: Vec<u8> = (0..=255).cycle().take(BLOCK + 34).collect();
    let file = source(&[]);
    let spool = source(&body);
    let mut api = Fake {
        steps: VecDeque::from([7, 11]),
        ..Fake::default()
    };
    let mut retired = None;
    {
        let mut s = Session::new(&file, &mut api, Mode::Write, &mut retired);
        assert_eq!(
            restore(
                &mut s,
                &spool,
                body.len() as u64,
                &mut WorkBudget::new(WORK_LIMIT),
                &AtomicBool::new(false),
                33,
                &Resident::new(RESIDENT_LIMIT)
            ),
            Ok(())
        );
    }
    assert_eq!(api.written, body);
    assert_eq!(api.aborts, 1);
    assert!(retired.is_none());
}
#[test]
fn zero_or_over_count_fails_once_instead_of_spinning_or_skipping() {
    for count in [0, 201] {
        let file = source(&[]);
        let spool = source(&[3; 200]);
        let mut api = Fake {
            steps: VecDeque::from([count]),
            ..Fake::default()
        };
        let mut retired = None;
        {
            let mut s = Session::new(&file, &mut api, Mode::Write, &mut retired);
            assert_eq!(
                restore(
                    &mut s,
                    &spool,
                    200,
                    &mut WorkBudget::new(WORK_LIMIT),
                    &AtomicBool::new(false),
                    33,
                    &Resident::new(RESIDENT_LIMIT)
                ),
                Err(Error::Invalid)
            );
        }
        assert_eq!(api.aborts, 1);
        assert!(retired.is_none());
    }
}
#[test]
fn failed_abort_retains_opaque_context_and_is_never_retried() {
    let file = source(&[]);
    let spool = source(&[3; 200]);
    let mut api = Fake {
        fail_write: true,
        abort_fails: true,
        ..Fake::default()
    };
    let mut retired = None;
    {
        let mut s = Session::new(&file, &mut api, Mode::Write, &mut retired);
        assert_eq!(
            restore(
                &mut s,
                &spool,
                200,
                &mut WorkBudget::new(WORK_LIMIT),
                &AtomicBool::new(false),
                33,
                &Resident::new(RESIDENT_LIMIT)
            ),
            Err(Error::CleanupUnknown)
        );
        assert!(!s.finish());
    }
    assert_eq!(api.aborts, 1);
    assert!(retired.is_some());
}
#[test]
fn unwind_still_attempts_one_abort_and_preserves_failure() {
    let file = source(&[]);
    let spool = source(&[]);
    let mut api = Fake {
        panic_read: true,
        abort_fails: true,
        ..Fake::default()
    };
    let mut retired = None;
    assert!(
        std::panic::catch_unwind(AssertUnwindSafe(|| {
            let mut s = Session::new(&file, &mut api, Mode::Read, &mut retired);
            let _ = capture(
                &mut s,
                &spool,
                &mut WorkBudget::new(WORK_LIMIT),
                &AtomicBool::new(false),
                33,
                &Resident::new(RESIDENT_LIMIT),
            );
        }))
        .is_err()
    );
    assert_eq!(api.aborts, 1);
    assert!(retired.is_some());
}
#[test]
fn cancelled_or_underbudget_work_is_not_dispatched() {
    for cancelled in [false, true] {
        let file = source(&[]);
        let spool = source(&[3; 200]);
        let mut api = Fake::default();
        let mut retired = None;
        {
            let mut s = Session::new(&file, &mut api, Mode::Write, &mut retired);
            assert!(
                restore(
                    &mut s,
                    &spool,
                    200,
                    &mut WorkBudget::new(20),
                    &AtomicBool::new(cancelled),
                    33,
                    &Resident::new(RESIDENT_LIMIT)
                )
                .is_err()
            );
        }
        assert_eq!(api.aborts, 0);
        assert!(api.written.is_empty());
    }
}
#[test]
fn partial_progress_with_illegal_final_tail_fails_without_padding() {
    let file = source(&[]);
    let body = vec![3; 40];
    let spool = source(&body);
    let mut api = Fake {
        steps: VecDeque::from([10]),
        ..Fake::default()
    };
    let mut retired = None;
    {
        let mut s = Session::new(&file, &mut api, Mode::Write, &mut retired);
        assert_eq!(
            restore(
                &mut s,
                &spool,
                40,
                &mut WorkBudget::new(WORK_LIMIT),
                &AtomicBool::new(false),
                33,
                &Resident::new(RESIDENT_LIMIT)
            ),
            Err(Error::Unsupported)
        );
    }
    assert_eq!(api.written.as_slice(), &body[..10]);
    assert_eq!(api.aborts, 1);
    assert!(retired.is_none());
}

#[test]
fn cancellation_after_actual_read_still_aborts_the_same_context() {
    let file = source(&[]);
    let spool = source(&[]);
    let cancel = std::sync::Arc::new(AtomicBool::new(false));
    let mut api = Fake {
        input: Cursor::new(vec![9; 100]),
        cancel_after_read: Some(cancel.clone()),
        ..Fake::default()
    };
    let mut retired = None;
    {
        let mut session = Session::new(&file, &mut api, Mode::Read, &mut retired);
        assert_eq!(
            capture(
                &mut session,
                &spool,
                &mut WorkBudget::new(WORK_LIMIT),
                &cancel,
                33,
                &Resident::new(RESIDENT_LIMIT)
            ),
            Err(Error::Cancelled)
        );
    }
    assert_eq!(api.aborts, 1);
    assert!(retired.is_none());
}

#[test]
fn read_failure_and_distinct_abort_failure_are_both_retained() {
    let file = source(&[]);
    let spool = source(&[]);
    let mut retired = None;
    let mut api = Fake {
        read_error: Some(13),
        abort_error: Some(5),
        ..Fake::default()
    };
    {
        let mut session = Session::new(&file, &mut api, Mode::Read, &mut retired);
        assert_eq!(
            capture(
                &mut session,
                &spool,
                &mut WorkBudget::new(WORK_LIMIT),
                &AtomicBool::new(false),
                33,
                &Resident::new(RESIDENT_LIMIT)
            ),
            Err(Error::CleanupUnknown)
        );
        assert!(!session.finish());
    }
    let held = retired.as_ref().unwrap();
    assert_eq!(
        held.operation,
        OperationOutcome::Failed(Error::Io {
            phase: "backupRead",
            code: Some(13)
        })
    );
    assert_eq!(held._abort_error, Some(5));
    assert_eq!(
        held.operation_error(),
        Some(&Error::Io {
            phase: "backupRead",
            code: Some(13)
        })
    );
    assert_eq!(api.aborts, 1);
}
#[test]
fn write_failure_and_distinct_abort_failure_are_both_retained() {
    let file = source(&[]);
    let spool = source(&[3; 200]);
    let mut retired = None;
    let mut api = Fake {
        write_error: Some(87),
        abort_error: Some(32),
        ..Fake::default()
    };
    {
        let mut session = Session::new(&file, &mut api, Mode::Write, &mut retired);
        assert_eq!(
            restore(
                &mut session,
                &spool,
                200,
                &mut WorkBudget::new(WORK_LIMIT),
                &AtomicBool::new(false),
                33,
                &Resident::new(RESIDENT_LIMIT)
            ),
            Err(Error::CleanupUnknown)
        );
    }
    let held = retired.as_ref().unwrap();
    assert_eq!(
        held.operation,
        OperationOutcome::Failed(Error::Io {
            phase: "backupWrite",
            code: Some(87)
        })
    );
    assert_eq!(held._abort_error, Some(32));
    assert_eq!(api.aborts, 1);
}
#[test]
fn observed_cancellation_and_abort_failure_keep_separate_causes() {
    let file = source(&[]);
    let spool = source(&[]);
    let cancel = std::sync::Arc::new(AtomicBool::new(false));
    let mut api = Fake {
        input: Cursor::new(vec![9; 100]),
        cancel_after_read: Some(cancel.clone()),
        abort_error: Some(995),
        ..Fake::default()
    };
    let mut retired = None;
    {
        let mut session = Session::new(&file, &mut api, Mode::Read, &mut retired);
        assert_eq!(
            capture(
                &mut session,
                &spool,
                &mut WorkBudget::new(WORK_LIMIT),
                &cancel,
                33,
                &Resident::new(RESIDENT_LIMIT)
            ),
            Err(Error::CleanupUnknown)
        );
    }
    let held = retired.as_ref().unwrap();
    assert_eq!(held.operation, OperationOutcome::Failed(Error::Cancelled));
    assert_eq!(held._abort_error, Some(995));
    assert_eq!(api.aborts, 1);
}

#[test]
fn direct_inspection_requires_real_eof_and_retires_original_context_once() {
    let file = source(&[]);
    let mut api = Fake {
        input: Cursor::new(b"actual native input".to_vec()),
        ..Fake::default()
    };
    let mut retired = None;
    {
        let mut session = Session::new(&file, &mut api, Mode::Read, &mut retired);
        let bytes = inspect(
            &mut session,
            19,
            33,
            &mut WorkBudget::new(WORK_LIMIT),
            &Resident::new(RESIDENT_LIMIT),
            |reader, _| {
                let mut bytes = Vec::new();
                reader
                    .read_to_end(&mut bytes)
                    .map_err(|e| io_error("testReader", e))?;
                Ok(bytes)
            },
        )
        .unwrap();
        assert_eq!(bytes, b"actual native input");
    }
    assert_eq!(api.aborts, 1);
    assert!(retired.is_none());
}

#[test]
fn direct_inspection_early_success_does_not_count_as_eof() {
    let file = source(&[]);
    let mut api = Fake {
        input: Cursor::new(b"not exhausted".to_vec()),
        ..Fake::default()
    };
    let mut retired = None;
    {
        let mut session = Session::new(&file, &mut api, Mode::Read, &mut retired);
        assert_eq!(
            inspect(
                &mut session,
                13,
                33,
                &mut WorkBudget::new(WORK_LIMIT),
                &Resident::new(RESIDENT_LIMIT),
                |reader, _| {
                    let mut byte = [0];
                    reader
                        .read_exact(&mut byte)
                        .map_err(|e| io_error("testReader", e))?;
                    Ok(())
                }
            ),
            Err(Error::Invalid)
        );
    }
    assert_eq!(api.aborts, 1);
    assert!(retired.is_none());
}

#[test]
fn direct_inspection_preserves_native_error_and_unknown_abort_ownership() {
    let file = source(&[]);
    for unknown in [false, true] {
        let mut api = Fake {
            read_error: Some(1234),
            abort_fails: unknown,
            ..Fake::default()
        };
        let mut retired = None;
        {
            let mut session = Session::new(&file, &mut api, Mode::Read, &mut retired);
            assert_eq!(
                inspect(
                    &mut session,
                    0,
                    33,
                    &mut WorkBudget::new(WORK_LIMIT),
                    &Resident::new(RESIDENT_LIMIT),
                    |reader, _| {
                        let mut byte = [0];
                        reader
                            .read_exact(&mut byte)
                            .map_err(|e| io_error("parser", e))?;
                        Ok(())
                    }
                ),
                Err(if unknown {
                    Error::CleanupUnknown
                } else {
                    Error::Io {
                        phase: "backupRead",
                        code: Some(1234),
                    }
                })
            );
            assert_eq!(session.finish(), !unknown);
        }
        assert_eq!(api.aborts, 1);
        assert_eq!(retired.is_some(), unknown);
        if let Some(stopped) = retired {
            assert_eq!(
                stopped.operation_error(),
                Some(&Error::Io {
                    phase: "backupRead",
                    code: Some(1234)
                })
            );
        }
    }
}

#[test]
fn direct_inspection_budget_or_cancel_after_actual_read_still_aborts_once() {
    let file = source(&[]);
    for cancelled in [false, true] {
        let mut api = Fake {
            input: Cursor::new(b"bounded original".to_vec()),
            ..Fake::default()
        };
        let mut retired = None;
        {
            let mut session = Session::new(&file, &mut api, Mode::Read, &mut retired);
            let result = inspect(
                &mut session,
                16,
                33,
                &mut WorkBudget::new(100),
                &Resident::new(RESIDENT_LIMIT),
                |reader, work| {
                    let mut byte = [0];
                    reader
                        .read_exact(&mut byte)
                        .map_err(|e| io_error("testReader", e))?;
                    assert_eq!(byte, [b'b']); // the Native peer really supplied bytes
                    if cancelled {
                        check(&AtomicBool::new(true))?;
                    } else {
                        let refused = work.remaining() as usize + 1;
                        charge(work, refused)?;
                    }
                    Ok(())
                },
            );
            assert_eq!(
                result,
                Err(if cancelled {
                    Error::Cancelled
                } else {
                    Error::Limit
                })
            );
        }
        assert_eq!(api.aborts, 1);
        assert!(retired.is_none());
    }
}
