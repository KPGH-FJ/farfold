//! Controlled peers only; never launches an installed Agent or reads its settings.
use super::*;
use serde_json::json;
use std::process::Command;

const SKILLS_ID: &str = "01000000-0000-4000-8000-000000000001";
const PEER: &str = r#"
import sys,json
first=json.loads(sys.stdin.readline())
assert first['id']==1 and first['method']=='initialize'
assert set(first['params'])=={'clientInfo'}
assert first['params']['clientInfo']['name']=='farfold_extension_inventory'
print(json.dumps({'id':1,'result':{'userAgent':'controlled-peer','codexHome':'/PRIVATE_INIT'}}),flush=True)
second=json.loads(sys.stdin.readline())
assert second=={'method':'initialized'}
third=json.loads(sys.stdin.readline())
assert third=={'id':2,'method':'skills/list','params':{'cwds':['/tmp'],'forceReload':True}}
print(json.dumps({'id':2,'result':{'data':[{'cwd':'/tmp','skills':[], 'errors':[]}]}}),flush=True)
assert sys.stdin.read()==''
"#;
#[test]
fn skills_peer_receives_only_explicit_read_handshake_and_eof() {
    let requests = requests::Requests::default();
    let (request, _) = requests
        .begin("fixture", "/tmp", SKILLS_ID, SKILLS_ID, Kind::Skills)
        .unwrap();
    let mut command = Command::new(crate::platform_tests::python());
    command.args(["-u", "-c", PEER]);
    let result = process::run_skills(command, &request);
    assert!(
        result.is_ok(),
        "official JSONL reading must complete its handshake: {result:?}"
    );
}

