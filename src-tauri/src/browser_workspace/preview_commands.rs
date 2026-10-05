//! The main view selects an explicit local source. A project path is never an
//! ambient WebKit filesystem permission, and a server is never auto-discovered.
use super::{
    Bounds, BrowserInfo, BrowserWorkspace, close_owned,
    local_html::StoragePartition,
    local_preview::{DevServerOrigin, DirectoryPreview},
    native, policy, publish, require_main,
};
use std::path::Path;
use tauri::{AppHandle, State, Url, Webview};

#[derive(Clone)]
pub(super) enum PreviewSource {
    Directory(DirectoryPreview),
    Development(DevServerOrigin),
}
impl PreviewSource {
    pub(super) fn revoke(&self) {
        match self {
            Self::Directory(p) => p.revoke(),
            Self::Development(p) => p.revoke(),
        }
    }
}

impl super::Active {
    pub(super) fn shareable(&self) -> bool {
        self.info.local_file_name.is_none() || self.preview.is_some()
    }

    pub(super) fn allowed_url(&self, raw: &str) -> Option<Url> {
        match &self.preview {
            Some(PreviewSource::Directory(_)) => {
                let url = Url::parse(raw).ok()?;
                (url.scheme() == self.origin.scheme()
                    && url.host_str() == self.origin.host_str()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.port().is_none()
                    && url.query().is_none())
                .then_some(url)
            }
            Some(PreviewSource::Development(origin)) => origin
                .allows_navigation(raw)
                .then(|| Url::parse(raw).ok())
                .flatten(),
            None if self.info.local_file_name.is_some() => {
                (raw == self.origin.as_str()).then(|| self.origin.clone())
            }
            None => policy::validate_public_url(raw)
                .ok()
                .filter(|url| policy::same_origin(url, &self.origin)),
        }
    }
}

#[tauri::command]
pub(crate) async fn browser_workspace_open_directory(
    webview: Webview,
    app: AppHandle,
    state: State<'_, BrowserWorkspace>,
    task_key: String,
    project_directory: String,
    entry: String,
    bounds: Bounds,
) -> Result<BrowserInfo, String> {
    require_main(&webview)?;
    bounds.validate()?;
    policy::validate_task_key(&task_key)?;
    // The UI explains that this explicit action allows web resources within the
    // chosen task directory. Neither an Agent nor page JS chooses another root.
    let name = Path::new(&entry)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("请选择HTML入口文件")?
        .to_owned();
    let preview = tauri::async_runtime::spawn_blocking(move || {
        DirectoryPreview::select(Path::new(&project_directory), Path::new(&entry))
    })
    .await
    .map_err(|_| "网页资源无法读取")??;
    let _operation = state.1.lock().await;
    if let Some(old) = state.active_info()? {
        close_owned(&app, &state, &old.task_key, &old.label).await?;
    }
    let (id, _, _) = state.reserve(
        &task_key,
        Url::parse("https://preview.invalid/").expect("fixed temporary URL"),
    )?;
    let origin = Url::parse(&format!(
        "ff-preview://preview-{}{}",
        preview.storage_identifier(),
        preview.entry_path()
    ))
    .map_err(|_| "网页入口无效")?;
    {
        let mut store = state.0.lock().map_err(|_| "网页状态暂时不可用")?;
        let active = store
            .active
            .as_mut()
            .filter(|a| a.id == id)
            .ok_or("网页已关闭")?;
        active.origin = origin.clone();
        active.local_storage = Some(StoragePartition {
            identifier: preview.storage_identifier().into(),
            origin: origin.clone(),
        });
        active.preview = Some(PreviewSource::Directory(preview.clone()));
        active.info.local_file_name = Some(name);
        active.info.preview_mode = Some("directory".into());
        active.info.local_storage_persistent = Some(native::persistent_html_supported());
        active.info.url = origin.to_string();
    }
    let shared = state.inner().clone();
    if native::create_directory(&app, shared.clone(), id, bounds, preview, origin)
        .await
        .is_err()
        && let Some(info) = shared.event(id, 1, 2, "")
    {
        publish(&app, info);
    }
    let info = shared.info(id)?;
    publish(&app, info.clone());
    Ok(info)
}

#[tauri::command]
pub(crate) async fn browser_workspace_open_development(
    webview: Webview,
    app: AppHandle,
    state: State<'_, BrowserWorkspace>,
    task_key: String,
    project_directory: String,
    url: String,
    bounds: Bounds,
) -> Result<BrowserInfo, String> {
    require_main(&webview)?;
    bounds.validate()?;
    policy::validate_task_key(&task_key)?;
    let origin = DevServerOrigin::select(Path::new(&project_directory), &url)?;
    let _operation = state.1.lock().await;
    if let Some(old) = state.active_info()? {
        close_owned(&app, &state, &old.task_key, &old.label).await?;
    }
    let (id, _, _) = state.reserve(&task_key, origin.start_url().clone())?;
    {
        let mut store = state.0.lock().map_err(|_| "网页状态暂时不可用")?;
        let active = store
            .active
            .as_mut()
            .filter(|a| a.id == id)
            .ok_or("网页已关闭")?;
        active.local_storage = None;
        active.preview = Some(PreviewSource::Development(origin.clone()));
        active.info.preview_mode = Some("development".into());
        active.info.local_storage_persistent = Some(false);
    }
    let shared = state.inner().clone();
    if native::create_development(&app, shared.clone(), id, bounds, origin)
        .await
        .is_err()
        && let Some(info) = shared.event(id, 1, 2, "")
    {
        publish(&app, info);
    }
    let info = shared.info(id)?;
    publish(&app, info.clone());
    Ok(info)
}
