//! Strict, main-window-only flat archive IPC. Never expose another job domain.
use crate::{file_archive::*, file_copy_jobs::FileCopyJobs};
use serde::de::DeserializeOwned;
use tauri::{
    State, Webview,
    ipc::{InvokeBody, Request},
};
fn main(webview: &Webview) -> Result<(), Failure> {
    if crate::browser_workspace::caller_allowed(webview) {
        Ok(())
    } else {
        Err(fail("unavailable"))
    }
}
fn parse<T: DeserializeOwned>(body: &InvokeBody) -> Result<T, Failure> {
    match body {
        InvokeBody::Json(value) => T::deserialize(value).map_err(|_| fail("invalidRequest")),
        InvokeBody::Raw(_) => Err(fail("invalidRequest")),
    }
}
#[tauri::command]
pub(crate) fn file_archive_prepare(
    webview: Webview,
    jobs: State<FileCopyJobs>,
    request: Request<'_>,
) -> Result<Status, Failure> {
    main(&webview)?;
    jobs.archive_prepare(parse(request.body())?)
}
#[tauri::command]
pub(crate) fn file_archive_start(
    webview: Webview,
    jobs: State<FileCopyJobs>,
    request: Request<'_>,
) -> Result<Reply, Failure> {
    main(&webview)?;
    jobs.archive_start(&parse(request.body())?)
}
#[tauri::command]
pub(crate) fn file_archive_status(
    webview: Webview,
    jobs: State<FileCopyJobs>,
    request: Request<'_>,
) -> Result<Reply, Failure> {
    main(&webview)?;
    jobs.archive_status(&parse(request.body())?)
}
#[tauri::command]
pub(crate) fn file_archive_cancel(
    webview: Webview,
    jobs: State<FileCopyJobs>,
    request: Request<'_>,
) -> Result<Reply, Failure> {
    main(&webview)?;
    jobs.archive_cancel(&parse(request.body())?)
}
#[tauri::command]
pub(crate) fn file_archive_release(
    webview: Webview,
    jobs: State<FileCopyJobs>,
    request: Request<'_>,
) -> Result<bool, Failure> {
    main(&webview)?;
    jobs.archive_release(&parse(request.body())?)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn flat_ipc_does_not_silently_accept_foreign_or_missing_fields() {
        let p = crate::file_archive::tests::sample("/synthetic/archive.zip".into());
        let mut value = serde_json::to_value(&p).unwrap();
        assert!(parse::<Prepare>(&InvokeBody::Json(value.clone())).is_ok());
        value["extra"] = true.into();
        assert_eq!(
            parse::<Prepare>(&InvokeBody::Json(value))
                .err()
                .unwrap()
                .code,
            "invalidRequest"
        );
        assert!(parse::<Prepare>(&InvokeBody::Json(serde_json::json!({"input":p}))).is_err());
        assert!(
            parse::<Key>(&InvokeBody::Json(
                serde_json::json!({"operationId":p.operation_id})
            ))
            .is_err()
        );
        assert!(parse::<Key>(&InvokeBody::Raw(vec![1, 2])).is_err());
    }
}
