//! User-triggered delivery commands; remote browser content has no access.
use std::path::Path;
use tauri::Webview;

use crate::file_delivery::{self, DeliveryError, DeliveryReceipt, TextPreview, VerifiedFile};

fn allowed_caller(label: &str, url: &tauri::Url, development: bool) -> bool {
    if label != "main" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    (url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
        || (development && url.origin().ascii_serialization() == "http://127.0.0.1:1420")
}

fn require_main(webview: &Webview) -> Result<(), String> {
    let url = webview.url().map_err(|_| "请从主界面操作文件".to_owned())?;
    if allowed_caller(webview.label(), &url, cfg!(debug_assertions)) {
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
    tauri::async_runtime::spawn_blocking(move || {
        file_delivery::inspect(Path::new(&root), Path::new(&path))
    })
    .await
    .map_err(|_| display_error(DeliveryError::Unavailable))?
    .map_err(display_error)
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
    tauri::async_runtime::spawn_blocking(move || {
        let selected = Path::new(&path);
        let parent = selected.parent().ok_or(DeliveryError::InvalidPath)?;
        file_delivery::inspect(parent, selected)
    })
    .await
    .map_err(|_| display_error(DeliveryError::Unavailable))?
    .map_err(display_error)
}

#[tauri::command]
pub async fn file_delivery_read_text(
    webview: Webview,
    file: VerifiedFile,
) -> Result<TextPreview, String> {
    require_main(&webview)?;
    tauri::async_runtime::spawn_blocking(move || file_delivery::read_text(&file))
        .await
        .map_err(|_| display_error(DeliveryError::Unavailable))?
        .map_err(display_error)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_content_and_other_webviews_cannot_use_delivery_commands() {
        for (label, url, development) in [
            ("browser", "tauri://localhost", false),
            ("main", "https://example.com", false),
            ("main", "tauri://localhost.evil", false),
            ("main", "http://127.0.0.1:1420", false),
            ("main", "http://127.0.0.1:1421", true),
            ("main", "tauri://user@localhost", false),
        ] {
            assert!(!allowed_caller(
                label,
                &tauri::Url::parse(url).unwrap(),
                development
            ));
        }
        assert!(allowed_caller(
            "main",
            &tauri::Url::parse("tauri://localhost/index.html").unwrap(),
            false
        ));
        assert!(allowed_caller(
            "main",
            &tauri::Url::parse("http://127.0.0.1:1420").unwrap(),
            true
        ));
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
