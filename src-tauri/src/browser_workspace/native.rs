use super::{
    Bounds, BrowserWorkspace, FixedPageReadScope,
    local_html::StoragePartition,
    local_preview::{DevServerOrigin, DirectoryPreview},
    native_request::NativeRequest,
    publish,
};
use std::ffi::{CStr, CString, c_char, c_void};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;
const ACK_WAIT: Duration = Duration::from_secs(8);

type Policy = unsafe extern "C" fn(*mut c_void, *const c_char) -> bool;
type Status = unsafe extern "C" fn(*mut c_void, i32, u64, *const c_char) -> u64;
type Release = unsafe extern "C" fn(*mut c_void);
type Read = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char);
type ResourceRequest = unsafe extern "C" fn(*mut c_void, u64, *const c_char);

unsafe extern "C" {
    fn ff_browser_create(
        id: u64,
        parent: *mut c_void,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        context: *mut c_void,
        policy: Policy,
        status: Status,
        release: Release,
    ) -> bool;
    fn ff_browser_create_html(
        id: u64,
        parent: *mut c_void,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        context: *mut c_void,
        policy: Policy,
        status: Status,
        release: Release,
        storage_identifier: *const c_char,
    ) -> bool;
    fn ff_browser_persistent_html_supported() -> bool;
    fn ff_browser_create_preview(
        id: u64,
        parent: *mut c_void,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        context: *mut c_void,
        policy: Policy,
        status: Status,
        release: Release,
        storage_identifier: *const c_char,
        origin: *const c_char,
        resource: Option<ResourceRequest>,
    ) -> bool;
    fn ff_browser_navigate_preview(id: u64, navigation: u64, url: *const c_char) -> bool;
    fn ff_browser_resource_finish(
        id: u64,
        request: u64,
        bytes: *const u8,
        length: usize,
        mime: *const c_char,
        headers_json: *const c_char,
    ) -> bool;
    fn ff_browser_clear_html_storage(
        identifier: *const c_char,
        context: *mut c_void,
        callback: Read,
    ) -> bool;
    fn ff_browser_navigate(id: u64, navigation: u64, url: *const c_char) -> bool;
    fn ff_browser_load_html(
        id: u64,
        navigation: u64,
        html: *const c_char,
        base_url: *const c_char,
    ) -> bool;
    fn ff_browser_resize(id: u64, x: f64, y: f64, width: f64, height: f64) -> bool;
    fn ff_browser_set_visible(
        id: u64,
        visible: bool,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> bool;
    fn ff_browser_cancel_operation(id: u64, operation_id: u64) -> bool;
    fn ff_browser_read(
        id: u64,
        operation_id: u64,
        expected_url: *const c_char,
        context: *mut c_void,
        callback: Read,
    ) -> i32;
    fn ff_browser_observe(
        id: u64,
        operation_id: u64,
        navigation: u64,
        expected_url: *const c_char,
        screenshot: bool,
        context: *mut c_void,
        callback: Read,
    ) -> i32;
    fn ff_browser_act(
        id: u64,
        operation_id: u64,
        navigation: u64,
        expected_url: *const c_char,
        observation_id: *const c_char,
        node_ref: *const c_char,
        kind: i32,
        input_text: *const c_char,
        context: *mut c_void,
        callback: Read,
    ) -> i32;
    fn ff_browser_close(id: u64) -> bool;
    fn ff_browser_close_all() -> bool;
}

struct Owner {
    state: BrowserWorkspace,
    app: AppHandle,
    id: u64,
    directory: Option<(DirectoryPreview, tauri::Url)>,
}

unsafe extern "C" fn resource_request(context: *mut c_void, request: u64, url: *const c_char) {
    let owner = unsafe { &*(context.cast::<Owner>()) };
    // Clone owned state before the callback returns; close may free Owner while
    // disk I/O is pending. No user filesystem work runs on the WebKit thread.
    let Some((preview, origin)) = owner.directory.clone() else {
        return;
    };
    let app = owner.app.clone();
    let id = owner.id;
    let url = tauri::Url::parse(unsafe { text(url) });
    let path = url
        .ok()
        .filter(|url| {
            url.scheme() == origin.scheme()
                && url.host_str() == origin.host_str()
                && url.port() == origin.port()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
        })
        .map(|url| url.path().to_owned());
    let lease = preview.lease();
    tauri::async_runtime::spawn(async move {
        let resource = tauri::async_runtime::spawn_blocking(move || {
            preview.read_resource(&path.ok_or("网页资源位置无效")?)
        })
        .await;
        let _ = app.run_on_main_thread(move || {
            let delivered = lease.with_live(|| {
                if let Ok(Ok(resource)) = resource {
                    let mime = CString::new(resource.mime).expect("fixed MIME");
                    let headers: std::collections::BTreeMap<_, _> =
                        resource.headers().into_iter().collect();
                    let headers = CString::new(
                        serde_json::to_string(&headers).expect("fixed resource headers"),
                    )
                    .expect("JSON has no NUL");
                    unsafe {
                        ff_browser_resource_finish(
                            id,
                            request,
                            resource.bytes.as_ptr(),
                            resource.bytes.len(),
                            mime.as_ptr(),
                            headers.as_ptr(),
                        );
                    }
                } else {
                    unsafe {
                        ff_browser_resource_finish(
                            id,
                            request,
                            std::ptr::null(),
                            0,
                            std::ptr::null(),
                            std::ptr::null(),
                        );
                    }
                }
                Ok(())
            });
            if delivered.is_err() {
                // Failure acknowledges no bytes, including a close/revoke while
                // the file was being read. A stopped native request is ignored.
                unsafe {
                    ff_browser_resource_finish(
                        id,
                        request,
                        std::ptr::null(),
                        0,
                        std::ptr::null(),
                        std::ptr::null(),
                    );
                }
            }
        });
    });
}

unsafe fn text<'a>(value: *const c_char) -> &'a str {
    if value.is_null() {
        ""
    } else {
        unsafe { CStr::from_ptr(value) }.to_str().unwrap_or("")
    }
}
unsafe extern "C" fn policy(context: *mut c_void, url: *const c_char) -> bool {
    let owner = unsafe { &*(context.cast::<Owner>()) };
    owner.state.policy(owner.id, unsafe { text(url) })
}
unsafe extern "C" fn status(
    context: *mut c_void,
    kind: i32,
    navigation: u64,
    url: *const c_char,
) -> u64 {
    let owner = unsafe { &*(context.cast::<Owner>()) };
    if kind == 6 {
        if let Some((token, info)) = owner.state.manual_activity(owner.id) {
            publish(&owner.app, info);
            return token;
        }
        return 0;
    }
    if kind == 4 {
        if let Some((token, info)) = owner.state.link_navigation(owner.id, unsafe { text(url) }) {
            publish(&owner.app, info);
            return token;
        }
        return 0;
    }
    if let Some(info) = owner
        .state
        .event(owner.id, navigation, kind, unsafe { text(url) })
    {
        publish(&owner.app, info);
    }
    0
}
unsafe extern "C" fn release(context: *mut c_void) {
    drop(unsafe { Box::from_raw(context.cast::<Owner>()) });
}
unsafe extern "C" fn read_result(context: *mut c_void, json: *const c_char, error: *const c_char) {
    let sender =
        unsafe { Box::from_raw(context.cast::<oneshot::Sender<Result<String, String>>>()) };
    let value = if !error.is_null() {
        Err(unsafe { text(error) }.to_owned())
    } else {
        Ok(unsafe { text(json) }.to_owned())
    };
    let _ = sender.send(value);
}

pub(super) async fn await_ack<T>(
    receiver: oneshot::Receiver<Result<T, String>>,
    wait: Duration,
) -> Result<T, String> {
    tokio::time::timeout(wait, receiver)
        .await
        .map_err(|_| "网页操作未确认，请重试关闭")?
        .map_err(|_| "网页操作已取消")?
}

async fn main<T: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = oneshot::channel();
    app.run_on_main_thread(move || {
        if !sender.is_closed() {
            let _ = sender.send(action());
        }
    })
    .map_err(|_| "无法操作网页视图")?;
    await_ack(receiver, ACK_WAIT).await
}

