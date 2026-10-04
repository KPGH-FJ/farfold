//! In-process official protocol routes, not installed-product acceptance.
use super::*;
use agent_client_protocol::{Client, Error};
use serde_json::json;
use std::time::Duration;

struct Observation {
    opened: Result<OpenedSession, String>,
    calls: Vec<(String, Value)>,
}

async fn read(
    source: &str,
    requested: Vec<(&str, Value)>,
    resumed: bool,
    recorded: Option<Value>,
) -> Observation {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let store = crate::meta_store::MetaStore::open(&cwd.join("meta.db")).unwrap();
    let options = Arc::new(Mutex::new(json!([
        {"id":"model","name":"Model","category":"model","type":"select","currentValue":"old-model","options":[{"value":"old-model","name":"Old"},{"value":"chosen-model","name":"Chosen"}]},
        {"id":"thought_level","name":"Thinking","category":"thought_level","type":"select","currentValue":"high","options":[{"value":"high","name":"High"},{"value":"off","name":"Off"}]}
    ])));
    if matches!(source, "real-id" | "real-category" | "changing") {
        let mut option = json!({"id":"mode","name":"Mode","type":"select","currentValue":"high","options":[{"value":"high","name":"High"},{"value":"off","name":"Off"}]});
        if matches!(source, "real-category" | "changing") {
            option["category"] = json!("mode");
        }
        options.lock().unwrap().as_array_mut().unwrap().push(option);
    }
    let changing = source == "changing";
    if changing {
        options.lock().unwrap().as_array_mut().unwrap().push(json!({"id":"style","name":"Style","type":"select","currentValue":"old","options":[{"value":"old","name":"Old"},{"value":"chosen","name":"Chosen"}]}));
    }
    let modes = json!({"currentModeId":"high","availableModes":[{"id":"high","name":"High"},{"id":"off","name":"Off"}],"_meta":{"fixture":"keep"}});
    let calls = Arc::new(Mutex::new(Vec::new()));
    let peer_calls = calls.clone();
    let (entered, start) = oneshot::channel();
    let entered = Arc::new(Mutex::new(Some(entered)));
    let (release, released) = oneshot::channel();
    let released = Arc::new(Mutex::new(Some(released)));
    let reject = source == "reject";
    let delayed = source == "cancel";
    let peer = Agent.builder().on_receive_dispatch(
        async move |message: Dispatch, _cx| {
            if let Dispatch::Request(request, responder) = message {
                let method = request.method().to_string();
                let params = request.params().clone();
                peer_calls
                    .lock()
                    .unwrap()
                    .push((method.clone(), params.clone()));
                let result = match method.as_str() {
                    "session/new" | "session/load" => {
                        let mut response =
                            json!({"configOptions":options.lock().unwrap().clone(),"modes":modes});
                        if method == "session/new" {
                            response["sessionId"] = json!("mode-proof");
                        }
                        response
                    }
                    "session/set_config_option" => {
                        let mut options = options.lock().unwrap();
                        let option = options
                            .as_array_mut()
                            .unwrap()
                            .iter_mut()
                            .find(|o| o["id"] == params["configId"]);
                        let Some(option) = option else {
                            responder.respond_with_error(Error::invalid_params())?;
                            return Ok(Handled::Yes);
                        };
                        option["currentValue"] = params["value"].clone();
                        if changing && params["configId"] == "style" {
                            options
                                .as_array_mut()
                                .unwrap()
                                .retain(|o| o["id"] != "mode");
                        }
                        json!({"configOptions":options.clone()})
                    }
                    "session/set_mode" => {
                        if reject {
                            responder.respond_with_error(Error::invalid_params())?;
                            return Ok(Handled::Yes);
                        }
                        if delayed {
                            let entered = entered.lock().unwrap().take().unwrap();
                            let released = released.lock().unwrap().take().unwrap();
                            entered.send(()).unwrap();
                            released.await.unwrap();
                        }
                        json!({})
                    }
                    _ => json!({}),
                };
                responder.respond(result)?;
                return Ok(Handled::Yes);
            }
            Ok(Handled::No {
                message,
                retry: false,
            })
        },
        agent_client_protocol::on_receive_dispatch!(),
    );
    let operation = Operation::new();
    let requested = requested
        .into_iter()
        .map(|(id, value)| (id.to_owned(), value))
        .collect();
    let (send, receive) = oneshot::channel();
    let connection = Client
        .builder()
        .on_receive_dispatch(
            async move |message: Dispatch, _cx| {
                Ok(Handled::No {
                    message,
                    retry: false,
                })
            },
            agent_client_protocol::on_receive_dispatch!(),
        )
        .connect_with(peer, async move |cx| {
            let sessions = Arc::new(Mutex::new(HashMap::new()));
            let life = ConnectionLife::new();
            life.ready().unwrap();
            let pending = Arc::new(Mutex::new(HashMap::new()));
            let open = open_session_on_connection(
                &cx,
                &cwd,
                resumed.then(|| "mode-proof".into()),
                None,
                recorded,
                super::super::model_guard::ConfigStore {
                    store,
                    agent_id: "mode-fixture".into(),
                    cwd: cwd.to_string_lossy().into(),
                    service_record: None,
                    expected_model: None,
                    verified_permission_option: false,
                },
                requested,
                Arc::new(|_| {}),
                &sessions,
                &pending,
                SessionOps {
                    elicitations: Arc::new(Mutex::new(HashMap::new())),
                    life,
                },
                operation.clone(),
                None,
                None,
            );
            tokio::pin!(open);
            if delayed {
                tokio::select! {
                    _ = start => {
                        operation.abandon();
                        release.send(()).unwrap();
                    }
                    _ = &mut open => panic!("synthetic mode was never sent to session/set_mode"),
                }
            }
            let result = open.await;
            let controls = sessions
                .lock()
                .unwrap()
                .drain()
                .map(|(_, entry)| entry.control)
                .collect::<Vec<_>>();
            for control in controls {
                let _ = control.send(SessionControl::Shutdown);
                control.closed().await;
            }
            send.send(result).ok().unwrap();
            Ok(())
        });
    tokio::time::timeout(Duration::from_secs(5), connection)
        .await
        .unwrap()
        .unwrap();
    Observation {
        opened: receive.await.unwrap(),
        calls: calls.lock().unwrap().clone(),
    }
}

