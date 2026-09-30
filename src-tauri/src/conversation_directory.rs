//! Stable working location for conversations without a user-selected folder.
//! This is a working directory only; the Agent keeps its existing HOME/config.

use std::path::{Path, PathBuf};

use tauri::Manager;

fn prepare_directory(app_data: &Path) -> Result<PathBuf, String> {
    let path = app_data.join("conversations");
    std::fs::create_dir_all(&path).map_err(|_| "无法准备对话文件夹，请重试".to_string())?;
    let canonical = path
        .canonicalize()
        .map_err(|_| "无法读取对话文件夹，请重试".to_string())?;
    let app_data = app_data
        .canonicalize()
        .map_err(|_| "无法读取应用文件夹，请重试".to_string())?;
    if canonical != app_data.join("conversations") {
        return Err("对话文件夹位置已变化，请检查应用文件夹".into());
    }
    Ok(canonical)
}

#[tauri::command]
pub async fn app_default_working_directory(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法读取应用文件夹")?;
    tauri::async_runtime::spawn_blocking(move || {
        prepare_directory(&app_data).map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| "无法准备对话文件夹，请重试".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_directory_is_stable_and_preserves_existing_content() {
        let root = tempfile::tempdir().unwrap();
        let first = prepare_directory(root.path()).unwrap();
        std::fs::write(first.join("user-file"), "keep").unwrap();
        assert_eq!(prepare_directory(root.path()).unwrap(), first);
        assert_eq!(
            std::fs::read_to_string(first.join("user-file")).unwrap(),
            "keep"
        );
        assert_eq!(first.file_name().unwrap(), "conversations");
    }

    #[cfg(unix)]
    #[test]
    fn default_directory_does_not_follow_an_external_folder() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(external.path(), root.path().join("conversations")).unwrap();
        assert!(prepare_directory(root.path()).is_err());
    }
}
