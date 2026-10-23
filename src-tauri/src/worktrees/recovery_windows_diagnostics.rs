//! Test-binary-only observation of the original failing call, without retries.
//! Fixed stage labels and native error numbers never contain repository material.
use super::types::Result;

pub(super) fn step<T>(stage: &'static str, result: &Result<T>) {
    eprintln!(
        "FARFOLD_WINDOWS_RECOVER_STEP {}",
        serde_json::json!({
            "stage": stage,
            "ok": result.is_ok(),
            "code": result.as_ref().err().map(|failure| failure.code),
        })
    );
}

pub(super) fn io(stage: &'static str, failure: &std::io::Error) {
    eprintln!(
        "FARFOLD_WINDOWS_RECOVER_PATH_FAILURE {}",
        serde_json::json!({
            "stage": stage,
            "nativeError": failure.raw_os_error(),
            "kind": format!("{:?}", failure.kind()),
        })
    );
}

pub(super) fn configured_path_refused(
    absolute: bool,
    root: bool,
    prefix: bool,
    null_device_literal: bool,
) {
    eprintln!(
        "FARFOLD_WINDOWS_RECOVER_CONFIG_PATH_REFUSED {}",
        serde_json::json!({
            "isAbsolute": absolute,
            "hasRoot": root,
            "hasPrefix": prefix,
            "nullDeviceLiteral": null_device_literal,
        })
    );
}
