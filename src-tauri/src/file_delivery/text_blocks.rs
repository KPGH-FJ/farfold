//! One deterministic block, verified against the complete UTF-8 file.
use super::*;

const BLOCK_BYTES: usize = 128 * 1024;
const BLOCK_LINES: usize = 2000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextBlock {
    pub file: VerifiedFile,
    pub block_index: u64,
    pub block_count: u64,
    pub byte_start: u64,
    pub byte_end: u64,
    pub start_line: u64,
    pub end_line: u64,
    pub starts_mid_line: bool,
    pub ends_mid_line: bool,
    pub text: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct TextBlockFailure {
    pub code: &'static str,
}
impl TextBlockFailure {
    pub fn check(message: &str) -> Self {
        Self {
            code: super::RevisionFailure::check(message).code,
        }
    }
}
impl From<DeliveryError> for TextBlockFailure {
    fn from(error: DeliveryError) -> Self {
        Self {
            code: match error {
                DeliveryError::TooLarge => "tooLarge",
                DeliveryError::UnsupportedText => "unsupportedText",
                DeliveryError::Unreadable => "unreadable",
                DeliveryError::Changed
                | DeliveryError::OutsideRoot
                | DeliveryError::InvalidPath
                | DeliveryError::NotFile => "changed",
                _ => "unavailable",
            },
        }
    }
}

struct Blocks {
    current: TextBlock,
    selected: Option<TextBlock>,
    last: Option<TextBlock>,
    requested: u64,
    line: u64,
    mid_line: bool,
    newlines: usize,
    suffix: Vec<u8>,
    cr: bool,
}
impl Blocks {
    fn new(file: &VerifiedFile, requested: u64) -> Self {
        Self {
            current: TextBlock {
                file: file.clone(),
                block_index: 0,
                block_count: 0,
                byte_start: 0,
                byte_end: 0,
                start_line: 1,
                end_line: 1,
                starts_mid_line: false,
                ends_mid_line: false,
                text: String::new(),
            },
            selected: None,
            last: None,
            requested,
            line: 1,
            mid_line: false,
            newlines: 0,
            suffix: Vec::new(),
            cr: false,
        }
    }
    fn flush(&mut self) {
        let next = TextBlock {
            file: self.current.file.clone(),
            block_index: self.current.block_index + 1,
            block_count: 0,
            byte_start: self.current.byte_end,
            byte_end: self.current.byte_end,
            start_line: self.line,
            end_line: self.line,
            starts_mid_line: self.mid_line,
            ends_mid_line: self.mid_line,
            text: String::new(),
        };
        let block = std::mem::replace(&mut self.current, next);
        if block.block_index == self.requested {
            self.selected = Some(block.clone());
        }
        self.last = Some(block);
        self.newlines = 0;
    }
    fn token(&mut self, value: &str, newline: bool) {
        if self.current.text.len() + value.len() > BLOCK_BYTES {
            self.flush();
        }
        self.current.text.push_str(value);
        self.current.byte_end += value.len() as u64;
        self.current.end_line = self.line;
        if newline {
            self.line += 1;
            self.mid_line = false;
            self.newlines += 1;
        } else {
            self.mid_line = true;
        }
        self.current.ends_mid_line = self.mid_line;
        if self.current.text.len() == BLOCK_BYTES || self.newlines == BLOCK_LINES {
            self.flush();
        }
    }
    fn characters(&mut self, text: &str) {
        for character in text.chars() {
            if self.cr {
                self.cr = false;
                if character == '\n' {
                    self.token("\r\n", true);
                    continue;
                }
                self.token("\r", true);
            }
            if character == '\r' {
                self.cr = true;
            } else {
                let mut encoded = [0; 4];
                self.token(character.encode_utf8(&mut encoded), character == '\n');
            }
        }
    }
    fn consume(&mut self, bytes: &[u8]) -> Result<(), DeliveryError> {
        let mut joined = std::mem::take(&mut self.suffix);
        joined.extend_from_slice(bytes);
        match std::str::from_utf8(&joined) {
            Ok(text) => self.characters(text),
            Err(error) => {
                if error.error_len().is_some() {
                    return Err(DeliveryError::UnsupportedText);
                }
                let valid = error.valid_up_to();
                self.characters(
                    std::str::from_utf8(&joined[..valid])
                        .map_err(|_| DeliveryError::UnsupportedText)?,
                );
                self.suffix.extend_from_slice(&joined[valid..]);
            }
        }
        Ok(())
    }
    fn finish(mut self, restore: bool) -> Result<TextBlock, TextBlockFailure> {
        if !self.suffix.is_empty() {
            return Err(DeliveryError::UnsupportedText.into());
        }
        if self.cr {
            self.token("\r", true);
        }
        if !self.current.text.is_empty() || self.last.is_none() {
            self.flush();
        }
        let count = self.current.block_index;
        let selected = self.selected.or(if restore { self.last } else { None });
        let mut block = selected.ok_or(TextBlockFailure {
            code: "invalidBlock",
        })?;
        block.block_count = count;
        // End of file is a complete final line even without a newline.
        if block.block_index + 1 == count {
            block.ends_mid_line = false;
        }
        Ok(block)
    }
}

pub fn read_text_block(
    file: &VerifiedFile,
    block_index: u64,
    restore_position: bool,
) -> Result<TextBlock, TextBlockFailure> {
    let mut blocks = Blocks::new(file, block_index);
    stream::expected(file, |bytes, _| blocks.consume(bytes))?;
    blocks.finish(restore_position)
}

#[cfg(test)]
#[path = "text_blocks_tests.rs"]
mod tests;