pub(super) async fn create(
    app: &AppHandle,
    state: BrowserWorkspace,
    id: u64,
    bounds: Bounds,
    url: String,
) -> Result<(), String> {
    create_content(app, state, id, bounds, InitialContent::Public(url)).await
}

pub(super) async fn create_html(
    app: &AppHandle,
    state: BrowserWorkspace,
    id: u64,
    bounds: Bounds,
    storage: StoragePartition,
    document: String,
) -> Result<(), String> {
    create_content(
        app,
        state,
        id,
        bounds,
        InitialContent::Html { storage, document },
    )
    .await
}

pub(super) async fn create_directory(
    app: &AppHandle,
    state: BrowserWorkspace,
    id: u64,
    bounds: Bounds,
    preview: DirectoryPreview,
    origin: tauri::Url,
) -> Result<(), String> {
    create_content(
        app,
        state,
        id,
        bounds,
        InitialContent::Directory { preview, origin },
    )
    .await
}

pub(super) async fn create_development(
    app: &AppHandle,
    state: BrowserWorkspace,
    id: u64,
    bounds: Bounds,
    origin: DevServerOrigin,
) -> Result<(), String> {
    create_content(app, state, id, bounds, InitialContent::Development(origin)).await
}

enum InitialContent {
    Public(String),
    Html {
        storage: StoragePartition,
        document: String,
    },
    Directory {
        preview: DirectoryPreview,
        origin: tauri::Url,
    },
    Development(DevServerOrigin),
}

