use super::super::super::mach_channel::Server;
use super::*;

/// Live identity of the one owning Agent process and its exact conversation.
/// The Mach primitive separately authenticates the genuine Farfold executable.
#[derive(Clone)]
pub(crate) struct OwnerCheck {
    pub(crate) live: hub::CallbackLive,
    pub(crate) helper: Arc<dyn Fn(u32, u32) -> bool + Send + Sync>,
}
/// Public routing information, intentionally no environment or bearer value.
pub(crate) struct MachLaunch {
    name: String,
    command: PathBuf,
    endpoint: String,
    broker_pid: u32,
}
impl MachLaunch {
    pub(crate) fn into_server(self) -> McpServerStdio {
        McpServerStdio::new(self.name, self.command)
            .args(vec![
                helper::MACH_MODE.into(),
                self.endpoint,
                self.broker_pid.to_string(),
            ])
            .env(vec![])
    }
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn start_mach(
    app: AppHandle,
    page: SharedPage,
    on_ready: Callback,
    on_closed: Closed,
    on_permission: Permission,
    on_invalidated: Invalidated,
    owner: OwnerCheck,
) -> Result<(TransportHandle, MachLaunch), String> {
    let server = Server::bind().map_err(|_| "无法准备网页工具".to_owned())?;
    let launch = MachLaunch {
        name: format!(
            "farfold_page_{}",
            server.name().rsplit('.').next().unwrap_or_default()
        ),
        command: std::env::current_exe().map_err(|_| "找不到网页工具程序".to_owned())?,
        endpoint: server.name().into(),
        broker_pid: server.broker_pid(),
    };
    let gate = Arc::new(Gate::default());
    let shutdown = Arc::new(AtomicBool::new(false));
    let (controls, receive) = mpsc::channel();
    let (completed_tx, completed) = watch::channel(0);
    let listed = Arc::new(AtomicBool::new(false));
    let initialized = Arc::new(AtomicBool::new(false));
    let handle = TransportHandle(Arc::new(HandleInner {
        page: page.clone(),
        controls,
        shutdown: shutdown.clone(),
        completed,
        initialized: initialized.clone(),
        listed: listed.clone(),
        multi: Some(gate.clone()),
    }));
    let callbacks = hub::Callbacks {
        ready: Arc::new(move || {
            initialized.store(true, Ordering::Release);
            listed.store(true, Ordering::Release);
            on_ready();
        }),
        closed: on_closed,
        permission: on_permission,
        invalidated: on_invalidated,
    };
    std::thread::Builder::new()
        .name("farfold-page-channels".into())
        .spawn(move || {
            // Native capability querying must stay on this dedicated worker;
            // the factory asks the main thread and waits for its response.
            let hub = hub::Hub {
                execution: Execution::native(app),
                page: page.clone(),
                callbacks: callbacks.clone(),
                gate,
                shutdown,
                controls: receive,
                live: owner.live.clone(),
                incoming: Box::new(move |gate| {
                    server.accept(
                        &|peer| {
                            gate.available() && (owner.live)() && (owner.helper)(peer.pid, peer.uid)
                        },
                        Duration::from_millis(25),
                    )
                }),
            };
            let clean = hub.run();
            notify_page_closed(&page, &callbacks.closed, clean);
            let _ = completed_tx.send(if clean { 1 } else { 2 });
        })
        .map_err(|_| "无法启动网页工具".to_owned())?;
    Ok((handle, launch))
}
