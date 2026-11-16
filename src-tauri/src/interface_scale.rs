//! Main-window presentation preference. A reply confirms the actual platform
//! zoom; Tauri's queued set_zoom acknowledgement alone is not that evidence.
use std::time::Duration;
use tokio::sync::oneshot;

const FAILED: &str = "未能确认界面大小，请重新应用";

fn admit(label: &str, factor: f64) -> Result<(), String> {
    if label != "main" || ![1.0, 1.1, 1.25, 1.5].contains(&factor) {
        return Err("无法使用这个界面大小".into());
    }
    Ok(())
}

fn confirmed(actual: f64, requested: f64) -> Result<f64, String> {
    if actual.is_finite() && (actual - requested).abs() <= 0.000001 {
        Ok(actual)
    } else {
        Err(FAILED.into())
    }
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn ff_interface_scale_apply(view: *mut std::ffi::c_void, factor: f64) -> f64;
}

#[tauri::command]
pub async fn interface_scale_apply(webview: tauri::Webview, factor: f64) -> Result<f64, String> {
    admit(webview.label(), factor)?;
    let (send, receive) = oneshot::channel();
    webview
        .with_webview(move |platform| {
            if send.is_closed() {
                return;
            }
            #[cfg(target_os = "macos")]
            let result = confirmed(
                unsafe { ff_interface_scale_apply(platform.inner(), factor) },
                factor,
            );
            #[cfg(windows)]
            let result = (|| {
                let controller = platform.controller();
                unsafe { controller.SetZoomFactor(factor) }.map_err(|_| FAILED.to_owned())?;
                let mut actual = 0.0;
                unsafe { controller.ZoomFactor(&mut actual) }.map_err(|_| FAILED.to_owned())?;
                confirmed(actual, factor)
            })();
            let _ = send.send(result);
        })
        .map_err(|_| FAILED.to_owned())?;
    tokio::time::timeout(Duration::from_secs(8), receive)
        .await
        .map_err(|_| FAILED.to_owned())?
        .map_err(|_| FAILED.to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_main_and_supported_choices_are_admitted() {
        for value in [1.0, 1.1, 1.25, 1.5] {
            assert!(admit("main", value).is_ok());
            assert!(admit("page", value).is_err());
        }
        for value in [0.0, -1.0, 1.01, 2.0, f64::NAN, f64::INFINITY] {
            assert!(admit("main", value).is_err());
        }
    }
    #[test]
    fn queued_or_different_values_do_not_confirm_an_application() {
        assert_eq!(confirmed(1.25, 1.25).unwrap(), 1.25);
        for value in [0.0, 1.0, 1.5, f64::NAN, f64::INFINITY] {
            assert!(confirmed(value, 1.25).is_err());
        }
    }
}
