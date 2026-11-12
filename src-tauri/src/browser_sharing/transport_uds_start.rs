use super::*;
pub(crate) struct LocalEndpoint {
    pub(crate) name: String,
    pub(crate) path: PathBuf,
    pub(crate) uri: &'static str,
}

/// Direct HTTP is authenticated against the actual owned Agent process; it has
/// no helper credential or environment value to serialize into Agent history.
#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
pub(crate) fn start_uds(
    app: AppHandle,
    page: SharedPage,
    on_ready: Callback,
    on_closed: Closed,
    on_permission: Permission,
    on_invalidated: Invalidated,
    peer: PeerCheck,
) -> Result<(TransportHandle, LocalEndpoint), String> {
    let channel::Endpoint {
        guard: directory,
        listener,
        path,
        name,
    } = channel::create().map_err(|_| "无法准备网页工具".to_owned())?;
    let endpoint = LocalEndpoint {
        name: format!("farfold_page_{name}"),
        path,
        uri: "http://127.0.0.1:0/mcp",
    };
    let initialized = Arc::new(AtomicBool::new(false));
    let listed = Arc::new(AtomicBool::new(false));
    let shutdown = Arc::new(AtomicBool::new(false));
    let (controls, control_rx) = mpsc::channel();
    let (completed_tx, completed) = watch::channel(0u8);
    let handle = TransportHandle(Arc::new(HandleInner {
        page: page.clone(),
        controls,
        shutdown: shutdown.clone(),
        completed,
        initialized: initialized.clone(),
        listed: listed.clone(),
    }));
    std::thread::Builder::new()
        .name("farfold-page-http".into())
        .spawn(move || {
            let _directory = directory;
            let mut worker = Worker {
                app,
                page,
                shutdown,
                controls: control_rx,
                on_initialized: Some(Arc::new(move || {
                    initialized.store(true, Ordering::Release);
                })),
                on_ready: Arc::new(move || {
                    listed.store(true, Ordering::Release);
                    on_ready();
                }),
                on_closed,
                on_permission,
                on_invalidated,
                closed_notified: false,
            };
            let clean = worker.serve_uds(listener, peer);
            worker.notify_closed(clean);
            let _ = completed_tx.send(if clean { 1 } else { 2 });
        })
        .map_err(|_| "无法启动网页工具".to_owned())?;
    Ok((handle, endpoint))
}
