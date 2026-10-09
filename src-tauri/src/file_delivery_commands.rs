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
pub async fn file_delivery_read_text(
    webview: Webview,
    file: VerifiedFile,
) -> Result<TextPreview, String> {
    require_main(&webview)?;
    crate::file_read_check::run(move || file_delivery::read_text(&file).map_err(display_error))
        .await
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
pub async fn file_delivery_copy(
    webview: Webview,
    file: VerifiedFile,
    destination: String,
) -> Result<DeliveryReceipt, String> {
    require_main(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        file_delivery::copy(&file, Path::new(&destination))
    })
    .await
    .map_err(|_| display_error(DeliveryError::Unavailable))?
    .map_err(display_error)
}

#[tauri::command]
pub async fn file_delivery_export_text(
    webview: Webview,
    text: String,
    destination: String,
) -> Result<DeliveryReceipt, String> {
    require_main(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        file_delivery::export_text(&text, Path::new(&destination))
    })
    .await
    .map_err(|_| display_error(DeliveryError::Unavailable))?
    .map_err(display_error)
}

fn document_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some(
            "txt"
                | "html"
                | "htm"
                | "md"
                | "markdown"
                | "mdown"
                | "pdf"
                | "png"
                | "jpg"
                | "jpeg"
                | "gif"
                | "webp"
                | "docx"
                | "xlsx"
                | "pptx"
                | "csv"
        )
    )
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
}
