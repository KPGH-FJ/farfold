use super::*;
use crate::file_access::{
    ea_records::WorkBudget,
    material_backup_io::{self as transfer, Api, Mode, Session},
    material_carrier_records::{Error, RESIDENT_LIMIT, Resident, WORK_LIMIT},
};
use std::{
    ffi::c_void,
    fs::File,
    io::Cursor,
    sync::atomic::{AtomicBool, Ordering},
};

#[test]
fn every_extent_preserves_all_bytes_and_all_seek_positions() {
    let bytes: Vec<u8> = (0..31).collect();
    for start in 0..bytes.len() {
        for end in start + 1..=bytes.len() {
            let expected = [&bytes[..start], &bytes[end..], &bytes[start..end]].concat();
            let mut view = SecurityLast::new(
                Cursor::new(&bytes),
                bytes.len() as u64,
                start as u64..end as u64,
            )
            .unwrap();
            for position in 0..=bytes.len() {
                assert_eq!(
                    view.seek(SeekFrom::Start(position as u64)).unwrap(),
                    position as u64
                );
                let mut actual = Vec::new();
                view.read_to_end(&mut actual).unwrap();
                assert_eq!(actual, expected[position..]);
                assert_eq!(view.stream_position().unwrap(), bytes.len() as u64);
            }
            view.seek(SeekFrom::End(-1)).unwrap();
            view.seek(SeekFrom::Current(-1)).unwrap();
            let mut tail = [0; 2];
            view.read_exact(&mut tail).unwrap();
            assert_eq!(tail, expected[expected.len() - 2..]);
            assert!(view.seek(SeekFrom::End(1)).is_err());
            assert!(view.seek(SeekFrom::Start(u64::MAX)).is_err());
            assert_eq!(view.stream_position().unwrap(), bytes.len() as u64);
        }
    }
}

#[test]
fn invalid_extents_and_short_sources_cannot_invent_bytes() {
    for extent in [
        0..0,
        Range { start: 2, end: 1 },
        0..4,
        u64::MAX - 1..u64::MAX,
    ] {
        assert!(SecurityLast::new(Cursor::new([1, 2, 3]), 3, extent).is_err());
    }
    let mut short = SecurityLast::new(Cursor::new([1, 2, 3]), 4, 0..1).unwrap();
    assert_eq!(
        short.read_exact(&mut [0; 4]).unwrap_err().kind(),
        io::ErrorKind::UnexpectedEof
    );
    struct WrongSeek;
    impl Seek for WrongSeek {
        fn seek(&mut self, _: SeekFrom) -> io::Result<u64> {
            Ok(99)
        }
    }
    impl Read for WrongSeek {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            panic!("wrong offset must refuse before read")
        }
    }
    let mut wrong = SecurityLast::new(WrongSeek, 4, 0..1).unwrap();
    assert_eq!(
        wrong.read(&mut [0; 4]).unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
}

struct ShortReads(Cursor<Vec<u8>>);
impl Read for ShortReads {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let n = bytes.len().min(3);
        self.0.read(&mut bytes[..n])
    }
}
impl Seek for ShortReads {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        self.0.seek(from)
    }
}
struct Writes<'a> {
    bytes: Vec<u8>,
    calls: usize,
    aborts: usize,
    failure: bool,
    cancel_after: Option<&'a AtomicBool>,
}
impl Api for Writes<'_> {
    fn read(&mut self, _: &File, _: &mut [u8], _: &mut *mut c_void) -> io::Result<usize> {
        unreachable!()
    }
    fn write(&mut self, _: &File, input: &[u8], context: &mut *mut c_void) -> io::Result<usize> {
        *context = std::ptr::dangling_mut();
        self.calls += 1;
        if self.failure {
            return Err(io::Error::from_raw_os_error(5));
        }
        let n = input.len().min(7);
        self.bytes.extend_from_slice(&input[..n]);
        if let Some(cancel) = self.cancel_after {
            cancel.store(true, Ordering::SeqCst);
        }
        Ok(n)
    }
    fn abort(&mut self, _: Mode, _: &File, _: &mut *mut c_void) -> io::Result<()> {
        self.aborts += 1;
        Ok(())
    }
}
#[test]
fn original_transfer_short_writes_cancel_limit_and_failure_keep_exact_prefix_and_abort() {
    let source: Vec<u8> = (0..47).collect();
    let expected = [&source[..9], &source[24..], &source[9..24]].concat();
    for scenario in 0..5 {
        let cancel = AtomicBool::new(scenario == 1);
        let mut api = Writes {
            bytes: Vec::new(),
            calls: 0,
            aborts: 0,
            failure: scenario == 3,
            cancel_after: (scenario == 4).then_some(&cancel),
        };
        let file = tempfile::tempfile().unwrap();
        let mut context = None;
        let mut session = Session::new(&file, &mut api, Mode::Write, &mut context);
        let input = SecurityLast::new(ShortReads(Cursor::new(source.clone())), 47, 9..24).unwrap();
        let result = transfer::restore(
            &mut session,
            input,
            47,
            &mut WorkBudget::new(if scenario == 2 { 0 } else { WORK_LIMIT }),
            &cancel,
            1,
            &Resident::new(RESIDENT_LIMIT),
        );
        drop(session);
        assert!(context.is_none());
        match scenario {
            0 => {
                assert_eq!(result, Ok(()));
                assert_eq!(api.bytes, expected);
                assert_eq!(api.aborts, 1);
            }
            1 | 2 => {
                assert_eq!(
                    result,
                    Err(if scenario == 1 {
                        Error::Cancelled
                    } else {
                        Error::Limit
                    })
                );
                assert_eq!((api.calls, api.aborts), (0, 0));
            }
            3 => {
                assert_eq!(
                    result,
                    Err(Error::Io {
                        phase: "backupWrite",
                        code: Some(5)
                    })
                );
                assert_eq!((api.calls, api.aborts), (1, 1));
                assert!(api.bytes.is_empty());
            }
            _ => {
                assert_eq!(result, Err(Error::Cancelled));
                assert_eq!(api.bytes, expected[..7]);
                assert_eq!((api.calls, api.aborts), (1, 1));
            }
        }
    }
}
