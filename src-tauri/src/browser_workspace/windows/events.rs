use super::*;
use windows::core::BOOL;
fn string(
    read: impl FnOnce(*mut PWSTR) -> windows::core::Result<()>,
) -> windows::core::Result<String> {
    let mut value = PWSTR::null();
    read(&mut value)?;
    Ok(CoTaskMemPWSTR::from(value).to_string())
}
pub(super) fn install(view: &Rc<View>) -> Result<(), String> {
    let result = (|| -> windows::core::Result<()> {
        unsafe {
            let settings = view.core.Settings()?;
            settings.SetAreHostObjectsAllowed(false)?;
            settings.SetIsWebMessageEnabled(false)?;
            settings.SetAreDevToolsEnabled(false)?;
            settings.SetAreDefaultContextMenusEnabled(false)?;
            settings.SetAreDefaultScriptDialogsEnabled(false)?;
            let private_settings = settings.cast::<ICoreWebView2Settings4>()?;
            private_settings.SetIsPasswordAutosaveEnabled(false)?;
            private_settings.SetIsGeneralAutofillEnabled(false)?;
            let profile = view.core.cast::<ICoreWebView2_13>()?.Profile()?;
            let mut private = BOOL(0);
            profile.IsInPrivateModeEnabled(&mut private)?;
            if !view.content.local() && !private.as_bool() {
                return Err(windows::core::Error::from_hresult(
                    windows::Win32::Foundation::E_FAIL,
                ));
            }
            let weak = Rc::downgrade(view);
            let mut token = 0;
            view.core.add_NavigationStarting(
                &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let Some(view) = weak.upgrade() else {
                        args.SetCancel(true)?;
                        return Ok(());
                    };
                    let url = string(|value| args.Uri(value))?;
                    let mut native_id = 0;
                    args.NavigationId(&mut native_id)?;
                    if !view.live() || !view.state.policy(view.id, &url) {
                        args.SetCancel(true)?;
                        return Ok(());
                    }
                    let mut user = BOOL(0);
                    let mut redirected = BOOL(0);
                    args.IsUserInitiated(&mut user)?;
                    args.IsRedirected(&mut redirected)?;
                    let requested = view.requested.borrow().clone();
                    let navigation = if let Some((navigation, _expected)) =
                        requested.filter(|(_, expected)| expected == &url)
                    {
                        view.requested.borrow_mut().take();
                        Some(navigation)
                    } else if redirected.as_bool() {
                        view.navigations
                            .borrow()
                            .get(&native_id)
                            .copied()
                            .filter(|n| *n == view.navigation.get())
                    } else if user.as_bool()
                        || view
                            .action_navigation
                            .take()
                            .is_some_and(|until| Instant::now() < until)
                    {
                        view.state
                            .link_navigation(view.id, &url)
                            .map(|(navigation, info)| {
                                publish(&view.app, info);
                                navigation
                            })
                    } else {
                        None
                    };
                    let Some(navigation) = navigation else {
                        args.SetCancel(true)?;
                        return Ok(());
                    };
                    view.invalidate("网页已变化，请重新确认分享范围");
                    view.context.set(None);
                    preview::cancel_resources(&view);
                    view.navigation.set(navigation);
                    view.loading.set(true);
                    view.navigations.borrow_mut().insert(native_id, navigation);
                    view.emit(0, navigation, &url);
                    Ok(())
                })),
                &mut token,
            )?;
            let weak = Rc::downgrade(view);
            view.core.add_NavigationCompleted(
                &NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                    let (Some(view), Some(args)) = (weak.upgrade(), args) else {
                        return Ok(());
                    };
                    let mut native_id = 0;
                    args.NavigationId(&mut native_id)?;
                    let navigation = view.navigations.borrow_mut().remove(&native_id);
                    let Some(navigation) = navigation.filter(|n| *n == view.navigation.get())
                    else {
                        return Ok(());
                    };
                    let mut success = BOOL(0);
                    args.IsSuccess(&mut success)?;
                    if !success.as_bool() {
                        view.loading.set(false);
                        view.invalidate("网页加载未完成");
                        view.emit(2, navigation, "");
                        return Ok(());
                    }
                    observation::prepare(view, navigation);
                    Ok(())
                })),
                &mut token,
            )?;
            let weak = Rc::downgrade(view);
            view.core.add_SourceChanged(
                &SourceChangedEventHandler::create(Box::new(move |_, args| {
                    let (Some(view), Some(args)) = (weak.upgrade(), args) else {
                        return Ok(());
                    };
                    let mut new_document = BOOL(0);
                    args.IsNewDocument(&mut new_document)?;
                    if new_document.as_bool() || view.loading.get() || !view.live() {
                        return Ok(());
                    }
                    let Ok(url) = view.source() else {
                        return Ok(());
                    };
                    if let Some((navigation, info)) = view.state.link_navigation(view.id, &url) {
                        view.invalidate("网页已变化，请重新确认分享范围");
                        view.navigation.set(navigation);
                        view.loading.set(true);
                        publish(&view.app, info);
                        observation::prepare(view, navigation);
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            view.core.add_FrameNavigationStarting(
                &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        args.SetCancel(true)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            view.core.add_NewWindowRequested(
                &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        args.SetHandled(true)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            view.core.add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            view.core.cast::<ICoreWebView2_4>()?.add_DownloadStarting(
                &DownloadStartingEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        args.SetCancel(true)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            let weak = Rc::downgrade(view);
            view.core.add_ProcessFailed(
                &ProcessFailedEventHandler::create(Box::new(move |_, _| {
                    if let Some(view) = weak.upgrade() {
                        view.invalidate("网页连接已结束");
                        view.emit(5, view.navigation.get(), "");
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            observation::install_manual_event(view)?;
            Ok(())
        }
    })();
    result.map_err(|_| "网页组件缺少所需隔离接口，请更新 Microsoft Edge WebView2".into())
}
