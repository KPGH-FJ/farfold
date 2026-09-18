use super::workspace::*;
use super::*;

impl PiAcpRuntime {
    pub(crate) fn stop_for_recovery(
        &self,
        router: &RuntimeEventRouter,
        target: &SessionOpenTarget,
        generation: u64,
    ) -> Result<PiAcpStatus, String> {
        let _guard = self.start_lock.lock().map_err(|_| "Pi ACP 启停锁不可用")?;
        {
            let handle = self.connection()?;
            let connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
            require_connection_target(&connection, target)?;
            if connection.generation != generation {
                return Err("Pi ACP 恢复代次已失效".into());
            }
        }
        let stopped = self.stop_locked(Some(router));
        if !self.is_stopped()? {
            return Err(stopped
                .err()
                .unwrap_or_else(|| "Pi ACP 进程退出未确认".into()));
        }
        let mut status = current_status(self, router)?;
        status.last_error = stopped.err();
        Ok(status)
    }

    pub(crate) fn stop_idle_session(
        &self,
        router: &RuntimeEventRouter,
        target: &SessionOpenTarget,
        generation: u64,
    ) -> Result<PiAcpStatus, String> {
        let _guard = self.start_lock.lock().map_err(|_| "Pi ACP 启停锁不可用")?;
        let configuration_error = {
            let handle = self.connection()?;
            let connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
            require_connection_target(&connection, target)?;
            // The controller already requires no active Host turn. An explicit
            // disconnect may terminate a pending/unknown configuration operation.
            let configuring = connection.operations.is_config_pending();
            if connection.generation != generation
                || (!configuring
                    && (connection.operations.is_pending()
                        || connection.transport.has_unresolved_work()?))
            {
                return Err("Pi ACP 停止目标已失效或仍有未确认操作".into());
            }
            configuring.then(|| connection.last_error.clone()).flatten()
        };
        let stopped = self.stop_locked(Some(router));
        if !self.is_stopped()? {
            return Err(stopped
                .err()
                .unwrap_or_else(|| "Pi ACP 进程退出未确认".into()));
        }
        let mut status = current_status(self, router)?;
        status.last_error = match (configuration_error, stopped.err()) {
            (Some(configuration), Some(exit)) => Some(format!("{configuration}; {exit}")),
            (configuration, exit) => configuration.or(exit),
        };
        Ok(status)
    }

    pub(crate) fn is_stopped(&self) -> Result<bool, String> {
        Ok(matches!(
            *self.state.lock().map_err(|_| "Pi ACP 生命周期不可用")?,
            AcpLifecycle::Stopped
        ))
    }

    pub(crate) fn with_stopped<T>(
        &self,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = self.start_lock.lock().map_err(|_| "Pi ACP 启停锁不可用")?;
        if !self.is_stopped()? {
            return Err("请先停止当前 Pi ACP 连接，再进行数据操作".into());
        }
        operation()
    }

    /// The exact binding of the current connection, or none once stopped.
    pub(crate) fn current_binding(&self) -> Result<Option<RuntimeBinding>, String> {
        Ok(
            match &*self.state.lock().map_err(|_| "Pi ACP 生命周期不可用")? {
                AcpLifecycle::Stopped => None,
                AcpLifecycle::Running(handle) => Some(
                    handle
                        .lock()
                        .map_err(|_| "Pi ACP 连接不可用")?
                        .binding
                        .clone(),
                ),
            },
        )
    }

    pub(crate) fn connection(&self) -> Result<Arc<Mutex<PiAcpConnection>>, String> {
        match &*self.state.lock().map_err(|_| "Pi ACP 生命周期不可用")? {
            AcpLifecycle::Stopped => Err("Pi ACP 未连接".into()),
            AcpLifecycle::Running(connection) => Ok(connection.clone()),
        }
    }

    /// Current connection generation, read authoritatively from the runtime so
    /// unified Host commands never trust a client-supplied generation.
    pub(crate) fn current_generation(&self) -> Result<u64, String> {
        Ok(self
            .connection()?
            .lock()
            .map_err(|_| "Pi ACP 连接不可用")?
            .generation)
    }

    // Keep identity and occupancy until exit is confirmed, including failed startup.
    pub(crate) fn stop_for_shutdown(&self) -> Result<(), String> {
        let _guard = self.start_lock.lock().map_err(|_| "Pi ACP 启停锁不可用")?;
        self.stop_locked(None)
    }

