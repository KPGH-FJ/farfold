//! Track only the initial, still-unanswered ConPTY cursor inheritance query.
use std::{
    io::Write,
    sync::atomic::{AtomicUsize, Ordering},
};

const QUERY: &[u8] = b"\x1b[6n";
const DISARMED: usize = QUERY.len() + 1;

#[derive(Default)]
pub(super) struct CursorRetirement(AtomicUsize);

impl CursorRetirement {
    pub(super) fn observe(&self, bytes: &[u8]) {
        let offset = self.0.load(Ordering::Acquire);
        if offset == DISARMED {
            return;
        }
        let next = if QUERY[offset..].starts_with(bytes) {
            offset + bytes.len()
        } else {
            DISARMED
        };
        // A concurrent input write can disarm the query. Never re-arm it.
        let _ = self
            .0
            .compare_exchange(offset, next, Ordering::AcqRel, Ordering::Acquire);
    }

    pub(super) fn disarm(&self) {
        self.0.store(DISARMED, Ordering::Release);
    }

    /// Call under the same writer lock as ordinary input, after Child and Job
    /// are both stopped. Other bytes or any ordinary write disarm this path.
    pub(super) fn reply(&self, writer: &mut dyn Write) {
        if self.0.swap(DISARMED, Ordering::AcqRel) == QUERY.len() {
            let _ = writer.write_all(b"\x1b[1;1R").and_then(|()| writer.flush());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_complete_initial_query_without_other_output_or_input_is_answered_once() {
        for split in 0..=QUERY.len() {
            let cursor = CursorRetirement::default();
            cursor.observe(&QUERY[..split]);
            cursor.observe(&QUERY[split..]);
            let mut output = Vec::new();
            cursor.reply(&mut output);
            cursor.reply(&mut output);
            assert_eq!(output, b"\x1b[1;1R");
        }
        for (bytes, input, tail) in [
            (b"\x1b[6".as_slice(), false, b"".as_slice()),
            (b"x\x1b[6n", false, b""),
            (QUERY, false, b"x"),
            (QUERY, true, b""),
        ] {
            let cursor = CursorRetirement::default();
            cursor.observe(bytes);
            if input {
                cursor.disarm();
            }
            cursor.observe(tail);
            let mut output = Vec::new();
            cursor.reply(&mut output);
            assert!(output.is_empty());
        }
    }
}
