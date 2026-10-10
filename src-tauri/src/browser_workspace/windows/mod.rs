//! Independent WebView2 controller. It is never registered as a Tauri webview.
//! Only fixed internal observation programs reach CDP; no page/App command bridge.
mod events;
mod observation;
mod preview;
use super::{
    Bounds, BrowserWorkspace, FixedPageReadScope,
    local_html::StoragePartition,
    local_preview::{DevServerOrigin, DirectoryPreview},
    publish,
};
use serde_json::Value;
use std::result::Result;
use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
    path::PathBuf,
    rc::Rc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, Url};
use tokio::sync::oneshot;
use webview2_com::{Microsoft::Web::WebView2::Win32::*, *};
use windows::{
    Win32::Foundation::{HWND, RECT},
    core::{HSTRING, Interface, PCWSTR, PWSTR},
};
const ACK_WAIT: Duration = Duration::from_secs(8);
type CompletionReply = Rc<RefCell<Option<oneshot::Sender<Result<(), String>>>>>;
use super::native_request::PendingOperation;
thread_local! {
    static VIEWS:RefCell<HashMap<u64,Rc<View>>>=RefCell::new(HashMap::new());
    static SHUTDOWN:Cell<bool>=const{Cell::new(false)};
    static CLEARING:RefCell<HashSet<String>>=RefCell::new(HashSet::new());
}
#[derive(Clone)]
enum Content {
    Public(String),
    Html {
        storage: StoragePartition,
        document: String,
    },
    Directory {
        preview: DirectoryPreview,
        origin: Url,
    },
    Development(DevServerOrigin),
}
impl Content {
    fn url(&self) -> &str {
        match self {
            Self::Public(url) => url,
            Self::Html { storage, .. } => storage.origin.as_str(),
            Self::Directory { origin, .. } => origin.as_str(),
            Self::Development(origin) => origin.start_url().as_str(),
        }
    }
    fn storage(&self) -> Option<&str> {
        match self {
            Self::Html { storage, .. } => Some(&storage.identifier),
            Self::Directory { preview, .. } => Some(preview.storage_identifier()),
            _ => None,
        }
    }
    fn local(&self) -> bool {
        matches!(self, Self::Html { .. } | Self::Directory { .. })
    }
}
struct View {
    app: AppHandle,
    state: BrowserWorkspace,
    id: u64,
    controller: ICoreWebView2Controller,
    core: ICoreWebView2,
    environment: ICoreWebView2Environment,
    content: Content,
    _temporary: Option<tempfile::TempDir>,
    closed: Cell<bool>,
    close_complete: Cell<bool>,
    visible: Cell<bool>,
    loading: Cell<bool>,
    navigation: Cell<u64>,
    requested: RefCell<Option<(u64, String)>>,
    navigations: RefCell<HashMap<u64, u64>>,
    context: Cell<Option<i64>>,
    manual_revision: Cell<u64>,
    observation: RefCell<Option<String>>,
    pending: RefCell<Option<PendingOperation>>,
    action_navigation: Cell<Option<Instant>>,
    resources: RefCell<HashMap<u64, preview::PendingResource>>,
    resource_sequence: Cell<u64>,
    parent: HWND,
    scale: Cell<f64>,
    bounds: Cell<Bounds>,
}
impl View {
    fn live(&self) -> bool {
        !self.closed.get() && !SHUTDOWN.get()
    }
    fn source(&self) -> Result<String, String> {
        let mut value = PWSTR::null();
        unsafe { self.core.Source(&mut value) }.map_err(|_| "网页位置不可读取")?;
        Ok(CoTaskMemPWSTR::from(value).to_string())
    }
    fn emit(&self, kind: i32, navigation: u64, url: &str) {
        if let Some(info) = self.state.event(self.id, navigation, kind, url) {
            publish(&self.app, info);
        }
    }
    fn invalidate(&self, message: &str) {
        self.observation.borrow_mut().take();
        self.action_navigation.set(None);
        if let Some(pending) = self.pending.borrow_mut().as_mut()
            && let Some(reply) = pending.reply.take()
        {
            // Once dispatched, a lost callback cannot prove the action had no
            // effect. Keep the occupied slot until the actual callback (or view
            // destruction), even after retiring its receiver. A new grant cannot
            // overlap a still-running old operation.
            let result = match &pending.action {
                Some(observation) => Ok(observation::unknown(observation)),
                None => Err(message.into()),
            };
            let _ = reply.send(result);
        }
    }
    fn manual_activity(&self) {
        if !self.live() || !self.visible.get() {
            return;
        }
        self.invalidate("你已操作此网页，请重新确认分享范围");
        if let Some((navigation, info)) = self.state.manual_activity(self.id) {
            self.navigation.set(navigation);
            publish(&self.app, info);
        }
    }
    fn navigate(&self, navigation: u64, url: &str) -> Result<(), String> {
        if !self.live() || !self.state.policy(self.id, url) {
            return Err("网页已关闭或地址不受支持".into());
        }
        self.invalidate("网页已变化，请重新确认分享范围");
        self.context.set(None);
        preview::cancel_resources(self);
        self.navigation.set(navigation);
        self.loading.set(true);
        *self.requested.borrow_mut() = Some((navigation, url.into()));
        unsafe { self.core.Navigate(&HSTRING::from(url)) }.map_err(|_| "无法打开网页".into())
    }
    fn resize(&self, bounds: Bounds) -> Result<(), String> {
        let factor = self
            .app
            .get_webview_window("main")
            .and_then(|w| w.scale_factor().ok())
            .unwrap_or(self.scale.get());
        self.scale.set(factor);
        let mut client = RECT::default();
        unsafe { windows::Win32::UI::WindowsAndMessaging::GetClientRect(self.parent, &mut client) }
            .map_err(|_| "无法调整网页位置")?;
        let rect = RECT {
            left: (bounds.x * factor).round() as i32,
            top: (bounds.y * factor).round() as i32,
            right: ((bounds.x + bounds.width) * factor).round() as i32,
            bottom: ((bounds.y + bounds.height) * factor).round() as i32,
        };
        if rect.left < 0
            || rect.top < 0
            || rect.right > client.right
            || rect.bottom > client.bottom
            || rect.right <= rect.left
            || rect.bottom <= rect.top
        {
            return Err("网页显示区域已变化，请重新打开内容栏".into());
        }
        unsafe { self.controller.SetBounds(rect) }.map_err(|_| "无法调整网页位置")?;
        self.bounds.set(bounds);
        Ok(())
    }
    fn close(&self) -> bool {
        if self.close_complete.get() {
            return true;
        }
        self.closed.set(true);
        self.invalidate("网页已关闭，操作已结束");
        preview::cancel_resources(self);
        // Close detaches all event handlers/controller. A failed close remains an
        // error; it is not translated into an acknowledged stop.
        let complete = unsafe {
            let _ = self.core.Stop();
            self.controller.Close().is_ok()
        };
        self.close_complete.set(complete);
        complete
    }
}
fn lookup(id: u64) -> Result<Rc<View>, String> {
    VIEWS
        .with(|views| views.borrow().get(&id).cloned())
        .filter(|view| view.live())
        .ok_or("网页已关闭".into())
}
fn finish_create(reply: &CompletionReply, result: Result<(), String>) {
    if let Some(reply) = reply.borrow_mut().take() {
        let _ = reply.send(result);
    }
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
    create_content(app, state, id, bounds, Content::Public(url)).await
}
pub(super) async fn create_html(
    app: &AppHandle,
    state: BrowserWorkspace,
    id: u64,
    bounds: Bounds,
    storage: StoragePartition,
    document: String,
) -> Result<(), String> {
    create_content(app, state, id, bounds, Content::Html { storage, document }).await
}
pub(super) async fn create_directory(
    app: &AppHandle,
    state: BrowserWorkspace,
    id: u64,
    bounds: Bounds,
    preview: DirectoryPreview,
    origin: Url,
) -> Result<(), String> {
    create_content(
        app,
        state,
        id,
        bounds,
        Content::Directory { preview, origin },
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
    create_content(app, state, id, bounds, Content::Development(origin)).await
}
fn environment_options() -> ICoreWebView2EnvironmentOptions {
    let options = CoreWebView2EnvironmentOptions::default();
    let scheme = CoreWebView2CustomSchemeRegistration::new("ff-preview".into());
    unsafe {
        scheme.set_treat_as_secure(true);
        scheme.set_has_authority_component(true);
        options.set_scheme_registrations(vec![Some(scheme.into())]);
    }
    options.into()
}
fn profile_path(app: &AppHandle, storage: &str) -> Result<PathBuf, String> {
    if storage.len() != 36 || !storage.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err("网页存储位置无效".into());
    }
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "无法访问网页存储")?
        .join("browser-previews")
        .join(storage))
}
async fn create_content(
    app: &AppHandle,
    state: BrowserWorkspace,
    id: u64,
    bounds: Bounds,
    content: Content,
) -> Result<(), String> {
    let parent = app.get_webview_window("main").ok_or("找不到应用主页面")?;
    let (sender, receiver) = oneshot::channel();
    let app = app.clone();
    parent
        .with_webview(move |platform| {
            let reply = Rc::new(RefCell::new(Some(sender)));
            let result = (|| -> Result<(), String> {
                if SHUTDOWN.get() || !state.can_operate(id, Some(1)) {
                    return Err("网页打开已取消".into());
                }
                if content
                    .storage()
                    .is_some_and(|s| CLEARING.with(|set| set.borrow().contains(s)))
                {
                    return Err("网页进度正在清除，请稍后再打开".into());
                }
                let mut hwnd = HWND::default();
                unsafe { platform.controller().ParentWindow(&mut hwnd) }
                    .map_err(|_| "找不到应用窗口")?;
                let (temporary, path) = if let Some(storage) = content.storage() {
                    let path = profile_path(&app, storage)?;
                    std::fs::create_dir_all(&path).map_err(|_| "无法准备网页存储")?;
                    (None, path)
                } else {
                    let temp = tempfile::Builder::new()
                        .prefix("farfold-page-")
                        .tempdir()
                        .map_err(|_| "无法准备临时网页")?;
                    let path = temp.path().to_owned();
                    (Some(temp), path)
                };
                let options = environment_options();
                let callback_reply = reply.clone();
                let callback = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
                    move |result, environment| {
                        let result = (|| -> Result<(), String> {
                            result
                                .map_err(|_| "网页组件未能启动，请检查 Microsoft Edge WebView2")?;
                            if callback_reply
                                .borrow()
                                .as_ref()
                                .is_none_or(|r| r.is_closed())
                                || !state.can_operate(id, Some(1))
                            {
                                return Err("网页打开已取消".into());
                            }
                            let environment = environment.ok_or("网页组件未能启动")?;
                            let environment10 = environment
                                .cast::<ICoreWebView2Environment10>()
                                .map_err(|_| "网页组件版本过旧，请更新 Microsoft Edge WebView2")?;
                            let controller_options =
                                unsafe { environment10.CreateCoreWebView2ControllerOptions() }
                                    .map_err(|_| "无法准备网页视图")?;
                            unsafe {
                                controller_options.SetProfileName(windows::core::w!("Farfold"))
                            }
                            .map_err(|_| "无法准备网页存储")?;
                            unsafe {
                                controller_options.SetIsInPrivateModeEnabled(!content.local())
                            }
                            .map_err(|_| "无法准备临时网页")?;
                            let done_reply = callback_reply.clone();
                            let retained_environment = environment.clone();
                            let done = CreateCoreWebView2ControllerCompletedHandler::create(
                                Box::new(move |result, controller| {
                                    let result = (|| -> Result<(), String> {
                                        result.map_err(|_| "网页视图未能创建")?;
                                        let controller = controller.ok_or("网页视图未能创建")?;
                                        if done_reply
                                            .borrow()
                                            .as_ref()
                                            .is_none_or(|r| r.is_closed())
                                            || !state.can_operate(id, Some(1))
                                        {
                                            unsafe {
                                                let _ = controller.Close();
                                            }
                                            return Err("网页打开已取消".into());
                                        }
                                        let core = unsafe { controller.CoreWebView2() }
                                            .map_err(|_| "无法准备网页视图")?;
                                        let view = Rc::new(View {
                                            app,
                                            state,
                                            id,
                                            controller,
                                            core,
                                            environment: retained_environment,
                                            content,
                                            _temporary: temporary,
                                            closed: Cell::new(false),
                                            close_complete: Cell::new(false),
                                            visible: Cell::new(true),
                                            loading: Cell::new(true),
                                            navigation: Cell::new(1),
                                            requested: RefCell::new(None),
                                            navigations: RefCell::new(HashMap::new()),
                                            context: Cell::new(None),
                                            manual_revision: Cell::new(0),
                                            observation: RefCell::new(None),
                                            pending: RefCell::new(None),
                                            action_navigation: Cell::new(None),
                                            resources: RefCell::new(HashMap::new()),
                                            resource_sequence: Cell::new(0),
                                            parent: hwnd,
                                            scale: Cell::new(1.0),
                                            bounds: Cell::new(bounds),
                                        });
                                        if let Err(error) = events::install(&view)
                                            .and_then(|_| preview::install(&view))
                                            .and_then(|_| view.resize(bounds))
                                        {
                                            view.close();
                                            return Err(error);
                                        }
                                        VIEWS.with(|views| {
                                            views.borrow_mut().insert(id, view.clone());
                                        });
                                        if let Err(error) = view.navigate(1, view.content.url()) {
                                            view.close();
                                            VIEWS.with(|views| views.borrow_mut().remove(&id));
                                            return Err(error);
                                        }
                                        Ok(())
                                    })();
                                    finish_create(&done_reply, result);
                                    Ok(())
                                }),
                            );
                            unsafe {
                                environment10.CreateCoreWebView2ControllerWithOptions(
                                    hwnd,
                                    &controller_options,
                                    &done,
                                )
                            }
                            .map_err(|_| "网页视图未能创建")?;
                            Ok(())
                        })();
                        if let Err(error) = result {
                            finish_create(&callback_reply, Err(error));
                        }
                        Ok(())
                    },
                ));
                unsafe {
                    CreateCoreWebView2EnvironmentWithOptions(
                        PCWSTR::null(),
                        &HSTRING::from(path.as_os_str()),
                        &options,
                        &callback,
                    )
                }
                .map_err(|_| "网页组件不可用，请安装 Microsoft Edge WebView2")?;
                Ok(())
            })();
            if let Err(error) = result {
                finish_create(&reply, Err(error));
            }
        })
        .map_err(|_| "无法操作网页视图")?;
    await_ack(receiver, ACK_WAIT).await
}
pub(super) fn persistent_html_supported() -> bool {
    true
}
pub(super) async fn clear_html_storage(
    app: &AppHandle,
    storage: StoragePartition,
) -> Result<(), String> {
    preview::clear_storage(app, storage).await
}
pub(super) async fn navigate(
    app: &AppHandle,
    state: BrowserWorkspace,
    id: u64,
    navigation: u64,
    url: String,
) -> Result<(), String> {
    main(app, move || {
        if !state.can_operate(id, Some(navigation)) {
            return Err("网页打开已取消".into());
        }
        lookup(id)?.navigate(navigation, &url)
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
    navigate(app, state, id, navigation, url).await
}
pub(super) async fn resize(app: &AppHandle, id: u64, bounds: Bounds) -> Result<(), String> {
    main(app, move || lookup(id)?.resize(bounds)).await
}
pub(super) async fn set_visible(
    app: &AppHandle,
    state: BrowserWorkspace,
    id: u64,
    visible: bool,
    bounds: Option<Bounds>,
) -> Result<(), String> {
    main(app, move || {
        if !state.can_operate(id, None) {
            return Err("网页已关闭".into());
        }
        let view = lookup(id)?;
        unsafe { view.controller.SetIsVisible(false) }.map_err(|_| "无法隐藏网页")?;
        view.visible.set(false);
        if visible {
            view.resize(bounds.ok_or("网页显示区域未确认，请重新打开内容栏")?)?;
            unsafe { view.controller.SetIsVisible(true) }.map_err(|_| "无法显示网页")?;
            view.visible.set(true);
        }
        Ok(())
    })
    .await
}
pub(super) async fn close(app: &AppHandle, id: u64) -> Result<(), String> {
    main(app, move || {
        let view = VIEWS.with(|views| views.borrow().get(&id).cloned());
        if let Some(view) = view {
            if !view.close() {
                return Err("网页关闭尚未确认，请重试".into());
            }
            VIEWS.with(|views| views.borrow_mut().remove(&id));
        }
        Ok(())
    })
    .await
}
pub(super) fn close_all_on_main_thread() -> bool {
    SHUTDOWN.set(true);
    let views = VIEWS.with(|views| views.borrow().values().cloned().collect::<Vec<_>>());
    let mut closed = true;
    for view in views {
        closed &= view.close();
    }
    if closed {
        VIEWS.with(|views| views.borrow_mut().clear());
    }
    closed
}
pub(super) enum NativeAction {
    Click,
    Input { text: String },
}
pub(super) async fn read(app: &AppHandle, scope: FixedPageReadScope) -> Result<String, String> {
    let raw = observation::run(app, scope, None).await?;
    let page: Value = serde_json::from_str(&raw).map_err(|_| "网页返回内容无效")?;
    // The ordinary read surface returns text only, matching the common
    // NativeSnapshot contract and its smaller response-size limit.
    Ok(serde_json::json!({
        "blocked": page["blocked"],
        "url": page["url"].as_str().unwrap_or_default(),
        "title": page["title"].as_str().unwrap_or_default(),
        "text": page["text"].as_str().unwrap_or_default(),
    })
    .to_string())
}
pub(super) async fn observe(
    app: &AppHandle,
    scope: FixedPageReadScope,
    _screenshot: bool,
) -> Result<String, String> {
    observation::run(app, scope, None).await
}
pub(super) async fn act(
    app: &AppHandle,
    scope: FixedPageReadScope,
    observation_id: String,
    node_ref: String,
    action: NativeAction,
) -> Result<String, String> {
    observation::run(app, scope, Some((observation_id, node_ref, action))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn late_operation_cannot_consume_a_new_reply() {
        let (a_reply, mut a_receive) = oneshot::channel();
        let slot = RefCell::new(Some(PendingOperation {
            id: 1,
            reply: Some(a_reply),
            action: Some("observation-a".into()),
        }));
        // Invalidate A's reply without admitting B; only its real completion
        // removes the occupied slot, after which approved B may start.
        {
            let mut slot = slot.borrow_mut();
            let a = slot.as_mut().unwrap();
            a.reply
                .take()
                .unwrap()
                .send(Ok(observation::unknown(a.action.as_deref().unwrap())))
                .unwrap();
        }
        assert!(slot.borrow().is_some());
        assert!(
            PendingOperation::take_matching(&slot, 1)
                .unwrap()
                .reply
                .is_none()
        );
        let (b_reply, mut b_receive) = oneshot::channel();
        *slot.borrow_mut() = Some(PendingOperation {
            id: 2,
            reply: Some(b_reply),
            action: None,
        });
        assert!(PendingOperation::take_matching(&slot, 1).is_none());
        assert!(matches!(
            b_receive.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        let b = PendingOperation::take_matching(&slot, 2).unwrap();
        b.reply.unwrap().send(Ok("b-result".into())).unwrap();
        assert_eq!(b_receive.try_recv().unwrap().unwrap(), "b-result");
        let unknown: Value = serde_json::from_str(&a_receive.try_recv().unwrap().unwrap()).unwrap();
        assert_eq!(unknown["outcome"], "unknown");
        assert_eq!(unknown["applied"], Value::Null);
    }
}
