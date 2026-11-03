//! Actual manager routing and a controlled JSON-RPC peer; no installed Agent.
use super::*;
use serde_json::json;
use std::{path::PathBuf, sync::OnceLock, time::Duration};

const UNKNOWN: &str = "FAILED:PROMPT_EMBEDDED_CONTEXT_UNKNOWN";
const UNSUPPORTED: &str = "FAILED:PROMPT_EMBEDDED_CONTEXT_UNSUPPORTED";
#[path = "prompt_audio_tests.rs"]
mod audio_tests;
const PEER: &str = r#"
import json,os,sys
root=sys.argv[1];prompt=None
def send(m): print(json.dumps(dict(jsonrpc='2.0',**m)),flush=True)
for line in sys.stdin.buffer:
 m=json.loads(line);p=m.get('params',{});method=m.get('method')
 if method=='initialize':
  result={'protocolVersion':1,'agentCapabilities':json.load(open(os.path.join(root,'capabilities.json'))),'authMethods':[]}
 elif method=='session/new':result={'sessionId':'context-'+str(os.getpid()),'configOptions':[]}
 elif method=='session/prompt':
  with open(os.path.join(root,'wire.tmp'),'w') as f:json.dump(p,f)
  os.replace(os.path.join(root,'wire.tmp'),os.path.join(root,'wire.json'));prompt=m;continue
 elif method=='session/cancel':
  if prompt:send({'id':prompt['id'],'result':{'stopReason':'cancelled'}});prompt=None
  continue
 else:continue
 send({'id':m['id'],'result':result})
"#;

fn embedded() -> Vec<ContentBlock> {
    serde_json::from_value(json!([
        {"type":"text","text":"read selected text"},
        {"type":"resource","resource":{"uri":"farfold-context:fixture","mimeType":"text/plain","text":"完整中文正文\nsecond line"}}
    ])).unwrap()
}

struct Fixture {
    _directory: tempfile::TempDir,
    cwd: PathBuf,
    manager: Arc<AcpManager>,
    store: MetaStore,
    row: AgentRow,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}

impl Fixture {
    fn new(capabilities: Value) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path().canonicalize().unwrap();
        std::fs::write(cwd.join("peer.py"), PEER).unwrap();
        std::fs::write(cwd.join("capabilities.json"), capabilities.to_string()).unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
        let row = AgentRow {
            id: "prompt-context-fixture".into(),
            name: "Fixture".into(),
            source: "custom".into(),
            command: crate::platform_tests::python(),
            args: vec![
                "-u".into(),
                cwd.join("peer.py").to_string_lossy().into(),
                cwd.to_string_lossy().into(),
            ],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&row).unwrap();
        Self {
            _directory: directory,
            cwd,
            manager,
            store,
            row,
        }
    }

    async fn open(&self) -> String {
        self.manager
            .open_session(
                &self.row,
                &self.cwd,
                None,
                vec![],
                Arc::new(|_| {}),
                &self.store,
            )
            .await
            .unwrap()
            .session_id
    }

    fn clear_actual_handshake(&self, id: &str) {
        let actual = self
            .manager
            .session_connection(&self.row.id, &self.cwd, id)
            .unwrap();
        for connection in self.manager.lock().unwrap().values_mut() {
            if Arc::ptr_eq(&connection.life, &actual.life) {
                connection.handshake = Arc::new(OnceLock::new());
            }
        }
    }

    async fn intercepted(
        &self,
        id: &str,
        blocks: Vec<ContentBlock>,
    ) -> (Result<(), String>, Vec<Vec<ContentBlock>>) {
        let connection = self
            .manager
            .session_connection(&self.row.id, &self.cwd, id)
            .unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let old = {
            let mut sessions = connection.sessions.lock().unwrap();
            std::mem::replace(&mut sessions.get_mut(id).unwrap().control, tx)
        };
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let messages = captured.clone();
        let observer = tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                match message {
                    SessionControl::Prompt { blocks, result, .. } => {
                        messages.lock().unwrap().push(blocks);
                        // This existing interceptor checks admission content,
                        // not an actual SDK offer or active-resource receipt.
                        let _ = result
                            .send(super::super::active_prompt::DispatchResult::Offered(Ok(())));
                    }
                    _ => panic!("unexpected control message"),
                }
            }
        });
        let result = self
            .manager
            .session_prompt(&self.row.id, &self.cwd, id, blocks)
            .await;
        connection
            .sessions
            .lock()
            .unwrap()
            .get_mut(id)
            .unwrap()
            .control = old;
        observer.await.unwrap();
        let messages = std::mem::take(&mut *captured.lock().unwrap());
        (result, messages)
    }
}

#[tokio::test]
async fn prompt_context_false_or_omitted_actual_session_rejects_despite_supported_preparation_and_cache()
 {
    for actual in [
        json!({"promptCapabilities":{"embeddedContext":false}}),
        json!({}),
    ] {
        let f = Fixture::new(json!({"promptCapabilities":{"embeddedContext":true}}));
        f.manager.connect(&f.row, &f.cwd, &f.store).await.unwrap();
        let preparation = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
        std::fs::write(f.cwd.join("capabilities.json"), actual.to_string()).unwrap();
        let id = f.open().await;
        assert!(
            preparation
                .handshake
                .get()
                .unwrap()
                .typed
                .agent_capabilities
                .prompt_capabilities
                .embedded_context
        );
        f.store.set_agent_handshake(&f.row,&json!({"protocolVersion":1,"agentCapabilities":{"promptCapabilities":{"embeddedContext":true}}})).unwrap();
        let (result, messages) = f.intercepted(&id, embedded()).await;
        assert_eq!(result, Err(UNSUPPORTED.into()));
        assert!(
            messages.is_empty(),
            "rejection must precede SessionControl send"
        );
        assert!(!f.cwd.join("wire.json").exists());
        f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
    }
}

