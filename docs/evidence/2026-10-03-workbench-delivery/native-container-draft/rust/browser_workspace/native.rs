use super::{Bounds, BrowserWorkspace, publish};
use std::ffi::{CStr, CString, c_char, c_void};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

type Policy = unsafe extern "C" fn(*mut c_void, *const c_char) -> bool;
type Status = unsafe extern "C" fn(*mut c_void, i32, *const c_char);
type Release = unsafe extern "C" fn(*mut c_void);
type Read = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char);

unsafe extern "C" {
    fn ff_browser_create(id: u64, parent: *mut c_void, x: f64, y: f64, width: f64, height: f64,
        context: *mut c_void, policy: Policy, status: Status, release: Release) -> bool;
    fn ff_browser_navigate(id: u64, url: *const c_char) -> bool;
    fn ff_browser_resize(id: u64, x: f64, y: f64, width: f64, height: f64) -> bool;
    fn ff_browser_read(id: u64, context: *mut c_void, callback: Read) -> bool;
    fn ff_browser_close(id: u64);
}

struct Owner { state: BrowserWorkspace, app: AppHandle, id: u64 }

unsafe fn text<'a>(value: *const c_char) -> &'a str {
    if value.is_null() { "" } else { unsafe { CStr::from_ptr(value) }.to_str().unwrap_or("") }
}
unsafe extern "C" fn policy(context: *mut c_void, url: *const c_char) -> bool {
    let owner = unsafe { &*(context.cast::<Owner>()) };
    owner.state.policy(owner.id, unsafe { text(url) })
}
unsafe extern "C" fn status(context: *mut c_void, kind: i32, url: *const c_char) {
    let owner = unsafe { &*(context.cast::<Owner>()) };
    if let Some(info) = owner.state.event(owner.id, kind, unsafe { text(url) }) { publish(&owner.app, info); }
}
unsafe extern "C" fn release(context: *mut c_void) {
    drop(unsafe { Box::from_raw(context.cast::<Owner>()) });
}
unsafe extern "C" fn read_result(context: *mut c_void, json: *const c_char, error: *const c_char) {
    let sender = unsafe { Box::from_raw(context.cast::<oneshot::Sender<Result<String, String>>>()) };
    let value = if !error.is_null() { Err(unsafe { text(error) }.to_owned()) }
        else { Ok(unsafe { text(json) }.to_owned()) };
    let _ = sender.send(value);
}

async fn main<T: Send + 'static>(app: &AppHandle, action: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let (sender, receiver) = oneshot::channel();
    app.run_on_main_thread(move || { let _ = sender.send(action()); }).map_err(|_| "无法操作网页视图")?;
    receiver.await.map_err(|_| "网页操作已取消")?
}

pub(super) async fn create(app: &AppHandle, state: BrowserWorkspace, id: u64, old: Option<u64>, bounds: Bounds, url: String) -> Result<(), String> {
    let parent = app.get_webview_window("main").ok_or("找不到应用主页面")?;
    let owner_app = app.clone();
    let (sender, receiver) = oneshot::channel();
    parent.with_webview(move |platform| {
        if let Some(previous) = old { unsafe { ff_browser_close(previous); } }
        if state.info(id).is_err() { let _ = sender.send(Err("网页打开已取消".into())); return; }
        let context = Box::into_raw(Box::new(Owner { state, app: owner_app, id })).cast();
        // Tauri's official PlatformWebview.inner() is the current WKWebView.
        // Only its NSView parent is used. The new WKWebView is not registered
        // with Tauri and does not reuse the parent's configuration/controller.
        let success = unsafe { ff_browser_create(id, platform.inner(), bounds.x, bounds.y, bounds.width, bounds.height, context, policy, status, release) };
        if !success {
            unsafe { release(context); }
            let _ = sender.send(Err("无法打开内嵌网页".into()));
            return;
        }
        let target = CString::new(url).expect("validated URL has no NUL");
        if !unsafe { ff_browser_navigate(id, target.as_ptr()) } {
            unsafe { ff_browser_close(id); }
            let _ = sender.send(Err("公开网页地址未能打开".into()));
            return;
        }
        let _ = sender.send(Ok(()));
    }).map_err(|_| "无法打开内嵌网页")?;
    receiver.await.map_err(|_| "网页打开已取消")?
}

pub(super) async fn navigate(app: &AppHandle, id: u64, url: String) -> Result<(), String> {
    let target = CString::new(url).map_err(|_| "网页地址无效")?;
    main(app, move || if unsafe { ff_browser_navigate(id, target.as_ptr()) } { Ok(()) } else { Err("网页已关闭或地址未获准".into()) }).await
}
pub(super) async fn resize(app: &AppHandle, id: u64, bounds: Bounds) -> Result<(), String> {
    main(app, move || if unsafe { ff_browser_resize(id, bounds.x, bounds.y, bounds.width, bounds.height) } { Ok(()) } else { Err("网页位置已变化，请重新打开".into()) }).await
}
pub(super) async fn close(app: &AppHandle, id: u64) -> Result<(), String> {
    main(app, move || { unsafe { ff_browser_close(id); } Ok(()) }).await
}
pub(super) async fn read(app: &AppHandle, id: u64) -> Result<String, String> {
    let (sender, receiver) = oneshot::channel();
    main(app, move || {
        let context = Box::into_raw(Box::new(sender)).cast();
        if !unsafe { ff_browser_read(id, context, read_result) } {
            drop(unsafe { Box::from_raw(context.cast::<oneshot::Sender<Result<String, String>>>()) });
            return Err("网页正在变化或读取中，请稍后再试".into());
        }
        Ok(())
    }).await?;
    receiver.await.map_err(|_| "网页读取已取消")?
}