fn skill() -> serde_json::Value {
    json!({"name":"review-docs","description":"Review documents and summarize changes.","shortDescription":null,"path":"/PRIVATE_SKILL/SKILL.md","scope":"repo","enabled":false,"interface":{"shortDescription":"Review documents","iconSmall":"https://PRIVATE/icon"},"dependencies":{"tools":[{"value":"PRIVATE_COMMAND"}]},"pluginId":"PRIVATE_PLUGIN"})
}
fn response(skills: Vec<serde_json::Value>, errors: Vec<serde_json::Value>) -> serde_json::Value {
    json!({"data":[{"cwd":"/tmp","skills":skills,"errors":errors}]})
}
fn decode(value: serde_json::Value) -> Result<SkillsInventory> {
    skills_output::parse(&serde_json::to_vec(&value).unwrap(), "/tmp")
}
#[test]
fn management_target_eligibility_is_explicit_and_duplicate_paths_refuse() {
    let mut row = skill();
    row["pluginId"] = serde_json::Value::Null;
    let one = serde_json::to_value(decode(response(vec![row.clone()], vec![])).unwrap()).unwrap();
    assert_eq!(one["items"][0]["enablement"]["availability"], "reviewable");
    let duplicate =
        serde_json::to_value(decode(response(vec![row.clone(), row], vec![])).unwrap()).unwrap();
    assert_eq!(
        duplicate["items"][0]["enablement"]["reason"],
        "ambiguousTarget"
    );
    assert_eq!(
        duplicate["items"][1]["enablement"]["reason"],
        "ambiguousTarget"
    );
}
fn peer(code: &str) -> Command {
    let mut command = Command::new(crate::platform_tests::python());
    command.args(["-u", "-c", code]);
    command
}
#[test]
fn useful_description_disabled_and_duplicate_names_survive_without_private_fields() {
    let mut other = skill();
    other["scope"] = json!("user");
    other["path"] = json!("/PRIVATE_OTHER/SKILL.md");
    other["enabled"] = json!(true);
    let result = decode(response(
        vec![skill(), other],
        vec![json!({"path":"/PRIVATE_BROKEN", "message":"PRIVATE_ERROR"})],
    ))
    .unwrap();
    assert!(!result.complete);
    assert_eq!(result.error_count, 1);
    assert_eq!(result.items.len(), 2);
    assert_eq!(
        result.items[0].description.as_deref(),
        Some("Review documents")
    );
    assert!(!result.items[0].reported_enabled);
    assert!(result.items[1].reported_enabled);
    assert_eq!(result.items[0].origin, "repo");
    assert_eq!(result.items[1].origin, "user");
    assert!(result.items[0].plugin_reported);
    let serialized = serde_json::to_string(&result).unwrap();
    assert!(!serialized.contains("PRIVATE"));
    assert!(!serialized.contains("path"));
    assert!(!serialized.contains("dependencies"));
}
#[test]
fn description_preference_fallback_and_unicode_budget_are_explicit() {
    let mut row = skill();
    row["interface"] = json!({"shortDescription":"  "});
    row["shortDescription"] = json!("Fallback summary");
    assert_eq!(
        decode(response(vec![row.clone()], vec![])).unwrap().items[0]
            .description
            .as_deref(),
        Some("Fallback summary")
    );
    row["shortDescription"] = json!(null);
    row["description"] = json!("文".repeat(2049));
    let result = decode(response(vec![row.clone()], vec![])).unwrap();
    assert_eq!(
        result.items[0]
            .description
            .as_ref()
            .unwrap()
            .chars()
            .count(),
        2048
    );
    assert!(result.items[0].description_truncated);
    assert!(!result.items[0].description_redacted);
    row["description"] = json!("   ");
    assert!(
        decode(response(vec![row], vec![])).unwrap().items[0]
            .description
            .is_none()
    );
}
#[test]
fn recognizable_private_tokens_controls_and_unsafe_names_do_not_leave_decoder() {
    let mut row = skill();
    row["name"] = json!("/PRIVATE_NAME");
    row["interface"] = json!(null);
    row["description"] = json!(
        "Use /PRIVATE_SKILL/SKILL.md https://PRIVATE?token=PRIVATE ~/PRIVATE C:\\PRIVATE token=PRIVATE Bearer PRIVATE user@PRIVATE sk-PRIVATE \u{202e} safely."
    );
    let result = decode(response(vec![row], vec![])).unwrap();
    let item = &result.items[0];
    assert!(item.name.is_none());
    assert!(item.description_redacted);
    assert!(!serde_json::to_string(item).unwrap().contains("PRIVATE"));
    assert!(item.description.as_ref().unwrap().contains("safely."));
}
#[test]
fn unknown_scope_is_preserved_as_unknown_not_promoted_to_repository() {
    let mut row = skill();
    row["scope"] = json!("future-private-path");
    let result = decode(response(vec![row], vec![])).unwrap();
    assert_eq!(result.items[0].origin, "unknown");
    assert!(result.complete);
}
#[test]
fn invalid_skill_structure_cwd_and_limits_fail_without_partial_success() {
    for field in ["name", "description", "path", "scope", "enabled"] {
        let mut row = skill();
        row.as_object_mut().unwrap().remove(field);
        assert_eq!(
            decode(response(vec![row], vec![])).unwrap_err().code,
            Code::InvalidOutput,
            "{field}"
        );
    }
    let mut row = skill();
    row["path"] = json!("relative/SKILL.md");
    assert_eq!(
        decode(response(vec![row], vec![])).unwrap_err().code,
        Code::InvalidOutput
    );
    let mut wrong = response(vec![], vec![]);
    wrong["data"][0]["cwd"] = json!("/other");
    assert_eq!(decode(wrong).unwrap_err().code, Code::InvalidOutput);
    assert_eq!(
        decode(json!({"data":[]})).unwrap_err().code,
        Code::InvalidOutput
    );
    assert_eq!(
        decode(response(vec![skill(); 513], vec![]))
            .unwrap_err()
            .code,
        Code::OutputLimit
    );
    assert_eq!(
        decode(response(
            vec![],
            vec![json!({"path":"p","message":"m"}); 513]
        ))
        .unwrap_err()
        .code,
        Code::OutputLimit
    );
    assert_eq!(
        skills_output::parse(br#"{"data":[],"data":[]}"#, "/tmp")
            .unwrap_err()
            .code,
        Code::InvalidOutput
    );
}
fn exchange() -> skills_rpc::Exchange {
    let mut exchange = skills_rpc::Exchange::new("/tmp").unwrap();
    let mut sent = Vec::new();
    exchange.write(&mut sent).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&sent).unwrap()["method"],
        "initialize"
    );
    exchange
}
fn receive(exchange: &mut skills_rpc::Exchange, value: serde_json::Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&value).unwrap();
    bytes.push(b'\n');
    exchange.received(&mut bytes)
}
#[test]
fn fixed_exchange_handles_split_lines_and_notifications_but_sends_no_other_rpc() {
    let mut exchange = exchange();
    receive(
        &mut exchange,
        json!({"method":"notice","params":{"private":"PRIVATE"}}),
    )
    .unwrap();
    let mut bytes = br#"{"id":1,"result":{"userAgent":"fixture","private":"PRIVATE"}}"#.to_vec();
    exchange.received(&mut bytes).unwrap();
    assert!(!exchange.done());
    bytes.push(b'\n');
    exchange.received(&mut bytes).unwrap();
    assert!(bytes.is_empty());
    let mut sent = Vec::new();
    exchange.write(&mut sent).unwrap();
    let lines: Vec<serde_json::Value> = String::from_utf8(sent)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        lines,
        vec![
            json!({"method":"initialized"}),
            json!({"id":2,"method":"skills/list","params":{"cwds":["/tmp"],"forceReload":true}})
        ]
    );
    receive(
        &mut exchange,
        json!({"id":2,"result":response(vec![], vec![])}),
    )
    .unwrap();
    assert!(exchange.done());
    assert!(exchange.finish(b" \r\n").unwrap().complete);
}
#[test]
fn mismatched_unsolicited_error_duplicate_and_premature_responses_fail_closed() {
    for value in [
        json!({"id":2,"result":{"userAgent":"fixture"}}),
        json!({"id":"1","result":{"userAgent":"fixture"}}),
        json!({"id":1,"method":"approval","params":{}}),
        json!({"id":1,"result":{},"error":{"message":"PRIVATE"}}),
        json!({"id":1,"result":{"other":"PRIVATE"}}),
    ] {
        assert_eq!(
            receive(&mut exchange(), value).unwrap_err().code,
            Code::InvalidOutput
        );
    }
    assert_eq!(
        receive(
            &mut exchange(),
            json!({"id":1,"error":{"code":-1,"message":"PRIVATE_ERROR"}})
        )
        .unwrap_err()
        .code,
        Code::QueryFailed
    );
    let mut exchange = exchange();
    receive(
        &mut exchange,
        json!({"id":1,"result":{"userAgent":"fixture"}}),
    )
    .unwrap();
    // A reply before the actual list request has been written is not a result.
    assert_eq!(
        receive(
            &mut exchange,
            json!({"id":2,"result":response(vec![],vec![])})
        )
        .unwrap_err()
        .code,
        Code::InvalidOutput
    );
    assert_eq!(
        exchange.finish(b"PRIVATE").unwrap_err().code,
        Code::InvalidOutput
    );
}
#[test]
fn both_kinds_share_admission_and_request_ids_never_change_kind() {
    let registry = requests::Requests::default();
    let (request, _) = registry
        .begin("a", "/tmp", SKILLS_ID, SKILLS_ID, Kind::Skills)
        .unwrap();
    assert!(matches!(
        registry.begin("a", "/tmp", SKILLS_ID, SKILLS_ID, Kind::Mcp),
        Err(Failure {
            code: Code::RequestConflict
        })
    ));
    assert!(matches!(
        registry.begin(
            "a",
            "/tmp",
            "01000000-0000-4000-8000-000000000002",
            SKILLS_ID,
            Kind::Mcp
        ),
        Err(Failure { code: Code::Busy })
    ));
    let cancelled = registry.cancel("a", SKILLS_ID).unwrap();
    assert_eq!(cancelled.operation.unwrap().kind, Kind::Skills);
    request.finish(Err(Code::Cancelled.into()));
    assert!(
        registry
            .begin(
                "a",
                "/tmp",
                "01000000-0000-4000-8000-000000000002",
                SKILLS_ID,
                Kind::Mcp
            )
            .is_ok()
    );
}
#[test]
fn real_jsonl_peer_rejects_eof_wrong_id_rpc_errors_and_excess_output() {
    for (code, expected) in [
        ("pass".to_owned(), Code::InvalidOutput),
        (
            "import sys; print('PRIVATE_INVALID',flush=True)".into(),
            Code::InvalidOutput,
        ),
        (
            PEER.replace("'id':1,'result'", "'id':3,'result'"),
            Code::InvalidOutput,
        ),
        (
            PEER.replace(
                "'result':{'userAgent':'controlled-peer','codexHome':'/PRIVATE_INIT'}",
                "'error':{'code':-1,'message':'PRIVATE_ERROR'}",
            ),
            Code::QueryFailed,
        ),
        (
            "import sys; sys.stdout.write(' '*(1048576+1));sys.stdout.flush()".into(),
            Code::OutputLimit,
        ),
        (
            "import sys; sys.stderr.write('PRIVATE'*10000);sys.stderr.flush()".into(),
            Code::OutputLimit,
        ),
    ] {
        let registry = requests::Requests::default();
        let (request, _) = registry
            .begin("fixture", "/tmp", SKILLS_ID, SKILLS_ID, Kind::Skills)
            .unwrap();
        assert_eq!(
            process::run_skills(peer(&code), &request).unwrap_err().code,
            expected
        );
    }
}
#[test]
fn actual_skills_peer_emits_sanitized_serialization_with_partial_errors() {
    let registry = requests::Requests::default();
    let (request, _) = registry
        .begin("fixture", "/tmp", SKILLS_ID, SKILLS_ID, Kind::Skills)
        .unwrap();
    let running = request.snapshot().unwrap();
    let value = response(
        vec![skill()],
        vec![json!({"path":"/PRIVATE_ERROR_PATH","message":"PRIVATE_ERROR_BODY"})],
    );
    let response_line = serde_json::to_string(&json!({"id":2,"result":value})).unwrap();
    let code = PEER.replace("print(json.dumps({'id':2,'result':{'data':[{'cwd':'/tmp','skills':[], 'errors':[]}]}}),flush=True)", &format!("print({},flush=True)", serde_json::to_string(&response_line).unwrap()));
    let snapshot = process::run_skills(peer(&code), &request).unwrap();
    assert_eq!(snapshot.items.len(), 1);
    assert_eq!(snapshot.error_count, 1);
    request.finish(Ok(InventorySnapshot::Skills(snapshot)));
    let ready = request.snapshot().unwrap();
    assert_eq!(ready.kind, Kind::Skills);
    assert_eq!(ready.state, State::Ready);
    let value = json!({"skillsRunning":running,"skillsReady":ready});
    assert!(!value.to_string().contains("PRIVATE"));
    println!(
        "SKILLS_INVENTORY_WIRE:{}",
        serde_json::to_string(&value).unwrap()
    );
}

