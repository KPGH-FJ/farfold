use super::*;
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}
#[test]
fn raw_units_including_unpaired_surrogates_are_admitted_without_rewriting() {
    for raw in [
        vec![0xd800],
        vec![0xdc00],
        vec![0x61, 0xd800, 0x62],
        wide("Ä-🙂-é.txt"),
    ] {
        let original = raw.clone();
        assert_eq!(check(&raw), Ok(()));
        assert_eq!(raw, original);
    }
}
#[test]
fn counted_limit_is_utf16_units_not_unicode_scalars_or_utf8_bytes() {
    let units = vec![0xd800; 255];
    assert_eq!(check(&units), Ok(()));
    assert_eq!(check(&[0xd800; 256]), Err(Failure::Invalid));
    assert_eq!(check(&wide(&"🙂".repeat(127))), Ok(()));
    assert_eq!(check(&wide(&"🙂".repeat(128))), Err(Failure::Invalid));
}
#[test]
fn relative_separators_controls_streams_and_empty_names_never_pass() {
    for raw in [
        vec![],
        vec![46],
        vec![46, 46],
        vec![0],
        vec![31],
        vec![127],
        vec![159],
        wide("a/b"),
        wide("a\\b"),
        wide("a:stream"),
        wide("a?"),
        wide("a*"),
        wide("a\""),
        wide("a<"),
        wide("a>"),
        wide("a|"),
        wide("a."),
        wide("a "),
    ] {
        assert_eq!(check(&raw), Err(Failure::Invalid));
    }
}
#[test]
fn dos_devices_and_extensions_keep_existing_material_boundary() {
    for word in [
        "CON",
        "con.txt",
        "NuL.bin",
        "prn",
        "AUX",
        "CONIN$",
        "conout$.x",
        "com1",
        "COM9.txt",
        "lpt1",
        "LPT9.bin",
        "COM¹",
        "LPT².txt",
        "COM³",
    ] {
        assert_eq!(check(&wide(word)), Err(Failure::Invalid));
    }
    for word in ["COM0", "LPT0", "CONSOLE", "NULx", "COM10", "ordinary.txt"] {
        assert_eq!(check(&wide(word)), Ok(()));
    }
}
#[test]
fn unicode_spelling_is_not_normalized_into_an_alias_or_device_name() {
    let composed = wide("é.txt");
    let decomposed = wide("e\u{301}.txt");
    assert_ne!(composed, decomposed);
    assert_eq!(check(&composed), Ok(()));
    assert_eq!(check(&decomposed), Ok(()));
    assert_eq!(check(&wide("ＣＯＮ.txt")), Ok(()));
    // Actual per-directory case-insensitive uniqueness uses the existing OS
    // ordinal comparison, not this non-mutating spelling validator.
}
