//! Public configuration fixtures, never real-Agent or installed-product evidence.
use super::model_guard::ModelGuard;
use serde_json::{Value, json};

fn option(id: &str, category: &str, value: &str) -> Value {
    json!({"id":id,"name":id,"category":category,"type":"select","currentValue":value,
        "options":[{"value":value,"name":value}]})
}
fn options() -> Value {
    json!([
        option("model", "model", "m"),
        option("reasoning_effort", "thought_level", "medium"),
        option("thinking_budget", "thought_level", "0")
    ])
}

#[test]
fn category_guard_accepts_distinct_ids_and_records_every_choice() {
    let mut data = options();
    data.as_array_mut()
        .unwrap()
        .push(option("speed", "model", "standard"));
    let guard = ModelGuard::new(&data, None, false);
    assert_eq!(guard.check().status, "ready");
    let saved = guard.record();
    assert_eq!(saved["_farfoldConfig"], 2);
    assert_eq!(saved["choices"].as_array().unwrap().len(), 4);
    let mut reversed = data.as_array().unwrap().clone();
    reversed.reverse();
    assert!(ModelGuard::new(&json!(reversed), Some(&saved), true).admissible());
    for index in 0..4 {
        let mut changed = data.clone();
        changed[index]["currentValue"] = json!("different");
        assert!(!ModelGuard::new(&changed, Some(&saved), true).admissible());
        let mut missing = data.as_array().unwrap().clone();
        missing.remove(index);
        assert!(!ModelGuard::new(&json!(missing), Some(&saved), true).admissible());
    }
}

#[test]
fn category_guard_legacy_id_rename_is_not_same_choice_even_when_value_matches() {
    let saved = json!({"_farfoldConfig":1,
        "model":{"id":"original-model","category":"model","value":"m"},
        "thoughtLevel":null});
    let data = json!([option("replacement-model", "model", "m")]);
    let guard = ModelGuard::new(&data, Some(&saved), true);
    assert_eq!(guard.check().status, "blocked");
    assert!(!guard.confirmable(&guard.current_value()));
}

#[test]
fn category_guard_duplicate_id_across_categories_is_invalid() {
    let data = json!([
        option("model", "model", "m"),
        option("model", "_custom", "m")
    ]);
    let guard = ModelGuard::new(&data, None, false);
    assert_eq!(guard.check().status, "blocked");
    assert!(!guard.confirmable(&guard.current_value()));
}

#[test]
fn category_guard_unknown_snapshot_never_falls_back_to_matching_flat_values() {
    let data = json!([option("model", "model", "m")]);
    for marker in [json!(3), json!("2"), Value::Null] {
        let saved = json!({"_farfoldConfig":marker,"model":"m"});
        let guard = ModelGuard::new(&data, Some(&saved), true);
        assert_eq!(guard.check().status, "blocked");
        assert!(!guard.confirmable(&guard.current_value()));
    }
}

#[test]
fn category_guard_legacy_missing_thoughts_require_the_complete_displayed_set() {
    let mut guard = ModelGuard::new(&options(), Some(&json!({"model":"m"})), true);
    assert_eq!(guard.check().status, "confirmation_required");
    let shown = guard.current_value();
    assert!(guard.confirmable(&shown));
    let mut changed = options();
    changed[2]["currentValue"] = json!("1024");
    guard.observe(&changed);
    assert!(!guard.confirmable(&shown));
    assert!(guard.confirmable(&guard.current_value()));
}

#[test]
fn category_guard_protects_saved_ids_after_category_or_type_changes() {
    let saved = ModelGuard::new(&options(), None, false).record();
    for change in [json!("_custom"), json!("model"), Value::Null] {
        let mut data = options();
        data[2]["category"] = change;
        let guard = ModelGuard::new(&data, Some(&saved), true);
        assert_eq!(guard.check().status, "ready");
        assert!(guard.protected_ids().contains(&"thinking_budget".into()));
        assert!(!guard.may_set("thinking_budget"));
        assert!(!guard.confirmable(&guard.current_value()));
        data[2]["currentValue"] = json!("1024");
        let changed = ModelGuard::new(&data, Some(&saved), true);
        assert_eq!(changed.check().status, "blocked");
        assert!(!changed.may_set("thinking_budget"));
    }
    for value in [json!(false), json!(2), json!({"value":"0"}), Value::Null] {
        let mut data = options();
        data[2]["currentValue"] = value;
        let guard = ModelGuard::new(&data, Some(&saved), true);
        assert_eq!(guard.check().status, "blocked");
        assert!(!guard.confirmable(&guard.current_value()));
    }
    let mut data = options();
    data[2]["type"] = json!("boolean");
    assert_eq!(
        ModelGuard::new(&data, Some(&saved), true).check().status,
        "blocked"
    );
}

