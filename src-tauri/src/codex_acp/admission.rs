//! Ephemeral scoped account/catalog/selection state; only no-network synthetic entry enables it.
#[cfg(test)]
mod tests;
use super::*;
pub use crate::host_store::native_model_selection::SessionModelSelection;
use crate::host_store::{HostStore, native_model_selection::NativeModelSelection};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Effort {
    pub reasoning_effort: String,
    pub description: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Model {
    pub id: String,
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub hidden: bool,
    pub is_default: bool,
    pub supported_reasoning_efforts: Vec<Effort>,
    pub default_reasoning_effort: String,
    pub input_modalities: Vec<String>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Account {
    pub kind: String,
    pub requires_openai_auth: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Actual {
    pub catalog_model_id: String,
    pub native_model: String,
    pub provider: String,
    pub reasoning_effort: String,
    pub native_thread_id: String,
    pub native_session_id: String,
}
impl Actual {
    pub fn selection(&self) -> NativeModelSelection {
        NativeModelSelection {
            catalog_model_id: self.catalog_model_id.clone(),
            native_model: self.native_model.clone(),
            provider: self.provider.clone(),
            reasoning_effort: self.reasoning_effort.clone(),
        }
    }
    pub(super) fn validate(&self, t: &threads::ThreadRef) -> Result<(), String> {
        self.selection().validate()?;
        if self.native_thread_id != t.native_thread_id
            || self.native_session_id != t.native_session_id
            || self.provider != t.model_provider
        {
            return Err("Actual model belongs to a foreign native Session".into());
        }
        Ok(())
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub scope: Scope,
    pub epoch: u64,
    pub account: Option<Account>,
    pub catalog: Option<Vec<Model>>,
    pub catalog_hash: Option<String>,
    pub selection: Option<NativeModelSelection>,
    pub actual: Option<Actual>,
}
impl Snapshot {
    fn validate(&self) -> Result<(), String> {
        let data = self.catalog.as_ref().ok_or("Incomplete model catalog")?;
        if self.epoch == 0
            || self.epoch > 9_007_199_254_740_991
            || data.len() > 512
            || self
                .catalog_hash
                .as_ref()
                .is_none_or(|h| h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()))
            || self.account.as_ref().is_none_or(|a| {
                !matches!(
                    a.kind.as_str(),
                    "apiKey" | "chatgpt" | "amazonBedrock" | "unauthenticated"
                )
            })
        {
            return Err("Invalid account/catalog observation".into());
        }
        let mut ids = std::collections::BTreeSet::new();
        for m in data {
            NativeModelSelection {
                catalog_model_id: m.id.clone(),
                native_model: m.model.clone(),
                provider: "catalog".into(),
                reasoning_effort: m.default_reasoning_effort.clone(),
            }
            .validate()?;
            let efforts: std::collections::BTreeSet<_> = m
                .supported_reasoning_efforts
                .iter()
                .map(|e| &e.reasoning_effort)
                .collect();
            if !ids.insert(&m.id)
                || m.display_name.len() > 4096
                || m.description.len() > 4096
                || efforts.is_empty()
                || efforts.len() > 32
                || efforts.len() != m.supported_reasoning_efforts.len()
                || !efforts.contains(&m.default_reasoning_effort)
                || m.supported_reasoning_efforts
                    .iter()
                    .any(|e| e.description.len() > 4096 || !turns::identifier(&e.reasoning_effort))
                || m.input_modalities.is_empty()
                || m.input_modalities.len() > 2
                || m.input_modalities
                    .iter()
                    .any(|v| !matches!(v.as_str(), "text" | "image"))
            {
                return Err("Invalid native catalog model".into());
            }
        }
        if let Some(s) = &self.selection {
            s.validate()?;
            if self
                .account
                .as_ref()
                .is_none_or(|a| a.kind == "unauthenticated")
                || !data.iter().any(|m| {
                    m.id == s.catalog_model_id
                        && m.model == s.native_model
                        && !m.hidden
                        && m.input_modalities.iter().any(|v| v == "text")
                        && m.supported_reasoning_efforts
                            .iter()
                            .any(|e| e.reasoning_effort == s.reasoning_effort)
                })
            {
                return Err("Explicit model choice unavailable".into());
            }
        }
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CommandInput {
    Refresh,
    Select {
        observation_scope: Scope,
        epoch: u64,
        catalog_hash: String,
        catalog_model_id: String,
        provider: String,
        reasoning_effort: String,
    },
    Restore {
        selection: NativeModelSelection,
    },
    Preflight {
        thread: threads::ThreadRef,
    },
}
// The ordinary facade cannot deserialize internal restore/preflight/thread operations.
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ViewCommand {
    Refresh,
    Select {
        observation_scope: Box<Scope>,
        epoch: u64,
        catalog_hash: String,
        selection: NativeModelSelection,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSnapshot {
    scope: Scope,
    epoch: u64,
    account: Option<Account>,
    catalog: Option<Vec<Model>>,
    catalog_hash: Option<String>,
    // A current explicit view choice only; never native actual or task readiness.
    selection: Option<NativeModelSelection>,
}
impl configure::Runtime {
    pub fn admission_view(
        &self,
        scope: &Scope,
        command: ViewCommand,
    ) -> Result<ViewSnapshot, String> {
        let (command, expected) = match command {
            ViewCommand::Refresh => (CommandInput::Refresh, None),
            ViewCommand::Select {
                observation_scope,
                epoch,
                catalog_hash,
                selection,
            } => (
                CommandInput::Select {
                    observation_scope: *observation_scope,
                    epoch,
                    catalog_hash,
                    catalog_model_id: selection.catalog_model_id.clone(),
                    provider: selection.provider.clone(),
                    reasoning_effort: selection.reasoning_effort.clone(),
                },
                Some(selection),
            ),
        };
        let s = self.admission_checked(scope, command, true, expected.as_ref())?;
        Ok(ViewSnapshot {
            scope: s.scope,
            epoch: s.epoch,
            account: s.account,
            catalog: s.catalog,
            catalog_hash: s.catalog_hash,
            selection: expected.and(s.selection),
        })
    }
    pub fn admission(&self, scope: &Scope, command: CommandInput) -> Result<Snapshot, String> {
        self.admission_checked(scope, command, false, None)
    }
    fn admission_checked(
        &self,
        scope: &Scope,
        command: CommandInput,
        view: bool,
        expected: Option<&NativeModelSelection>,
    ) -> Result<Snapshot, String> {
        let (handle, op, pending, observation) = self.controller.exclusive(|| {
            let handle = self.connection()?;
            let mut c = handle.lock().map_err(|_| "Connection unavailable")?;
            if &c.scope != scope {
                return Err("Admission belongs to another connection".into());
            }
            if c.threads.unknown {
                // Unknown registration retains the original native identity/model for
                // diagnosis. A rejected view read must not erase that private evidence.
                return Err("Admission blocked by unsettled/foreign connection".into());
            }
            let previous = if view { c.admission.take() } else { None };
            if c.turns.unknown || c.turns.active.is_some() || c.control.admission_blocked() {
                return Err("Admission blocked by unsettled/foreign connection".into());
            }
            let observation = if let Some(expected) = expected {
                expected.validate()?;
                if c.threads.bound.is_some() {
                    return Err("Bound Session model selection is immutable".into());
                }
                let s = previous.ok_or("Fresh original catalog required")?;
                s.validate()?;
                let CommandInput::Select {
                    observation_scope,
                    epoch,
                    catalog_hash,
                    ..
                } = &command
                else {
                    return Err("Invalid view selection".into());
                };
                if observation_scope != scope
                    || &s.scope != scope
                    || *epoch != s.epoch
                    || s.catalog_hash.as_ref() != Some(catalog_hash)
                    || s.account
                        .as_ref()
                        .is_none_or(|a| a.kind == "unauthenticated")
                    || !s.catalog.as_ref().unwrap().iter().any(|m| {
                        m.id == expected.catalog_model_id
                            && m.model == expected.native_model
                            && !m.hidden
                            && m.input_modalities.iter().any(|v| v == "text")
                            && m.supported_reasoning_efforts
                                .iter()
                                .any(|e| e.reasoning_effort == expected.reasoning_effort)
                    })
                {
                    return Err("Expired or unavailable explicit model selection".into());
                }
                Some(s)
            } else {
                None
            };
            let unresolved = c.transport.has_unresolved_work()?;
            let op = c.control.operations.begin_connection_config(unresolved)?;
            let dispatched = c.transport.begin_request_unbounded(
                "_codex/admission",
                json!({"scope":scope,"command":command}),
            );
            let p = match dispatched {
                Ok(p) => p,
                Err(crate::acp_transport::AcpDispatchError::NotSent(_)) => {
                    c.control.operations.complete(op)?;
                    return Err("Admission not dispatched".into());
                }
                Err(_) => {
                    c.admission = None;
                    c.threads.unknown = true;
                    return Err("Admission dispatch unconfirmed".into());
                }
            };
            drop(c);
            Ok((handle, op, p, observation))
        })?;
        let response = pending.wait_timeout(Duration::from_secs(15));
        self.controller.exclusive(|| {
            if !Arc::ptr_eq(&self.connection()?, &handle) {
                return Err("Retired admission operation".into());
            }
            let mut c = handle.lock().map_err(|_| "Connection unavailable")?;
            c.admission = None;
            if &c.scope != scope {
                return Err("Retired admission generation".into());
            }
            if matches!(
                &response,
                Err(crate::acp_transport::AcpDispatchError::Rejected {
                    code: -32602..=-32600,
                    ..
                })
            ) {
                c.control.operations.complete(op)?;
                return Err("Admission unavailable or locally disabled".into());
            }
            let result = (|| {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Receipt {
                    scope: Scope,
                    snapshot: Snapshot,
                }
                let mut r: Receipt =
                    serde_json::from_value(response.map_err(|_| "Admission outcome unknown")?)
                        .map_err(|_| "Malformed admission receipt")?;
                if &r.scope != scope {
                    return Err("Admission scope mismatch".into());
                }
                if &r.snapshot.scope != scope {
                    return Err("Admission observation belongs to another scope".into());
                }
                r.snapshot.validate()?;
                if let Some(original) = &observation
                    && (r.snapshot.epoch != original.epoch
                        || r.snapshot.catalog_hash != original.catalog_hash
                        || r.snapshot.catalog != original.catalog
                        || r.snapshot.account != original.account
                        || r.snapshot.selection.as_ref() != expected)
                {
                    return Err(
                        "Explicit selection receipt differs from original observation".into(),
                    );
                }
                if view && expected.is_none() {
                    // The Adapter may retain an internal selection after refresh. It is
                    // not a new explicit Host choice and cannot authorize Session start.
                    r.snapshot.selection = None;
                    r.snapshot.actual = None;
                }
                Ok(r.snapshot)
            })();
            if let Ok(s) = &result {
                c.control.operations.complete(op)?;
                c.admission = Some(s.clone());
            } else {
                c.threads.unknown = true;
            }
            result
        })
    }
    pub(super) fn prepare_model(
        &self,
        store: &HostStore,
        scope: &Scope,
        id: &crate::host_ids::FarfoldSessionId,
    ) -> Result<Snapshot, String> {
        let (thread, saved) = self.controller.exclusive(|| {
            let c = self.connection()?;
            let c = c.lock().map_err(|_| "Connection unavailable")?;
            let t = turns::target(store, &c, scope, id)?;
            let saved = store.session_model_selection(id)?;
            saved.verify(
                &t,
                &crate::host_ids::RuntimeProfileId::parse(&scope.profile_id)
                    .map_err(|e| e.to_string())?,
            )?;
            Ok((c.threads.bound.clone().ok_or("Thread missing")?, saved))
        })?;
        let s = self.admission(
            scope,
            CommandInput::Preflight {
                thread: thread.clone(),
            },
        )?;
        if s.selection.as_ref() != Some(&saved.selection)
            || s.actual
                .as_ref()
                .is_none_or(|a| a.selection() != saved.selection || a.validate(&thread).is_err())
        {
            return Err("Original Session actual model mismatch".into());
        }
        Ok(s)
    }
}
