use super::{Bounds, BrowserWorkspace, FixedPageReadScope, publish};
use std::ffi::{CStr, CString, c_char, c_void};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;
const ACK_WAIT: Duration = Duration::from_secs(8);

type Policy = unsafe extern "C" fn(*mut c_void, *const c_char) -> bool;
type Status = unsafe extern "C" fn(*mut c_void, i32, u64, *const c_char) -> u64;
type Release = unsafe extern "C" fn(*mut c_void);
type Read = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char);

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
    fn ff_browser_read(
        id: u64,
        expected_url: *const c_char,
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
    base_url: String,
    document: String,
) -> Result<(), String> {
    create_content(
        app,
        state,
        id,
        bounds,
        InitialContent::Html { base_url, document },
    )
    .await
}

enum InitialContent {
    Public(String),
    Html { base_url: String, document: String },
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
            }))
            .cast();
            // Tauri's official PlatformWebview.inner() is the current WKWebView.
            // Only its NSView parent is used. The new WKWebView is not registered
            // with Tauri and does not reuse the parent's configuration/controller.
            let success = unsafe {
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
                InitialContent::Html { base_url, document } => {
                    let base = CString::new(base_url).expect("generated origin has no NUL");
                    match CString::new(document) {
                        Ok(html) => unsafe {
                            ff_browser_load_html(id, 1, html.as_ptr(), base.as_ptr())
                        },
                        Err(_) => false,
                    }
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
pub(super) async fn read(app: &AppHandle, scope: FixedPageReadScope) -> Result<String, String> {
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
            _ => Err("网页正在变化或读取中，请稍后再试".into()),
        }
    })
    .await?;
    receiver.await.map_err(|_| "网页读取已取消")?
}