    pub(crate) fn stop_locked(&self, router: Option<&RuntimeEventRouter>) -> Result<(), String> {
        if self.is_stopped()? {
            return Ok(());
        }
        let handle = self.connection()?;
        let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
        let stopped = connection.transport.stop();
        if stopped.is_err() && connection.transport.is_running()? {
            return stopped;
        }
        connection.event_pump_stop.store(true, Ordering::Release);
        let publication = if let Some(router) = router {
            let drained = connection.update_events(router);
            let terminated = router.route(
                connection.binding.clone(),
                json!({"generation":connection.generation,
                "kind":"lifecycle","payload":{"state":"terminated"}}),
            );
            drained.and(terminated.map(|_| ()))
        } else {
            Ok(())
        };
        *self.state.lock().map_err(|_| "Pi ACP 生命周期不可用")? = AcpLifecycle::Stopped;
        stopped
            .and(publication)
            .map_err(|error| format!("Pi ACP 进程已确认退出，但结果或终态发布仍需核对：{error}"))
    }
}

pub(crate) fn adapter_assets(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let packaged = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .ancestors()
        .any(|path| path.extension().is_some_and(|extension| extension == "app"));
    let node = resources.join("pi-capability-runtime/runtime/node");
    let adapter = resources.join("pi-acp-adapter/index.js");
    let (node, adapter) = if packaged || (node.is_file() && adapter.is_file()) {
        (node, adapter)
    } else {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        (
            manifest.join("capability-bridge/runtime/node"),
            manifest.join("pi-acp-adapter/dist/index.js"),
        )
    };
    if file_sha256(&node)? != NODE_SHA256 {
        return Err("Pi ACP Node 与固定发行摘要不符".into());
    }
    let expected: String = Sha256::digest(include_bytes!("../../pi-acp-adapter/dist/index.js"))
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if file_sha256(&adapter)? != expected {
        return Err("Pi ACP 适配器与本应用构建不符".into());
    }
    Ok((node, adapter))
}

pub(crate) fn launch_command<Bootstrap>(
    node: &Path,
    adapter: &Path,
    pi: &Path,
    cwd: &Path,
    prepared: &PreparedAcpProfile<Bootstrap>,
    trust: Option<&str>,
) -> Result<Command, String> {
    if trust.is_some_and(|value| !matches!(value, "saved" | "approve" | "ignore")) {
        return Err("Unknown Pi project resource choice".into());
    }
    let home = prepared.profile_root.join("home");
    for path in [&home, &prepared.profile_root.join("tmp")] {
        protect_directory(path)?;
    }
    let mut command = Command::new(node);
    command
        .arg(adapter)
        .current_dir(cwd)
        .env_clear()
        .env("HOME", &home)
        .env(
            "PATH",
            launch_path(node, std::env::var_os("PATH").as_deref())?,
        )
        .env("TMPDIR", prepared.profile_root.join("tmp"))
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("XDG_DATA_HOME", home.join("data"))
        .env("XDG_CACHE_HOME", home.join("cache"))
        .env("XDG_STATE_HOME", home.join("state"))
        .env("PI_CODING_AGENT_DIR", &prepared.config_root)
        .env(
            "PI_CODING_AGENT_SESSION_DIR",
            prepared.profile_root.join("sessions"),
        )
        .env("PI_ACP_PI_COMMAND", pi)
        .env("FARFOLD_PI_PROJECT_TRUST", trust.unwrap_or("saved"))
        .envs(&prepared.environment);
    Ok(command)
}

pub(crate) fn launch_path(
    node: &Path,
    inherited: Option<&std::ffi::OsStr>,
) -> Result<std::ffi::OsString, String> {
    let mut paths = vec![
        node.parent()
            .ok_or("Pi ACP Node has no parent")?
            .to_path_buf(),
    ];
    for path in inherited.into_iter().flat_map(std::env::split_paths).chain(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        .map(PathBuf::from),
    ) {
        if path.is_absolute() && !paths.contains(&path) {
            paths.push(path);
        }
    }
    std::env::join_paths(paths).map_err(|error| error.to_string())
}

