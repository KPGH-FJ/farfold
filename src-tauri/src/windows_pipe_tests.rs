//! Real Win32 pipe tests; only local, self-connected handles and synthetic bytes.
use super::*;
use std::io::Read;

#[test]
fn fixed_stdin_has_nonblocking_parent_and_blocking_byte_reader() {
    let (writer, reader) = stdin_pair().unwrap();
    for (file, nonblocking) in [(&writer, true), (&reader, false)] {
        let mut state = 0;
        assert_ne!(
            unsafe {
                GetNamedPipeHandleStateW(
                    file.as_raw_handle(),
                    &mut state,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    0,
                )
            },
            0
        );
        assert_eq!(state & PIPE_NOWAIT != 0, nonblocking);
        assert_eq!(state & PIPE_READMODE_MESSAGE, 0);
        let mut flags = 0;
        assert_ne!(
            unsafe { GetHandleInformation(file.as_raw_handle(), &mut flags) },
            0
        );
        assert_eq!(flags & HANDLE_FLAG_INHERIT, 0);
    }
    assert!(logon_sid().unwrap().starts_with("S-1-5-5-"));
    assert_eq!(write_handle(writer.as_raw_handle(), &[]).unwrap(), 0);
}

#[test]
fn full_byte_pipe_reports_backpressure_and_preserves_every_accepted_byte() {
    let (writer, mut reader) = stdin_pair().unwrap();
    let mut expected = Vec::new();
    let mut blocked = false;
    for turn in 0..2048 {
        let bytes: Vec<_> = (0..8192).map(|n| ((n + turn) % 251) as u8).collect();
        match write_handle(writer.as_raw_handle(), &bytes) {
            Ok(count) => {
                assert!(count > 0 && count <= bytes.len());
                expected.extend_from_slice(&bytes[..count]);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                blocked = true;
                break;
            }
            result => panic!("unexpected fixed pipe result: {result:?}"),
        }
    }
    assert!(
        blocked,
        "the finite synthetic write series must reach backpressure"
    );
    let mut actual = vec![0; expected.len()];
    reader.read_exact(&mut actual).unwrap();
    assert_eq!(actual, expected);
    let tail = b"after backpressure";
    assert_eq!(
        write_handle(writer.as_raw_handle(), tail).unwrap(),
        tail.len()
    );
    let mut actual = vec![0; tail.len()];
    reader.read_exact(&mut actual).unwrap();
    assert_eq!(actual, tail);
    drop(writer);
    assert_eq!(reader.read(&mut [0; 1]).unwrap(), 0);
}

#[test]
fn retired_reader_cannot_report_a_successful_nonempty_write() {
    let (writer, reader) = stdin_pair().unwrap();
    drop(reader);
    assert!(write_handle(writer.as_raw_handle(), b"not delivered").is_err());
}
