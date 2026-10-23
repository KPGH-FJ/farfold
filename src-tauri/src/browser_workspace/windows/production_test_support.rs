//! Compiled only in the Windows libtest binary. No product switch or fake CDP.
//! Fixed owned HTTPS responses exercise the original Public controller and guards.
use super::*;
use serde_json::json;
use windows::Win32::UI::Shell::SHCreateMemStream;

pub(crate) const ORIGIN: &str = "https://example.com/farfold-p27-owned/";
thread_local! {
    static FACTS: RefCell<Facts> = RefCell::new(Facts::default());
}
#[derive(Default)]
struct Facts {
    documents: usize,
    refused_resources: usize,
    capture_callbacks: usize,
    actual_callback_revocations: usize,
    revoked_callback_had_png: bool,
    revoke_next_capture: bool,
    version: String,
}

pub(crate) fn facts() -> Value {
    let mut closed = false;
    let mut design = false;
    VIEWS.with(|views| {
        for view in views.borrow().values() {
            if !matches!(&view.content, Content::Public(url) if url.starts_with(ORIGIN)) {
                continue;
            }
            let mut title = PWSTR::null();
            if unsafe { view.core.DocumentTitle(&mut title) }.is_ok() {
                let title = CoTaskMemPWSTR::from(title).to_string();
                closed |= title == "OWNED_CLOSED_RETAINED";
                design |= title == "OWNED_DESIGN_ON";
            }
        }
    });
    FACTS.with(|facts| {
        let f = facts.borrow();
        json!({"documents":f.documents,"refusedResources":f.refused_resources,
            "captureCallbacks":f.capture_callbacks,
            "actualCallbackRevocations":f.actual_callback_revocations,
            "revokedCallbackHadPng":f.revoked_callback_had_png,
            "closedPageScriptConfirmed":closed,"designModeScriptConfirmed":design,
            "runtimeVersion":f.version})
    })
}

pub(crate) fn arm_capture_revocation() {
    FACTS.with(|facts| facts.borrow_mut().revoke_next_capture = true);
}

pub(crate) fn capture_completed(scope: &FixedPageReadScope, result: &Result<Value, String>) {
    let revoke = FACTS.with(|facts| {
        let mut f = facts.borrow_mut();
        f.capture_callbacks += 1;
        let revoke = f.revoke_next_capture;
        f.revoke_next_capture = false;
        if revoke {
            f.actual_callback_revocations += 1;
            f.revoked_callback_had_png = result
                .as_ref()
                .ok()
                .and_then(|value| value["data"].as_str())
                .and_then(crate::browser_workspace::screenshot::captured)
                .is_some();
        }
        revoke
    });
    // This is the SAME admitted scope at the actual native completion. It is
    // neither a fabricated native reply nor a claim that native work stopped.
    if revoke {
        scope.revoke();
    }
}

fn document(path: &str) -> Option<String> {
    let body = match path {
        "plain" | "late" => "<p>OWNED_P27_PUBLIC_TEXT</p>",
        "closed" => {
            "<div id='host'></div><script>const h=document.getElementById('host');h.attachShadow({mode:'closed'}).innerHTML='<input type=password value=OWNED_P27_SECRET>';if(h.shadowRoot!==null)throw Error('closed semantics changed');document.title='OWNED_CLOSED_RETAINED';</script>"
        }
        "design" => {
            "<p>OWNED_P27_SECRET</p><script>document.designMode='on';if(document.designMode==='on')document.title='OWNED_DESIGN_ON';</script>"
        }
        "frame" => "<iframe srcdoc='<input type=password value=OWNED_P27_SECRET>'></iframe>",
        _ => return None,
    };
    Some(format!(
        "<!doctype html><meta charset=utf-8><title>Owned P27 {path}</title><style>html,body{{margin:0;width:100%;height:100%;background:rgb(12,132,44)}}p{{margin:0}}</style>{body}"
    ))
}

pub(super) fn install(view: &Rc<View>) -> Result<(), String> {
    if !matches!(&view.content, Content::Public(url) if url.starts_with(ORIGIN)) {
        return Ok(());
    }
    // Only the test-owned View is intercepted, before its FIRST Navigate. The
    // normal Public policy, InPrivate profile and isolated observation remain.
    let result = (|| -> windows::core::Result<()> {
        unsafe {
            let mut version = PWSTR::null();
            view.environment.BrowserVersionString(&mut version)?;
            let version = CoTaskMemPWSTR::from(version).to_string();
            FACTS.with(|facts| facts.borrow_mut().version = version);
            view.core.AddWebResourceRequestedFilter(
                windows::core::w!("*"),
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            )?;
            let weak = Rc::downgrade(view);
            let mut token = 0;
            view.core.add_WebResourceRequested(
                &WebResourceRequestedEventHandler::create(Box::new(move |sender, args| {
                    let (Some(view), Some(args)) = (weak.upgrade(), args) else {
                        if let Some(sender) = sender {
                            let _ = sender.Stop();
                        }
                        return Ok(());
                    };
                    let result = (|| -> windows::core::Result<()> {
                        let request = args.Request()?;
                        let mut url = PWSTR::null();
                        request.Uri(&mut url)?;
                        let url = CoTaskMemPWSTR::from(url).to_string();
                        let mut method = PWSTR::null();
                        request.Method(&mut method)?;
                        let method = CoTaskMemPWSTR::from(method).to_string();
                        let html = (view.live() && method == "GET")
                            .then(|| url.strip_prefix(ORIGIN).and_then(document))
                            .flatten();
                        FACTS.with(|facts| {
                            let mut f = facts.borrow_mut();
                            if html.is_some() { f.documents += 1; }
                            else { f.refused_resources += 1; }
                        });
                        let bytes = html.as_deref().unwrap_or("").as_bytes();
                        let stream = SHCreateMemStream(Some(bytes));
                        let response = view.environment.CreateWebResourceResponse(
                            stream.as_ref(),
                            if html.is_some() { 200 } else { 403 },
                            windows::core::w!("Owned fixture"),
                            windows::core::w!("Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'\r\n"),
                        )?;
                        args.SetResponse(&response)
                    })();
                    if result.is_err() {
                        let _ = view.core.Stop();
                    }
                    result
                })),
                &mut token,
            )?;
            Ok(())
        }
    })();
    result.map_err(|error| format!("owned P27 fixture setup HRESULT={:#x}", error.code().0))
}
