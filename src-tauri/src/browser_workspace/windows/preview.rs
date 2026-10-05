use super::*;
use crate::browser_workspace::local_preview::Resource;
use windows::Win32::UI::Shell::SHCreateMemStream;
pub(super) struct PendingResource {
    args: ICoreWebView2WebResourceRequestedEventArgs,
    deferral: ICoreWebView2Deferral,
    navigation: u64,
}
// This function also runs inside the preview lease: do not acquire workspace
// state here. Return the native acknowledgement and report failure afterwards.
fn assign_response(view: &View, pending: PendingResource, resource: Option<Resource>) -> bool {
    unsafe {
        let (bytes, status, mime, headers) = match resource {
            Some(resource) => {
                let headers = resource
                    .headers()
                    .into_iter()
                    .map(|(k, v)| format!("{k}: {v}\r\n"))
                    .collect::<String>();
                (resource.bytes, 200, resource.mime, headers)
            }
            None => (
                Vec::new(),
                403,
                "text/plain; charset=utf-8",
                "Cache-Control: no-store\r\n".into(),
            ),
        };
        let headers = HSTRING::from(format!("Content-Type: {mime}\r\n{headers}"));
        let stream = SHCreateMemStream(Some(&bytes));
        let assigned = view
            .environment
            .CreateWebResourceResponse(
                stream.as_ref(),
                status,
                if status == 200 {
                    windows::core::w!("OK")
                } else {
                    windows::core::w!("Forbidden")
                },
                &headers,
            )
            .and_then(|response| pending.args.SetResponse(&response));
        if assigned.is_err() {
            // Never complete without a response and accidentally permit fallback networking.
            let _ = view.core.Stop();
        }
        let completed = pending.deferral.Complete();
        if completed.is_err() {
            let _ = view.core.Stop();
        }
        assigned.is_ok() && completed.is_ok()
    }
}
fn response_failed(view: &View) {
    view.invalidate("本地网页资源返回未完成，请重新打开");
    view.emit(5, view.navigation.get(), "");
}
fn response(view: &View, pending: PendingResource, resource: Option<Resource>) {
    if !assign_response(view, pending, resource) {
        response_failed(view);
    }
}
pub(super) fn cancel_resources(view: &View) {
    let requests = view
        .resources
        .borrow_mut()
        .drain()
        .map(|(_, r)| r)
        .collect::<Vec<_>>();
    for request in requests {
        response(view, request, None);
    }
}
fn exact_path(target: &str, origin: &Url) -> Option<String> {
    let target = Url::parse(target).ok()?;
    (target.scheme() == origin.scheme()
        && target.host_str() == origin.host_str()
        && target.port() == origin.port()
        && target.username().is_empty()
        && target.password().is_none()
        && target.query().is_none()
        && target.fragment().is_none())
    .then(|| target.path().to_owned())
}
pub(super) fn install(view: &Rc<View>) -> Result<(), String> {
    if !view.content.local() {
        return Ok(());
    }
    let result = (|| -> windows::core::Result<()> {
        unsafe {
            // Intercept every request from local documents; there is no directory
            // mount, unvalidated folder mapping, network fallback or listing API.
            // The original filter omits some frame/worker sources. Require the
            // source-kind surface, installed before the first navigation.
            view.core
                .cast::<ICoreWebView2_22>()?
                .AddWebResourceRequestedFilterWithRequestSourceKinds(
                    windows::core::w!("*"),
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
                )?;
            let weak = Rc::downgrade(view);
            let mut token = 0;
            view.core.add_WebResourceRequested(
                &WebResourceRequestedEventHandler::create(Box::new(move |sender, args| {
                    let Some(view) = weak.upgrade() else {
                        if let Some(sender) = sender {
                            let _ = sender.Stop();
                        }
                        return Ok(());
                    };
                    let prepared = (|| -> windows::core::Result<_> {
                        let args = args.ok_or_else(|| {
                            windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL)
                        })?;
                        let request = args.Request()?;
                        let mut raw_url = PWSTR::null();
                        request.Uri(&mut raw_url)?;
                        let url = CoTaskMemPWSTR::from(raw_url).to_string();
                        let mut raw_method = PWSTR::null();
                        request.Method(&mut raw_method)?;
                        let method = CoTaskMemPWSTR::from(raw_method).to_string();
                        let pending = PendingResource {
                            deferral: args.GetDeferral()?,
                            args,
                            navigation: view.navigation.get(),
                        };
                        Ok((url, method, pending))
                    })();
                    let Ok((url, method, pending)) = prepared else {
                        // An event error alone is not a denial response. Stop
                        // pending fetches before returning; no preview lease is
                        // held while reporting this preparation failure.
                        let stopped = view.core.Stop().is_ok();
                        response_failed(&view);
                        if !stopped {
                            view.close();
                        }
                        return Ok(());
                    };
                    if !view.live() || method != "GET" {
                        response(&view, pending, None);
                        return Ok(());
                    }
                    match &view.content {
                        Content::Html { storage, document } => {
                            let resource = (url == storage.origin.as_str()).then(|| Resource {
                                bytes: document.as_bytes().to_vec(),
                                mime: "text/html; charset=utf-8",
                            });
                            response(&view, pending, resource);
                        }
                        Content::Directory { preview, origin } => {
                            let Some(path) = exact_path(&url, origin) else {
                                response(&view, pending, None);
                                return Ok(());
                            };
                            if view.resources.borrow().len() >= 32 {
                                response(&view, pending, None);
                                return Ok(());
                            }
                            let number = view.resource_sequence.get().checked_add(1);
                            let Some(number) = number else {
                                response(&view, pending, None);
                                return Ok(());
                            };
                            view.resource_sequence.set(number);
                            view.resources.borrow_mut().insert(number, pending);
                            let preview = preview.clone();
                            let lease = preview.lease();
                            let app = view.app.clone();
                            let id = view.id;
                            tauri::async_runtime::spawn(async move {
                                let result = tauri::async_runtime::spawn_blocking(move || {
                                    preview.read_resource(&path)
                                })
                                .await;
                                let _ = app.run_on_main_thread(move || {
                                    let Ok(view) = lookup(id) else {
                                        return;
                                    };
                                    let pending = view.resources.borrow_mut().remove(&number);
                                    let Some(pending) = pending else {
                                        return;
                                    };
                                    if pending.navigation != view.navigation.get() {
                                        response(&view, pending, None);
                                        return;
                                    }
                                    // Keep exact lease through response assignment AND deferral completion.
                                    let mut pending = Some(pending);
                                    let mut result = Some(result);
                                    let delivered = lease.with_live(|| {
                                        Ok(assign_response(
                                            &view,
                                            pending.take().expect("owned request"),
                                            result.take().and_then(Result::ok).and_then(Result::ok),
                                        ))
                                    });
                                    match delivered {
                                        Ok(true) => {}
                                        Ok(false) => response_failed(&view),
                                        Err(_) => {
                                            if let Some(pending) = pending {
                                                response(&view, pending, None);
                                            }
                                        }
                                    }
                                });
                            });
                        }
                        _ => response(&view, pending, None),
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            Ok(())
        }
    })();
    result.map_err(|_| "无法准备本地网页资源".into())
}
fn clear_done(storage: &str, reply: &CompletionReply, result: Result<(), String>) {
    CLEARING.with(|set| set.borrow_mut().remove(storage));
    finish_create(reply, result);
}
pub(super) async fn clear_storage(
    app: &AppHandle,
    storage: StoragePartition,
) -> Result<(), String> {
    let path = profile_path(app, &storage.identifier)?;
    let parent = app.get_webview_window("main").ok_or("找不到应用主页面")?;
    let (sender, receiver) = oneshot::channel();
    parent
        .with_webview(move |platform| {
            let reply = Rc::new(RefCell::new(Some(sender)));
            let id = storage.identifier;
            if SHUTDOWN.get()
                || VIEWS.with(|views| {
                    views
                        .borrow()
                        .values()
                        .any(|view| view.content.storage() == Some(id.as_str()))
                })
                || !CLEARING.with(|set| set.borrow_mut().insert(id.clone()))
            {
                finish_create(&reply, Err("网页仍在使用此进度，请先关闭后重试".into()));
                return;
            }
            let result = (|| -> Result<(), String> {
                let mut hwnd = HWND::default();
                unsafe { platform.controller().ParentWindow(&mut hwnd) }
                    .map_err(|_| "找不到应用窗口")?;
                let options = environment_options();
                let complete_reply = reply.clone();
                let identifier = id.clone();
                let callback = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
                    move |result, environment| {
                        let result = (|| -> Result<(), String> {
                            result.map_err(|_| "无法访问此网页进度")?;
                            let environment = environment.ok_or("无法访问此网页进度")?;
                            let env = environment
                                .cast::<ICoreWebView2Environment10>()
                                .map_err(|_| "网页组件版本过旧")?;
                            let options = unsafe { env.CreateCoreWebView2ControllerOptions() }
                                .map_err(|_| "无法访问此网页进度")?;
                            unsafe { options.SetProfileName(windows::core::w!("Farfold")) }
                                .map_err(|_| "无法访问此网页进度")?;
                            unsafe { options.SetIsInPrivateModeEnabled(false) }
                                .map_err(|_| "无法访问此网页进度")?;
                            let done_reply = complete_reply.clone();
                            let done_id = identifier.clone();
                            let callback = CreateCoreWebView2ControllerCompletedHandler::create(
                                Box::new(move |result, controller| {
                                    let result = (|| -> Result<(), String> {
                                        result.map_err(|_| "无法访问此网页进度")?;
                                        let controller = controller.ok_or("无法访问此网页进度")?;
                                        let core = unsafe { controller.CoreWebView2() }
                                            .map_err(|_| "无法访问此网页进度")?;
                                        unsafe { controller.SetIsVisible(false) }
                                            .map_err(|_| "无法访问此网页进度")?;
                                        let profile = unsafe {
                                            core.cast::<ICoreWebView2_13>()
                                                .map_err(|_| "网页组件版本过旧")?
                                                .Profile()
                                        }
                                        .map_err(|_| "无法访问此网页进度")?
                                        .cast::<ICoreWebView2Profile2>()
                                        .map_err(|_| "网页组件版本过旧")?;
                                        let final_reply = done_reply.clone();
                                        let final_id = done_id.clone();
                                        let callback = ClearBrowsingDataCompletedHandler::create(
                                            Box::new(move |result| {
                                                let closed = unsafe { controller.Close() }.is_ok();
                                                clear_done(
                                                    &final_id,
                                                    &final_reply,
                                                    if result.is_ok() && closed {
                                                        Ok(())
                                                    } else {
                                                        Err("网页进度清除尚未确认，请重试".into())
                                                    },
                                                );
                                                Ok(())
                                            }),
                                        );
                                        unsafe { profile.ClearBrowsingDataAll(&callback) }
                                            .map_err(|_| "网页进度清除尚未确认")?;
                                        Ok(())
                                    })();
                                    if let Err(error) = result {
                                        clear_done(&done_id, &done_reply, Err(error));
                                    }
                                    Ok(())
                                }),
                            );
                            unsafe {
                                env.CreateCoreWebView2ControllerWithOptions(
                                    hwnd, &options, &callback,
                                )
                            }
                            .map_err(|_| "无法访问此网页进度")?;
                            Ok(())
                        })();
                        if let Err(error) = result {
                            clear_done(&identifier, &complete_reply, Err(error));
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
                .map_err(|_| "无法访问此网页进度")?;
                Ok(())
            })();
            if let Err(error) = result {
                clear_done(&id, &reply, Err(error));
            }
        })
        .map_err(|_| "无法操作网页视图")?;
    await_ack(receiver, ACK_WAIT).await
}