async fn create_content(
    app: &AppHandle,
    state: BrowserWorkspace,
    id: u64,
    bounds: Bounds,
    content: InitialContent,
) -> Result<(), String> {
    let parent = app.get_webview_window("main").ok_or("找不到应用主页面")?;
    let owner_app = app.clone();
    let (sender, receiver) = oneshot::channel();
    parent
        .with_webview(move |platform| {
            if sender.is_closed() || !state.can_operate(id, Some(1)) {
                let _ = sender.send(Err("网页打开已取消".into()));
                return;
            }
            let context = Box::into_raw(Box::new(Owner {
                state,
                app: owner_app,
                id,
                directory: match &content {
                    InitialContent::Directory { preview, origin } => {
                        Some((preview.clone(), origin.clone()))
                    }
                    _ => None,
                },
            }))
            .cast();
            // Tauri's official PlatformWebview.inner() is the current WKWebView.
            // Only its NSView parent is used. The new WKWebView is not registered
            // with Tauri and does not reuse the parent's configuration/controller.
            let storage_id = match &content {
                InitialContent::Html { storage, .. } => {
                    Some(CString::new(storage.identifier.clone()).expect("generated UUID"))
                }
                InitialContent::Directory { preview, .. } => {
                    Some(CString::new(preview.storage_identifier()).expect("generated UUID"))
                }
                InitialContent::Development(_) => None,
                _ => None,
            };
            let preview_origin = match &content {
                InitialContent::Directory { origin, .. } => Some((origin.as_str(), true)),
                InitialContent::Development(origin) => Some((origin.start_url().as_str(), false)),
                _ => None,
            };
            let success = if let Some((origin, directory)) = preview_origin {
                let origin = CString::new(origin).expect("validated origin");
                unsafe {
                    ff_browser_create_preview(
                        id,
                        platform.inner(),
                        bounds.x,
                        bounds.y,
                        bounds.width,
                        bounds.height,
                        context,
                        policy,
                        status,
                        release,
                        storage_id
                            .as_ref()
                            .map_or(std::ptr::null(), |value| value.as_ptr()),
                        origin.as_ptr(),
                        directory.then_some(resource_request as ResourceRequest),
                    )
                }
            } else if let Some(storage_id) = storage_id {
                unsafe {
                    ff_browser_create_html(
                        id,
                        platform.inner(),
                        bounds.x,
                        bounds.y,
                        bounds.width,
                        bounds.height,
                        context,
                        policy,
                        status,
                        release,
                        storage_id.as_ptr(),
                    )
                }
            } else {
                unsafe {
                    ff_browser_create(
                        id,
                        platform.inner(),
                        bounds.x,
                        bounds.y,
                        bounds.width,
                        bounds.height,
                        context,
                        policy,
                        status,
                        release,
                    )
                }
            };
            if !success {
                unsafe {
                    release(context);
                }
                let _ = sender.send(Err("无法打开内嵌网页".into()));
                return;
            }
            let started = match content {
                InitialContent::Public(url) => {
                    let target = CString::new(url).expect("validated URL has no NUL");
                    unsafe { ff_browser_navigate(id, 1, target.as_ptr()) }
                }
                InitialContent::Html { storage, document } => {
                    let base = CString::new(storage.origin.to_string())
                        .expect("generated origin has no NUL");
                    match CString::new(document) {
                        Ok(html) => unsafe {
                            ff_browser_load_html(id, 1, html.as_ptr(), base.as_ptr())
                        },
                        Err(_) => false,
                    }
                }
                InitialContent::Directory {
                    preview,
                    mut origin,
                } => {
                    origin.set_path(&preview.entry_path());
                    let target = CString::new(origin.as_str()).expect("generated URL");
                    unsafe { ff_browser_navigate_preview(id, 1, target.as_ptr()) }
                }
                InitialContent::Development(origin) => {
                    let target = CString::new(origin.start_url().as_str()).expect("validated URL");
                    unsafe { ff_browser_navigate_preview(id, 1, target.as_ptr()) }
                }
            };
            if !started {
                unsafe {
                    ff_browser_close(id);
                }
                let _ = sender.send(Err("网页内容未能打开".into()));
                return;
            }
            if sender.send(Ok(())).is_err() {
                // Caller timed out/cancelled after creation started. Never leave an
                // unacknowledged native owner alive; Store reservation remains retryable.
                unsafe {
                    ff_browser_close(id);
                }
            }
        })
        .map_err(|_| "无法打开内嵌网页")?;
    await_ack(receiver, ACK_WAIT).await
}

