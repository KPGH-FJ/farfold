//! Runtime account/configuration admission across aliases of a proven entrypoint.
//! This is not an account identity or a persistent relationship between Agents.
use super::*;
use std::sync::Weak;

/// Only a resolved executable or a bounded, explicit interpreter script is known.
/// Unknown wrappers remain unknown; the interpreter itself is never an account.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct LaunchIdentity(PathBuf);

impl LaunchIdentity {
    pub(crate) fn from_launch(command: &str, args: &[String]) -> Option<Self> {
        let path = Path::new(command);
        let canonical = path.canonicalize().ok()?;
        let name = path.file_name()?.to_str()?;
        let resolved_name = canonical.file_name()?.to_str()?;
        let runtime = |name: &str| {
            matches!(
                name,
                "node"
                    | "bun"
                    | "deno"
                    | "python"
                    | "ruby"
                    | "perl"
                    | "sh"
                    | "bash"
                    | "zsh"
                    | "fish"
                    | "npm"
                    | "npx"
                    | "pnpm"
                    | "yarn"
                    | "uv"
                    | "uvx"
                    | "env"
            ) || name.strip_prefix("python").is_some_and(|v| {
                !v.is_empty()
                    && v.split('.')
                        .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
            })
        };
        if !runtime(name) && !runtime(resolved_name) {
            return canonical.is_file().then_some(Self(canonical));
        }
        // Deliberately do not parse -c/-m, loader expressions, package runners,
        // environment assignments or shell text. These need separate evidence.
        let python = name.starts_with("python") || resolved_name.starts_with("python");
        let node = name == "node" || resolved_name == "node";
        if !python && !node {
            return None;
        }
        let mut args = args.iter().peekable();
        while let Some(arg) = args.peek() {
            let harmless = if python {
                matches!(
                    arg.as_str(),
                    "-u" | "-B" | "-E" | "-I" | "-O" | "-OO" | "-s" | "-S"
                )
            } else {
                matches!(arg.as_str(), "--no-warnings" | "--enable-source-maps")
            };
            if harmless {
                args.next();
            } else {
                break;
            }
        }
        if args.peek().is_some_and(|arg| arg.as_str() == "--") {
            args.next();
        }
        let entry = Path::new(args.next()?);
        if !entry.is_absolute() {
            return None;
        }
        let entry = entry.canonicalize().ok()?;
        entry.is_file().then_some(Self(entry))
    }

    fn of(row: &AgentRow) -> Option<Self> {
        Self::from_launch(&row.command, &row.args)
    }
}

struct Claim {
    agent_id: String,
    entries: Vec<LaunchIdentity>,
}
impl Claim {
    fn includes(&self, agent_id: &str, entry: Option<&LaunchIdentity>) -> bool {
        self.agent_id == agent_id || entry.is_some_and(|entry| self.entries.contains(entry))
    }
}

#[derive(Default)]
pub(crate) struct AccountAdmission(Mutex<Vec<Weak<Claim>>>);
impl AccountAdmission {
    /// Called under the connections lock, as is reserve. There is no await and
    /// no inverse lock order: launch publication and account admission are atomic.
    pub(crate) fn check(
        &self,
        agent_id: &str,
        entry: Option<&LaunchIdentity>,
    ) -> Result<(), String> {
        let mut claims = self.0.lock().map_err(|_| "无法读取账号操作状态")?;
        claims.retain(|claim| claim.strong_count() != 0);
        if claims
            .iter()
            .filter_map(Weak::upgrade)
            .any(|claim| claim.includes(agent_id, entry))
        {
            return Err("此程序正在处理账号或配置，请等待结果后重试".into());
        }
        Ok(())
    }

    fn reserve(&self, claim: Claim) -> Result<Arc<Claim>, String> {
        let mut claims = self.0.lock().map_err(|_| "无法读取账号操作状态")?;
        claims.retain(|claim| claim.strong_count() != 0);
        if claims.iter().filter_map(Weak::upgrade).any(|other| {
            other.agent_id == claim.agent_id
                || claim
                    .entries
                    .iter()
                    .any(|entry| other.entries.contains(entry))
        }) {
            return Err("此程序上次账号或配置操作尚未结束，请等待结果".into());
        }
        let claim = Arc::new(claim);
        claims.push(Arc::downgrade(&claim));
        Ok(claim)
    }
}

pub(crate) struct AccountScope {
    // Release member admissions before allowing another launch into this scope.
    _operations: Vec<super::super::lifecycle::OperationLease>,
    _claim: Arc<Claim>,
}

#[cfg(test)]
impl AccountScope {
    pub(crate) fn empty_for_test() -> Self {
        Self {
            _operations: Vec::new(),
            _claim: Arc::new(Claim {
                agent_id: String::new(),
                entries: Vec::new(),
            }),
        }
    }
}

impl AcpManager {
    pub(crate) fn reserve_account_change(&self, agent_id: &str) -> Result<AccountScope, String> {
        self.reserve_configuration_scope(agent_id, [])
    }

    pub(crate) fn reserve_preparation_change(
        &self,
        agent_id: &str,
    ) -> Result<AccountScope, String> {
        self.reserve_configuration_scope(agent_id, [])
    }

    /// The selected, verified terminal can be a separately registered companion.
    /// Its entrypoint is added before reading any credential or starting the PTY.
    pub(crate) fn reserve_authentication_terminal(
        &self,
        agent_id: &str,
        command: &str,
        args: &[String],
    ) -> Result<AccountScope, String> {
        self.reserve_configuration_scope(agent_id, LaunchIdentity::from_launch(command, args))
    }

    /// An official setup may run before any ACP connection exists, and its
    /// companion CLI can also be registered under another name.
    pub(crate) fn reserve_preparation_action(
        &self,
        row: &AgentRow,
        command: &str,
        args: &[String],
    ) -> Result<AccountScope, String> {
        self.reserve_configuration_scope(
            &row.id,
            [
                LaunchIdentity::of(row),
                LaunchIdentity::from_launch(command, args),
            ]
            .into_iter()
            .flatten(),
        )
    }

    fn reserve_configuration_scope(
        &self,
        agent_id: &str,
        entries: impl IntoIterator<Item = LaunchIdentity>,
    ) -> Result<AccountScope, String> {
        let connections = self.lock()?;
        let mut entries: Vec<_> = entries.into_iter().collect();
        for (key, connection) in connections.iter() {
            if key.agent_id == agent_id {
                entries.extend(connection.launch_identity.clone());
            }
        }
        let claim = self.account_admission.reserve(Claim {
            agent_id: agent_id.into(),
            entries,
        })?;
        let mut operations = Vec::new();
        for (key, connection) in connections.iter() {
            if !claim.includes(&key.agent_id, connection.launch_identity.as_ref())
                || matches!(
                    connection.state.load(Ordering::SeqCst),
                    STATE_CLOSED | STATE_FAILED
                )
            {
                continue;
            }
            if key.candidate {
                return Err("相关程序检查尚未结束，请等待后再处理账号或配置".into());
            }
            operations.push(connection.life.operation("account_change".into())?);
        }
        Ok(AccountScope {
            _operations: operations,
            _claim: claim,
        })
    }
}

#[cfg(test)]
#[path = "account_scope_identity_tests.rs"]
mod identity_tests;
