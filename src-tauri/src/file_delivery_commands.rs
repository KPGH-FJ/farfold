//! User-triggered delivery commands; remote browser content has no access.
use std::path::Path;
use tauri::Webview;

use crate::file_delivery::{self, DeliveryError, DeliveryReceipt, TextPreview, VerifiedFile};

fn require_main(webview: &Webview) -> Result<(), String> {
    if crate::browser_workspace::caller_allowed(webview) {
        Ok(())
    } else {
        Err("请从主界面操作文件".to_owned())
    }
}

fn display_error(error: DeliveryError) -> String {
    error.message().to_owned()
}

#[tauri::command]
pub async fn file_delivery_inspect(
    webview: Webview,
    root: String,
    path: String,
) -> Result<VerifiedFile, String> {
    require_main(&webview)?;
    crate::file_read_check::run(move || {
        file_delivery::inspect(Path::new(&root), Path::new(&path)).map_err(display_error)
    })
    .await
}

#[tauri::command]
pub async fn file_delivery_inspect_selected(
    webview: Webview,
    path: String,
) -> Result<VerifiedFile, String> {
    require_main(&webview)?;
    // The main UI calls this for one exact file explicitly chosen by the user,
    // through a native picker or a clicked local file link. Never scan prose.
    // The parent is an implementation bound for this file, not a reusable grant.
    crate::file_read_check::run(move || {
        let selected = Path::new(&path);
        let parent = selected
            .parent()
            .ok_or_else(|| display_error(DeliveryError::InvalidPath))?;
        file_delivery::inspect(parent, selected).map_err(display_error)
    })
    .await
}

#[tauri::command]
pub async fn file_delivery_check_revision(
    webview: Webview,
    file: VerifiedFile,
    mode: file_delivery::RevisionMode,
) -> Result<file_delivery::RevisionCheck, file_delivery::RevisionFailure> {
    require_main(&webview).map_err(|_| file_delivery::RevisionFailure { code: "unreadable" })?;
    // No retry: a pending OS read retains its real admission slot after the
    // bounded reply expires. The caller must stop automatic checks on pending.
    crate::file_read_check::run(move || Ok(file_delivery::check_revision(&file, mode)))
        .await
        .map_err(|message| file_delivery::RevisionFailure::check(&message))?
}

#[tauri::command]
pub async fn file_delivery_inspect_text(
    webview: Webview,
    path: String,
) -> Result<VerifiedFile, file_delivery::RevisionFailure> {
    require_main(&webview).map_err(|_| file_delivery::RevisionFailure { code: "unreadable" })?;
    crate::file_read_check::run(move || Ok(file_delivery::inspect_text(Path::new(&path))))
        .await
        .map_err(|message| file_delivery::RevisionFailure::check(&message))?
}

#[tauri::command]
pub async fn file_delivery_check_text_revision(
    webview: Webview,
    file: VerifiedFile,
) -> Result<file_delivery::RevisionCheck, file_delivery::RevisionFailure> {
    require_main(&webview).map_err(|_| file_delivery::RevisionFailure { code: "unreadable" })?;
    crate::file_read_check::run(move || Ok(file_delivery::check_text_revision(&file)))
        .await
        .map_err(|message| file_delivery::RevisionFailure::check(&message))?
}

#[tauri::command]
pub async fn file_delivery_read_text(
    webview: Webview,
    file: VerifiedFile,
) -> Result<TextPreview, String> {
    require_main(&webview)?;
    crate::file_read_check::run(move || file_delivery::read_text(&file).map_err(display_error))
        .await
}

#[tauri::command]
pub async fn file_delivery_read_text_block(
    webview: Webview,
    file: VerifiedFile,
    block_index: u64,
    restore_position: Option<bool>,
) -> Result<file_delivery::TextBlock, file_delivery::TextBlockFailure> {
    require_main(&webview).map_err(|_| file_delivery::TextBlockFailure { code: "unreadable" })?;
    crate::file_read_check::run(move || {
        Ok(file_delivery::read_text_block(
            &file,
            block_index,
            restore_position.unwrap_or(false),
        ))
    })
    .await
    .map_err(|message| file_delivery::TextBlockFailure::check(&message))?
}

