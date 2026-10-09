use crate::{
    file_copy_jobs::{CopyFailure, CopyStatus, FileCopyJobs},
    file_delivery::VerifiedFile,
};
use tauri::{State, Webview};
#[derive(Debug, serde::Serialize)]
#[serde(untagged)]
pub(crate) enum CopyReply {
    Status(Box<CopyStatus>),
    Absent {
        #[serde(rename = "operationId")]
        operation_id: String,
        absent: bool,
        settled: bool,
    },
}
impl CopyReply {
    fn from_status(operation_id: String, status: Option<CopyStatus>) -> Self {
        match status {
            Some(status) => Self::Status(Box::new(status)),
            None => Self::Absent {
                operation_id,
                absent: true,
                settled: true,
            },
        }
    }
}
fn main(webview: &Webview) -> Result<(), CopyFailure> {
    if crate::browser_workspace::caller_allowed(webview) {
        Ok(())
    } else {
        Err(CopyFailure {
            code: "unavailable",
        })
    }
}
#[tauri::command]
pub(crate) fn file_copy_prepare(
    webview: Webview,
    jobs: State<FileCopyJobs>,
    file: VerifiedFile,
    destination: String,
) -> Result<CopyStatus, CopyFailure> {
    main(&webview)?;
    jobs.prepare(file, destination)
}
#[tauri::command]
pub(crate) fn file_copy_start(
    webview: Webview,
    jobs: State<FileCopyJobs>,
    operation_id: String,
) -> Result<CopyReply, CopyFailure> {
    main(&webview)?;
    Ok(CopyReply::from_status(
        operation_id.clone(),
        jobs.start(&operation_id)?,
    ))
}
#[tauri::command]
pub(crate) fn file_copy_status(
    webview: Webview,
    jobs: State<FileCopyJobs>,
    operation_id: String,
) -> Result<CopyReply, CopyFailure> {
    main(&webview)?;
    Ok(CopyReply::from_status(
        operation_id.clone(),
        jobs.status(&operation_id)?,
    ))
}
#[tauri::command]
pub(crate) fn file_copy_cancel(
    webview: Webview,
    jobs: State<FileCopyJobs>,
    operation_id: String,
) -> Result<CopyReply, CopyFailure> {
    main(&webview)?;
    Ok(CopyReply::from_status(
        operation_id.clone(),
        jobs.cancel(&operation_id)?,
    ))
}
#[tauri::command]
pub(crate) fn file_copy_release(
    webview: Webview,
    jobs: State<FileCopyJobs>,
    operation_id: String,
) -> Result<bool, CopyFailure> {
    main(&webview)?;
    jobs.release(&operation_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn successful_missing_query_serializes_exact_current_process_absence() {
        let jobs = FileCopyJobs::default();
        let id = "known-request-id".to_owned();
        for status in [
            jobs.status(&id).unwrap(),
            jobs.start(&id).unwrap(),
            jobs.cancel(&id).unwrap(),
        ] {
            let reply = CopyReply::from_status(id.clone(), status);
            assert_eq!(
                serde_json::to_value(reply).unwrap(),
                serde_json::json!({"operationId":id,"absent":true,"settled":true})
            );
        }
        // An error is not an absent or completed receipt.
        assert_eq!(
            serde_json::to_value(CopyFailure {
                code: "unavailable"
            })
            .unwrap(),
            serde_json::json!({"code":"unavailable"})
        );
    }
}
