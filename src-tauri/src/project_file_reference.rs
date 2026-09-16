use crate::{
    host_ids::{FarfoldSessionId, NativeSessionId},
    host_store::HostStore,
    session_controller::{HostSessionController, require_session_target},
};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFileReferenceInput {
    farfold_session_id: FarfoldSessionId,
    native_session_id: NativeSessionId,
    paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevealProjectFileInput {
    farfold_session_id: FarfoldSessionId,
    native_session_id: NativeSessionId,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenProjectFileInput {
    farfold_session_id: FarfoldSessionId,
    native_session_id: NativeSessionId,
    path: String,
}

fn resolve_project_file(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let resolved = path.canonicalize().map_err(|_| "文件不存在或无法访问")?;
    if !resolved.is_file() {
        return Err("只能定位普通文件，不能定位目录或设备".into());
    }
    if !resolved.starts_with(root) {
        return Err("文件不在当前 Working Copy 内".into());
    }
    Ok(resolved)
}

fn result_file(root: &Path, path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.len() > 16 * 1024 || path.chars().any(char::is_control) {
        return Err("无效的项目文件路径".into());
    }
    let root = root.canonicalize().map_err(|_| "无法核对会话工作目录")?;
    if !root.is_dir() {
        return Err("会话工作目录不可用".into());
    }
    let candidate = root.join(path);
    // Prefer an actual filename (including a literal ':2') over a source-line suffix.
    // Only strip :line[:column] when the original path does not exist at all.
    let candidate = if std::fs::symlink_metadata(&candidate)
        .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
    {
        let mut base = path;
        for _ in 0..2 {
            let Some((prefix, suffix)) = base.rsplit_once(':') else {
                break;
            };
            if suffix.is_empty() || !suffix.bytes().all(|v| v.is_ascii_digit()) {
                break;
            }
            base = prefix;
            if std::fs::symlink_metadata(root.join(base)).is_ok() {
                break;
            }
        }
        if base.is_empty() {
            return Err("无效的项目文件路径".into());
        }
        root.join(base)
    } else {
        candidate
    };
    resolve_project_file(&root, &candidate)
}

#[tauri::command]
pub async fn host_reveal_project_file(
    app: AppHandle,
    input: RevealProjectFileInput,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<HostSessionController>().exclusive(|| {
            let target = app
                .state::<HostStore>()
                .session_open_target(&input.farfold_session_id)?;
            require_session_target(target.project_blockers())?;
            if target.native_session_id != input.native_session_id {
                return Err("文件链接与原生会话身份不匹配".into());
            }
            let path = result_file(Path::new(&target.working_copy_path), &input.path)?;
            app.opener()
                .reveal_item_in_dir(path)
                .map_err(|e| format!("无法在访达中显示文件：{e}"))
        })
    })
    .await
    .map_err(|_| "文件定位被中断".to_string())?
}

#[tauri::command]
pub async fn host_open_project_file(
    app: AppHandle,
    input: OpenProjectFileInput,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<HostSessionController>().exclusive(|| {
            let target = app
                .state::<HostStore>()
                .session_open_target(&input.farfold_session_id)?;
            require_session_target(target.project_blockers())?;
            if target.native_session_id != input.native_session_id {
                return Err("文件链接与原生会话身份不匹配".into());
            }
            let path = result_file(Path::new(&target.working_copy_path), &input.path)?;
            let path = path
                .to_str()
                .ok_or_else(|| "文件路径不是有效 UTF-8".to_string())?;
            app.opener()
                .open_path(path, None::<&str>)
                .map_err(|e| format!("无法打开文件：{e}"))
        })
    })
    .await
    .map_err(|_| "文件打开被中断".to_string())?
}

