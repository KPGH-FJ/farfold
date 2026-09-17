#![allow(dead_code)]

use std::{future::Future, path::PathBuf, pin::Pin, sync::Arc};

use serde_json::Value;

use crate::acp_transport::AcpTransport;
use crate::runtime_registry::{RuntimeBinding, RuntimeIdentity};

pub(crate) type AcpResult<T> = Result<T, String>;
pub(crate) type AcpFuture<T> = Pin<Box<dyn Future<Output = AcpResult<T>> + Send>>;

pub(crate) trait AcpRuntimeAdapter: Send + 'static {
    fn identity(&self) -> RuntimeIdentity;
    fn adapter_id(&self) -> &str;
    fn expected_adapter_version(&self) -> &str;
    fn spawn_and_initialize(
        &self,
        binding: RuntimeBinding,
        cwd: PathBuf,
    ) -> AcpFuture<Arc<AcpTransport>>;
    fn new_session(&self, transport: Arc<AcpTransport>, working_copy: PathBuf) -> AcpFuture<Value>;
    fn load_session(&self, transport: Arc<AcpTransport>, locator: Value) -> AcpFuture<Value>;
    fn set_config_option(
        &self,
        transport: Arc<AcpTransport>,
        session_id: String,
        option_id: String,
        value: Value,
    ) -> AcpFuture<()>;
    fn send_prompt(
        &self,
        transport: Arc<AcpTransport>,
        session_id: String,
        text: String,
    ) -> AcpFuture<String>;
    fn stop_turn(
        &self,
        transport: Arc<AcpTransport>,
        session_id: String,
        turn_id: String,
    ) -> AcpFuture<()>;
    fn map_event(&self, event: Value) -> AcpResult<Value>;
}
