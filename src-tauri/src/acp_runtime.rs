use crate::acp_transport::AcpTransport;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, atomic::AtomicU64};
use std::{path::Path, process::Command, time::Duration};

pub(crate) trait AcpEventConnection: Send + 'static {
    fn transport(&self) -> Arc<AcpTransport>;
    // Some protocols confirm identity in a command receipt before queued events
    // can be validated. Do not spin on that queue or hold its connection lock.
    fn can_consume_events(&self) -> bool {
        true
    }
    fn update_events(
        &mut self,
        router: &crate::runtime_event_router::RuntimeEventRouter,
    ) -> Result<(), String>;
    fn record_event_error(&mut self, error: String);
}

pub(crate) fn start_event_pump<C: AcpEventConnection>(
    handle: Arc<Mutex<C>>,
    router: crate::runtime_event_router::RuntimeEventRouter,
    stop: Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    std::thread::Builder::new()
        .name("acp-event-pump".into())
        .spawn(move || {
            while !stop.load(Ordering::Acquire) {
                let (transport, ready) = match handle.lock() {
                    Ok(connection) => (connection.transport(), connection.can_consume_events()),
                    Err(_) => break,
                };
                if !ready {
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                }
                if transport
                    .wait_for_events(Duration::from_millis(100))
                    .is_err()
                {
                    break;
                }
                let Ok(mut connection) = handle.lock() else {
                    break;
                };
                if stop.load(Ordering::Acquire) {
                    break;
                }
                if !connection.can_consume_events() {
                    continue;
                }
                // Drain and route under the connection lock so status reads cannot
                // overtake a batch from this pump.
                if let Err(error) = connection.update_events(&router) {
                    connection.record_event_error(error);
                    break;
                }
                if transport.failure().is_some() {
                    break;
                }
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Cannot start ACP event pump: {error}"))
}

pub(crate) fn initialize_transport(
    command: &mut Command,
    cwd: &Path,
    client_capabilities: Value,
    expected_agent_version: &str,
    timeout: Duration,
) -> Result<(Arc<AcpTransport>, Value), String> {
    initialize_transport_with_read_limit(
        command,
        cwd,
        client_capabilities,
        expected_agent_version,
        timeout,
        crate::acp_transport::AcpReadLimit::Standard,
    )
}

pub(crate) fn initialize_transport_with_read_limit(
    command: &mut Command,
    cwd: &Path,
    client_capabilities: Value,
    expected_agent_version: &str,
    timeout: Duration,
    read_limit: crate::acp_transport::AcpReadLimit,
) -> Result<(Arc<AcpTransport>, Value), String> {
    let transport = Arc::new(match read_limit {
        crate::acp_transport::AcpReadLimit::Standard => AcpTransport::spawn(command)?,
        _ => AcpTransport::spawn_with_read_limit(command, read_limit)?,
    });
    let initialize = (|| {
        transport.enable_client_resources(cwd)?;
        let response = transport
            .request_timeout(
                "initialize",
                json!({"protocolVersion": 1, "clientCapabilities": client_capabilities}),
                timeout,
            )
            .map_err(|error| error.to_string())?;
        if response.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
            return Err("ACP initialize 协议版本缺失或不受支持".to_string());
        }
        if response
            .pointer("/agentInfo/version")
            .and_then(Value::as_str)
            != Some(expected_agent_version)
        {
            return Err("ACP initialize 适配器版本缺失或与固定组合不符".to_string());
        }
        Ok(response)
    })();
    match initialize {
        Ok(response) => Ok((transport, response)),
        Err(error) => {
            transport
                .stop()
                .map_err(|stop| format!("{error}；ACP 进程清理未确认：{stop}"))?;
            Err(error)
        }
    }
}

pub enum AcpLifecycle<C> {
    Stopped,
    Running(Arc<Mutex<C>>),
}

/// One adapter's live connection. Admission and task ownership remain in the Host.
pub struct AcpRuntime<C> {
    pub(crate) state: Arc<Mutex<AcpLifecycle<C>>>,
    pub(crate) start_lock: Arc<Mutex<()>>,
    pub(crate) generation: Arc<AtomicU64>,
}

impl<C> Clone for AcpRuntime<C> {
    fn clone(&self) -> Self {
        Self {
            state: self.state.clone(),
            start_lock: self.start_lock.clone(),
            generation: self.generation.clone(),
        }
    }
}

impl<C> Default for AcpRuntime<C> {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(AcpLifecycle::Stopped)),
            start_lock: Arc::new(Mutex::new(())),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl<C> AcpRuntime<C> {
    pub(crate) fn take_connection(&self) -> Result<Option<Arc<Mutex<C>>>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "ACP 连接生命周期状态不可用")?;
        Ok(
            match std::mem::replace(&mut *state, AcpLifecycle::Stopped) {
                AcpLifecycle::Stopped => None,
                AcpLifecycle::Running(connection) => Some(connection),
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{AcpLifecycle, AcpRuntime, initialize_transport};
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use std::{process::Command, time::Duration};

    #[test]
    fn clones_share_lifecycle_but_peer_runtime_instances_do_not() {
        let first = AcpRuntime::<u64>::default();
        let copy = first.clone();
        let peer = AcpRuntime::<u64>::default();
        *first.state.lock().unwrap() = AcpLifecycle::Running(Arc::new(Mutex::new(7)));
        assert!(peer.take_connection().unwrap().is_none());
        assert_eq!(*copy.take_connection().unwrap().unwrap().lock().unwrap(), 7);
        assert!(first.take_connection().unwrap().is_none());
    }

    #[test]
    fn failed_initialize_cleans_the_owned_process_for_missing_wrong_and_timed_out_contracts() {
        let root = tempfile::tempdir().unwrap();
        for response in [
            json!({}),
            json!({"protocolVersion":2,"agentInfo":{"version":"fixed"}}),
            json!({"protocolVersion":1,"agentInfo":{"version":"wrong"}}),
            json!(null),
        ] {
            let pid_path = root.path().join("pid");
            let result = initialize_transport(
                Command::new("/usr/bin/python3")
                    .args([
                        "-u",
                        "-c",
                        r#"
import json, os, sys, time
with open(sys.argv[1], 'w') as marker: marker.write(str(os.getpid()))
request = json.loads(sys.stdin.readline())
response = json.loads(sys.argv[2])
if response is not None:
    print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':response}), flush=True)
time.sleep(60)
"#,
                    ])
                    .arg(&pid_path)
                    .arg(response.to_string()),
                root.path(),
                json!({"_meta":{"farfoldPi":{"version":1}}}),
                "fixed",
                Duration::from_millis(500),
            );
            assert!(result.is_err());
            let pid: i32 = std::fs::read_to_string(&pid_path).unwrap().parse().unwrap();
            assert_eq!(
                unsafe { libc::kill(pid, 0) },
                -1,
                "failed handshake left its process running"
            );
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
        }
    }

    #[test]
    fn initialize_preserves_negotiated_extensions_and_unknown_capabilities() {
        let root = tempfile::tempdir().unwrap();
        let capabilities = json!({"elicitation":{"form":{}},"_meta":{"farfoldPi":{"version":1}}});
        let (transport, response) = initialize_transport(
            Command::new("/usr/bin/python3").args(["-u", "-c", r#"
import json, sys
request = json.loads(sys.stdin.readline())
print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'protocolVersion':1,'agentInfo':{'version':'fixed'},'agentCapabilities':{'future':{'value':7}},'_meta':request['params']['clientCapabilities']}}), flush=True)
sys.stdin.read()
"#]), root.path(), capabilities.clone(), "fixed", Duration::from_secs(2),
        ).unwrap();
        assert_eq!(response["_meta"], capabilities);
        assert_eq!(response["agentCapabilities"]["future"]["value"], 7);
        assert!(!transport.has_unresolved_work().unwrap());
        transport.stop().unwrap();
    }
}
