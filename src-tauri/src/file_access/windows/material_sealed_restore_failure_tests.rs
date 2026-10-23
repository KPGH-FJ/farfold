//! Failure-only test diagnostics. No write, reopen, privilege change or retry.
//! Readback is an intermediate observation, never restore acceptance. Diagnostic
//! I/O can affect test timing; its finite budget is separate from product work.
use super::*;

const HEADER_BYTES: u64 = 20;
const MAX_RECORDS: usize = 32;

#[derive(Debug, PartialEq, Eq)]
struct Header {
    start: u64,
    end: u64,
    id: u32,
    flags: u32,
    body_bytes: u64,
    name_bytes: u32,
}

// Visit numeric headers only. Names, bodies and descriptor bytes are not read
// or emitted. Offsets identify offered ranges, not the undocumented internal
// point at which a failed BackupWrite applied or refused a record.
fn layout(
    input: &mut (impl Read + Seek),
    length: u64,
    mut visit: impl FnMut(Header),
) -> io::Result<(usize, bool)> {
    let mut at = 0u64;
    let mut count = 0;
    while at < length && count < MAX_RECORDS {
        if length - at < HEADER_BYTES || input.seek(SeekFrom::Start(at))? != at {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut raw = [0u8; HEADER_BYTES as usize];
        input.read_exact(&mut raw)?;
        let body_bytes = u64::from_le_bytes(raw[8..16].try_into().unwrap());
        let name_bytes = u32::from_le_bytes(raw[16..20].try_into().unwrap());
        if body_bytes > i64::MAX as u64 || !name_bytes.is_multiple_of(2) {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let end = at
            .checked_add(HEADER_BYTES)
            .and_then(|n| n.checked_add(name_bytes as u64))
            .and_then(|n| n.checked_add(body_bytes))
            .filter(|n| *n <= length)
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))?;
        visit(Header {
            start: at,
            end,
            id: u32::from_le_bytes(raw[..4].try_into().unwrap()),
            flags: u32::from_le_bytes(raw[4..8].try_into().unwrap()),
            body_bytes,
            name_bytes,
        });
        at = end;
        count += 1;
    }
    Ok((count, at == length))
}

fn source_layout(sealed: &File, node: &tree::Node) {
    let mut cursor = sealed;
    let saved = match cursor.stream_position() {
        Ok(at) => at,
        Err(error) => {
            eprintln!(
                "FARFOLD_RESTORE_FAILURE_LAYOUT phase=save-position kind={:?} code={:?}",
                error.kind(),
                error.raw_os_error()
            );
            return;
        }
    };
    let result = Range::new(sealed, node).and_then(|mut input| {
        layout(&mut input, node.native_bytes, |header| {
            eprintln!(
                "FARFOLD_RESTORE_FAILURE_LAYOUT start={} end={} id={} flags={} bodyBytes={} nameBytes={}",
                header.start, header.end, header.id, header.flags, header.body_bytes, header.name_bytes
            );
        })
        .map_err(|error| io_error("diagnosticLayout", error))
    });
    // Restore even if scanning failed. This separate diagnostic outcome must
    // never replace the original BackupWrite failure or suppress its cleanup.
    let restored = cursor.seek(SeekFrom::Start(saved)).map(|at| at == saved);
    eprintln!("FARFOLD_RESTORE_FAILURE_LAYOUT result={result:?}");
    match restored {
        Ok(same) => {
            eprintln!("FARFOLD_RESTORE_FAILURE_LAYOUT positionRestored={same}");
        }
        Err(error) => eprintln!(
            "FARFOLD_RESTORE_FAILURE_LAYOUT phase=restore-position kind={:?} code={:?}",
            error.kind(),
            error.raw_os_error()
        ),
    }
}