#[test]
fn explicit_credential_labels_keep_value_hidden_across_separate_assignment_tokens() {
    for description in [
        "token = PRIVATE_VALUE",
        "password : PRIVATE_VALUE",
        "authorization : Bearer PRIVATE_VALUE",
    ] {
        let mut row = skill();
        row["interface"] = json!(null);
        row["description"] = json!(description);
        let result = decode(response(vec![row], vec![])).unwrap();
        assert!(
            !serde_json::to_string(&result)
                .unwrap()
                .contains("PRIVATE_VALUE"),
            "{description}"
        );
    }
}
#[test]
fn request_cannot_publish_a_snapshot_for_a_different_inventory_kind() {
    let registry = requests::Requests::default();
    let (request, _) = registry
        .begin("fixture", "/tmp", SKILLS_ID, SKILLS_ID, Kind::Skills)
        .unwrap();
    request.finish(Ok(output::parse(b"[]").unwrap().into()));
    let result = request.snapshot().unwrap();
    assert_eq!(result.state, State::Failed);
    assert_eq!(result.code, Some(Code::InvalidOutput));
    assert!(result.snapshot.is_none());
}

#[test]
fn nonblocking_partial_writes_never_skip_or_duplicate_request_bytes() {
    struct Slow {
        calls: usize,
        bytes: Vec<u8>,
    }
    impl std::io::Write for Slow {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.calls += 1;
            if self.calls % 2 == 1 {
                return Err(std::io::ErrorKind::WouldBlock.into());
            }
            let count = bytes.len().min(7);
            self.bytes.extend_from_slice(&bytes[..count]);
            Ok(count)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut exchange = skills_rpc::Exchange::new("/tmp").unwrap();
    let mut slow = Slow {
        calls: 0,
        bytes: vec![],
    };
    for _ in 0..100 {
        exchange.write(&mut slow).unwrap();
    }
    let value: serde_json::Value = serde_json::from_slice(&slow.bytes).unwrap();
    assert_eq!(value["id"], 1);
    assert_eq!(value["method"], "initialize");
    let before = slow.bytes.clone();
    exchange.write(&mut slow).unwrap();
    assert_eq!(slow.bytes, before);
    receive(
        &mut exchange,
        json!({"id":1,"result":{"userAgent":"fixture"}}),
    )
    .unwrap();
}
#[test]
fn skills_handshake_deadline_cleans_up_instead_of_waiting_forever_for_initialize() {
    let registry = requests::Requests::default();
    let (request, _) = registry
        .begin("fixture", "/tmp", SKILLS_ID, SKILLS_ID, Kind::Skills)
        .unwrap();
    let started = Instant::now();
    let result = process::run_skills(peer("import time;time.sleep(30)"), &request);
    assert_eq!(result.unwrap_err().code, Code::TimedOut);
    assert!(started.elapsed() >= Duration::from_secs(10));
    assert!(started.elapsed() < Duration::from_secs(15));
}
#[test]
fn duplicate_known_fields_and_deep_notifications_are_not_accepted() {
    let mut exchange = exchange();
    let mut duplicate = br#"{"id":1,"id":1,"result":{"userAgent":"fixture"}}
"#
    .to_vec();
    assert_eq!(
        exchange.received(&mut duplicate).unwrap_err().code,
        Code::InvalidOutput
    );
    let mut deep = format!(
        "{{\"method\":\"notice\",\"params\":{}0{}}}\n",
        "[".repeat(40),
        "]".repeat(40)
    )
    .into_bytes();
    assert_eq!(
        exchange.received(&mut deep).unwrap_err().code,
        Code::InvalidOutput
    );
}

#[test]
fn official_qualified_skill_names_survive_the_production_decoder() {
    for name in [
        "sample:search",
        "documents:documents",
        "my-plugin:review_docs",
        "项目:审阅",
    ] {
        let mut row = skill();
        row["name"] = json!(name);
        let result = decode(response(vec![row], vec![])).unwrap();
        assert_eq!(result.items[0].name.as_deref(), Some(name));
    }
}

#[test]
fn qualified_skill_names_keep_path_control_and_segment_guards() {
    for name in [
        "https://example.com",
        "C:\\private",
        "/private:skill",
        "a:b:c",
        "a:",
        ":b",
        "a: ",
        "a b:c",
        "a:b c",
        "a:\tb",
        "a:\nb",
        "a:\u{202e}b",
        "a:../b",
        "a:b..c",
    ] {
        let mut row = skill();
        row["name"] = json!(name);
        assert!(
            decode(response(vec![row], vec![])).unwrap().items[0]
                .name
                .is_none(),
            "{name:?}"
        );
    }
    for (name, visible) in [
        (format!("{}:{}", "a".repeat(127), "b".repeat(128)), true),
        (format!("{}:{}", "a".repeat(128), "b".repeat(128)), false),
        (format!("{}:{}", "界".repeat(42), "文".repeat(42)), true),
        (format!("{}:{}", "界".repeat(43), "文".repeat(43)), false),
    ] {
        let mut row = skill();
        row["name"] = json!(name);
        assert_eq!(
            decode(response(vec![row], vec![])).unwrap().items[0]
                .name
                .is_some(),
            visible
        );
    }
    assert!(
        output::safe_name("sample:search").is_none(),
        "MCP policy remains unchanged"
    );
    for name in ["ordinary-name", "Review documents", "中文技能"] {
        let mut row = skill();
        row["name"] = json!(name);
        assert_eq!(
            decode(response(vec![row], vec![])).unwrap().items[0].name,
            output::safe_name(name)
        );
    }
}
#[test]
fn qualified_names_actual_rust_wire_keeps_disabled_and_duplicate_rows() {
    let names = [
        "sample:search",
        "documents:documents",
        "sample:search",
        "ordinary-name",
    ];
    let rows = names
        .iter()
        .enumerate()
        .map(|(index, name)| {
            let mut row = skill();
            row["name"] = json!(name);
            row["path"] = json!(format!("/PRIVATE_{index}/SKILL.md"));
            row["scope"] = json!(if index == 2 { "user" } else { "repo" });
            row["enabled"] = json!(index != 1);
            if index == 2 {
                row["pluginId"] = json!(null);
            }
            row
        })
        .collect();
    let value = response(rows, vec![]);
    let response_line = serde_json::to_string(&json!({"id":2,"result":value})).unwrap();
    let code=PEER.replace("print(json.dumps({'id':2,'result':{'data':[{'cwd':'/tmp','skills':[], 'errors':[]}]}}),flush=True)",&format!("print({},flush=True)",serde_json::to_string(&response_line).unwrap()));
    let registry = requests::Requests::default();
    let id = "03000000-0000-4000-8000-000000000001";
    let (request, _) = registry
        .begin("fixture", "/tmp", id, id, Kind::Skills)
        .unwrap();
    let snapshot = process::run_skills(peer(&code), &request).unwrap();
    assert_eq!(
        snapshot
            .items
            .iter()
            .map(|i| i.name.as_deref().unwrap())
            .collect::<Vec<_>>(),
        names
    );
    assert!(!snapshot.items[1].reported_enabled);
    assert!(!snapshot.items[2].plugin_reported);
    request.finish(Ok(InventorySnapshot::Skills(snapshot)));
    let operation = request.snapshot().unwrap();
    assert_eq!(operation.state, State::Ready);
    let wire = serde_json::to_string(&operation).unwrap();
    assert!(!wire.contains("PRIVATE"));
    println!("SKILLS_QUALIFIED_WIRE:{wire}");
}
