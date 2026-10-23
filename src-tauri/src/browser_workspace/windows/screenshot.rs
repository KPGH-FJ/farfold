//! One bounded CDP capture under the original pending operation and grant.
//! Commands are chained by actual completion, not merely queued in order.
use super::*;
use crate::browser_workspace::screenshot_guard::{Document, Guard};

struct Capture {
    view: Rc<View>,
    scope: FixedPageReadScope,
    operation: u64,
    navigation: u64,
    url: String,
    context: i64,
    page: Value,
    before: Option<Guard>,
    bounds: Bounds,
}
impl Capture {
    fn gate(&self) -> impl Fn() -> bool + 'static {
        let view = self.view.clone();
        let scope = self.scope.clone();
        let navigation = self.navigation;
        let context = self.context;
        let operation = self.operation;
        let url = self.url.clone();
        let bounds = self.bounds;
        move || {
            scope
                .with_valid(|| {
                    if !view.live()
                        || !view.visible.get()
                        || view.loading.get()
                        || view.bounds.get() != bounds
                        || view.navigation.get() != navigation
                        || view.source().ok().as_deref() != Some(url.as_str())
                        || view.context.get() != Some(context)
                        || view
                            .pending
                            .borrow()
                            .as_ref()
                            .is_none_or(|p| p.id != operation || p.reply.is_none())
                    {
                        Err("网页已变化，请重新观察".into())
                    } else {
                        Ok(())
                    }
                })
                .is_ok()
        }
    }
    fn live(&self) -> bool {
        self.gate()()
    }
    fn fail(self) {
        // No old pixels, text or node references reach a changed/retired grant.
        finish(
            &self.view,
            self.operation,
            Err("截图保护未能确认，请重新观察页面".into()),
        );
    }
    fn unavailable(mut self) {
        if !self.live() {
            self.fail();
            return;
        }
        self.page["screenshot"] =
            json!({"status":"unavailable","reason":"截图保护或图像未能确认，请重新观察页面"});
        *self.view.observation.borrow_mut() =
            self.page["observationId"].as_str().map(str::to_owned);
        finish(&self.view, self.operation, Ok(self.page.to_string()));
    }
}
fn submit<T: serde::de::DeserializeOwned + 'static>(
    capture: Capture,
    method: &'static str,
    params: Value,
    complete: impl FnOnce(Capture, Result<T, String>) + 'static,
) {
    if !capture.live() {
        capture.fail();
        return;
    }
    let view = capture.view.clone();
    let operation = capture.operation;
    let gate = capture.gate();
    if cdp_guarded(&view, method, params, gate, move |result| {
        if !capture.live() {
            capture.fail();
            return;
        }
        complete(capture, result);
    })
    .is_err()
    {
        finish(
            &view,
            operation,
            Err("截图保护未能开始，请重新观察页面".into()),
        );
    }
}
pub(super) fn start(
    view: Rc<View>,
    scope: FixedPageReadScope,
    operation: u64,
    navigation: u64,
    url: String,
    context: i64,
    page: Value,
) {
    let bounds = view.bounds.get();
    let capture = Capture {
        view,
        scope,
        operation,
        navigation,
        url,
        context,
        page,
        before: None,
        bounds,
    };
    if capture.page["screenshotReason"].is_string() {
        let mut capture = capture;
        capture.page["screenshot"] =
            json!({"status":"unavailable","reason":"页面含可编辑内容或嵌入页面，暂不能安全截图"});
        if !capture.live() {
            capture.fail();
            return;
        }
        *capture.view.observation.borrow_mut() =
            capture.page["observationId"].as_str().map(str::to_owned);
        finish(&capture.view, operation, Ok(capture.page.to_string()));
        return;
    }
    // Deserialize structure directly. CDP attributes/nodeValue/inputValue never
    // become a Value tree, a log, an observation or an Agent response here.
    submit::<Document>(
        capture,
        "DOM.getDocument",
        json!({"depth":-1,"pierce":true}),
        |mut capture, result| {
            let guard = match result.and_then(|d| d.guard().map_err(str::to_owned)) {
                Ok(guard) => guard,
                Err(_) => {
                    capture.scope.revoke();
                    capture.fail();
                    return;
                }
            };
            capture.before = Some(guard);
            take(capture);
        },
    );
}
fn take(capture: Capture) {
    let viewport = &capture.page["viewport"];
    let get = |name: &str| viewport[name].as_f64().filter(|v| v.is_finite());
    let (Some(width), Some(height), Some(dpr), Some(x), Some(y)) = (
        get("width"),
        get("height"),
        get("scale"),
        get("x"),
        get("y"),
    ) else {
        capture.unavailable();
        return;
    };
    if width <= 0.0
        || height <= 0.0
        || width > 16_384.0
        || height > 16_384.0
        || !(0.1..=16.0).contains(&dpr)
        || x < 0.0
        || y < 0.0
    {
        capture.unavailable();
        return;
    }
    let scale = (1024.0 / (width.max(height) * dpr.max(1.0))).min(1.0);
    submit::<Value>(
        capture,
        "Page.captureScreenshot",
        json!({"format":"png","fromSurface":true,"captureBeyondViewport":false,"clip":{"x":x,"y":y,"width":width,"height":height,"scale":scale}}),
        |mut capture, result| {
            #[cfg(test)]
            super::super::production_test_support::capture_completed(&capture.scope, &result);
            let image = result.ok().and_then(|v| {
                v["data"]
                    .as_str()
                    .and_then(crate::browser_workspace::screenshot::captured)
            });
            let Some(image) = image else {
                capture.unavailable();
                return;
            };
            capture.page["screenshot"] = image;
            submit::<Document>(
                capture,
                "DOM.getDocument",
                json!({"depth":-1,"pierce":true}),
                |capture, result| {
                    let after = result.ok().and_then(|d| d.guard().ok());
                    if after.is_none() || after != capture.before {
                        capture.scope.revoke();
                        capture.fail();
                        return;
                    }
                    check(capture);
                },
            );
        },
    );
}
fn check(capture: Capture) {
    let function = OPERATION
        .trim()
        .trim_end_matches(';')
        .replace("/* FARFOLD_OBSERVATION_PROGRAM */", PROGRAM);
    let args = [
        json!("check"),
        json!(""),
        json!(""),
        json!(capture.navigation.to_string()),
        json!(""),
        json!(""),
        json!(""),
        json!(""),
        json!(0),
        json!(capture.view.manual_revision.get()),
    ]
    .into_iter()
    .map(|value| json!({"value":value}))
    .collect::<Vec<_>>();
    let context = capture.context;
    submit::<Value>(
        capture,
        "Runtime.callFunctionOn",
        json!({"functionDeclaration":function,"executionContextId":context,"arguments":args,"returnByValue":true,"awaitPromise":true}),
        |capture, result| {
            let checked = result
                .ok()
                .filter(|r| r.get("exceptionDetails").is_none())
                .and_then(|r| r.get("result")?.get("value").cloned());
            let Some(checked) = checked else {
                capture.fail();
                return;
            };
            if checked["blocked"] != false || checked["screenshotReason"].is_string() {
                capture.scope.revoke();
                capture.fail();
                return;
            }
            if checked["url"] != capture.page["url"]
                || checked["documentVersion"] != capture.page["documentVersion"]
                || checked["viewport"] != capture.page["viewport"]
            {
                capture.fail();
                return;
            }
            // The last grant/pending check runs after the final actual callback;
            // the common Rust layer and transport gate still check before delivery.
            if !capture.live() {
                capture.fail();
                return;
            }
            *capture.view.observation.borrow_mut() =
                capture.page["observationId"].as_str().map(str::to_owned);
            finish(
                &capture.view,
                capture.operation,
                Ok(capture.page.to_string()),
            );
        },
    );
}
