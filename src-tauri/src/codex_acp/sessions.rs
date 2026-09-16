//! Narrow, closed Session orchestration over the shared identities and existing lifecycle.
//! No independent Session state, native retries, Turn dispatch or UI readiness.
use super::*;
use crate::{
    host_ids::{
        FarfoldSessionId, InstallationId, NativeSessionId, RuntimeBuildId, RuntimeProfileId,
        WorkingCopyId,
    },
    host_store::{
        HostStore, native_model_selection::NativeModelSelection, records::*,
        session_binding_index::native_session_host_id,
    },
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExplicitSelection {
    pub observation_scope: Scope,
    pub epoch: u64,
    pub catalog_hash: String,
    pub selection: NativeModelSelection,
}
impl ExplicitSelection {
    pub(super) fn verify(
        &self,
        scope: &Scope,
        observed: Option<&admission::Snapshot>,
    ) -> Result<(), String> {
        self.selection.validate()?;
        let s = observed.ok_or("Current explicit selection missing")?;
        if &self.observation_scope != scope
            || &s.scope != scope
            || self.epoch == 0
            || self.epoch != s.epoch
            || Some(&self.catalog_hash) != s.catalog_hash.as_ref()
            || s.selection.as_ref() != Some(&self.selection)
            || s.account
                .as_ref()
                .is_none_or(|a| a.kind == "unauthenticated")
        {
            return Err("Session requires the current explicit model selection".into());
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CommandInput {
    Start {
        working_copy_id: WorkingCopyId,
        choice: Box<ExplicitSelection>,
    },
    Open {
        farfold_session_id: FarfoldSessionId,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub scope: Scope,
    pub farfold_session_id: FarfoldSessionId,
    pub working_copy_id: WorkingCopyId,
    pub native_thread_id: String,
    pub native_tree_id: String,
    pub selection: NativeModelSelection,
}

// Selection intent only. This read never starts/restores a profile or queries native state.
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ContextInput {
    Start {
        installation_id: InstallationId,
        runtime_build_id: RuntimeBuildId,
        working_copy_id: WorkingCopyId,
    },
    Open {
        farfold_session_id: FarfoldSessionId,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    scope: Scope,
    project_id: crate::host_ids::ProjectId,
    working_copy_id: WorkingCopyId,
    cwd: PathBuf,
    navigation_expectation: crate::host_store::session_open::NavigationExpectation,
}

impl configure::Runtime {
    pub fn session_context(
        &self,
        store: &HostStore,
        input: ContextInput,
    ) -> Result<Context, String> {
        self.controller.exclusive(|| {
            let handle = self.connection()?;
            let c = handle.lock().map_err(|_| "Connection unavailable")?;
            if c.transport.failure().is_some()
                || c.threads.unknown
                || c.turns.unknown
                || c.turns.active.is_some()
                || c.control.operations.is_pending()
                || c.control.workspace_phase() == Some(configure::Phase::Unknown)
            {
                return Err("Original connection is unavailable".into());
            }
            let id = match input {
                ContextInput::Start {
                    installation_id,
                    runtime_build_id,
                    working_copy_id,
                } => {
                    let binding = c.scope.binding()?;
                    if binding.installation_id != installation_id
                        || binding.runtime_build_id != runtime_build_id
                        || c.threads.bound.is_some()
                    {
                        return Err(
                            "Selected installation is not an unbound owned connection".into()
                        );
                    }
                    working_copy_id
                }
                ContextInput::Open { farfold_session_id } => {
                    let target = store.session_open_target(&farfold_session_id)?;
                    if target.binding() != c.scope.binding()? {
                        return Err("Session does not belong to this owned connection".into());
                    }
                    store.session_model_selection(&farfold_session_id)?.verify(
                        &target,
                        &RuntimeProfileId::parse(&c.scope.profile_id).map_err(|e| e.to_string())?,
                    )?;
                    target.working_copy_id
                }
            };
            let workspace = store.registered_session_workspace(&id)?;
            let launch = store.current_owned_profile_launch(
                &c.scope.binding()?,
                &RuntimeProfileId::parse(&c.scope.profile_id).map_err(|e| e.to_string())?,
                c.scope.generation,
            )?;
            if c.profile_home != launch.home
                || launch.cwd != workspace.cwd
                || launch.working_copy_id != id
                || c.workspace.cwd != workspace.cwd
                || c.workspace.working_copy_id.as_ref() != Some(&id)
            {
                return Err("Selected workspace is not the original owned launch".into());
            }
            Ok(Context {
                scope: c.scope.clone(),
                project_id: workspace.project_id,
                working_copy_id: id,
                cwd: workspace.cwd,
                navigation_expectation: store.raw_navigation_expectation()?,
            })
        })
    }

    pub fn focus_registered_session(
        &self,
        store: &HostStore,
        receipt: &Snapshot,
        expected: &crate::host_store::session_open::NavigationExpectation,
    ) -> Result<crate::host_store::session_binding_index::HostNavigationSnapshot, String> {
        use crate::host_store::session_open::{OwnedFocusGuard, SessionFocusGuard};
        receipt.scope.validate()?;
        self.controller.exclusive(|| {
            let handle = self.connection()?;
            let c = handle
                .lock()
                .map_err(|_| "Original connection unavailable")?;
            if c.scope != receipt.scope
                || c.transport.failure().is_some()
                || c.threads.unknown
                || c.turns.unknown
                || c.turns.active.is_some()
                || c.control.operations.is_pending()
                || c.control.workspace_phase() == Some(configure::Phase::Unknown)
            {
                return Err("Original focus scope is no longer current".into());
            }
            let target = store.session_open_target(&receipt.farfold_session_id)?;
            let model = store.session_model_selection(&receipt.farfold_session_id)?;
            model.verify(
                &target,
                &RuntimeProfileId::parse(&c.scope.profile_id).map_err(|e| e.to_string())?,
            )?;
            let native = c
                .threads
                .bound
                .as_ref()
                .ok_or("Original native focus target missing")?;
            if target.binding() != c.scope.binding()?
                || receipt.working_copy_id != target.working_copy_id
                || receipt.native_thread_id != native.native_thread_id
                || receipt.native_tree_id != native.native_session_id
                || model.native_thread_id != receipt.native_thread_id
                || model.native_tree_id != receipt.native_tree_id
                || model.selection != receipt.selection
                || model.cwd != native.cwd
                || c.workspace.cwd != model.cwd
                || c.workspace.working_copy_id.as_ref() != Some(&model.working_copy_id)
                || c.admission
                    .as_ref()
                    .and_then(|a| a.actual.as_ref())
                    .is_none_or(|a| a.selection() != model.selection || a.validate(native).is_err())
            {
                return Err(
                    "Original focus receipt differs from current native/Host identity".into(),
                );
            }
            // Hold the existing controller and original connection authority through commit.
            // Shared storage repeats target/model/owned generation/raw navigation in one tx.
            store
                .mark_session_opened_guarded(
                    &receipt.farfold_session_id,
                    &SessionFocusGuard {
                        expected_navigation: expected,
                        target: &target,
                        owned: Some(OwnedFocusGuard {
                            model: &model,
                            generation: c.scope.generation,
                            profile_home: &c.profile_home,
                        }),
                    },
                )
                .map(|(_, navigation)| navigation)
        })
    }
    pub fn session_operation(
        &self,
        store: &HostStore,
        scope: &Scope,
        command: CommandInput,
    ) -> Result<Snapshot, String> {
        scope.validate()?;
        match command {
            CommandInput::Start {
                working_copy_id,
                choice,
            } => self.start_registered_session(store, scope, &working_copy_id, &choice),
            CommandInput::Open { farfold_session_id } => {
                // All native identities and immutable choice come from original shared records.
                let handle = self.connection()?;
                self.open_registered_thread(store, scope, &farfold_session_id)?;
                let result = self.registered_session_receipt(store, scope, &farfold_session_id);
                if result.is_err() {
                    self.mark_session_receipt_unknown(scope, &handle)?;
                }
                result
            }
        }
    }

    fn start_registered_session(
        &self,
        store: &HostStore,
        scope: &Scope,
        id: &WorkingCopyId,
        choice: &ExplicitSelection,
    ) -> Result<Snapshot, String> {
        let workspace = store.registered_session_workspace(id)?;
        let launch = store.current_owned_profile_launch(
            &scope.binding()?,
            &RuntimeProfileId::parse(&scope.profile_id).map_err(|e| e.to_string())?,
            scope.generation,
        )?;
        let handle = self.connection()?;
        {
            let c = handle.lock().map_err(|_| "Connection unavailable")?;
            if &c.scope != scope
                || c.profile_home != launch.home
                || launch.cwd != workspace.cwd
                || launch.working_copy_id != *id
                || c.workspace.cwd != workspace.cwd
                || c.workspace.working_copy_id.as_ref() != Some(id)
            {
                return Err("Session workspace differs from original owned launch".into());
            }
        }
        let native_workspace = threads::Workspace {
            cwd: workspace.cwd.clone(),
            working_copy_id: Some(id.clone()),
        };
        let started = self.start_selected_thread(scope, &native_workspace, choice)?;
        // From here a native thread exists: any failure retains its original identity and
        // closes subsequent work on this generation. Never retry start to repair storage.
        let result = (|| {
            let thread = started
                .thread
                .as_ref()
                .ok_or("Started native identity missing")?;
            if store.registered_session_workspace(id)? != workspace
                || started
                    .model
                    .as_ref()
                    .is_none_or(|m| m.selection() != choice.selection)
            {
                return Err("Workspace or explicit choice changed during native start".into());
            }
            let binding = scope.binding()?;
            let native_session_id =
                NativeSessionId::parse(&thread.native_thread_id).map_err(|e| e.to_string())?;
            let farfold_session_id = native_session_host_id(&binding, &native_session_id)?;
            let now = crate::host_store::now_millis();
            self.register_thread_in_workspace(
                store,
                scope,
                &SessionRegistration {
                    farfold_session_id: farfold_session_id.clone(),
                    runtime_product_id: binding.product_id,
                    installation_id: binding.installation_id,
                    runtime_build_id: binding.runtime_build_id,
                    adapter_id: binding.adapter_id,
                    connection_id: binding.connection_id,
                    project_id: workspace.project_id.clone(),
                    project_path: workspace.project_path.clone(),
                    project_name: workspace.project_name.clone(),
                    working_copy_id: workspace.working_copy_id.clone(),
                    working_copy_path: workspace.cwd.clone(),
                    working_copy_kind: workspace.kind,
                    branch_name: workspace.branch_name.clone(),
                    native_session_id,
                    title: "Codex Session".into(),
                    title_source: SessionTitleSource::Native,
                    created_at: now,
                    updated_at: now,
                },
                Some(&workspace),
            )?;
            self.registered_session_receipt(store, scope, &farfold_session_id)
        })();
        if result.is_err() {
            self.mark_session_receipt_unknown(scope, &handle)?;
        }
        result
    }

    fn mark_session_receipt_unknown(
        &self,
        scope: &Scope,
        original: &Arc<std::sync::Mutex<Connection>>,
    ) -> Result<(), String> {
        if let Ok(current) = self.connection()
            && Arc::ptr_eq(original, &current)
        {
            let mut c = current.lock().map_err(|_| "Connection unavailable")?;
            if &c.scope == scope {
                c.threads.unknown = true;
            }
        }
        Ok(())
    }

    fn registered_session_receipt(
        &self,
        store: &HostStore,
        scope: &Scope,
        id: &FarfoldSessionId,
    ) -> Result<Snapshot, String> {
        self.controller.exclusive(|| {
            let handle = self.connection()?;
            let c = handle.lock().map_err(|_| "Connection unavailable")?;
            if &c.scope != scope || c.threads.unknown || c.control.operations.is_pending() {
                return Err("Session receipt is no longer settled".into());
            }
            let target = store.session_open_target(id)?;
            let saved = store.session_model_selection(id)?;
            saved.verify(
                &target,
                &RuntimeProfileId::parse(&scope.profile_id).map_err(|e| e.to_string())?,
            )?;
            let native = c
                .threads
                .bound
                .as_ref()
                .ok_or("Original native Session missing")?;
            if target.binding() != scope.binding()?
                || target.native_session_id.as_str() != native.native_thread_id
                || target.locator_value.as_deref() != Some(&native.native_session_id)
                || target.working_copy_path != native.cwd
                || c.admission
                    .as_ref()
                    .and_then(|s| s.actual.as_ref())
                    .is_none_or(|a| a.selection() != saved.selection || a.validate(native).is_err())
            {
                return Err("Session receipt differs from original native/Host identity".into());
            }
            Ok(Snapshot {
                scope: scope.clone(),
                farfold_session_id: id.clone(),
                working_copy_id: target.working_copy_id,
                native_thread_id: native.native_thread_id.clone(),
                native_tree_id: native.native_session_id.clone(),
                selection: saved.selection,
            })
        })
    }
}

#[tauri::command]
pub async fn host_codex_acp_session_context(
    app: tauri::AppHandle,
    input: ContextInput,
) -> Result<Context, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<configure::Runtime>()
            .session_context(&app.state::<HostStore>(), input)
            .map_err(|_| "无法匹配已登记的原连接与工作副本；不会创建或恢复连接".to_string())
    })
    .await
    .map_err(|_| "会话上下文读取被中断".to_string())?
}