pub(super) fn persistent_html_supported() -> bool {
    // Availability only; no store, file, user configuration or page is read.
    unsafe { ff_browser_persistent_html_supported() }
}

pub(super) async fn clear_html_storage(
    app: &AppHandle,
    storage: StoragePartition,
) -> Result<(), String> {
    let identifier = CString::new(storage.identifier).expect("generated UUID");
    let (sender, receiver) = oneshot::channel::<Result<String, String>>();
    main(app, move || {
        let context = Box::into_raw(Box::new(sender)).cast();
        if unsafe { ff_browser_clear_html_storage(identifier.as_ptr(), context, read_result) } {
            Ok(())
        } else {
            drop(unsafe {
                Box::from_raw(context.cast::<oneshot::Sender<Result<String, String>>>())
            });
            Err("网页存档未能清除，请重新打开后再试".into())
        }
    })
    .await?;
    await_ack(receiver, ACK_WAIT).await.map(|_| ())
}

pub(super) async fn navigate(
    app: &AppHandle,
    state: BrowserWorkspace,
    id: u64,
    navigation: u64,
    url: String,
) -> Result<(), String> {
    let target = CString::new(url).map_err(|_| "网页地址无效")?;
    main(app, move || {
        if state.can_operate(id, Some(navigation))
            && unsafe { ff_browser_navigate(id, navigation, target.as_ptr()) }
        {
            Ok(())
        } else {
            Err("网页已关闭或地址未获准".into())
        }
    })
    .await
}