#[test]
fn category_guard_legacy_records_do_not_guess_new_models_or_rewrite_choices() {
    let old = json!({"_farfoldConfig":1,
        "model":{"id":"model","category":"model","value":"m"},
        "thoughtLevel":{"id":"reasoning_effort","category":"thought_level","value":"medium"},
        "_farfoldService":{"kind":"existing"}});
    let guard = ModelGuard::new(&options(), Some(&old), true);
    assert_eq!(guard.check().status, "confirmation_required");
    assert_eq!(
        guard.check().issues[0].id.as_deref(),
        Some("thinking_budget")
    );
    let mut new_model = options();
    new_model
        .as_array_mut()
        .unwrap()
        .push(option("second-model", "model", "other"));
    let guard = ModelGuard::new(&new_model, Some(&old), true);
    assert_eq!(guard.check().status, "blocked");
    assert!(!guard.confirmable(&guard.current_value()));
    assert_eq!(old["model"]["id"], "model");
    let guard = ModelGuard::new(
        &options(),
        Some(&json!({"model":"m","reasoning_effort":"medium","thinking_budget":"0"})),
        true,
    );
    assert!(guard.admissible());
    assert!(!guard.may_set("thinking_budget"));
    assert!(!guard.may_set("model"));
}

#[test]
fn category_guard_legacy_flat_does_not_forget_an_unclassified_saved_id() {
    let data = json!([
        option("model", "model", "m"),
        option("thinking_budget", "_custom", "1024")
    ]);
    let guard = ModelGuard::new(
        &data,
        Some(&json!({"model":"m","thinking_budget":"0"})),
        true,
    );
    assert_eq!(guard.check().status, "blocked");
    assert!(!guard.may_set("thinking_budget"));
    assert!(!guard.confirmable(&guard.current_value()));
    let known_mode = json!([
        option("model", "model", "m"),
        option("access-mode", "mode", "ask")
    ]);
    let guard = ModelGuard::new(
        &known_mode,
        Some(&json!({"model":"m","access-mode":"ask","mode":"off"})),
        true,
    );
    assert!(guard.admissible());
    assert!(guard.may_set("access-mode"));
}

#[test]
fn category_guard_malformed_snapshots_and_ambiguous_api_models_stay_blocked() {
    let data = options();
    for saved in [
        json!({"_farfoldConfig":2}),
        json!({"_farfoldConfig":2,"choices":[{"id":"model","category":"model","type":"select","value":false}]}),
        json!({"_farfoldConfig":1,"model":{"id":"model","category":"model","value":"m"}}),
        json!({"_farfoldConfig":2,"choices":[
            {"id":"model","category":"model","type":"select","value":"m"},
            {"id":"model","category":"thought_level","type":"select","value":"m"}]}),
    ] {
        let guard = ModelGuard::new(&data, Some(&saved), true);
        assert_eq!(guard.check().status, "blocked");
        assert!(!guard.confirmable(&guard.current_value()));
    }
    let guard = ModelGuard::new(&data, None, false);
    assert_eq!(guard.single_model_value(), Some("m"));
    let mut multiple = data;
    multiple
        .as_array_mut()
        .unwrap()
        .push(option("speed", "model", "m"));
    let guard = ModelGuard::new(&multiple, None, false);
    assert!(guard.admissible());
    assert_eq!(guard.single_model_value(), None);
    assert!(super::service_config::validate_model("m", &multiple).is_err());
}

