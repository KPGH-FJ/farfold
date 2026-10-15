//! Saving a location requires the actual selected page, never a claimed URL alone.
use super::*;
use crate::meta_store::MetaStore;
use crate::meta_store::remembered_pages::{PageOwner, RememberedPages};

impl BrowserWorkspace {
    fn with_confirmed_page<T>(
        &self,
        owner: &PageOwner,
        label: &str,
        revision: u64,
        confirmed_url: &str,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        policy::validate_public_url(confirmed_url)?;
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        let eligible = store.pages.values().any(|page| {
            store.selected_page(page)
                && page.info.task_key == owner.session_id
                && page.info.label == label
                && page.info.revision == revision
                && page.info.phase == "ready"
                && page.info.error.is_none()
                && page.info.url == confirmed_url
                && page.info.local_file_name.is_none()
                && page.local_storage.is_none()
                && page.preview.is_none()
                && store.presentation_uncertain.is_none()
        });
        if !eligible {
            return Err("网页已变化，请查看当前公开网页并重新确认".into());
        }
        // Keep page identity/navigation stable through the metadata commit.
        action()
    }

    async fn finish_reopen<C, F>(
        &self,
        info: BrowserInfo,
        owner_check: Result<(), String>,
        close: C,
    ) -> Result<BrowserInfo, String>
    where
        C: FnOnce(String, String) -> F,
        F: std::future::Future<Output = Result<(), String>>,
    {
        let Err(error) = owner_check else {
            return Ok(info);
        };
        match close(info.task_key.clone(), info.label.clone()).await {
            Ok(()) => Err(error),
            Err(_) => self.info(self.identity(&info.task_key, &info.label)?),
        }
    }
}

fn metadata(app: &AppHandle) -> Result<MetaStore, String> {
    app.try_state::<MetaStore>()
        .map(|store| store.inner().clone())
        .ok_or_else(|| "设置暂不可用，请稍后重试".into())
}

#[tauri::command]
pub(crate) async fn browser_pages_list(
    webview: Webview,
    app: AppHandle,
    owner: PageOwner,
) -> Result<RememberedPages, String> {
    require_main(&webview)?;
    metadata(&app)?
        .run(move |store| store.remembered_pages(&owner))
        .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Trusted caller/state plus exact confirmation fields.
pub(crate) async fn browser_pages_remember(
    webview: Webview,
    app: AppHandle,
    state: State<'_, BrowserWorkspace>,
    owner: PageOwner,
    expected_revision: u64,
    label: String,
    page_revision: u64,
    confirmed_url: String,
) -> Result<RememberedPages, String> {
    require_main(&webview)?;
    let _operation = state.1.lock().await;
    let pages = state.inner().clone();
    metadata(&app)?
        .run(move |store| {
            pages.with_confirmed_page(&owner, &label, page_revision, &confirmed_url, || {
                store.remember_page(&owner, expected_revision, &confirmed_url)
            })
        })
        .await
}

#[tauri::command]
pub(crate) async fn browser_pages_forget(
    webview: Webview,
    app: AppHandle,
    owner: PageOwner,
    expected_revision: u64,
    item_id: Option<String>,
) -> Result<RememberedPages, String> {
    require_main(&webview)?;
    metadata(&app)?
        .run(move |store| store.forget_page(&owner, expected_revision, item_id.as_deref()))
        .await
}

#[tauri::command]
pub(crate) async fn browser_pages_reopen(
    webview: Webview,
    app: AppHandle,
    state: State<'_, BrowserWorkspace>,
    owner: PageOwner,
    expected_revision: u64,
    item_id: String,
    bounds: Bounds,
) -> Result<BrowserInfo, String> {
    require_main(&webview)?;
    bounds.validate()?;
    let _operation = state.1.lock().await;
    let saved = metadata(&app)?;
    let lookup_owner = owner.clone();
    let url = saved
        .run(move |store| store.remembered_page_url(&lookup_owner, expected_revision, &item_id))
        .await?;
    let url = policy::validate_public_url(&url)?;
    let info = open_public_owned(&app, &state, &owner.session_id, url, bounds).await?;
    let check_owner = owner.clone();
    let owner_check = saved
        .run(move |store| store.verify_page_owner(&check_owner))
        .await;
    // Do not abandon a possibly created native view on a late owner deletion.
    // A missing close ACK returns its real identity for the existing Scope.
    state
        .finish_reopen(info, owner_check, |task, label| {
            let app = app.clone();
            let state = state.inner().clone();
            async move { close_owned(&app, &state, &task, &label).await }
        })
        .await
}

#[cfg(test)]
#[path = "remembered_pages_tests.rs"]
mod tests;