#[tauri::command]
pub async fn file_delivery_read_visual(
    webview: Webview,
    file: VerifiedFile,
) -> Result<file_delivery::VisualPreview, String> {
    require_main(&webview)?;
    crate::file_read_check::run(move || file_delivery::read_visual(&file).map_err(display_error))
        .await
}

#[tauri::command]
pub async fn file_delivery_read_workbook(
    webview: Webview,
    file: VerifiedFile,
) -> Result<file_delivery::WorkbookCapture, file_delivery::WorkbookReadFailure> {
    require_main(&webview)
        .map_err(|_| file_delivery::WorkbookReadFailure { code: "unreadable" })?;
    crate::file_read_check::run(move || Ok(file_delivery::read_workbook(&file)))
        .await
        .map_err(|message| file_delivery::WorkbookReadFailure::check(&message))?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn file_delivery_read_workbook_search(
    webview: Webview,
    file: VerifiedFile,
) -> Result<file_delivery::WorkbookCapture, file_delivery::WorkbookReadFailure> {
    require_main(&webview)
        .map_err(|_| file_delivery::WorkbookReadFailure { code: "unreadable" })?;
    checked_workbook_search(file).await
}

async fn checked_workbook_search(
    file: VerifiedFile,
) -> Result<file_delivery::WorkbookCapture, file_delivery::WorkbookReadFailure> {
    // Capture and archive validation retain one shared OS slot until they finish,
    // even when the caller stops waiting or the bounded reply expires.
    crate::file_read_check::run(move || Ok(file_delivery::read_workbook_search(&file)))
        .await
        .map_err(|message| file_delivery::WorkbookReadFailure::check(&message))?
        .map_err(Into::into)
}

#[cfg(test)]
#[path = "file_delivery/workbook_search_command_tests.rs"]
mod workbook_search_tests;

#[tauri::command]
pub async fn file_delivery_read_docx(
    webview: Webview,
    file: VerifiedFile,
) -> Result<file_delivery::DocxCapture, file_delivery::DocxReadFailure> {
    require_main(&webview).map_err(|_| file_delivery::DocxReadFailure { code: "unreadable" })?;
    crate::file_read_check::run(move || Ok(file_delivery::read_docx(&file)))
        .await
        .map_err(|message| file_delivery::DocxReadFailure::check(&message))?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn file_delivery_read_pptx(
    webview: Webview,
    file: VerifiedFile,
) -> Result<file_delivery::PptxCapture, file_delivery::PptxReadFailure> {
    require_main(&webview).map_err(|_| file_delivery::PptxReadFailure { code: "unreadable" })?;
    // The shared slot follows the actual OS read, even if this reply is dropped
    // or times out. Captured parts never grant access to a remote browser view.
    crate::file_read_check::run(move || Ok(file_delivery::read_pptx(&file)))
        .await
        .map_err(|message| file_delivery::PptxReadFailure::check(&message))?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn file_delivery_read_pptx_search(
    webview: Webview,
    file: VerifiedFile,
) -> Result<file_delivery::PptxCapture, file_delivery::PptxReadFailure> {
    require_main(&webview).map_err(|_| file_delivery::PptxReadFailure { code: "unreadable" })?;
    checked_pptx_search(file).await
}

async fn checked_pptx_search(
    file: VerifiedFile,
) -> Result<file_delivery::PptxCapture, file_delivery::PptxReadFailure> {
    // Keep the slot until the actual bounded source/archive read has returned,
    // including when the caller retires its results or the reply times out.
    crate::file_read_check::run(move || Ok(file_delivery::read_pptx_search(&file)))
        .await
        .map_err(|message| file_delivery::PptxReadFailure::check(&message))?
        .map_err(Into::into)
}

#[cfg(test)]
#[path = "file_delivery/presentation_search_command_tests.rs"]
mod pptx_search_tests;

#[tauri::command]
pub async fn file_delivery_read_docx_search(
    webview: Webview,
    file: VerifiedFile,
) -> Result<file_delivery::DocxCapture, file_delivery::DocxReadFailure> {
    require_main(&webview).map_err(|_| file_delivery::DocxReadFailure { code: "unreadable" })?;
    checked_docx_search(file).await
}

async fn checked_docx_search(
    file: VerifiedFile,
) -> Result<file_delivery::DocxCapture, file_delivery::DocxReadFailure> {
    // Same real OS budget as other file reads. A dropped/timed-out reply does
    // not release its slot while capture and archive validation are still running.
    crate::file_read_check::run(move || Ok(file_delivery::read_docx_search(&file)))
        .await
        .map_err(|message| file_delivery::DocxReadFailure::check(&message))?
        .map_err(Into::into)
}

#[cfg(test)]
#[path = "file_delivery/document_search_command_tests.rs"]
mod docx_search_tests;

#[tauri::command]
pub async fn file_delivery_read_pdf_input(
    webview: Webview,
    file: VerifiedFile,
) -> Result<file_delivery::PdfInputCapture, file_delivery::PdfInputReadFailure> {
    require_main(&webview)
        .map_err(|_| file_delivery::PdfInputReadFailure { code: "unreadable" })?;
    // A timed-out IPC reply cannot cancel a started OS read. Its existing
    // shared check slot stays held until that read actually returns.
    crate::file_read_check::run(move || Ok(file_delivery::read_pdf_input(&file)))
        .await
        .map_err(|message| file_delivery::PdfInputReadFailure::check(&message))?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn file_delivery_read_pdf_search(
    webview: Webview,
    file: VerifiedFile,
) -> Result<file_delivery::PdfInputCapture, file_delivery::PdfInputReadFailure> {
    require_main(&webview)
        .map_err(|_| file_delivery::PdfInputReadFailure { code: "unreadable" })?;
    checked_pdf_search(file).await
}

async fn checked_pdf_search(
    file: VerifiedFile,
) -> Result<file_delivery::PdfInputCapture, file_delivery::PdfInputReadFailure> {
    // The shared slot follows the real OS read, even when this reply is dropped
    // or expires. PDF decoding happens separately in the existing parser.
    crate::file_read_check::run(move || Ok(file_delivery::read_pdf_search(&file)))
        .await
        .map_err(|message| file_delivery::PdfInputReadFailure::check(&message))?
        .map_err(Into::into)
}

#[cfg(test)]
#[path = "file_delivery/pdf_search_command_tests.rs"]
mod pdf_search_tests;

#[tauri::command]
pub async fn file_delivery_export_text(
    webview: Webview,
    text: String,
    destination: String,
) -> Result<DeliveryReceipt, String> {
    require_main(&webview)?;
    run_text_export(crate::managed_update::activity, move || {
        file_delivery::export_text(&text, Path::new(&destination))
    })
    .await
}

async fn run_text_export<T, F>(
    admit: impl FnOnce() -> Result<crate::managed_update::ActivityPermit, String>,
    operation: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, DeliveryError> + Send + 'static,
{
    let activity = admit()?;
    tauri::async_runtime::spawn_blocking(move || {
        // The blocking write outlives a dropped IPC waiter. Its real completion,
        // including unwinding, owns the admission release.
        let _activity = activity;
        operation()
    })
    .await
    .map_err(|_| display_error(DeliveryError::Unavailable))?
    .map_err(display_error)
}

fn document_extension(path: &Path) -> bool {
    file_delivery::document_extension(path)
}

async fn selected_location_action(
    webview: Webview,
    root: Option<String>,
    path: String,
    open: bool,
) -> Result<(), String> {
    require_main(&webview)?;
    // Do not put an opener inside the read timeout: its late continuation must
    // not open another application after reporting an expired read.
    tauri::async_runtime::spawn_blocking(move || {
        let target = Path::new(&path);
        let root = root
            .as_deref()
            .map(Path::new)
            .or_else(|| target.parent())
            .ok_or_else(|| display_error(DeliveryError::InvalidPath))?;
        let location =
            file_delivery::selected_location(root, target, open).map_err(display_error)?;
        if open {
            tauri_plugin_opener::open_path(location, None::<&str>)
                .map_err(|_| "打开未完成，请先定位到文件夹".to_owned())
        } else {
            tauri_plugin_opener::reveal_item_in_dir(location)
                .map_err(|_| "无法定位文件，请重新检查".to_owned())
        }
    })
    .await
    .map_err(|_| display_error(DeliveryError::Unavailable))?
}

#[tauri::command]
pub async fn file_delivery_open_selected_location(
    webview: Webview,
    root: Option<String>,
    path: String,
) -> Result<(), String> {
    selected_location_action(webview, root, path, true).await
}

#[tauri::command]
pub async fn file_delivery_reveal_selected_location(
    webview: Webview,
    root: Option<String>,
    path: String,
) -> Result<(), String> {
    selected_location_action(webview, root, path, false).await
}

#[tauri::command]
pub async fn file_delivery_open(webview: Webview, file: VerifiedFile) -> Result<(), String> {
    require_main(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = file_delivery::revalidate_for_open(&file).map_err(display_error)?;
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(&path)
                .map_err(|_| display_error(DeliveryError::Changed))?
                .permissions()
                .mode()
                & 0o111
                != 0
        };
        #[cfg(windows)]
        let executable = false; // Windows launchable suffixes are absent from the document allowlist.
        if !document_extension(Path::new(&path)) || executable {
            return Err("此文件请先定位到文件夹，再选择打开方式".to_owned());
        }
        // Explicit user action only. No command interpolation or open-with override.
        tauri_plugin_opener::open_path(&path, None::<&str>)
            .map_err(|_| "打开未完成，请先定位到文件夹".to_owned())
    })
    .await
    .map_err(|_| display_error(DeliveryError::Unavailable))?
}

#[tauri::command]
pub async fn file_delivery_reveal(webview: Webview, file: VerifiedFile) -> Result<(), String> {
    require_main(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = file_delivery::revalidate_for_open(&file).map_err(display_error)?;
        tauri_plugin_opener::reveal_item_in_dir(path)
            .map_err(|_| "无法定位文件，请重新检查".to_owned())
    })
    .await
    .map_err(|_| display_error(DeliveryError::Unavailable))?
}

/// Show a conversation's working directory in the file manager. The path is
/// a recorded session cwd — only an existing absolute directory is accepted.
#[tauri::command]
pub async fn file_delivery_reveal_location(webview: Webview, path: String) -> Result<(), String> {
    require_main(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        if path.is_empty() || path.chars().any(|c| c.is_control()) {
            return Err("无法确认这个工作位置，请重新打开对话后重试".to_owned());
        }
        let target = Path::new(&path);
        if !target.is_absolute() || !target.is_dir() {
            return Err("这个工作位置已不存在，请检查后再试".to_owned());
        }
        tauri_plugin_opener::open_path(target, None::<&str>)
            .map_err(|_| "无法在访达中显示该位置，请重试".to_owned())
    })
    .await
    .map_err(|_| "无法在访达中显示该位置，请重试".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_config() -> tauri::Config {
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap()
    }

    #[test]
    fn review_regression_delivery_accepts_windows_packaged_main_origin() {
        let mut config = app_config();
        config.build.dev_url = None;
        let main = config
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
            .unwrap();
        assert!(!main.use_https_scheme);
        assert!(crate::browser_workspace::caller_allowed_for_config(
            "main",
            &tauri::Url::parse("http://tauri.localhost/index.html").unwrap(),
            &config,
            true
        ));
    }

    #[test]
    fn main_caller_uses_exact_platform_and_configured_protocol() {
        for (windows, use_https_scheme, trusted) in [
            (false, false, "tauri://localhost"),
            (false, true, "tauri://localhost"),
            (true, false, "http://tauri.localhost"),
            (true, true, "https://tauri.localhost"),
        ] {
            let mut config = app_config();
            config.build.dev_url = None;
            config
                .app
                .windows
                .iter_mut()
                .find(|window| window.label == "main")
                .unwrap()
                .use_https_scheme = use_https_scheme;
            for candidate in [
                "tauri://localhost",
                "http://tauri.localhost",
                "https://tauri.localhost",
            ] {
                assert_eq!(
                    crate::browser_workspace::caller_allowed_for_config(
                        "main",
                        &tauri::Url::parse(candidate).unwrap(),
                        &config,
                        windows
                    ),
                    candidate == trusted,
                    "{trusted} must only admit its own origin: {candidate}"
                );
            }
        }
        let mut missing_main = app_config();
        missing_main.app.windows.clear();
        assert!(!crate::browser_workspace::caller_allowed_for_config(
            "main",
            &tauri::Url::parse("http://tauri.localhost").unwrap(),
            &missing_main,
            true
        ));
    }

    #[test]
    fn remote_content_and_other_webviews_cannot_use_delivery_commands() {
        let mut packaged = app_config();
        packaged.build.dev_url = None;
        let development_config = app_config();
        for (label, url, development) in [
            ("browser", "tauri://localhost", false),
            ("main", "https://example.com", false),
            ("main", "tauri://localhost.evil", false),
            ("main", "http://127.0.0.1:1420", false),
            ("main", "http://127.0.0.1:1421", true),
            ("main", "tauri://user@localhost", false),
        ] {
            let config = if development {
                &development_config
            } else {
                &packaged
            };
            assert!(!crate::browser_workspace::caller_allowed_for_config(
                label,
                &tauri::Url::parse(url).unwrap(),
                config,
                false
            ));
        }
        assert!(crate::browser_workspace::caller_allowed_for_config(
            "main",
            &tauri::Url::parse("tauri://localhost/index.html").unwrap(),
            &packaged,
            false
        ));
        assert_eq!(
            crate::browser_workspace::caller_allowed_for_config(
                "main",
                &tauri::Url::parse("http://127.0.0.1:1420").unwrap(),
                &development_config,
                false
            ),
            cfg!(debug_assertions)
        );
    }

    #[test]
    fn automatic_system_open_is_limited_to_document_types() {
        assert!(document_extension(Path::new("report.PDF")));
        assert!(document_extension(Path::new("game.html")));
        assert!(document_extension(Path::new("game.HTM")));
        for path in [
            "run.command",
            "setup.sh",
            "unknown",
            "macro.docm",
            "run.app",
        ] {
            assert!(!document_extension(Path::new(path)));
        }
    }
    #[tokio::test]
    async fn export_admission_blocks_writes_during_exclusive_maintenance() {
        let gate = crate::managed_update::UpdateAdmission::default();
        let exclusive = gate.update().unwrap();
        let called = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = called.clone();
        let result = run_text_export(
            || gate.activity(),
            move || {
                observed.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
        assert!(result.is_err());
        assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
        drop(exclusive);
    }

    #[tokio::test]
    async fn export_admission_remains_owned_by_blocking_writer_after_waiter_drop() {
        use std::sync::{Arc, mpsc};
        use std::time::Duration;
        let gate = Arc::new(crate::managed_update::UpdateAdmission::default());
        let worker_gate = gate.clone();
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("export.txt");
        let target = destination.clone();
        let (entered, started) = tokio::sync::oneshot::channel();
        let (release, released) = mpsc::channel();
        let (finished, completion) = tokio::sync::oneshot::channel();
        let waiter = tokio::spawn(async move {
            run_text_export(
                || worker_gate.activity(),
                move || {
                    let _ = entered.send(());
                    released.recv_timeout(Duration::from_secs(5)).unwrap();
                    let result = file_delivery::export_text("controlled export", &target);
                    let _ = finished.send(result.is_ok());
                    result
                },
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), started)
            .await
            .unwrap()
            .unwrap();
        let held_before = gate.update().is_err();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        let held_after = gate.update().is_err();
        release.send(()).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(5), completion)
                .await
                .unwrap()
                .unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(destination).unwrap(),
            "controlled export"
        );
        assert!(
            held_before,
            "actual export must hold admission while writing"
        );
        assert!(
            held_after,
            "dropping the IPC waiter cannot release an active writer"
        );
    }

    #[tokio::test]
    async fn export_admission_releases_on_success_error_and_worker_panic() {
        let gate = crate::managed_update::UpdateAdmission::default();
        assert_eq!(
            run_text_export(|| gate.activity(), || Ok(42))
                .await
                .unwrap(),
            42
        );
        assert!(gate.update().is_ok());
        assert_eq!(
            run_text_export(
                || gate.activity(),
                || Err::<(), _>(DeliveryError::AlreadyExists)
            )
            .await
            .unwrap_err(),
            display_error(DeliveryError::AlreadyExists)
        );
        assert!(gate.update().is_ok());
        let failed = run_text_export(
            || gate.activity(),
            || -> Result<(), DeliveryError> { panic!("controlled worker failure") },
        )
        .await;
        assert_eq!(
            failed.unwrap_err(),
            display_error(DeliveryError::Unavailable)
        );
        assert!(gate.update().is_ok());
    }
}
