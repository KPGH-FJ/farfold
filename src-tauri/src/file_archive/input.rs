//! Pure admission checks. No source/destination opening or logging.
use super::types::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub(crate) const TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
pub(crate) const INLINE_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const REQUEST_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const PAYLOAD_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MANIFEST_BYTES: usize = 1024 * 1024;
pub(crate) const ZIP_BYTES: u64 = TOTAL_BYTES + 4 * 1024 * 1024;
pub(crate) const ID_CAPACITY: usize = 4096;
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(crate) fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
pub(crate) fn digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn check_key(key: &Key) -> Result<(), Failure> {
    if !uuid(&key.operation_id) || !digest(&key.input_sha256) {
        Err(fail("invalidRequest"))
    } else {
        Ok(())
    }
}
pub(crate) fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn source_tuple(source: &Source) -> Value {
    match source {
        Source::Local {
            file: f,
            selected_by,
        } => json!([
            "local",
            [
                f.root,
                f.path,
                f.resolved_path,
                f.name,
                f.size,
                f.sha256,
                f.version
            ],
            selected_by
        ]),
        Source::InlineText { text, utf8_bytes } => json!(["inlineText", text, utf8_bytes]),
        Source::InlineBinary {
            base64,
            decoded_bytes,
        } => json!(["inlineBinary", base64, decoded_bytes]),
    }
}
// Fixed-position compact JSON, not arbitrary-map canonicalization. All numbers
// have bounded integer types; serde rejects lone surrogates and negative u64.
pub(crate) fn canonical(input: &Prepare) -> Vec<u8> {
    let candidates: Vec<_> = input
        .candidates
        .iter()
        .map(|c| {
            json!([
                c.candidate_id,
                [
                    c.origin.item_ordinal,
                    c.origin.role,
                    c.origin.attachment_ordinal,
                    c.origin.tool_content_ordinal,
                    c.origin.declaration
                ],
                c.display_name,
                c.declared_mime_type,
                c.representation,
                c.replaces_candidate_id
            ])
        })
        .collect();
    let selected: Vec<_> = input
        .selected
        .iter()
        .map(|s| json!([s.candidate_id, source_tuple(&s.source)]))
        .collect();
    let omitted: Vec<_> = input
        .omitted
        .iter()
        .map(|s| json!([s.candidate_id, s.reason]))
        .collect();
    serde_json::to_vec(&json!([
        "farfold.conversationArchive.v1",
        input.snapshot_id,
        input.selection_id,
        input.destination,
        input.markdown,
        candidates,
        selected,
        omitted
    ]))
    .expect("typed JSON contains no non-finite numbers")
}
fn path(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32768
        && !s.contains('\0')
        && crate::file_access::absolute(std::path::Path::new(s)).is_ok()
}
pub(crate) fn validate(input: &Prepare) -> Result<usize, Failure> {
    check_key(&input.key())?;
    if !uuid(&input.snapshot_id) || !uuid(&input.selection_id) || input.markdown.trim().is_empty() {
        return Err(fail("invalidRequest"));
    }
    if !path(&input.destination)
        || std::path::Path::new(&input.destination)
            .file_name()
            .is_none()
    {
        return Err(fail("invalidDestination"));
    }
    if input.markdown.len() > 1024 * 1024
        || input.candidates.len() > 4096
        || input.selected.len() > 256
        || input.omitted.len() > 4096
    {
        return Err(fail("tooLarge"));
    }
    let mut candidates = HashMap::new();
    for c in &input.candidates {
        if !uuid(&c.candidate_id)
            || candidates.insert(c.candidate_id.as_str(), c).is_some()
            || c.origin.item_ordinal > SAFE_INTEGER
            || c.origin
                .attachment_ordinal
                .is_some_and(|n| n > SAFE_INTEGER)
            || c.origin
                .tool_content_ordinal
                .is_some_and(|n| n > SAFE_INTEGER)
        {
            return Err(fail("invalidRequest"));
        }
        if c.display_name.len() > 1024
            || c.declared_mime_type.as_ref().is_some_and(|s| s.len() > 256)
        {
            return Err(fail("tooLarge"));
        }
    }
    let mut chosen = HashSet::new();
    let mut total = 0u64;
    let mut inline = 0usize;
    for s in &input.selected {
        let c = candidates
            .get(s.candidate_id.as_str())
            .ok_or(fail("invalidRequest"))?;
        if !chosen.insert(s.candidate_id.as_str()) {
            return Err(fail("invalidRequest"));
        }
        match &s.source {
            Source::Local {
                file: f,
                selected_by,
            } => {
                if c.representation != Representation::LocalCurrentFile
                    || !path(&f.root)
                    || !path(&f.path)
                    || !path(&f.resolved_path)
                    || f.name.len() > 32768
                    || !digest(&f.sha256)
                    || !digest(&f.version)
                    || (*selected_by == SelectedBy::FilePickerSubstitute)
                        != c.replaces_candidate_id.is_some()
                {
                    return Err(fail("invalidRequest"));
                }
                if f.size > crate::file_delivery::MAX_VERIFIED_FILE_BYTES {
                    return Err(fail("tooLarge"));
                }
            }
            Source::InlineText { text, utf8_bytes } => {
                if c.representation != Representation::ReceivedText
                    || *utf8_bytes != text.len() as u64
                {
                    return Err(fail("invalidData"));
                }
                inline = inline.checked_add(text.len()).ok_or(fail("tooLarge"))?;
            }
            Source::InlineBinary {
                base64,
                decoded_bytes,
            } => {
                if c.representation != Representation::ReceivedBytes {
                    return Err(fail("invalidData"));
                }
                if base64.len() > INLINE_BYTES.div_ceil(3) * 4
                    || *decoded_bytes > INLINE_BYTES as u64
                {
                    return Err(fail("tooLarge"));
                }
                let decoded = STANDARD.decode(base64).map_err(|_| fail("invalidData"))?;
                if decoded.len() as u64 != *decoded_bytes || STANDARD.encode(&decoded) != *base64 {
                    return Err(fail("invalidData"));
                }
                inline = inline.checked_add(decoded.len()).ok_or(fail("tooLarge"))?;
            }
        }
        total = total.checked_add(s.source.size()).ok_or(fail("tooLarge"))?;
        if total > TOTAL_BYTES || inline > INLINE_BYTES {
            return Err(fail("tooLarge"));
        }
    }
    let mut omitted = HashMap::new();
    for o in &input.omitted {
        if !candidates.contains_key(o.candidate_id.as_str())
            || !chosen.insert(o.candidate_id.as_str())
            || omitted.insert(o.candidate_id.as_str(), o.reason).is_some()
        {
            return Err(fail("invalidRequest"));
        }
    }
    if chosen.len() != candidates.len() {
        return Err(fail("invalidRequest"));
    }
    let mut replaced = HashSet::new();
    for c in &input.candidates {
        if let Some(original) = &c.replaces_candidate_id
            && (!uuid(original)
                || original == &c.candidate_id
                || !candidates.contains_key(original.as_str())
                || candidates[original.as_str()]
                    .replaces_candidate_id
                    .is_some()
                || !replaced.insert(original.as_str())
                || omitted.get(original.as_str()) != Some(&Omission::ReplacedByUserSelection)
                || !input.selected.iter().any(|s| {
                    s.candidate_id == c.candidate_id
                        && matches!(
                            s.source,
                            Source::Local {
                                selected_by: SelectedBy::FilePickerSubstitute,
                                ..
                            }
                        )
                }))
        {
            return Err(fail("invalidRequest"));
        }
    }
    if omitted
        .iter()
        .any(|(id, why)| *why == Omission::ReplacedByUserSelection && !replaced.contains(id))
    {
        return Err(fail("invalidRequest"));
    }
    let retained = serde_json::to_vec(input)
        .map_err(|_| fail("invalidRequest"))?
        .len();
    if retained > REQUEST_BYTES || super::manifest::estimated_size(input) > MANIFEST_BYTES {
        return Err(fail("tooLarge"));
    }
    if hash(&canonical(input)) != input.input_sha256 {
        return Err(fail("invalidRequest"));
    }
    Ok(retained)
}
