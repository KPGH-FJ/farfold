//! Real manager/public-stdio publication controls. No real Agent or App.
use super::*;
use std::sync::Mutex;

const PERMISSION_PEER: &str = r#"
import sys,json,os,time,threading
native=os.environ.get('FIXTURE_SESSION','fixture')
prompt=None
def close_when_requested():
 while not os.path.exists(sys.argv[1]+'_close_'+native): time.sleep(.005)
 os._exit(0)
threading.Thread(target=close_when_requested,daemon=True).start()
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params',{})
 if method=='initialize':
  reply(m,{'protocolVersion':1,'agentCapabilities':{},'authMethods':[]})
 elif method=='session/new':
  reply(m,{'sessionId':native,'configOptions':[]})
 elif method=='session/prompt':
  prompt=m
  request={'sessionId':native,'toolCall':{'toolCallId':'controlled-'+native,'title':'Controlled approval','kind':'read','status':'pending','rawInput':{'marker':native,'future':[None,True,'🙂'],'padding':'x'*9000}},'options':[{'optionId':'allow','name':'Allow once','kind':'allow_once'},{'optionId':'deny','name':'Reject once','kind':'reject_once'}],'_meta':{'unknown':{'value':native,'array':[1,None,False]}}}
  send({'id':900,'method':'session/request_permission','params':request})
 elif method=='session/cancel':
  if prompt is not None:
   reply(prompt,{'stopReason':'cancelled'}); prompt=None
 elif method is None and m.get('id')==900:
  if prompt is not None:
   selected=m.get('result',{}).get('outcome',{}).get('outcome')=='selected'
   reply(prompt,{'stopReason':'end_turn' if selected else 'cancelled'}); prompt=None
"#;

