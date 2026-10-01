use super::*;
use serde_json::{Value, json};

const PACKAGE: &str = "@official/companion";
const BIN: &str = "companion";
const URL: &str = "https://registry.npmjs.org/@official%2fcompanion";
const OLD: &str = "2026-09-01T00:00:00Z";

fn manifest() -> Value {
    json!({"name":PACKAGE,"engines":{"node":">=22.19.0"},"bin":{BIN:"dist/cli.js"}})
}

fn select_fixture(metadata: &Value, range: Option<&str>) -> Result<ProgramRelease, String> {
    select_from(
        metadata,
        PACKAGE,
        BIN,
        range,
        URL,
        utc_seconds("2026-10-01T00:00:00Z").unwrap(),
    )
}

#[test]
fn no_minimum_uses_the_newest_eligible_official_stable_release() {
    let mut metadata = json!({"versions":{},"time":{}});
    for version in [
        "0.1.0",
        "0.2.0",
        "0.3.0",
        "0.4.0",
        "0.5.0",
        "0.6.0",
        "0.7.0",
        "0.8.0",
        "0.9.0",
        "0.10.0",
        "0.11.0",
        "0.12.0",
        "0.13.0",
        "9.0.0-beta.1",
    ] {
        metadata["versions"][version] = manifest();
        metadata["time"][version] = json!(OLD);
    }
    metadata["versions"]["0.3.0"]["name"] = json!("@unrelated/program");
    metadata["versions"]["0.4.0"]["deprecated"] = json!("Use another version");
    metadata["time"]["0.5.0"] = json!("2026-09-30T00:00:00Z");
    metadata["time"]["0.6.0"] = json!("2026-10-02T00:00:00Z");
    metadata["time"]["0.7.0"] = json!("not-an-official-timestamp");
    metadata["time"].as_object_mut().unwrap().remove("0.8.0");
    metadata["versions"]["0.9.0"]["engines"]["node"] = json!("unsupported || range");
    metadata["versions"]["0.10.0"]
        .as_object_mut()
        .unwrap()
        .remove("engines");
    metadata["versions"]["0.11.0"]["bin"] = json!({"other":"dist/cli.js"});
    metadata["versions"]["0.12.0"]["bin"] = json!({BIN:"../outside.js"});
    metadata["versions"]["0.13.0"]["bin"] = json!({BIN:"/outside.js"});

    let release = select_fixture(&metadata, None).unwrap();
    assert_eq!(release.package, PACKAGE);
    assert_eq!(release.version, "0.2.0");
    assert_eq!(release.bin, BIN);
    assert_eq!(release.node_engine, ">=22.19.0");
    assert_eq!(release.source_url, URL);
    assert_eq!(release.published_at, OLD);
    assert_eq!(
        select_fixture(&metadata, Some("<0.2.0")).unwrap().version,
        "0.1.0"
    );
    assert!(select_fixture(&metadata, Some(">=0.81.0")).is_err());
    assert!(select_fixture(&metadata, Some("not a verified range")).is_err());
}

#[test]
fn no_minimum_does_not_relax_the_seven_day_boundary() {
    let mut metadata = json!({"versions":{"0.0.1":manifest()},"time":{
        "0.0.1":"2026-09-24T00:00:00.001Z"
    }});
    assert!(select_fixture(&metadata, None).is_err());
    metadata["time"]["0.0.1"] = json!("2026-09-24T00:00:00Z");
    assert_eq!(select_fixture(&metadata, None).unwrap().version, "0.0.1");
    assert!(select_fixture(&metadata, Some(">=0.81.0")).is_err());
}