pub(super) fn observe(
    sealed: &File,
    node: &tree::Node,
    proof: &NativeProof,
    target: &File,
    cancel: &AtomicBool,
    resident: &Resident,
) {
    source_layout(sealed, node);
    let _memory = match resident.lease(records::CATALOG_RESIDENT + 2 * records::BLOCK) {
        Ok(memory) => memory,
        Err(error) => {
            eprintln!("FARFOLD_RESTORE_FAILURE_READBACK phase=reserve error={error:?}");
            return;
        }
    };
    let mut security_work = WorkBudget::new(4 * records::BLOCK as u64);
    match regular::security(target, &mut security_work, cancel) {
        Ok(actual) => eprintln!(
            "FARFOLD_RESTORE_FAILURE_READBACK phase=full-security same={} descriptorBytes={} aceCount={}",
            proof.security.as_ref() == Some(&actual),
            actual.returned_bytes,
            actual.aces
        ),
        Err(error) => {
            eprintln!("FARFOLD_RESTORE_FAILURE_READBACK phase=full-security error={error:?}")
        }
    }
    // An SD query failure does not hide the independent stream query result.
    let mut stream_work = WorkBudget::new(4 * records::BLOCK as u64);
    let streams = match node.kind {
        tree::Kind::Regular => regular::inventory(target, &mut stream_work, cancel),
        tree::Kind::Directory => regular::directory_inventory(target, &mut stream_work, cancel),
    };
    match streams {
        Ok(inventory) => {
            let actual = inventory.carrier_data();
            let named_bytes = actual
                .iter()
                .filter(|(name, _)| !name.is_empty())
                .try_fold(0u64, |sum, (_, bytes)| sum.checked_add(*bytes));
            eprintln!(
                "FARFOLD_RESTORE_FAILURE_READBACK phase=streams same={} count={} defaultBytes={:?} namedCount={} namedBytes={named_bytes:?} expectedCount={} expectedDefaultBytes={:?}",
                actual == proof.expected,
                actual.len(),
                inventory.default_size(),
                actual.keys().filter(|name| !name.is_empty()).count(),
                proof.expected.len(),
                proof.expected.get(&Vec::<u16>::new())
            );
        }
        Err(error) => {
            eprintln!("FARFOLD_RESTORE_FAILURE_READBACK phase=streams error={error:?}");
        }
    }
}

fn header(id: u32, flags: u32, body: u64, name: u32) -> Vec<u8> {
    [
        id.to_le_bytes().as_slice(),
        flags.to_le_bytes().as_slice(),
        body.to_le_bytes().as_slice(),
        name.to_le_bytes().as_slice(),
    ]
    .concat()
}

#[test]
fn layout_reports_physical_offsets_without_reading_names_or_bodies() {
    struct HeadersOnly(std::io::Cursor<Vec<u8>>);
    impl Read for HeadersOnly {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            assert!(matches!(self.0.position(), 0 | 27));
            assert_eq!(bytes.len(), 20);
            self.0.read(bytes)
        }
    }
    impl Seek for HeadersOnly {
        fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
            self.0.seek(position)
        }
    }
    let mut bytes = header(3, 2, 5, 2);
    bytes.extend([0xff; 7]);
    bytes.extend(header(4, 0, 9, 4));
    bytes.extend([0xee; 13]);
    let length = bytes.len() as u64;
    let mut source = HeadersOnly(std::io::Cursor::new(bytes));
    let mut seen = Vec::new();
    assert_eq!(
        layout(&mut source, length, |v| seen.push(v)).unwrap(),
        (2, true)
    );
    assert_eq!(
        seen[0],
        Header {
            start: 0,
            end: 27,
            id: 3,
            flags: 2,
            body_bytes: 5,
            name_bytes: 2
        }
    );
    assert_eq!(
        seen[1],
        Header {
            start: 27,
            end: 60,
            id: 4,
            flags: 0,
            body_bytes: 9,
            name_bytes: 4
        }
    );
}

#[test]
fn layout_rejects_truncated_and_unbounded_record_extents() {
    for bytes in [
        vec![0; 19],
        header(1, 0, 1, 0),
        header(3, 0, u64::MAX, 0),
        header(4, 0, 0, 1),
    ] {
        let length = bytes.len() as u64;
        let mut source = std::io::Cursor::new(bytes);
        let mut visited = 0;
        assert!(layout(&mut source, length, |_| visited += 1).is_err());
        assert_eq!(visited, 0);
    }
}

#[test]
fn layout_caps_output_and_reports_incomplete_instead_of_inventing_eof() {
    let bytes = header(3, 0, 0, 0).repeat(MAX_RECORDS + 1);
    let length = bytes.len() as u64;
    let mut source = std::io::Cursor::new(bytes);
    let mut count = 0;
    assert_eq!(
        layout(&mut source, length, |_| count += 1).unwrap(),
        (MAX_RECORDS, false)
    );
    assert_eq!(count, MAX_RECORDS);
}