pub(super) async fn navigate_preview(
    app: &AppHandle,
    state: BrowserWorkspace,
    id: u64,
    navigation: u64,
    url: String,
) -> Result<(), String> {
    main(app, move || {
        let target = CString::new(url).map_err(|_| "网页地址无效")?;
        if state.can_operate(id, Some(navigation))
            && unsafe { ff_browser_navigate_preview(id, navigation, target.as_ptr()) }
        {
            Ok(())
        } else {
            Err("本地网页无法打开".into())
        }
    })
    .await
}
pub(super) async fn resize(app: &AppHandle, id: u64, bounds: Bounds) -> Result<(), String> {
    main(app, move || {
        if unsafe { ff_browser_resize(id, bounds.x, bounds.y, bounds.width, bounds.height) } {
            Ok(())
        } else {
            Err("网页位置已变化，请重新打开".into())
        }
    })
    .await
}
pub(super) async fn set_visible(
    app: &AppHandle,
    state: BrowserWorkspace,
    id: u64,
    visible: bool,
    bounds: Option<Bounds>,
) -> Result<(), String> {
    main(app, move || {
        let Bounds {
            x,
            y,
            width,
            height,
        } = bounds.unwrap_or(Bounds {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        });
        if state.can_operate(id, None)
            && (!visible || state.can_present(id))
            && unsafe { ff_browser_set_visible(id, visible, x, y, width, height) }
        {
            Ok(())
        } else {
            Err("网页显示状态未确认，请重试关闭".into())
        }
    })
    .await
}

pub(super) async fn close(app: &AppHandle, id: u64) -> Result<(), String> {
    main(app, move || {
        if unsafe { ff_browser_close(id) } {
            Ok(())
        } else {
            Err("网页关闭未确认，请重试".into())
        }
    })
    .await
}

pub(super) fn close_all_on_main_thread() -> bool {
    // The native entry point checks the thread before reporting an ACK.
    unsafe { ff_browser_close_all() }
}
fn request_owner(app: &AppHandle, browser_id: u64) -> Result<NativeRequest, String> {
    let app = app.clone();
    NativeRequest::new(move |operation_id| {
        // Retirement is exact and best effort if the main thread is unavailable.
        // Native retains any dispatched execution until its real completion.
        // Only its single completion callback owns and releases the reply Box.
        let _ = app.run_on_main_thread(move || unsafe {
            ff_browser_cancel_operation(browser_id, operation_id);
        });
    })
}
pub(super) async fn read(app: &AppHandle, scope: FixedPageReadScope) -> Result<String, String> {
    let request = request_owner(app, scope.native_id())?;
    let operation_id = request.id();
    let (sender, receiver) = oneshot::channel();
    main(app, move || {
        let outcome = scope.observe(|id, expected| {
            if sender.is_closed() {
                return Err("网页读取已取消".into());
            }
            let expected = expected
                .map(CString::new)
                .transpose()
                .map_err(|_| "网页地址无效")?;
            let context = Box::into_raw(Box::new(sender)).cast();
            let outcome = unsafe {
                ff_browser_read(
                    id,
                    operation_id,
                    expected
                        .as_ref()
                        .map_or(std::ptr::null(), |url| url.as_ptr()),
                    context,
                    read_result,
                )
            };
            if outcome != 1 {
                drop(unsafe {
                    Box::from_raw(context.cast::<oneshot::Sender<Result<String, String>>>())
                });
            }
            Ok(outcome)
        })?;
        match outcome {
            1 => Ok(()),
            2 => {
                // Revoke outside observe's lease/Store locks. No JS was started.
                scope.revoke();
                Err("网页已变化，请重新确认要分享的页面".into())
            }
            _ => Err("网页仍在加载或等待先前读取结束，请等待或关闭网页".into()),
        }
    })
    .await?;
    request.reply(receiver).await
}

pub(super) enum NativeAction {
    Click,
    Input { text: String },
}

