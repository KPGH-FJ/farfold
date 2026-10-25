use super::*;
#[test]
fn windows_file_identity_preserves_all_128_bits_and_volume_bytes() {
    let value = serde_json::json!({"windows":{"volume":[1,2,3,4,5,6,7,8],"fileId":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]}});
    let id: Stamp = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(&id).unwrap(), value);
    let mut other = value.clone();
    other["windows"]["fileId"][15] = serde_json::json!(17);
    assert_ne!(id, serde_json::from_value::<Stamp>(other).unwrap());
    for invalid in [
        serde_json::json!({"windows":{"volume":[1],"fileId":vec![0;16]}}),
        serde_json::json!({"windows":{"volume":vec![0;8],"fileId":vec![0;16],"future":true}}),
        serde_json::json!({"dev":1,"ino":2,"windows":{"volume":vec![0;8],"fileId":vec![0;16]}}),
        serde_json::json!({"dev":1,"ino":2,"future":true}),
    ] {
        assert!(serde_json::from_value::<Stamp>(invalid).is_err());
    }
}
#[test]
fn unix_stamp_serialized_bytes_and_unknown_field_rules_are_unchanged() {
    let raw = r#"{"dev":18446744073709551615,"ino":9007199254740993}"#;
    let id: Stamp = serde_json::from_str(raw).unwrap();
    assert_eq!(serde_json::to_string(&id).unwrap(), raw);
    assert!(serde_json::from_str::<Stamp>(r#"{"dev":1,"dev":2,"ino":3}"#).is_err());
}
#[cfg(unix)]
#[test]
fn foreign_windows_stamp_cannot_verify_a_unix_directory_or_rewrite_it() {
    let directory = tempfile::tempdir().unwrap();
    let raw = serde_json::json!({"windows":{"volume":vec![1;8],"fileId":vec![1;16]}});
    let id: Stamp = serde_json::from_value(raw.clone()).unwrap();
    let current = canonical(directory.path()).unwrap();
    assert_eq!(same(&current, &id).unwrap_err().code, "changed");
    assert_eq!(serde_json::to_value(id).unwrap(), raw);
}
#[cfg(windows)]
#[test]
fn foreign_unix_stamp_is_not_verified_or_rewritten_on_windows() {
    let directory = crate::test_support::tempdir().unwrap();
    let raw = r#"{"dev":1,"ino":2}"#;
    let id: Stamp = serde_json::from_str(raw).unwrap();
    assert_eq!(
        same(&canonical(directory.path()).unwrap(), &id)
            .unwrap_err()
            .code,
        "changed"
    );
    assert_eq!(serde_json::to_string(&id).unwrap(), raw);
}