#[tokio::test]
async fn prompt_context_missing_actual_handshake_rejects_before_control_send() {
    let f = Fixture::new(json!({"promptCapabilities":{"embeddedContext":true}}));
    let id = f.open().await;
    f.clear_actual_handshake(&id);
    let (result, messages) = f.intercepted(&id, embedded()).await;
    assert_eq!(result, Err(UNKNOWN.into()));
    assert!(messages.is_empty());
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}

#[tokio::test]
async fn prompt_context_supported_actual_wire_preserves_content_and_pump_busy_guard() {
    let f = Fixture::new(json!({"promptCapabilities":{"embeddedContext":false}}));
    f.manager.connect(&f.row, &f.cwd, &f.store).await.unwrap();
    std::fs::write(
        f.cwd.join("capabilities.json"),
        r#"{"promptCapabilities":{"embeddedContext":true}}"#,
    )
    .unwrap();
    let (events, mut notifications) = mpsc::unbounded_channel();
    let id = f
        .manager
        .open_session(
            &f.row,
            &f.cwd,
            None,
            vec![],
            Arc::new(move |event| {
                let _ = events.send(event);
            }),
            &f.store,
        )
        .await
        .unwrap()
        .session_id;
    f.store.set_agent_handshake(&f.row, &json!({"protocolVersion":1,"agentCapabilities":{"promptCapabilities":{"embeddedContext":false}}})).unwrap();
    let blocks = embedded();
    f.manager
        .session_prompt(&f.row.id, &f.cwd, &id, blocks.clone())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !f.cwd.join("wire.json").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let wire: Value =
        serde_json::from_slice(&std::fs::read(f.cwd.join("wire.json")).unwrap()).unwrap();
    assert_eq!(wire["sessionId"], id);
    assert_eq!(wire["prompt"], serde_json::to_value(&blocks).unwrap());
    assert_eq!(
        f.manager
            .session_prompt(&f.row.id, &f.cwd, &id, blocks)
            .await,
        Err("FAILED: 上次请求尚未结束，请先停止或等待".into())
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(f.cwd.join("wire.json")).unwrap()).unwrap(),
        wire
    );
    f.manager
        .session_cancel(&f.row.id, &f.cwd, &id)
        .await
        .unwrap();
    // Cancel acknowledgement only confirms delivery; wait for the peer's result.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = notifications.recv().await.unwrap();
            if event["kind"] == "turnEnd" {
                assert_eq!(event["stopReason"], "cancelled");
                break;
            }
        }
    })
    .await
    .unwrap();
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}

#[tokio::test]
async fn prompt_context_baseline_text_and_link_need_no_embedded_handshake() {
    let f = Fixture::new(json!({}));
    let id = f.open().await;
    f.clear_actual_handshake(&id);
    let blocks: Vec<ContentBlock> = serde_json::from_value(json!([
        {"type":"text","text":"ordinary text"},
        {"type":"resource_link","name":"selected.txt","uri":"file:///fixture/selected.txt"}
    ]))
    .unwrap();
    let (result, sent) = f.intercepted(&id, blocks.clone()).await;
    assert_eq!(result, Ok(()));
    assert_eq!(sent, vec![blocks]);
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}

#[tokio::test]
async fn prompt_context_supported_does_not_bypass_existing_preview_protection() {
    let f = Fixture::new(json!({"promptCapabilities":{"embeddedContext":true}}));
    let id = f.open().await;
    let connection = f
        .manager
        .session_connection(&f.row.id, &f.cwd, &id)
        .unwrap();
    connection
        .sessions
        .lock()
        .unwrap()
        .get_mut(&id)
        .unwrap()
        .preview_token = Some("fixture-preview".into());
    let (result, sent) = f.intercepted(&id, embedded()).await;
    assert_eq!(result, Err("FAILED: 此对话正在预览，加入后再继续".into()));
    assert!(sent.is_empty());
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}

#[test]
fn prompt_context_gate_requires_typed_true_only_for_resource_variant() {
    for raw in [
        json!({}),
        json!({"promptCapabilities":{}}),
        json!({"promptCapabilities":{"embeddedContext":false}}),
        json!({"promptCapabilities":{"embeddedContext":"true"}}),
        json!({"promptCapabilities":{"embeddedContext":null}}),
    ] {
        let handshake =
            Handshake::decode(json!({"protocolVersion":1,"agentCapabilities":raw})).unwrap();
        assert_eq!(
            embedded_context_admission(Some(&handshake), &embedded()),
            Err(UNSUPPORTED)
        );
    }
    let handshake=Handshake::decode(json!({"protocolVersion":1,"agentCapabilities":{"promptCapabilities":{"embeddedContext":true}}})).unwrap();
    assert_eq!(
        embedded_context_admission(Some(&handshake), &embedded()),
        Ok(())
    );
    assert_eq!(embedded_context_admission(None, &embedded()), Err(UNKNOWN));
    let unchanged: Vec<ContentBlock> = serde_json::from_value(json!([
        {"type":"text","text":"ordinary"},
        {"type":"resource_link","name":"selected","uri":"file:///fixture"},
        {"type":"image","data":"AA==","mimeType":"image/png"},
        {"type":"audio","data":"AA==","mimeType":"audio/wav"}
    ]))
    .unwrap();
    assert_eq!(embedded_context_admission(None, &unchanged), Ok(()));
}
