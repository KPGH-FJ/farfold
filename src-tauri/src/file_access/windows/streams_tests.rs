//! Controlled production Session tests; no fake result is a Windows API proof.
use super::*;
use std::{cell::Cell, collections::VecDeque, rc::Rc};
struct Script {
    chunks: VecDeque<io::Result<Vec<u8>>>,
    abort_ok: bool,
    reads: Rc<Cell<usize>>,
    aborts: Rc<Cell<usize>>,
}
impl Api for Script {
    fn read(
        &mut self,
        _file: &File,
        bytes: &mut [u8],
        context: &mut *mut c_void,
    ) -> io::Result<usize> {
        self.reads.set(self.reads.get() + 1);
        // Pure opaque witness, never dereferenced or printed. This test does
        // not allocate/free or emulate a Windows BackupRead context.
        *context = std::ptr::dangling_mut::<u8>().cast();
        let data = self.chunks.pop_front().expect("unexpected data retry")?;
        assert!(data.len() <= bytes.len());
        bytes[..data.len()].copy_from_slice(&data);
        Ok(data.len())
    }
    fn abort(&mut self, _file: &File, context: &mut *mut c_void) -> io::Result<()> {
        self.aborts.set(self.aborts.get() + 1);
        if self.abort_ok {
            *context = ptr::null_mut();
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(5))
        }
    }
}
fn script(
    chunks: Vec<io::Result<Vec<u8>>>,
    abort_ok: bool,
) -> (Script, Rc<Cell<usize>>, Rc<Cell<usize>>) {
    let reads = Rc::new(Cell::new(0));
    let aborts = Rc::new(Cell::new(0));
    (
        Script {
            chunks: chunks.into(),
            abort_ok,
            reads: reads.clone(),
            aborts: aborts.clone(),
        },
        reads,
        aborts,
    )
}
#[test]
fn a_successful_data_sequence_finishes_once_without_a_drop_retry() {
    let file = tempfile::tempfile().unwrap();
    let mut retired = None;
    let (api, reads, aborts) = script(vec![Ok(vec![])], true);
    {
        let mut session = Session {
            file: &file,
            api,
            context: ptr::null_mut(),
            dispatched: false,
            finished: false,
            retired: &mut retired,
        };
        assert_eq!(session.read(&mut [0u8; 64]).unwrap(), 0);
        assert!(session.finish());
    }
    assert_eq!(reads.get(), 1);
    assert_eq!(aborts.get(), 1);
    assert!(retired.is_none());
}
#[test]
fn failed_abort_preserves_the_returned_context_and_is_never_retried_by_drop() {
    let file = tempfile::tempfile().unwrap();
    let mut retired = None;
    let (api, reads, aborts) = script(vec![Ok(vec![1])], false);
    {
        let mut session = Session {
            file: &file,
            api,
            context: ptr::null_mut(),
            dispatched: false,
            finished: false,
            retired: &mut retired,
        };
        assert_eq!(session.read(&mut [0u8; 64]).unwrap(), 1);
        assert!(!session.finish());
        assert!(!session.finish());
    }
    assert_eq!(reads.get(), 1);
    assert_eq!(aborts.get(), 1);
    let (context, error) = retired.unwrap();
    assert_eq!(context._pointer, std::ptr::dangling_mut::<u8>().cast());
    assert_eq!(error, Some(5));
}
#[test]
fn read_error_does_not_become_eof_and_still_finishes_once() {
    let file = tempfile::tempfile().unwrap();
    let mut retired = None;
    let (api, reads, aborts) = script(vec![Err(io::Error::from_raw_os_error(5))], true);
    {
        let mut session = Session {
            file: &file,
            api,
            context: ptr::null_mut(),
            dispatched: false,
            finished: false,
            retired: &mut retired,
        };
        assert!(session.read(&mut [0u8; 64]).is_err());
    }
    assert_eq!(reads.get(), 1);
    assert_eq!(aborts.get(), 1);
    assert!(retired.is_none());
}
#[test]
fn unwind_attempts_one_abort_before_the_outer_sink_can_be_adopted() {
    let file = tempfile::tempfile().unwrap();
    let mut retired = None;
    let (api, reads, aborts) = script(vec![Ok(vec![1])], false);
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let mut session = Session {
            file: &file,
            api,
            context: ptr::null_mut(),
            dispatched: false,
            finished: false,
            retired: &mut retired,
        };
        session.read(&mut [0u8; 64]).unwrap();
        panic!("controlled reader unwind");
    }));
    assert!(result.is_err());
    assert_eq!(reads.get(), 1);
    assert_eq!(aborts.get(), 1);
    assert!(retired.is_some());
}
#[test]
fn active_context_is_not_exported_but_sealed_retirement_can_cross_a_thread() {
    fn send<T: Send>() {}
    send::<RetiredBackup>();
}
