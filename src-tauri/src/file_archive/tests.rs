use super::{input, types::*};
use serde_json::json;

fn synthetic(path: &str) -> String {
    #[cfg(windows)]
    let root = std::path::Path::new(r"C:\synthetic");
    #[cfg(not(windows))]
    let root = std::path::Path::new("/synthetic");
    root.join(path).to_str().unwrap().into()
}

pub(crate) fn id(n: u64) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}
pub(crate) fn sample(destination: String) -> Prepare {
    let mut p = Prepare {
        operation_id: id(1),
        input_sha256: String::new(),
        snapshot_id: id(2),
        selection_id: id(3),
        destination,
        markdown: "# 已加载\n\n正文 <literal>\n".into(),
        candidates: vec![Candidate {
            candidate_id: id(4),
            origin: Origin {
                item_ordinal: 0,
                role: Role::Agent,
                attachment_ordinal: Some(0),
                tool_content_ordinal: None,
                declaration: Declaration::MessageAttachment,
            },
            display_name: "空\" \n😀\u{2028}".into(),
            declared_mime_type: Some("text/plain".into()),
            representation: Representation::ReceivedText,
            replaces_candidate_id: None,
        }],
        selected: vec![Selected {
            candidate_id: id(4),
            source: Source::InlineText {
                text: "\0\t\u{0008}\u{000c}\r\n中文😀".into(),
                utf8_bytes: 0,
            },
        }],
        omitted: vec![],
    };
    if let Source::InlineText { text, utf8_bytes } = &mut p.selected[0].source {
        *utf8_bytes = text.len() as u64;
    }
    resign(&mut p);
    p
}
pub(crate) fn resign(p: &mut Prepare) {
    p.input_sha256 = input::hash(&input::canonical(p));
}
#[test]
fn canonical_serialization_actual_wire() {
    let first = sample(synthetic("未创建 archive.zip"));
    let mut empty = first.clone();
    empty.operation_id = id(5);
    empty.selected.clear();
    empty.omitted = vec![Omitted {
        candidate_id: id(4),
        reason: Omission::NotSelected,
    }];
    resign(&mut empty);
    let mut binary = first.clone();
    binary.operation_id = id(6);
    binary.candidates[0].representation = Representation::ReceivedBytes;
    binary.selected[0].source = Source::InlineBinary {
        base64: "AAEC/w==".into(),
        decoded_bytes: 4,
    };
    resign(&mut binary);
    let mut local = first.clone();
    local.operation_id = id(7);
    local.candidates[0].representation = Representation::LocalCurrentFile;
    local.selected[0].source = Source::Local {
        file: LocalFile {
            root: synthetic(""),
            path: synthetic("source"),
            resolved_path: synthetic("source"),
            name: "source".into(),
            size: 0,
            sha256: "0".repeat(64),
            version: "1".repeat(64),
        },
        selected_by: SelectedBy::DeclaredSource,
    };
    resign(&mut local);
    let mut values = vec![];
    for p in [first, empty, binary, local] {
        input::validate(&p).unwrap();
        let bytes = input::canonical(&p);
        values.push(json!({"input":p,"canonical":String::from_utf8(bytes.clone()).unwrap(),"sha256":input::hash(&bytes),"ready":Status::ready(&p)}));
    }
    println!(
        "ARCHIVE_CANONICAL_WIRE={}",
        serde_json::to_string(&values).unwrap()
    );
}
#[test]
fn strict_input_rejects_unknown_missing_null_negative_and_surrogate_fields() {
    let value = serde_json::to_value(sample(synthetic("archive.zip"))).unwrap();
    let mut missing = value.clone();
    missing["candidates"][0]["origin"]
        .as_object_mut()
        .unwrap()
        .remove("toolContentOrdinal");
    assert!(serde_json::from_value::<Prepare>(missing).is_err());
    let mut extra = value.clone();
    extra["selected"][0]["source"]["secret"] = json!("never accepted");
    assert!(serde_json::from_value::<Prepare>(extra).is_err());
    let text = serde_json::to_string(&value)
        .unwrap()
        .replace("\"itemOrdinal\":0", "\"itemOrdinal\":-0");
    assert!(serde_json::from_str::<Prepare>(&text).is_err());
    let mut bad = value;
    bad["markdown"] = json!("sentinel");
    assert!(
        serde_json::from_str::<Prepare>(
            &serde_json::to_string(&bad)
                .unwrap()
                .replace("sentinel", "\\ud800")
        )
        .is_err()
    );
}
#[test]
fn validation_recomputes_bytes_hash_and_complete_selection_without_opening_files() {
    let p = sample(synthetic("no-such-parent/archive.zip"));
    input::validate(&p).unwrap();
    let mut bad = p.clone();
    bad.markdown.push('x');
    assert_eq!(input::validate(&bad).unwrap_err().code, "invalidRequest");
    let mut bad = p.clone();
    bad.selected[0].source = Source::InlineText {
        text: "é".into(),
        utf8_bytes: 1,
    };
    resign(&mut bad);
    assert_eq!(input::validate(&bad).unwrap_err().code, "invalidData");
    let mut bad = p.clone();
    bad.selected.clear();
    resign(&mut bad);
    assert_eq!(input::validate(&bad).unwrap_err().code, "invalidRequest");
    let mut bad = p.clone();
    bad.candidates[0].representation = Representation::ReceivedBytes;
    bad.selected[0].source = Source::InlineBinary {
        base64: "AB==".into(),
        decoded_bytes: 1,
    };
    resign(&mut bad);
    assert_eq!(input::validate(&bad).unwrap_err().code, "invalidData");
}
#[test]
fn canonical_safe_integer_empty_text_and_array_order_actual_wire() {
    let mut p = sample(synthetic("boundary.zip"));
    p.candidates[0].origin.item_ordinal = 9_007_199_254_740_991;
    p.selected[0].source = Source::InlineText {
        text: String::new(),
        utf8_bytes: 0,
    };
    let mut second = p.candidates[0].clone();
    second.candidate_id = id(10);
    second.display_name = String::new();
    second.declared_mime_type = None;
    p.candidates.push(second);
    p.omitted.push(Omitted {
        candidate_id: id(10),
        reason: Omission::NotSelected,
    });
    resign(&mut p);
    input::validate(&p).unwrap();
    let mut reversed = p.clone();
    reversed.candidates.reverse();
    resign(&mut reversed);
    input::validate(&reversed).unwrap();
    assert_ne!(p.input_sha256, reversed.input_sha256);
    let values:Vec<_>=[p.clone(),reversed].into_iter().map(|p|{let bytes=input::canonical(&p);json!({"input":p,"canonical":String::from_utf8(bytes.clone()).unwrap(),"sha256":input::hash(&bytes),"ready":Status::ready(&p)})}).collect();
    println!(
        "ARCHIVE_CANONICAL_BOUNDARY_WIRE={}",
        serde_json::to_string(&values).unwrap()
    );
    p.candidates[0].origin.item_ordinal += 1;
    resign(&mut p);
    assert_eq!(input::validate(&p).unwrap_err().code, "invalidRequest");
}
#[test]
fn ordinary_extension_hints_are_usable_without_reusing_untrusted_basenames() {
    let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../src/runtime/fixtures/archive-member-cases.json"
    ))
    .unwrap();
    for c in cases {
        let mut p = sample(synthetic("archive.zip"));
        p.candidates[0].display_name = c["displayName"].as_str().unwrap().into();
        if c["inlineText"] == false {
            p.candidates[0].representation = Representation::ReceivedBytes;
            p.selected[0].source = Source::InlineBinary {
                base64: "AA==".into(),
                decoded_bytes: 1,
            };
        }
        let value: serde_json::Value =
            serde_json::from_slice(&super::manifest::document(&p, &["0".repeat(64)])).unwrap();
        if c["index"] == 0 {
            assert_eq!(value["items"][0]["included"]["member"], c["member"]);
        }
        assert_eq!(
            super::manifest::member(
                c["index"].as_u64().unwrap() as usize,
                &p.selected[0].source,
                &p.candidates[0].display_name
            ),
            c["member"],
            "shared hint case {c}"
        );
    }
}