enum ObservationOperation {
    Observe {
        screenshot: bool,
    },
    Act {
        observation_id: CString,
        node_ref: CString,
        kind: i32,
        input: CString,
    },
}

pub(super) async fn observe(
    app: &AppHandle,
    scope: FixedPageReadScope,
    _screenshot: bool,
) -> Result<String, String> {
    // Current public WebKit APIs cannot rule out filled controls in closed
    // shadow trees. Keep pixel capture confined to the direct synthetic native
    // fixture until that boundary can be enforced; no production Rust caller
    // can request pixels, even if an upper layer accidentally passes true.
    observation_operation(
        app,
        scope,
        ObservationOperation::Observe { screenshot: false },
    )
    .await
}

pub(super) async fn act(
    app: &AppHandle,
    scope: FixedPageReadScope,
    observation_id: String,
    node_ref: String,
    action: NativeAction,
) -> Result<String, String> {
    if observation_id.is_empty()
        || observation_id.len() > 128
        || node_ref.is_empty()
        || node_ref.len() > 64
    {
        return Err("网页操作目标无效，请重新观察".into());
    }
    let (kind, input) = match action {
        NativeAction::Click => (1, String::new()),
        NativeAction::Input { text } => (2, text),
    };
    if input.len() > 8192
        || input
            .chars()
            .any(|value| value.is_control() && value != '\n' && value != '\t')
    {
        return Err("输入内容过长或含不支持的字符".into());
    }
    let operation = ObservationOperation::Act {
        observation_id: CString::new(observation_id).map_err(|_| "网页操作目标无效")?,
        node_ref: CString::new(node_ref).map_err(|_| "网页操作目标无效")?,
        kind,
        input: CString::new(input).map_err(|_| "输入内容无效")?,
    };
    observation_operation(app, scope, operation).await
}

async fn observation_operation(
    app: &AppHandle,
    scope: FixedPageReadScope,
    operation: ObservationOperation,
) -> Result<String, String> {
    let request = request_owner(app, scope.native_id())?;
    let operation_id = request.id();
    let (sender, receiver) = oneshot::channel();
    main(app, move || {
        let navigation = scope.navigation();
        let outcome = scope.observe(|id, expected| {
            if sender.is_closed() {
                return Err("网页操作已取消".into());
            }
            // Agent observation/actions always require the exact captured URL.
            let expected = CString::new(expected.ok_or("请先确认要分享的页面")?)
                .map_err(|_| "网页地址无效")?;
            let context = Box::into_raw(Box::new(sender)).cast();
            let outcome = unsafe {
                match operation {
                    ObservationOperation::Observe { screenshot } => ff_browser_observe(
                        id,
                        operation_id,
                        navigation,
                        expected.as_ptr(),
                        screenshot,
                        context,
                        read_result,
                    ),
                    ObservationOperation::Act {
                        observation_id,
                        node_ref,
                        kind,
                        input,
                    } => ff_browser_act(
                        id,
                        operation_id,
                        navigation,
                        expected.as_ptr(),
                        observation_id.as_ptr(),
                        node_ref.as_ptr(),
                        kind,
                        input.as_ptr(),
                        context,
                        read_result,
                    ),
                }
            };
            if outcome != 1 {
                drop(unsafe {
                    Box::from_raw(context.cast::<oneshot::Sender<Result<String, String>>>())
                });
            }
            Ok(outcome)
        })?;
        match outcome {
            1 => Ok(()),
            2 => {
                scope.revoke();
                Err("网页已变化，请重新确认要分享的页面".into())
            }
            3 => Err("网页操作目标已失效，请重新观察".into()),
            _ => Err("网页仍在加载或等待先前操作结束，请等待或关闭网页".into()),
        }
    })
    .await?;
    // A cancelled receiver cannot imply that an already dispatched action had
    // no effect. Callers must keep timeout/closed results unknown and never retry.
    request.reply(receiver).await
}
