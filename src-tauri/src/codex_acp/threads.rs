//! Headless native thread lifecycle. No Turn or task-ready projection.
use super::*;
use crate::{acp_session_operations::AcpSessionOperationKind as Kind, host_ids::WorkingCopyId};
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workspace {
    pub cwd: PathBuf,
    pub working_copy_id: Option<WorkingCopyId>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadRef {
    pub native_thread_id: String,
    pub native_session_id: String,
    pub cwd: PathBuf,
    pub path: Option<PathBuf>,
    pub status: String,
    pub cli_version: String,
    pub model_provider: String,
}
pub(super) fn native_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit() && !b.is_ascii_uppercase()
            }
        })
}
impl ThreadRef {
    pub(super) fn validate(&self, workspace: &Workspace, home: &Path) -> Result<(), String> {
        if !native_id(&self.native_thread_id)
            || !native_id(&self.native_session_id)
            || self.cwd != workspace.cwd
            || self.cwd.canonicalize().ok().as_ref() != Some(&self.cwd)
            || !matches!(self.status.as_str(), "idle" | "notLoaded")
            || self.cli_version != "0.143.0"
            || !super::turns::identifier(&self.model_provider)
        {
            return Err("Native thread identity/workspace outside lifecycle contract".into());
        }
        if let Some(path) = &self.path
            && (!path.starts_with(home.join("codex/sessions"))
                || path.canonicalize().ok().as_ref() != Some(path))
        {
            return Err("Native thread path outside original owned profile".into());
        }
        Ok(())
    }
    pub(super) fn same_identity(&self, other: &Self) -> bool {
        self.native_thread_id == other.native_thread_id
            && self.native_session_id == other.native_session_id
            && self.cwd == other.cwd
    }
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum CommandInput {
    List,
    Start,
    Read { thread: ThreadRef },
    Resume { thread: ThreadRef },
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub scope: Scope,
    pub data: Vec<ThreadRef>,
    pub thread: Option<ThreadRef>,
    #[serde(default)]
    pub model: Option<super::admission::Actual>,
}

#[derive(Default)]
pub(super) struct Control {
    pub(super) bound: Option<ThreadRef>,
    known: BTreeMap<String, ThreadRef>,
    pub(super) unknown: bool,
}
impl Control {
    pub(super) fn validate_event(
        &self,
        value: &Value,
        workspace: &Workspace,
        home: &Path,
    ) -> Result<(), String> {
        let mut fields = value.as_object().cloned().ok_or("Thread event missing")?;
        let method = fields
            .remove("method")
            .ok_or("Thread event method missing")?;
        if !matches!(
            method.as_str(),
            Some("thread/started" | "thread/status/changed")
        ) {
            return Err("Unvalidated native event".into());
        }
        let event: ThreadRef =
            serde_json::from_value(Value::Object(fields)).map_err(|_| "Invalid thread event")?;
        event.validate(workspace, home)?;
        if self
            .bound
            .as_ref()
            .is_none_or(|bound| !event.same_identity(bound))
        {
            return Err("Thread event is not bound to original native identity".into());
        }
        Ok(())
    }
}

impl configure::Runtime {
    pub fn register_thread(
        &self,
        store: &crate::host_store::HostStore,
        scope: &Scope,
        registration: &crate::host_store::records::SessionRegistration,
    ) -> Result<crate::host_store::records::WriteOutcome, String> {
        self.register_thread_in_workspace(store, scope, registration, None)
    }
    pub(super) fn register_thread_in_workspace(
        &self,
        store: &crate::host_store::HostStore,
        scope: &Scope,
        registration: &crate::host_store::records::SessionRegistration,
        workspace: Option<&crate::host_store::working_copy_manager::RegisteredSessionWorkspace>,
    ) -> Result<crate::host_store::records::WriteOutcome, String> {
        use crate::host_store::records::*;
        self.controller.exclusive(|| {
            let handle = self.connection()?;
            let mut connection = handle.lock().map_err(|_| "Connection unavailable")?;
            if &connection.scope != scope
                || connection.control.operations.is_pending()
                || connection.threads.unknown
            {
                return Err("Thread registration does not target a settled connection".into());
            }
            let thread = connection
                .threads
                .bound
                .as_ref()
                .ok_or("Native thread is not bound")?;
            if registration.runtime_product_id.as_str() != scope.runtime_product_id
                || registration.installation_id.as_str() != scope.installation_id
                || registration.runtime_build_id.as_str() != scope.runtime_build_id
                || registration.adapter_id.as_str() != scope.adapter_id
                || registration.connection_id.as_str() != scope.connection_id
                || registration.native_session_id.as_str() != thread.native_thread_id
                || registration.working_copy_path != thread.cwd
                || connection.workspace.working_copy_id.as_ref()
                    != Some(&registration.working_copy_id)
            {
                return Err(
                    "Host Session registration differs from the original native identity".into(),
                );
            }
            thread.validate(&connection.workspace, &connection.profile_home)?;
            let model = connection
                .admission
                .as_ref()
                .and_then(|s| s.actual.as_ref())
                .ok_or("Explicit actual model confirmation missing")?;
            model.validate(thread)?;
            let selection = super::admission::SessionModelSelection {
                farfold_session_id: registration.farfold_session_id.clone(),
                runtime: scope.binding()?,
                profile_id: crate::host_ids::RuntimeProfileId::parse(&scope.profile_id)
                    .map_err(|e| e.to_string())?,
                working_copy_id: registration.working_copy_id.clone(),
                cwd: registration.working_copy_path.clone(),
                native_thread_id: thread.native_thread_id.clone(),
                native_tree_id: thread.native_session_id.clone(),
                selection: model.selection(),
            };
            let locator = NativeSessionLocatorRegistration {
                kind: NativeSessionLocatorKind::CodexTreeSessionId,
                locator_value: thread.native_session_id.clone(),
                allowed_root: None,
            };
            let guard = OwnedSessionGuard {
                profile_id: crate::host_ids::RuntimeProfileId::parse(&scope.profile_id)
                    .map_err(|e| e.to_string())?,
                generation: scope.generation,
            };
            let outcome = match workspace {
                Some(workspace) => store.register_owned_session_in_workspace(
                    registration,
                    &locator,
                    &guard,
                    &selection,
                    Some(workspace),
                ),
                None => store.register_owned_session_with_native_model(
                    registration,
                    &locator,
                    &guard,
                    &selection,
                ),
            };
            match outcome {
                Ok(outcome) => Ok(outcome),
                Err(SessionRegistrationError::Preparation(error)) => Err(error),
                Err(SessionRegistrationError::Unconfirmed(error)) => {
                    // Native start is not rolled back. Preserve bound identity and actual
                    // selection, but block any further work until safe disconnection.
                    connection.threads.unknown = true;
                    Err(error)
                }
            }
        })
    }