// This is ownership evidence for an empty managed Session only, never model-request verification.
pub(crate) fn managed_pre_file_anchor(
    binding: &RuntimeBinding,
    provider: &ManagedAcpProviderBinding,
    profile_root: &Path,
    cwd: &Path,
) -> Result<Value, String> {
    let model = provider
        .runtime_model_id
        .strip_prefix(&format!("{}/", provider.runtime_provider_id))
        .filter(|model| !model.is_empty())
        .ok_or("Pi 空会话 bootstrap 模型身份无效")?;
    let ownership = json!({
        "version":1, "product":binding.product_id, "installation":binding.installation_id,
        "build":binding.runtime_build_id, "adapter":binding.adapter_id,
        "connection":binding.connection_id, "profile":profile_root, "cwd":cwd,
        "bootstrap":provider
    });
    Ok(json!({"version":1,
        "binding":Sha256::digest(ownership.to_string().as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
        "provider":provider.runtime_provider_id,"modelId":model}))
}

pub(crate) fn start_connection(
    runtime: &PiAcpRuntime,
    router: &RuntimeEventRouter,
    binding: RuntimeBinding,
    cwd: &Path,
    prepared: &PreparedPiProfile,
    command: &mut Command,
) -> Result<Arc<Mutex<PiAcpConnection>>, String> {
    if !runtime.is_stopped()? {
        return Err("Pi ACP 已连接；请先断开当前会话".into());
    }
    // Explicit removal prevents an inherited environment variable granting a legacy/native profile this path.
    command.env_remove("FARFOLD_PI_MANAGED_PRE_FILE");
    let managed_pre_file = if prepared.integrity.is_some() {
        prepared
            .binding
            .as_ref()
            .map(|provider| {
                managed_pre_file_anchor(&binding, provider, &prepared.profile_root, cwd)
            })
            .transpose()?
    } else {
        None
    };
    if let Some(anchor) = &managed_pre_file {
        command.env("FARFOLD_PI_MANAGED_PRE_FILE", anchor.to_string());
    }
    let (transport, initialized) = crate::acp_runtime::initialize_transport_with_read_limit(
        command,
        cwd,
        json!({
            "fs":{"readTextFile":true,"writeTextFile":true},"terminal":true,
            "elicitation":{"form":{}},"_meta":{"farfoldPi":{"version":1}}
        }),
        ADAPTER_VERSION,
        REQUEST_TIMEOUT,
        crate::acp_transport::AcpReadLimit::NativeHistory,
    )?;
    let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let stop = Arc::new(AtomicBool::new(false));
    let handle = Arc::new(Mutex::new(PiAcpConnection {
        transport: transport.clone(),
        binding: binding.clone(),
        generation,
        cwd: cwd.into(),
        sessions_root: prepared.profile_root.join("sessions"),
        native: None,
        config_options: json!([]),
        managed_provider: prepared.binding.clone(),
        managed_versions: prepared.managed_versions.clone(),
        profile_integrity: prepared.integrity.clone(),
        managed_pre_file,
        initialized_at: crate::host_store::now_millis(),
        last_error: None,
        dropped_events: 0,
        operations: AcpSessionOperations::default(),
        auth_flow: None,
        confirmed_native_selection: None,
        native_first_use: None,
        settlement_gate: Arc::new(Mutex::new(())),
        event_pump_stop: stop.clone(),
    }));
    *runtime.state.lock().map_err(|_| "Pi ACP 生命周期不可用")? =
        AcpLifecycle::Running(handle.clone());
    let activate = (|| {
        if initialized
            .pointer("/agentCapabilities/_meta/farfoldPi/ui")
            .and_then(Value::as_bool)
            != Some(true)
            || initialized
                .pointer("/agentCapabilities/_meta/farfoldPi/promptModel")
                .and_then(Value::as_bool)
                != Some(true)
            || initialized
                .pointer("/agentCapabilities/loadSession")
                .and_then(Value::as_bool)
                != Some(true)
        {
            return Err("Pi ACP 必需交互、模型派发校验或续接能力未协商成功".into());
        }
        router.activate_connection(binding.clone(), generation)?;
        router.route(
            binding,
            json!({"generation":generation,"kind":"lifecycle","payload":{"state":"running"}}),
        )?;
        crate::acp_runtime::start_event_pump(handle.clone(), router.clone(), stop)
    })();
    if let Err(error) = activate {
        runtime
            .stop_locked(Some(router))
            .map_err(|stop| format!("{error}；清理未确认：{stop}"))?;
        return Err(error);
    }
    Ok(handle)
}
