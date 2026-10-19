//! Material-only counted leaf policy. No path, normalization or String API.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Failure {
    Invalid,
}
fn upper(unit: u16) -> u16 {
    if (u16::from(b'a')..=u16::from(b'z')).contains(&unit) {
        unit - 32
    } else {
        unit
    }
}
fn ascii(raw: &[u16], word: &[u8]) -> bool {
    raw.len() == word.len()
        && raw
            .iter()
            .zip(word)
            .all(|(a, b)| upper(*a) == u16::from(*b))
}
pub(super) fn check(raw: &[u16]) -> Result<(), Failure> {
    if raw.is_empty()
        || raw.len() > 255
        || raw == [46]
        || raw == [46, 46]
        || matches!(raw.last(), Some(32 | 46))
        || raw.iter().any(|v| {
            *v < 32
                || (0x7f..=0x9f).contains(v)
                || [47, 92, 58, 63, 42, 34, 60, 62, 124].contains(v)
        })
    {
        return Err(Failure::Invalid);
    }
    let stem = &raw[..raw.iter().position(|v| *v == 46).unwrap_or(raw.len())];
    if [
        b"CON".as_slice(),
        b"PRN",
        b"AUX",
        b"NUL",
        b"CONIN$",
        b"CONOUT$",
    ]
    .iter()
    .any(|word| ascii(stem, word))
        || (stem.len() == 4
            && (ascii(&stem[..3], b"COM") || ascii(&stem[..3], b"LPT"))
            && ((49..=57).contains(&stem[3]) || [0xb9, 0xb2, 0xb3].contains(&stem[3])))
    {
        return Err(Failure::Invalid);
    }
    // Surrogates are raw filename units, not UTF8 text. Neither well-formed
    // pairs nor unpaired units are rewritten, split, normalized or case-folded.
    Ok(())
}
#[cfg(test)]
#[path = "material_raw_name_tests.rs"]
mod tests;