// This prepares visible path text only. It neither reads file contents nor grants
// the Runtime file access. The Runtime still owns reading and permission checks.
fn project_paths(root: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() || paths.len() > 16 {
        return Err("每次请选择 1–16 个项目文件".into());
    }
    let root = root.canonicalize().map_err(|_| "无法核对会话工作目录")?;
    if !root.is_dir() {
        return Err("会话工作目录不可用".into());
    }
    let mut references = Vec::new();
    for path in paths {
        if path.len() > 16 * 1024 || !Path::new(path).is_absolute() {
            return Err("请选择有效的本地项目文件".into());
        }
        let resolved = resolve_project_file(&root, Path::new(path))?;
        let relative = resolved
            .strip_prefix(&root)
            .map_err(|_| "所选文件不在当前 Working Copy 内；草稿已保留")?
            .to_str()
            .ok_or("文件路径不是有效 UTF-8")?;
        let reference = format!("./{relative}");
        if !references.contains(&reference) {
            references.push(reference);
        }
    }
    Ok(references)
}

#[tauri::command]
pub async fn host_project_file_references(
    app: AppHandle,
    input: ProjectFileReferenceInput,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<HostSessionController>().exclusive(|| {
            let target = app
                .state::<HostStore>()
                .session_open_target(&input.farfold_session_id)?;
            require_session_target(target.project_blockers())?;
            if target.native_session_id != input.native_session_id {
                return Err("文件引用与当前原生会话身份不匹配".into());
            }
            project_paths(Path::new(&target.working_copy_path), &input.paths)
        })
    })
    .await
    .map_err(|_| "文件引用核对被中断；草稿已保留".to_string())?
}

#[cfg(test)]
mod tests {
    use super::{project_paths, result_file};
    use std::{fs, os::unix::fs::symlink};

    #[test]
    fn result_links_resolve_local_lines_and_reject_missing_or_escaping_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Project Files");
        fs::create_dir(&root).unwrap();
        let file = root.join("报告.md");
        fs::write(&file, "42").unwrap();
        let colon = root.join("报告.md:12");
        fs::write(&colon, "literal name").unwrap();
        let outside = temp.path().join("outside.md");
        fs::write(&outside, "protected").unwrap();
        symlink(&outside, root.join("escape.md")).unwrap();
        symlink(&file, root.join("alias.md")).unwrap();
        for path in ["./报告.md", "报告.md:1", "报告.md:2:3", "alias.md#unused"] {
            if path.ends_with("#unused") {
                assert!(result_file(&root, path).is_err());
            } else {
                assert_eq!(
                    result_file(&root, path).unwrap(),
                    file.canonicalize().unwrap()
                );
            }
        }
        assert_eq!(
            result_file(&root, file.to_str().unwrap()).unwrap(),
            file.canonicalize().unwrap()
        );
        for path in ["报告.md:12", "报告.md:12:4"] {
            assert_eq!(
                result_file(&root, path).unwrap(),
                colon.canonicalize().unwrap()
            );
        }
        for path in [
            "../outside.md",
            "escape.md",
            "escape.md:1",
            "missing.md",
            ".",
            "",
            "报告.md\n",
            outside.to_str().unwrap(),
        ] {
            assert!(result_file(&root, path).is_err(), "{path}");
        }
        assert_eq!(fs::read_to_string(outside).unwrap(), "protected");
    }

    #[test]
    fn references_reject_escape_missing_and_non_file_without_partial_results() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        let inside = root.join("资料 \"one\".md");
        fs::write(&inside, "fixture").unwrap();
        let outside = temp.path().join("outside.txt");
        fs::write(&outside, "outside").unwrap();
        let escaped = root.join("escaped");
        symlink(&outside, &escaped).unwrap();
        let alias = root.join("alias");
        symlink(&inside, &alias).unwrap();
        let path = |p: &std::path::Path| p.to_str().unwrap().to_string();
        assert_eq!(
            project_paths(&root, &[path(&inside), path(&alias)]).unwrap(),
            vec!["./资料 \"one\".md"]
        );
        for invalid in [&outside, &escaped, &root, &root.join("missing")] {
            assert!(project_paths(&root, &[path(&inside), path(invalid)]).is_err());
        }
        assert!(project_paths(&root, &["../outside.txt".into()]).is_err());
        assert!(project_paths(&root, &[]).is_err());
        assert!(project_paths(&root, &vec![path(&inside); 17]).is_err());
        assert_eq!(fs::read_to_string(inside).unwrap(), "fixture");
        assert_eq!(fs::read_to_string(outside).unwrap(), "outside");
    }
}