#[derive(Clone)]
struct Observed {
    event: Value,
    table_unlocked: Option<bool>,
    own_registered: Option<bool>,
    pending_count: Option<usize>,
}
#[derive(Default)]
struct Probe(Mutex<Vec<Observed>>);
impl Probe {
    fn sink(self: &Arc<Self>, manager: &Arc<AcpManager>) -> SessionSink {
        let probe = self.clone();
        let manager = Arc::downgrade(manager);
        Arc::new(move |event| {
            let permission = event["kind"] == "permissionRequest";
            let (table_unlocked, own_registered, pending_count) = if permission {
                let manager = manager
                    .upgrade()
                    .expect("fixture manager still owns this route");
                // Never call lock()/permission_respond/wait from this callback.
                // On the original code the try_lock fails immediately; the
                // producer returns normally and cleanup can finish before RED.
                Self::inspect_table(&manager, &event)
            } else {
                (None, None, None)
            };
            probe.0.lock().unwrap().push(Observed {
                event,
                table_unlocked,
                own_registered,
                pending_count,
            });
        })
    }
    fn inspect_table(
        manager: &AcpManager,
        event: &Value,
    ) -> (Option<bool>, Option<bool>, Option<usize>) {
        match manager.pending_permissions.try_lock() {
            Ok(table) => {
                let own = event["requestId"].as_str().and_then(|id| table.get(id));
                (
                    Some(true),
                    Some(own.is_some_and(|p| {
                        Some(p.session_id.as_str()) == event["request"]["sessionId"].as_str()
                            && p.responder.is_some()
                            && p.options == ["allow", "deny"]
                    })),
                    Some(table.len()),
                )
            }
            Err(_) => (Some(false), None, None),
        }
    }
    fn permissions(&self) -> Vec<Observed> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|v| v.event["kind"] == "permissionRequest")
            .cloned()
            .collect()
    }
    fn ended(&self, reason: &str) -> bool {
        self.0
            .lock()
            .unwrap()
            .iter()
            .any(|v| v.event["kind"] == "turnEnd" && v.event["stopReason"] == reason)
    }
}
fn expected_request(native: &str) -> Value {
    json!({
        "sessionId":native,
        "toolCall":{
            "toolCallId":format!("controlled-{native}"),
            "title":"Controlled approval", "kind":"read", "status":"pending",
            "rawInput":{"marker":native,"future":[null,true,"🙂"],"padding":"x".repeat(9000)}
        },
        "options":[
            {"optionId":"allow","name":"Allow once","kind":"allow_once"},
            {"optionId":"deny","name":"Reject once","kind":"reject_once"}
        ],
        "_meta":{"unknown":{"value":native,"array":[1,null,false]}}
    })
}
fn configured_pair() -> (Fixture, AgentRow) {
    let f = Fixture::new();
    std::fs::write(f.cwd.join("peer.py"), PERMISSION_PEER).unwrap();
    let mut second = f.row.clone();
    second.id = "permission-publication-second".into();
    second.env = vec![("FIXTURE_SESSION".into(), "second".into())];
    f.store.insert_agent(&second).unwrap();
    (f, second)
}
async fn prompt(f: &Fixture, row: &AgentRow, native: &str) {
    f.manager
        .session_prompt(
            &row.id,
            &f.cwd,
            native,
            serde_json::from_value(json!([{"type":"text","text":"controlled approval"}])).unwrap(),
        )
        .await
        .unwrap();
}
fn id(observed: &Observed) -> &str {
    observed.event["requestId"].as_str().unwrap()
}
fn assert_original_payload(observed: &Observed, native: &str) {
    let expected = expected_request(native);
    assert_eq!(observed.event["request"], expected);
    assert_eq!(observed.event["toolCall"], expected["toolCall"]);
    assert_eq!(observed.event["options"], expected["options"]);
    assert!(!id(observed).is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_publication_releases_global_table_before_sink_and_keeps_both_interactions() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let (f, second) = configured_pair();
        let first_probe = Arc::new(Probe::default());
        let second_probe = Arc::new(Probe::default());
        let first = f
            .manager
            .open_session(
                &f.row,
                &f.cwd,
                None,
                vec![],
                first_probe.sink(&f.manager),
                &f.store,
            )
            .await
            .unwrap();
        let other = f
            .manager
            .open_session(
                &second,
                &f.cwd,
                None,
                vec![],
                second_probe.sink(&f.manager),
                &f.store,
            )
            .await
            .unwrap();
        assert_ne!(first.connection_id, other.connection_id);
        assert_ne!(first.session_id, other.session_id);
        let first_connection = f
            .manager
            .session_connection(&f.row.id, &f.cwd, &first.session_id)
            .unwrap();
        let other_connection = f
            .manager
            .session_connection(&second.id, &f.cwd, &other.session_id)
            .unwrap();
        // B remains unanswered when A is published. Both connections use the
        // same manager-global responder table; no second manager is substituted.
        prompt(&f, &second, &other.session_id).await;
        until(|| second_probe.permissions().len() == 1).await;
        prompt(&f, &f.row, &first.session_id).await;
        until(|| first_probe.permissions().len() == 1).await;
        let b = second_probe.permissions().remove(0);
        let a = first_probe.permissions().remove(0);
        assert_original_payload(&a, &first.session_id);
        assert_original_payload(&b, &other.session_id);
        assert_ne!(id(&a), id(&b));
        assert_eq!(f.manager.pending_permissions.lock().unwrap().len(), 2);
        // These are deliberately OUTSIDE every event callback and Probe lock.
        // Wrong source/option cannot consume A or the independent B responder.
        assert_eq!(
            f.manager
                .permission_respond(id(&a), "allow", &other.session_id)
                .unwrap()
                .status,
            "expired"
        );
        assert_eq!(
            f.manager
                .permission_respond(id(&a), "missing", &first.session_id)
                .unwrap()
                .status,
            "retryable"
        );
        assert_eq!(f.manager.pending_permissions.lock().unwrap().len(), 2);
        for (request, native) in [(&a, &first.session_id), (&b, &other.session_id)] {
            assert_eq!(
                f.manager
                    .permission_respond(id(request), "allow", native)
                    .unwrap()
                    .status,
                "submitted"
            );
            assert_eq!(
                f.manager
                    .permission_respond(id(request), "allow", native)
                    .unwrap()
                    .status,
                "expired"
            );
        }
        until(|| first_probe.ended("end_turn") && second_probe.ended("end_turn")).await;
        until(|| {
            first_connection
                .life
                .work
                .load(std::sync::atomic::Ordering::SeqCst)
                == 0
                && other_connection
                    .life
                    .work
                    .load(std::sync::atomic::Ordering::SeqCst)
                    == 0
        })
        .await;
        assert!(f.manager.pending_permissions.lock().unwrap().is_empty());
        f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
        f.manager.disconnect(&second.id, &f.cwd).await.unwrap();
        assert!(first_connection.life.finished() && other_connection.life.finished());
        // Assert only AFTER real cleanup: original source should report this
        // boolean semantic failure, never a blocked callback or timeout RED.
        assert_eq!(
            a.table_unlocked,
            Some(true),
            "permission A sink held global responder table"
        );
        assert_eq!(
            b.table_unlocked,
            Some(true),
            "permission B sink held global responder table"
        );
        assert_eq!(a.own_registered, Some(true));
        assert_eq!(b.own_registered, Some(true));
        assert_eq!(b.pending_count, Some(1));
        assert_eq!(a.pending_count, Some(2));
    })
    .await
    .expect("bounded controlled two-peer case must settle");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_publication_keeps_cancel_and_exact_connection_close_cleanup() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let (f, second) = configured_pair();
        let first_probe = Arc::new(Probe::default());
        let second_probe = Arc::new(Probe::default());
        let first = f
            .manager
            .open_session(
                &f.row,
                &f.cwd,
                None,
                vec![],
                first_probe.sink(&f.manager),
                &f.store,
            )
            .await
            .unwrap();
        let other = f
            .manager
            .open_session(
                &second,
                &f.cwd,
                None,
                vec![],
                second_probe.sink(&f.manager),
                &f.store,
            )
            .await
            .unwrap();
        let first_connection = f
            .manager
            .session_connection(&f.row.id, &f.cwd, &first.session_id)
            .unwrap();
        let other_connection = f
            .manager
            .session_connection(&second.id, &f.cwd, &other.session_id)
            .unwrap();
        prompt(&f, &f.row, &first.session_id).await;
        prompt(&f, &second, &other.session_id).await;
        until(|| first_probe.permissions().len() == 1 && second_probe.permissions().len() == 1)
            .await;
        let a = first_probe.permissions().remove(0);
        let b = second_probe.permissions().remove(0);
        f.manager
            .session_cancel(&f.row.id, &f.cwd, &first.session_id)
            .await
            .unwrap();
        until(|| first_probe.ended("cancelled")).await;
        assert_eq!(
            f.manager
                .permission_respond(id(&a), "allow", &first.session_id)
                .unwrap()
                .status,
            "expired"
        );
        assert!(
            f.manager
                .pending_permissions
                .lock()
                .unwrap()
                .contains_key(id(&b))
        );
        // Ordinary disconnect must still reject live interaction ownership.
        assert!(f.manager.disconnect(&second.id, &f.cwd).await.is_err());
        assert!(
            f.manager
                .pending_permissions
                .lock()
                .unwrap()
                .contains_key(id(&b))
        );
        // Only this owned test peer observes the marker. Its actual EOF/reap
        // exercises unexpected close cleanup without bypassing admission.
        std::fs::write(f.cwd.join("listed_close_second"), b"close\n").unwrap();
        other_connection.life.terminated().await;
        assert_eq!(
            f.manager
                .permission_respond(id(&b), "allow", &other.session_id)
                .unwrap()
                .status,
            "expired"
        );
        f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
        assert!(f.manager.pending_permissions.lock().unwrap().is_empty());
        assert!(first_connection.life.finished() && other_connection.life.finished());
        assert_eq!(first_probe.permissions().len(), 1);
        assert_eq!(second_probe.permissions().len(), 1);
    })
    .await
    .expect("bounded cancel/close control must settle");
}
