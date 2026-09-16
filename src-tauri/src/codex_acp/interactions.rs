//! Fixed native interactions on the shared registry, never the old direct controller.
use super::*;
use crate::{
    codex_interactions::{CodexInteraction, CodexInteractionReply},
    host_ids::derived_host_id,
    host_store::HostStore,
    interaction_registry::InteractionRegistry,
};

pub(crate) fn request_id(v: &Value) -> bool {
    v.as_i64()
        .is_some_and(|n| (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&n))
        || v.as_str()
            .is_some_and(|s| s.len() <= 128 && turns::identifier(s))
}

// Typed display allowlist. Raw native extra fields are retained only in the adapter.
#[allow(dead_code)]
mod shape {
    use serde::Deserialize;
    use serde_json::Value;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct Command {
        thread_id: String,
        turn_id: String,
        item_id: String,
        started_at_ms: u64,
        environment_id: Option<String>,
        approval_id: Option<String>,
        reason: Option<String>,
        command: Option<String>,
        cwd: Option<String>,
        network_approval_context: Option<NetworkContext>,
        additional_permissions: Option<Permissions>,
        proposed_execpolicy_amendment: Option<Vec<String>>,
        proposed_network_policy_amendments: Option<Vec<NetworkRule>>,
        available_decisions: Option<Vec<Value>>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct NetworkContext {
        host: String,
        protocol: NetworkProtocol,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    enum NetworkProtocol {
        Http,
        Https,
        Socks5Tcp,
        Socks5Udp,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct NetworkRule {
        host: String,
        action: NetworkAction,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "lowercase")]
    enum NetworkAction {
        Allow,
        Deny,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Permissions {
        network: Option<Network>,
        file_system: Option<FileSystem>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Network {
        enabled: Option<bool>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct FileSystem {
        read: Option<Vec<String>>,
        write: Option<Vec<String>>,
        glob_scan_max_depth: Option<u32>,
        entries: Option<Vec<Entry>>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Entry {
        path: FilePath,
        access: Access,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "lowercase")]
    enum Access {
        Read,
        Write,
        Deny,
    }
    #[derive(Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
    enum FilePath {
        Path { path: String },
        GlobPattern { pattern: String },
        Special { value: Special },
    }
    #[derive(Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
    enum Special {
        Root,
        Minimal,
        ProjectRoots {
            subpath: Option<String>,
        },
        Tmpdir,
        SlashTmp,
        Unknown {
            path: String,
            subpath: Option<String>,
        },
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct File {
        thread_id: String,
        turn_id: String,
        item_id: String,
        started_at_ms: u64,
        reason: Option<String>,
        grant_root: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct QuestionRequest {
        thread_id: String,
        turn_id: String,
        item_id: String,
        questions: Vec<Question>,
        auto_resolution_ms: Option<u64>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Question {
        id: String,
        header: String,
        question: String,
        is_other: bool,
        is_secret: bool,
        options: Option<Vec<OptionEntry>>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct OptionEntry {
        label: String,
        description: String,
    }
}

pub(super) fn validate_request(
    raw: &Value,
    mode: &str,
    context: &turns::Context,
    turn: &str,
) -> Result<CodexInteraction, String> {
    if !request_id(&raw["id"])
        || raw.as_object().is_none_or(|o| {
            o.len() != 3
                || !o.contains_key("id")
                || !o.contains_key("method")
                || !o.contains_key("params")
        })
        || raw.to_string().len() > 65536
    {
        return Err("Native interaction envelope invalid".into());
    }
    let params = raw["params"].clone();
    match raw["method"].as_str() {
        Some("item/commandExecution/requestApproval") => {
            serde_json::from_value::<shape::Command>(params)
                .map_err(|_| "Invalid command display fields")?;
        }
        Some("item/fileChange/requestApproval") => {
            serde_json::from_value::<shape::File>(params)
                .map_err(|_| "Invalid file approval fields")?;
        }
        Some("item/tool/requestUserInput") if mode == "plan" => {
            serde_json::from_value::<shape::QuestionRequest>(params)
                .map_err(|_| "Invalid Plan question fields")?;
        }
        _ => return Err("Unsupported native interaction/mode".into()),
    }
    let mut parsed = CodexInteraction::parse(raw.clone())?;
    if parsed.thread_id != context.thread.native_thread_id
        || parsed.turn_id != turn
        || !turns::identifier(&parsed.item_id)
    {
        return Err("Native request differs from original Turn".into());
    }
    parsed.key = derived_host_id(
        "codex-acp-request",
        &[
            context.farfold_session_id.as_str(),
            context.host_turn_id.as_str(),
            &context.thread.native_session_id,
            &parsed.thread_id,
            &parsed.turn_id,
            &raw["id"].to_string(),
        ],
    );
    Ok(parsed)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Interaction {
    pub scope: Scope,
    pub context: turns::Context,
    pub native_turn_id: String,
    pub native_mode: String,
    pub request: CodexInteraction,
    pub file_changes: Option<Vec<FileChange>>,
}
impl Interaction {
    pub(crate) fn from_event(scope: Scope, event: &turns::Event) -> Result<Self, String> {
        let turns::Payload::InteractionOpen {
            request,
            native_mode,
            file_changes,
        } = &event.payload
        else {
            return Err("Not an interaction event".into());
        };
        validate_changes(file_changes.as_deref(), request)?;
        Ok(Self {
            scope,
            context: event.context.clone(),
            native_turn_id: event.native_turn_id.clone(),
            native_mode: native_mode.clone(),
            request: validate_request(request, native_mode, &event.context, &event.native_turn_id)?,
            file_changes: file_changes.clone(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileChange {
    pub path: String,
    pub kind: PatchKind,
    pub diff: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum PatchKind {
    Add,
    Delete,
    Update { move_path: Option<String> },
}
pub(super) fn validate_changes(
    changes: Option<&[FileChange]>,
    request: &Value,
) -> Result<(), String> {
    if let Some(changes) = changes
        && (request["method"] != "item/fileChange/requestApproval"
            || changes.len() > 32
            || serde_json::to_vec(changes)
                .map_err(|_| "Invalid file preview")?
                .len()
                > 65536
            || changes
                .iter()
                .any(|c| c.path.len() > 16384 || c.diff.len() > 16384))
    {
        return Err("Invalid native file approval preview".into());
    }
    Ok(())
}

impl configure::Runtime {
    pub fn reply_interaction(
        &self,
        store: &HostStore,
        registry: &InteractionRegistry,
        interaction: &Interaction,
        reply: CodexInteractionReply,
    ) -> Result<(), String> {
        let (handle, pending) = self.controller.exclusive(|| {
            let handle = self.connection()?;
            let c = handle.lock().map_err(|_| "Connection unavailable")?;
            let t = turns::target(store, &c, &interaction.scope, &interaction.context.farfold_session_id)?;
            let active = c.turns.active.as_ref().ok_or("No active Turn")?;
            if active.context != interaction.context || active.native_id.as_deref() != Some(&interaction.native_turn_id) || active.interrupt_requested || c.turns.unknown {
                return Err("Interaction no longer belongs to this active Turn".into());
            }
            let registered = registry.codex_acp_request(&t.binding(), interaction.scope.generation, &interaction.request.key)?;
            if registered != *interaction { return Err("Interaction content/identity changed".into()); }
            let response = registered.request.response(reply)?;
            if response.to_string().len() > 65536 { return Err("Interaction reply too large".into()); }
            registry.begin_response(t.binding(), interaction.scope.generation, &interaction.request.key, Some(&interaction.context.thread.native_thread_id))?;
            let command = json!({"context":interaction.context,"nativeTurnId":interaction.native_turn_id,"nativeRequestId":interaction.request.native_request["id"],"itemId":interaction.request.item_id,"response":response});
            let pending = c.transport.begin_request_unbounded("_codex/interaction/reply", json!({"scope":interaction.scope,"command":command}));
            match pending {
                Ok(p) => { drop(c); Ok((handle,p)) },
                Err(crate::acp_transport::AcpDispatchError::NotSent(_)) => { registry.finish_response(t.binding(),interaction.scope.generation,&interaction.request.key,false)?; Err("Interaction not sent".into()) },
                Err(_) => Err("Interaction write outcome unknown".into()),
            }
        })?;
        let result = pending.wait_timeout(Duration::from_secs(15));
        self.controller.exclusive(|| {
            if !Arc::ptr_eq(&self.connection()?, &handle) { return Err("Retired interaction reply".into()); }
            let mut c = handle.lock().map_err(|_| "Connection unavailable")?;
            if c.scope != interaction.scope || c.turns.active.as_ref().is_none_or(|a| a.context != interaction.context || a.native_id.as_deref() != Some(&interaction.native_turn_id)) { return Err("Retired interaction Turn".into()); }
            let expected = json!({"scope":interaction.scope,"nativeRequestId":interaction.request.native_request["id"],"itemId":interaction.request.item_id,"sent":true});
            if result.ok().as_ref()!=Some(&expected) { c.turns.mark_unknown()?; return Err("Native response delivery unknown".into()); }
            // JSON-RPC response has no native ACK. Registry remains Responding until native resolution.
            Ok(())
        })
    }

    pub fn steer_turn(
        &self,
        store: &HostStore,
        scope: &Scope,
        context: &turns::Context,
        native_turn_id: &str,
        operation_id: &str,
        text: &str,
    ) -> Result<(), String> {
        if !turns::identifier(operation_id)
            || operation_id.len() > 128
            || text.trim().is_empty()
            || text.len() > 65536
        {
            return Err("Invalid steering input/operation".into());
        }
        let (handle,pending) = self.controller.exclusive(|| {
            let handle = self.connection()?;
            let mut c = handle.lock().map_err(|_| "Connection unavailable")?;
            turns::target(store,&c,scope,&context.farfold_session_id)?;
            if c.turns.unknown { return Err("Unknown Turn blocks steering".into()); }
            let active = c.turns.active.as_mut().ok_or("No active Turn")?;
            if active.context != *context || active.native_id.as_deref()!=Some(native_turn_id) || active.interrupt_requested || active.steering.is_some() || active.steer_ids.contains(operation_id) || active.steer_ids.len()>=256 {
                return Err("Steering operation stale, duplicate or unavailable".into());
            }
            active.steering=Some(operation_id.into()); active.steer_ids.insert(operation_id.into());
            let pending=c.transport.begin_request_unbounded("_codex/turn/steer",json!({"scope":scope,"command":{"context":context,"nativeTurnId":native_turn_id,"operationId":operation_id,"text":text}}));
            match pending { Ok(p)=>{drop(c);Ok((handle,p))},Err(_)=>{c.turns.mark_unknown()?;Err("Steering dispatch unknown".into())} }
        })?;
        let result = pending.wait_timeout(Duration::from_secs(15));
        self.controller.exclusive(|| {
            if !Arc::ptr_eq(&self.connection()?,&handle) { return Err("Retired steer connection".into()); }
            let mut c=handle.lock().map_err(|_|"Connection unavailable")?;
            let Some(a)=c.turns.active.as_mut() else {return Err("Turn ended before steer result".into())};
            if a.context!=*context || a.native_id.as_deref()!=Some(native_turn_id) || a.steering.as_deref()!=Some(operation_id) {return Err("Retired steer operation".into())}
            a.steering=None;
            if a.interrupt_requested {return Err("Steer superseded by Stop; execution unknown".into())}
            let expected=json!({"scope":scope,"nativeTurnId":native_turn_id,"operationId":operation_id,"accepted":true});
            if result.ok().as_ref()!=Some(&expected) {c.turns.mark_unknown()?;return Err("Steer acceptance unknown".into())}
            Ok(()) // This acceptance is not execution/terminal evidence.
        })
    }
}

#[cfg(test)]
mod tests;
