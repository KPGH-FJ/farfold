use super::*;
use std::io;
#[derive(Default)]
struct Sink {
    bytes: Vec<u8>,
    stop: Option<usize>,
}
impl Write for Sink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let remaining = self
            .stop
            .unwrap_or(usize::MAX)
            .saturating_sub(self.bytes.len());
        if remaining == 0 {
            return Err(io::Error::other("controlled capacity failure"));
        }
        let n = bytes.len().min(7).min(remaining);
        self.bytes.extend_from_slice(&bytes[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
#[test]
fn hash_writer_hashes_actual_short_write_prefixes_and_enforces_error_and_cap() {
    let mut writer = HashWriter {
        inner: Sink::default(),
        cancelled: &|| false,
        hash: Sha256::new(),
        bytes: 0,
    };
    writer.write_all(b"multiple short writes").unwrap();
    assert_eq!(writer.bytes, writer.inner.bytes.len() as u64);
    assert_eq!(
        writer
            .hash
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
        input::hash(&writer.inner.bytes)
    );
    let mut writer = HashWriter {
        inner: Sink {
            bytes: vec![],
            stop: Some(8),
        },
        cancelled: &|| false,
        hash: Sha256::new(),
        bytes: 0,
    };
    assert!(writer.write_all(b"more than eight bytes").is_err());
    assert_eq!(writer.bytes, 8);
    assert_eq!(writer.inner.bytes, b"more tha");
    writer.bytes = input::ZIP_BYTES;
    assert!(writer.write(b"x").is_err());
    assert_eq!(writer.inner.bytes.len(), 8);
}