    pub fn open_registered_thread(
        &self,
        store: &crate::host_store::HostStore,
        scope: &Scope,
        id: &crate::host_ids::FarfoldSessionId,
    ) -> Result<Snapshot, String> {
        use crate::host_store::records::NativeSessionLocatorKind;
        let target = store.session_open_target(id)?;
        let workspace = Workspace {
            cwd: target.working_copy_path.clone(),
            working_copy_id: Some(target.working_copy_id.clone()),
        };
        let tree = target
            .locator_value
            .as_deref()
            .filter(|_| target.locator_kind == Some(NativeSessionLocatorKind::CodexTreeSessionId))
            .ok_or("Original native tree identity missing")?;
        if !native_id(tree)
            || target.archived_at.is_some()
            || target.runtime_product_id.as_str() != scope.runtime_product_id
            || target.installation_id.as_str() != scope.installation_id
            || target.runtime_build_id.as_str() != scope.runtime_build_id
            || target.adapter_id.as_str() != scope.adapter_id
            || target.connection_id.as_str() != scope.connection_id
        {
            return Err("Original Host Session scope is not available".into());
        }
        let launch = store.current_owned_profile_launch(
            &target.binding(),
            &crate::host_ids::RuntimeProfileId::parse(&scope.profile_id)
                .map_err(|e| e.to_string())?,
            scope.generation,
        )?;
        {
            let handle = self.connection()?;
            let connection = handle.lock().map_err(|_| "Connection unavailable")?;
            if &connection.scope != scope
                || connection.profile_home != launch.home
                || connection.workspace != workspace
                || launch.cwd != workspace.cwd
                || Some(&launch.working_copy_id) != workspace.working_copy_id.as_ref()
            {
                return Err("Original profile/Working Copy launch mismatch".into());
            }
        }
        let list = self.threads(scope, &workspace, CommandInput::List)?;
        let listed = list
            .data
            .into_iter()
            .find(|t| {
                t.native_thread_id == target.native_session_id.as_str()
                    && t.native_session_id == tree
            })
            .ok_or("Persisted native thread/tree pair is absent from fresh list")?;
        let fresh = self
            .threads(scope, &workspace, CommandInput::Read { thread: listed })?
            .thread
            .ok_or("Fresh native thread read missing")?;
        if store.session_open_target(id)? != target {
            return Err("Host Session changed during native read".into());
        }
        let saved = store.session_model_selection(id)?;
        saved.verify(
            &target,
            &crate::host_ids::RuntimeProfileId::parse(&scope.profile_id)
                .map_err(|e| e.to_string())?,
        )?;
        if fresh.model_provider != saved.selection.provider {
            return Err("Fresh read provider differs from saved Session".into());
        }
        self.admission(
            scope,
            super::admission::CommandInput::Restore {
                selection: saved.selection.clone(),
            },
        )?;
        let resumed = self.threads(scope, &workspace, CommandInput::Resume { thread: fresh })?;
        if resumed
            .model
            .as_ref()
            .is_none_or(|m| m.selection() != saved.selection)
        {
            return Err("Restored actual model differs from saved choice".into());
        }
        if store.session_open_target(id)? != target {
            self.connection()?
                .lock()
                .map_err(|_| "Connection unavailable")?
                .threads
                .unknown = true;
            return Err("Host Session changed during native resume".into());
        }
        Ok(resumed)
    }
    pub fn threads(
        &self,
        scope: &Scope,
        workspace: &Workspace,
        command: CommandInput,
    ) -> Result<Snapshot, String> {
        self.threads_checked(scope, workspace, command, None)
    }
    pub(super) fn start_selected_thread(
        &self,
        scope: &Scope,
        workspace: &Workspace,
        choice: &super::sessions::ExplicitSelection,
    ) -> Result<Snapshot, String> {
        self.threads_checked(scope, workspace, CommandInput::Start, Some(choice))
    }
    fn threads_checked(
        &self,
        scope: &Scope,
        workspace: &Workspace,
        command: CommandInput,
        choice: Option<&super::sessions::ExplicitSelection>,
    ) -> Result<Snapshot, String> {
        let expected = match &command {
            CommandInput::Read { thread } | CommandInput::Resume { thread } => Some(thread.clone()),
            _ => None,
        };
        let selecting = matches!(command, CommandInput::Start | CommandInput::Resume { .. });
        let listing = matches!(command, CommandInput::List);
        let (handle, operation, pending) = self.controller.exclusive(|| {
            let handle = self.connection()?;
            let mut connection = handle.lock().map_err(|_| "Connection unavailable")?;
            if &connection.scope != scope
                || &connection.workspace != workspace
                || workspace.working_copy_id.is_none()
                || connection.threads.unknown
            {
                return Err("Original thread workspace/connection unavailable".into());
            }
            if let Some(choice) = choice {
                if connection.control.admission_blocked() {
                    return Err("Configure blocks Session start".into());
                }
                choice.verify(scope, connection.admission.as_ref())?;
            }
            if let Some(expected) = &expected {
                expected.validate(workspace, &connection.profile_home)?;
                if connection
                    .threads
                    .known
                    .get(&expected.native_thread_id)
                    .is_none_or(|known| !expected.same_identity(known))
                {
                    return Err("Original listed native identity required".into());
                }
            }
            let bound = connection
                .threads
                .bound
                .as_ref()
                .map(|t| t.native_thread_id.clone());
            let unresolved = connection.transport.has_unresolved_work()?;
            let operation = if selecting {
                connection.control.operations.begin(
                    if expected.is_some() {
                        Kind::Load
                    } else {
                        Kind::New
                    },
                    expected.as_ref().map(|t| t.native_thread_id.clone()),
                    bound.as_deref(),
                    unresolved,
                )?
            } else {
                connection
                    .control
                    .operations
                    .begin_connection_config(unresolved)?
            };
            let pending = connection
                .transport
                .begin_request_unbounded("_codex/thread", json!({"scope":scope,"command":command}));
            match pending {
                Ok(pending) => {
                    drop(connection);
                    Ok((handle, operation, pending))
                }
                Err(_) => {
                    connection.threads.unknown = true;
                    Err("Thread dispatch outcome unknown; disconnect required".into())
                }
            }
        })?;
        let response = pending.wait_timeout(Duration::from_secs(15));
        self.controller.exclusive(|| {
            let current = self.connection()?;
            if !Arc::ptr_eq(&current, &handle) {
                return Err("Retired thread operation".into());
            }
            let mut connection = handle.lock().map_err(|_| "Connection unavailable")?;
            if &connection.scope != scope {
                return Err("Retired thread generation".into());
            }
            if matches!(
                &response,
                Err(crate::acp_transport::AcpDispatchError::NotSent(_)
                    | crate::acp_transport::AcpDispatchError::Rejected {
                        code: -32602..=-32600,
                        ..
                    })
            ) {
                connection.control.operations.complete(operation)?;
                return Err("Thread operation not sent or explicitly rejected".into());
            }
            let validated = (|| {
                let raw = response.map_err(|_| "Thread result unconfirmed; disconnect required")?;
                let snapshot: Snapshot =
                    serde_json::from_value(raw).map_err(|_| "Invalid thread receipt")?;
                if &snapshot.scope != scope
                    || snapshot.data.len() > 10
                    || (listing && snapshot.thread.is_some())
                    || (!listing && (snapshot.thread.is_none() || !snapshot.data.is_empty()))
                {
                    return Err("Thread receipt scope/shape mismatch");
                }
                for thread in snapshot.data.iter().chain(snapshot.thread.iter()) {
                    thread
                        .validate(workspace, &connection.profile_home)
                        .map_err(|_| "Thread receipt identity invalid")?;
                }
                if let Some(expected) = &expected
                    && snapshot
                        .thread
                        .as_ref()
                        .is_none_or(|t| !expected.same_identity(t))
                {
                    return Err("Original native thread identity changed");
                }
                if selecting {
                    let model = snapshot
                        .model
                        .as_ref()
                        .ok_or("Actual model confirmation missing")?;
                    model
                        .validate(snapshot.thread.as_ref().ok_or("Thread missing")?)
                        .map_err(|_| "Actual model identity invalid")?;
                    if connection
                        .admission
                        .as_ref()
                        .and_then(|s| s.selection.as_ref())
                        != Some(&model.selection())
                    {
                        return Err("Actual model differs from explicit selection");
                    }
                }
                Ok(snapshot)
            })();
            let snapshot = match validated {
                Ok(s) => s,
                Err(e) => {
                    connection.threads.unknown = true;
                    return Err(e.into());
                }
            };
            connection.control.operations.complete(operation)?;
            if listing {
                connection.threads.known.clear();
            }
            for thread in snapshot.data.iter().chain(snapshot.thread.iter()) {
                connection
                    .threads
                    .known
                    .insert(thread.native_thread_id.clone(), thread.clone());
            }
            if selecting {
                connection.threads.bound = snapshot.thread.clone();
                connection
                    .admission
                    .as_mut()
                    .ok_or("Model selection missing")?
                    .actual = snapshot.model.clone();
            }
            Ok(snapshot)
        })
    }
    pub fn thread_events(&self, scope: &Scope) -> Result<Vec<Value>, String> {
        let handle = self.connection()?;
        let connection = handle.lock().map_err(|_| "Connection unavailable")?;
        if &connection.scope != scope || connection.control.operations.is_pending() {
            return Err("Thread event identity is not settled".into());
        }
        connection.events()
    }
}

#[cfg(test)]
pub(super) mod tests;