fn changes(observation: &Observation) -> Vec<&str> {
    observation
        .calls
        .iter()
        .filter(|(method, _)| method.starts_with("session/set_"))
        .map(|(method, _)| method.as_str())
        .collect()
}

#[test]
fn preparation_real_mode_category_suppresses_synthesis_with_a_different_option_id() {
    let response =
        json!({"modes":{"currentModeId":"high","availableModes":[{"id":"high","name":"High"}]}});
    let options = json!([{"id":"permission-mode","category":"mode","type":"select","currentValue":"safe","options":[]}]);
    assert!(synthetic_mode_state(&response, Some(&options)).is_none());
}

#[tokio::test]
async fn preparation_restores_top_level_mode_without_losing_model_or_thinking() {
    let result = read(
        "synthetic",
        vec![
            ("mode", json!("off")),
            ("model", json!("chosen-model")),
            ("thought_level", json!("off")),
        ],
        false,
        None,
    )
    .await;
    assert_eq!(
        changes(&result),
        [
            "session/set_mode",
            "session/set_config_option",
            "session/set_config_option"
        ]
    );
    let opened = result.opened.unwrap();
    assert!(opened.warnings.is_empty(), "{:?}", opened.warnings);
    assert_eq!(opened.response["modes"]["currentModeId"], "off");
    assert_eq!(opened.response["modes"]["_meta"]["fixture"], "keep");
    let options = opened.config_options.unwrap();
    assert_eq!(options[0]["currentValue"], "chosen-model");
    assert_eq!(options[1]["currentValue"], "off");
    assert_eq!(opened.config_check.status, "ready");
}

#[tokio::test]
async fn preparation_real_mode_option_keeps_its_config_route_with_or_without_category() {
    for source in ["real-id", "real-category"] {
        let result = read(source, vec![("mode", json!("off"))], false, None).await;
        assert_eq!(changes(&result), ["session/set_config_option"]);
        let opened = result.opened.unwrap();
        assert!(opened.warnings.is_empty());
        assert_eq!(opened.config_options.unwrap()[2]["currentValue"], "off");
        assert_eq!(opened.response["modes"]["currentModeId"], "high");
    }
}

#[tokio::test]
async fn preparation_rejects_undeclared_or_non_string_synthetic_modes_before_dispatch() {
    for value in [
        json!("unlisted"),
        json!(false),
        json!({"type":"value_id","value":"off"}),
    ] {
        let result = read("synthetic", vec![("mode", value)], false, None).await;
        assert!(changes(&result).is_empty());
        let opened = result.opened.unwrap();
        assert_eq!(opened.warnings.len(), 1);
        assert_eq!(opened.response["modes"]["currentModeId"], "high");
    }
}

#[tokio::test]
async fn preparation_resume_rejects_new_synthetic_mode_model_and_thinking_changes() {
    for id in ["mode", "model", "thought_level"] {
        let result = read("synthetic", vec![(id, json!("off"))], true, None).await;
        assert!(result.opened.is_err());
        assert!(changes(&result).is_empty());
    }
}

#[tokio::test]
async fn preparation_resume_may_read_recorded_mode_without_requesting_a_change() {
    let result = read(
        "synthetic",
        vec![],
        true,
        Some(json!({"model":"old-model","thought_level":"high","mode":"off"})),
    )
    .await;
    assert!(changes(&result).is_empty());
    let opened = result.opened.unwrap();
    assert_eq!(opened.config_check.status, "ready");
    assert_eq!(opened.response["modes"]["currentModeId"], "high");
    assert!(opened.warnings.is_empty());
}

#[tokio::test]
async fn preparation_resume_never_adds_mode_route_when_config_response_removes_real_mode() {
    let result = read(
        "changing",
        vec![("style", json!("chosen")), ("mode", json!("off"))],
        true,
        Some(json!({"model":"old-model","thought_level":"high","mode":"high"})),
    )
    .await;
    assert_eq!(
        changes(&result),
        ["session/set_config_option", "session/set_config_option"]
    );
    let opened = result.opened.unwrap();
    assert_eq!(opened.response["modes"]["currentModeId"], "high");
    assert_eq!(opened.warnings.len(), 1);
}

#[tokio::test]
async fn preparation_failed_mode_keeps_original_declared_value_and_warning() {
    let result = read("reject", vec![("mode", json!("off"))], false, None).await;
    assert_eq!(changes(&result), ["session/set_mode"]);
    let opened = result.opened.unwrap();
    assert_eq!(opened.response["modes"]["currentModeId"], "high");
    assert_eq!(opened.warnings.len(), 1);
}

#[tokio::test]
async fn preparation_cancelled_mode_does_not_publish_late_success_or_following_config() {
    let result = read(
        "cancel",
        vec![("mode", json!("off")), ("model", json!("chosen-model"))],
        false,
        None,
    )
    .await;
    assert_eq!(changes(&result), ["session/set_mode"]);
    let opened = result.opened.unwrap();
    assert_eq!(opened.response["modes"]["currentModeId"], "high");
    assert_eq!(
        opened.config_options.unwrap()[0]["currentValue"],
        "old-model"
    );
    assert_eq!(opened.warnings.len(), 1);
}
