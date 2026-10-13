//! Runtime-only page ownership and explicit selection. Hiding is not selection.
use super::*;
use std::future::Future;

#[derive(Clone, Default)]
pub(super) struct SelectionState {
    pub(super) label: Option<String>,
    pub(super) revision: u64,
    pub(super) switching: bool,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSelection {
    pub label: Option<String>,
    pub revision: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabs {
    pub task_key: String,
    pub pages: Vec<BrowserInfo>,
    pub selection: BrowserSelection,
}
pub(super) struct SelectionMove {
    task: String,
    revision: u64,
    target: Option<u64>,
    old: Option<(u64, String, PageReadLease)>,
}
impl Store {
    pub(super) fn selected_page(&self, page: &Active) -> bool {
        !self.shutting_down
            && !page.closing
            && !page.withdrawing
            && !page.creation_pending
            && self
                .selections
                .get(&page.info.task_key)
                .is_some_and(|selected| {
                    !selected.switching && selected.label.as_deref() == Some(&page.info.label)
                })
    }
}
impl BrowserWorkspace {
    pub(super) fn tabs(&self, task: &str) -> Result<BrowserTabs, String> {
        policy::validate_task_key(task)?;
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        let selected = store.selections.get(task).cloned().unwrap_or_default();
        Ok(BrowserTabs {
            task_key: task.into(),
            pages: store
                .pages
                .values()
                .filter(|p| p.info.task_key == task)
                .map(|p| p.info.clone())
                .collect(),
            selection: BrowserSelection {
                label: selected.label,
                revision: selected.revision,
            },
        })
    }
    pub(super) fn begin_select(
        &self,
        task: &str,
        label: Option<&str>,
        expected: &BrowserSelection,
    ) -> Result<Option<SelectionMove>, String> {
        policy::validate_task_key(task)?;
        let mut store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        if store.shutting_down {
            return Err("应用页面正在关闭，请重新打开后再试".into());
        }
        let selected = store.selections.get(task).cloned().unwrap_or_default();
        if selected.switching
            || selected.label != expected.label
            || selected.revision != expected.revision
        {
            return Err("网页选择已变化，请查看当前标签后重试".into());
        }
        let target = label
            .map(|label| {
                store
                    .pages
                    .values()
                    .find(|p| p.info.task_key == task && p.info.label == label && !p.closing)
                    .map(|p| p.id)
                    .ok_or_else(|| "要打开的网页标签已变化".to_string())
            })
            .transpose()?;
        let old_id = selected.label.as_ref().and_then(|label| {
            store
                .pages
                .values()
                .find(|p| p.info.task_key == task && &p.info.label == label)
                .map(|p| p.id)
        });
        if old_id.is_some_and(|id| store.pages[&id].closing) {
            return Err("原网页正在关闭，请等待确认或重试关闭".into());
        }
        if selected.label.as_deref() == label
            && old_id.is_none_or(|id| {
                !store.pages[&id].withdrawing && store.presentation_uncertain != Some(id)
            })
        {
            return Ok(None);
        }
        let revision = selected.revision.checked_add(1).ok_or("请重开应用后再试")?;
        // Invalidate UI actions not yet admitted (for example a delayed share
        // approval after A-B-A), independently of native navigation callbacks.
        let old_revision = old_id
            .map(|id| {
                store.pages[&id]
                    .info
                    .revision
                    .checked_add(1)
                    .ok_or("请重开应用后再试")
            })
            .transpose()?;
        store.selections.insert(
            task.into(),
            SelectionState {
                label: selected.label,
                revision,
                switching: true,
            },
        );
        let old = old_id.map(|id| {
            let page = store.pages.get_mut(&id).expect("owned old page");
            page.withdrawing = true;
            page.info.revision = old_revision.expect("owned old page revision");
            (id, page.info.label.clone(), page.read_gate.clone())
        });
        Ok(Some(SelectionMove {
            task: task.into(),
            revision,
            target,
            old,
        }))
    }
    fn selection_failed(&self, movement: &SelectionMove) {
        let Ok(mut store) = self.0.lock() else { return };
        if let Some(selected) = store.selections.get_mut(&movement.task)
            && selected.revision == movement.revision
        {
            selected.switching = false;
        }
        if let Some((id, _, _)) = &movement.old
            && let Some(page) = store.pages.get_mut(id)
        {
            page.info.error = Some("网页切换尚未确认，请重试或关闭原网页".into());
            page.info.revision = page.info.revision.saturating_add(1);
        }
    }
    fn finish_select(&self, movement: &SelectionMove) -> Result<BrowserTabs, String> {
        {
            let mut store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
            if store.shutting_down
                || !store
                    .selections
                    .get(&movement.task)
                    .is_some_and(|s| s.switching && s.revision == movement.revision)
            {
                return Err("网页选择已变化，请重新打开".into());
            }
            let label = if let Some(id) = movement.target {
                let page = store
                    .pages
                    .get_mut(&id)
                    .filter(|p| p.info.task_key == movement.task && !p.closing)
                    .ok_or("网页已关闭")?;
                if page.withdrawing {
                    page.read_gate = PageReadLease::new();
                }
                page.withdrawing = false;
                // Only the selection error is cleared; loading/network errors remain.
                if page.info.error.as_deref() == Some("网页切换尚未确认，请重试或关闭原网页")
                {
                    page.info.error = None;
                }
                Some(page.info.label.clone())
            } else {
                None
            };
            if let Some((id, _, _)) = &movement.old
                && let Some(old) = store.pages.get_mut(id)
                && old.info.error.as_deref() == Some("网页切换尚未确认，请重试或关闭原网页")
            {
                old.info.error = None;
                old.info.revision = old.info.revision.saturating_add(1);
            }
            let selected = store
                .selections
                .get_mut(&movement.task)
                .ok_or("网页已变化")?;
            selected.label = label;
            selected.switching = false;
        }
        self.tabs(&movement.task)
    }
    /// Production transaction, with actual stop/hide futures supplied by the IPC
    /// facade. Controlled tests drive these exact boundaries without a WebView.
    pub(super) async fn execute_selection<S, SF, H, HF>(
        &self,
        movement: SelectionMove,
        stop: S,
        hide: H,
    ) -> Result<BrowserTabs, String>
    where
        S: FnOnce(String, String) -> SF,
        SF: Future<Output = Result<(), String>>,
        H: FnOnce(u64) -> HF,
        HF: Future<Output = Result<(), String>>,
    {
        let result = async {
            if let Some((id, label, gate)) = &movement.old {
                gate.revoke();
                stop(movement.task.clone(), label.clone()).await?;
                self.visibility_start(*id, false)?;
                let hidden = hide(*id).await;
                self.visibility_finished(*id, false, hidden.is_ok());
                hidden?;
            }
            self.finish_select(&movement)
        }
        .await;
        if result.is_err() {
            self.selection_failed(&movement);
        }
        result
    }
    pub(super) fn visibility_start(&self, id: u64, visible: bool) -> Result<(), String> {
        let mut store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        let page = store
            .pages
            .get(&id)
            .filter(|p| !p.closing)
            .ok_or("网页正在关闭")?;
        if store.shutting_down {
            return Err("应用页面正在关闭".into());
        }
        if visible
            && (!store.selected_page(page)
                || store.pages.values().any(|p| p.creation_pending)
                || store.presentation_uncertain.is_some()
                || store.presented.is_some_and(|p| p != id))
        {
            return Err("请先确认原网页已隐藏，再显示当前标签".into());
        }
        // A different unknown surface must remain the owner of the barrier.
        if store.presentation_uncertain.is_some_and(|p| p != id) {
            return Err("原网页显示状态未确认，请先重试隐藏或关闭".into());
        }
        store.presentation_uncertain = Some(id);
        Ok(())
    }
    pub(super) fn can_present(&self, id: u64) -> bool {
        self.0.lock().is_ok_and(|s| {
            s.presentation_uncertain == Some(id)
                && !s.pages.values().any(|p| p.creation_pending)
                && s.presented.is_none_or(|p| p == id)
                && s.pages.get(&id).is_some_and(|p| s.selected_page(p))
        })
    }
    pub(super) fn visibility_finished(&self, id: u64, visible: bool, success: bool) {
        let Ok(mut store) = self.0.lock() else { return };
        if store.presentation_uncertain != Some(id) {
            return;
        }
        if success {
            store.presentation_uncertain = None;
            if !visible && let Some(page) = store.pages.get_mut(&id) {
                page.creation_pending = false;
            }
            if let Some(page) = store.pages.get_mut(&id)
                && page.info.error.as_deref() == Some("网页显示状态未确认，请重试隐藏或关闭")
            {
                page.info.error = None;
                page.info.revision = page.info.revision.saturating_add(1);
            }
            if visible {
                store.presented = Some(id);
            } else if store.presented == Some(id) {
                store.presented = None;
            }
        } else if let Some(page) = store.pages.get_mut(&id) {
            page.info.error = Some("网页显示状态未确认，请重试隐藏或关闭".into());
            page.info.revision = page.info.revision.saturating_add(1);
        }
    }
}

pub(super) fn publish_tabs(app: &AppHandle, task: &str) {
    let _ = app.emit_to(
        EventTarget::webview("main"),
        "browser-workspace:tabs-changed",
        serde_json::json!({"taskKey": task}),
    );
}
#[tauri::command]
pub(crate) fn browser_workspace_tabs(
    webview: Webview,
    state: State<'_, BrowserWorkspace>,
    task_key: String,
) -> Result<BrowserTabs, String> {
    require_main(&webview)?;
    state.tabs(&task_key)
}
#[tauri::command]
pub(crate) async fn browser_workspace_select(
    webview: Webview,
    app: AppHandle,
    state: State<'_, BrowserWorkspace>,
    task_key: String,
    label: Option<String>,
    expected_selected: BrowserSelection,
) -> Result<BrowserTabs, String> {
    require_main(&webview)?;
    let _operation = state.1.lock().await;
    let Some(movement) = state.begin_select(&task_key, label.as_deref(), &expected_selected)?
    else {
        return state.tabs(&task_key);
    };
    publish_tabs(&app, &task_key);
    let stop_app = app.clone();
    let result = state
        .execute_selection(
            movement,
            |task, label| async move {
                if let Some(sharing) =
                    stop_app.try_state::<crate::browser_sharing::BrowserSharing>()
                {
                    sharing.stop_page(&task, &label).await
                } else {
                    Ok(())
                }
            },
            |id| native::set_visible(&app, state.inner().clone(), id, false, None),
        )
        .await;
    if let Ok(tabs) = state.tabs(&task_key) {
        for page in tabs.pages {
            publish(&app, page);
        }
    }
    publish_tabs(&app, &task_key);
    result
}
pub(super) async fn set_visibility_owned(
    app: &AppHandle,
    state: &BrowserWorkspace,
    id: u64,
    visible: bool,
    bounds: Option<Bounds>,
) -> Result<(), String> {
    state.visibility_start(id, visible)?;
    let result = native::set_visible(app, state.clone(), id, visible, bounds).await;
    state.visibility_finished(id, visible, result.is_ok());
    if let Ok(info) = state.info(id) {
        publish(app, info);
    }
    result
}