#[test]
fn category_guard_does_not_expand_model_config_or_confirm_late_or_invalid_values() {
    let mut data = options();
    data.as_array_mut()
        .unwrap()
        .push(option("context-size", "model_config", "large"));
    let mut guard = ModelGuard::new(&data, None, false);
    assert!(!guard.protected_ids().contains(&"context-size".into()));
    guard.record_failed();
    let shown = guard.current_value();
    assert!(guard.confirmable(&shown));
    data[2]["currentValue"] = json!("1024");
    guard.observe(&data);
    assert!(!guard.confirmable(&shown));
    assert!(!guard.confirmable(&guard.current_value()));
    data[2]["currentValue"] = json!(false);
    guard.observe(&data);
    assert!(!guard.confirmable(&guard.current_value()));
}

#[tokio::test(flavor = "multi_thread")]
async fn category_guard_real_transport_returns_successful_new_without_extra_requests() {
    use super::{manager::AcpManager, pump::SessionSink};
    use crate::meta_store::{AgentRow, MetaStore};
    use std::sync::Arc;
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let peer = format!(
        r#"
import json,sys
options=json.loads({options:?})
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 with open(sys.argv[1],'a') as log: log.write(method+'\n')
 if method=='initialize': result={{'protocolVersion':1,'agentCapabilities':{{}},'authMethods':[]}}
 elif method=='session/new': result={{'sessionId':'categories','configOptions':options}}
 else: raise RuntimeError('unexpected fixture method')
 print(json.dumps({{'jsonrpc':'2.0','id':m['id'],'result':result}}),flush=True)
 if method=='session/new':
  print(json.dumps({{'jsonrpc':'2.0','method':'session/update','params':{{'sessionId':'categories','update':{{'sessionUpdate':'config_option_update','configOptions':options}}}}}}),flush=True)
"#,
        options = options().to_string()
    );
    let script = cwd.join("peer.py");
    let log = cwd.join("calls.txt");
    std::fs::write(&script, peer).unwrap();
    let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
    let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
    struct Stop(Arc<AcpManager>);
    impl Drop for Stop {
        fn drop(&mut self) {
            self.0.stop_for_shutdown();
        }
    }
    let _stop = Stop(manager.clone());
    let row = AgentRow {
        id: "category-fixture".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: "/usr/bin/python3".into(),
        args: vec![
            "-u".into(),
            script.to_string_lossy().into(),
            log.to_string_lossy().into(),
        ],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    store.insert_agent(&row).unwrap();
    let sink: SessionSink = Arc::new(|_| {});
    let opened = manager
        .open_session(&row, &cwd, None, vec![], sink, &store)
        .await
        .unwrap();
    assert_eq!(opened.config_check.status, "ready");
    assert_eq!(opened.config_options.unwrap(), options());
    assert_eq!(
        std::fs::read_to_string(log)
            .unwrap()
            .lines()
            .collect::<Vec<_>>(),
        ["initialize", "session/new"]
    );
    assert!(store.list_sessions().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn category_guard_persists_all_values_and_blocks_second_choice_drift_on_cold_restore() {
    use super::{manager::AcpManager, pump::SessionSink, session_index::session_row_id};
    use crate::meta_store::{AgentRow, MetaStore};
    use std::{
        sync::{Arc, mpsc},
        time::Duration,
    };
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let script = cwd.join("peer.py");
    let log = cwd.join("methods.txt");
    let values = cwd.join("values.json");
    std::fs::write(&values, options().to_string()).unwrap();
    std::fs::write(&script,r#"
import sys,json
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params',{})
 with open(sys.argv[1],'a') as f: f.write(method+'\n')
 if method=='initialize': r={'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[]}
 elif method in ('session/new','session/load'):
  with open(sys.argv[2]) as f: options=json.load(f)
  r={'configOptions':options}
  if method=='session/new': r['sessionId']='saved-choices'
 elif method=='session/prompt': r={'stopReason':'end_turn'}
 else: raise RuntimeError('unexpected fixture request')
 print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)
"#).unwrap();
    let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
    let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
    struct Stop(Arc<AcpManager>);
    impl Drop for Stop {
        fn drop(&mut self) {
            self.0.stop_for_shutdown();
        }
    }
    let _stop = Stop(manager.clone());
    let row = AgentRow {
        id: "saved-categories".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: "/usr/bin/python3".into(),
        args: vec![
            "-u".into(),
            script.to_string_lossy().into(),
            log.to_string_lossy().into(),
            values.to_string_lossy().into(),
        ],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    store.insert_agent(&row).unwrap();
    let (tx, rx) = mpsc::channel();
    let sink: SessionSink = Arc::new(move |event| {
        let _ = tx.send(event);
    });
    let opened = manager
        .open_session(&row, &cwd, None, vec![], sink.clone(), &store)
        .await
        .unwrap();
    assert_eq!(opened.config_check.status, "ready");
    let blocks = || serde_json::from_value(json!([{"type":"text","text":"fixture"}])).unwrap();
    manager
        .session_prompt(&row.id, &cwd, "saved-choices", blocks())
        .await
        .unwrap();
    loop {
        if rx.recv_timeout(Duration::from_secs(5)).unwrap()["kind"] == "turnEnd" {
            break;
        }
    }
    let id = session_row_id(&row.id, &cwd.to_string_lossy(), "saved-choices");
    let saved = store
        .get_session(&id)
        .unwrap()
        .unwrap()
        .config_options
        .unwrap();
    assert_eq!(saved["_farfoldConfig"], 2);
    assert_eq!(saved["_farfoldService"], json!({"kind":"existing"}));
    assert_eq!(
        saved["choices"],
        json!([
            {"id":"model","category":"model","type":"select","value":"m"},
            {"id":"reasoning_effort","category":"thought_level","type":"select","value":"medium"},
            {"id":"thinking_budget","category":"thought_level","type":"select","value":"0"}
        ])
    );
    manager.disconnect(&row.id, &cwd).await.unwrap();
    let mut reordered = options().as_array().unwrap().clone();
    reordered.reverse();
    std::fs::write(&values, json!(reordered).to_string()).unwrap();
    let restored = manager
        .open_session(
            &row,
            &cwd,
            Some("saved-choices".into()),
            vec![],
            sink.clone(),
            &store,
        )
        .await
        .unwrap();
    assert_eq!(restored.config_check.status, "ready");
    assert!(
        manager
            .session_set_config(
                &row.id,
                &cwd,
                "saved-choices",
                "thinking_budget",
                json!("1024")
            )
            .await
            .is_err()
    );
    manager.disconnect(&row.id, &cwd).await.unwrap();
    let mut changed = options();
    changed[2]["currentValue"] = json!("1024");
    std::fs::write(&values, changed.to_string()).unwrap();
    let restored = manager
        .open_session(
            &row,
            &cwd,
            Some("saved-choices".into()),
            vec![],
            sink.clone(),
            &store,
        )
        .await
        .unwrap();
    assert_eq!(restored.config_check.status, "blocked");
    assert_eq!(
        restored.config_check.issues[0].id.as_deref(),
        Some("thinking_budget")
    );
    assert!(
        manager
            .session_prompt(&row.id, &cwd, "saved-choices", blocks())
            .await
            .unwrap_err()
            .contains("CONFIG_BLOCKED")
    );
    assert!(
        manager
            .confirm_config(
                &row.id,
                &cwd,
                "saved-choices",
                restored.config_check.current
            )
            .await
            .is_err()
    );
    manager.disconnect(&row.id, &cwd).await.unwrap();
    changed[2]["category"] = json!("_custom");
    std::fs::write(&values, changed.to_string()).unwrap();
    let attempt = manager
        .open_session(
            &row,
            &cwd,
            Some("saved-choices".into()),
            vec![("thinking_budget".into(), json!("0"))],
            sink,
            &store,
        )
        .await;
    assert_eq!(attempt.err().unwrap(), "恢复会话不能修改模型或思考深度");
    assert_eq!(
        store.get_session(&id).unwrap().unwrap().config_options,
        Some(saved)
    );
    let calls = std::fs::read_to_string(log).unwrap();
    assert_eq!(calls.lines().filter(|m| *m == "session/prompt").count(), 1);
    assert!(!calls.lines().any(|m| m.starts_with("session/set_")));
}
