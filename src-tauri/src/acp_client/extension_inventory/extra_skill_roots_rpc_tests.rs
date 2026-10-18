//! Fixed-protocol counterexamples. No subprocess or real account.
use super::*;
use serde_json::{Value, json};

fn local_fixture_path(path: &str) -> String {
    if cfg!(windows) {
        format!("C:{path}")
    } else {
        path.into()
    }
}

fn receive(exchange: &mut skills_rpc::Exchange, value: Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&value).unwrap();
    bytes.push(b'\n');
    exchange.received(&mut bytes)
}
fn writes(exchange: &mut skills_rpc::Exchange) -> Vec<Value> {
    let mut bytes = Vec::new();
    exchange.write(&mut bytes).unwrap();
    String::from_utf8(bytes)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect()
}
fn waiting_set_ack() -> skills_rpc::Exchange {
    let mut exchange =
        skills_rpc::Exchange::with_roots("/tmp", &[local_fixture_path("/selected/root")]).unwrap();
    assert_eq!(writes(&mut exchange)[0]["method"], "initialize");
    receive(
        &mut exchange,
        json!({"id":1,"result":{"userAgent":"fixture"}}),
    )
    .unwrap();
    assert_eq!(
        writes(&mut exchange),
        vec![
            json!({"method":"initialized"}),
            json!({"id":2,"method":"skills/extraRoots/set","params":{"extraRoots":[local_fixture_path("/selected/root")]}})
        ]
    );
    exchange
}
#[test]
fn setter_ack_requires_exact_empty_object_and_never_falls_back_to_list() {
    for reply in [
        json!({"id":2,"result":null}),
        json!({"id":2,"result":[]}),
        json!({"id":2,"result":{"unexpected":true}}),
        json!({"id":2,"result":{"userAgent":"not-an-ack"}}),
        json!({"id":2,"result":{"data":[]}}),
        json!({"id":3,"result":{}}),
        json!({"id":2,"method":"approval","params":{}}),
        json!({"id":2,"result":{},"error":{"code":-32601}}),
    ] {
        let mut exchange = waiting_set_ack();
        assert_eq!(
            receive(&mut exchange, reply).unwrap_err().code,
            Code::InvalidOutput
        );
        assert!(writes(&mut exchange).is_empty());
        assert!(!exchange.done());
    }
}
#[test]
fn unsupported_setter_is_finite_unavailable_without_query_or_retry() {
    for (code, expected) in [
        (-32601, Code::Unavailable),
        (-32602, Code::QueryFailed),
        (-32000, Code::QueryFailed),
    ] {
        let mut exchange = waiting_set_ack();
        assert_eq!(
            receive(
                &mut exchange,
                json!({"id":2,"error":{"code":code,"message":"PRIVATE"}})
            )
            .unwrap_err()
            .code,
            expected
        );
        assert!(writes(&mut exchange).is_empty());
    }
}
#[test]
fn premature_ack_and_duplicate_or_out_of_order_reply_fail_closed() {
    let mut exchange =
        skills_rpc::Exchange::with_roots("/tmp", &[local_fixture_path("/selected/root")]).unwrap();
    writes(&mut exchange);
    receive(
        &mut exchange,
        json!({"id":1,"result":{"userAgent":"fixture"}}),
    )
    .unwrap();
    assert_eq!(
        receive(&mut exchange, json!({"id":2,"result":{}}))
            .unwrap_err()
            .code,
        Code::InvalidOutput
    );
    let mut exchange = waiting_set_ack();
    receive(
        &mut exchange,
        json!({"method":"skills/changed","params":{"private":"PRIVATE"}}),
    )
    .unwrap();
    receive(&mut exchange, json!({"id":2,"result":{}})).unwrap();
    assert_eq!(
        receive(&mut exchange, json!({"id":2,"result":{}}))
            .unwrap_err()
            .code,
        Code::InvalidOutput
    );
}
fn skill(name: &str, scope: &str, path: &str) -> Value {
    json!({"name":name,"description":"Controlled skill metadata.","path":local_fixture_path(path),"scope":scope,"enabled":true})
}
fn report(cwd: &str) -> skills_output::Wire {
    serde_json::from_value(json!({"data":[{"cwd":cwd,"skills":[skill("default-skill","user","/owned/default/SKILL.md"),skill("selected-skill","repo","/owned/extra/SKILL.md")],"errors":[]}]})).unwrap()
}
#[test]
fn entire_extra_report_is_discovery_only_including_default_skills_and_has_no_private_targets() {
    let (snapshot, targets) = report("/tmp").project_for_scope("/tmp", true).unwrap();
    assert_eq!(snapshot.scope, "officialSkillsForDirectory");
    assert_eq!(snapshot.items.len(), 2);
    assert!(targets.is_empty());
    assert!(
        snapshot
            .items
            .iter()
            .all(|v| v.enablement.availability == "unavailable"
                && v.enablement.reason == Some("discoveryOnly"))
    );
    let (_, normal) = report("/tmp").project_private("/tmp").unwrap();
    assert_eq!(normal.len(), 2);
}
#[test]
fn actual_serialized_ready_operations_have_exact_requested_roots_and_normal_empty_roots() {
    const ID: &str = "03000000-0000-4000-8000-000000000010";
    for (label, roots) in [
        ("normal", vec![]),
        ("extra", vec![local_fixture_path("/owned/extra-skill-root")]),
    ] {
        let registry = requests::Requests::default();
        let (request, _) = registry
            .begin_with_roots(
                "fixture",
                "/owned/skills-project",
                ID,
                ID,
                Kind::Skills,
                roots.clone(),
            )
            .unwrap();
        let (snapshot, _) = report("/owned/skills-project")
            .project_for_scope("/owned/skills-project", !roots.is_empty())
            .unwrap();
        request.finish(Ok(InventorySnapshot::Skills(snapshot)));
        let wire = serde_json::to_value(request.snapshot().unwrap()).unwrap();
        assert_eq!(wire["extraSkillRoots"], json!(roots));
        assert_eq!(wire["state"], "ready");
        assert_eq!(wire["settled"], true);
        println!(
            "FARFOLD_CONTROLLED_SKILLS_{label}={}",
            serde_json::to_string(&wire).unwrap()
        );
    }
}
