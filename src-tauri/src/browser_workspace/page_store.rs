use super::*;

impl BrowserWorkspace {
    pub(super) fn reserve(
        &self,
        task: &str,
        url: Url,
    ) -> Result<(u64, Option<u64>, BrowserInfo), String> {
        self.reserve_page(task, url, None, None)
    }

    pub(super) fn reserve_html(
        &self,
        task: &str,
        name: String,
        storage: local_html::StoragePartition,
    ) -> Result<(u64, Option<u64>, BrowserInfo), String> {
        self.reserve_page(task, storage.origin.clone(), Some(name), Some(storage))
    }

    pub(super) fn reserve_page(
        &self,
        task: &str,
        url: Url,
        local_file_name: Option<String>,
        local_storage: Option<local_html::StoragePartition>,
    ) -> Result<(u64, Option<u64>, BrowserInfo), String> {
        policy::validate_task_key(task)?;
        let mut store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        if store.shutting_down {
            return Err("应用页面正在关闭，请重新打开后再试".into());
        }
        store.next = store.next.checked_add(1).ok_or("请重开应用后再试")?;
        let id = store.next;
        let old = None;
        let info = BrowserInfo {
            task_key: task.into(),
            label: if local_file_name.is_some() {
                format!("local-html-{id}")
            } else {
                format!("public-page-{id}")
            },
            url: local_file_name.clone().unwrap_or_else(|| url.to_string()),
            local_storage_persistent: local_storage
                .as_ref()
                .map(|_| native::persistent_html_supported()),
            local_file_name,
            preview_mode: None,
            phase: "loading".into(),
            revision: 1,
            error: None,
        };
        store.selections.entry(task.into()).or_default();
        store.pages.insert(
            id,
            Active {
                id,
                info: info.clone(),
                origin: url,
                local_storage,
                preview: None,
                navigation: 1,
                closing: false,
                withdrawing: false,
                creation_pending: true,
                read_gate: PageReadLease::new(),
            },
        );
        Ok((id, old, info))
    }

    /// Only an acknowledged hidden creation clears this barrier. A timeout may
    /// leave a native surface, so its owner must still be hidden or closed.
    pub(super) fn creation_confirmed(&self, id: u64) -> Result<(), String> {
        let mut store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        if store.shutting_down {
            return Err("应用页面正在关闭".into());
        }
        let page = store
            .pages
            .get_mut(&id)
            .filter(|p| !p.closing)
            .ok_or("网页已关闭")?;
        page.creation_pending = false;
        Ok(())
    }

    pub(super) fn info(&self, id: u64) -> Result<BrowserInfo, String> {
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        Ok(store
            .pages
            .get(&id)
            .ok_or("网页已关闭或已更换")?
            .info
            .clone())
    }

    /// Permission requests capture only safe metadata for this exact ready page.
    pub(crate) fn permission_page(&self, task: &str) -> Result<BrowserInfo, String> {
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        store
            .pages
            .values()
            .find(|page| {
                store.selected_page(page)
                    && page.info.task_key == task
                    && page.info.phase == "ready"
                    && page.shareable()
            })
            .map(|page| page.info.clone())
            .ok_or_else(|| "请先打开此对话的公开网页".into())
    }

    pub(super) fn identity(&self, task: &str, label: &str) -> Result<u64, String> {
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        store
            .pages
            .values()
            .find(|page| page.info.task_key == task && page.info.label == label)
            .map(|page| page.id)
            .ok_or_else(|| "网页已关闭或已更换，请重新打开".into())
    }

    pub(super) fn local_storage(
        &self,
        task: &str,
        label: &str,
    ) -> Result<local_html::StoragePartition, String> {
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        let page = store
            .pages
            .values()
            .find(|page| !page.closing && page.info.task_key == task && page.info.label == label)
            .ok_or("请先打开要清除存档的本地网页")?;
        let storage = page
            .local_storage
            .clone()
            .ok_or("请先打开要清除存档的本地网页")?;
        if store.pages.values().any(|other| {
            other.id != page.id
                && other
                    .local_storage
                    .as_ref()
                    .is_some_and(|s| s.identifier == storage.identifier)
        }) {
            return Err("此文件还有其他网页标签，请先关闭后再清除存档".into());
        }
        Ok(storage)
    }

    pub(super) fn navigate(&self, id: u64, url: Url) -> Result<BrowserInfo, String> {
        let mut store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        let active = store.pages.get_mut(&id).ok_or("网页已关闭或已更换")?;
        if active.closing {
            return Err("网页正在关闭，请重试关闭后再打开".into());
        }
        if active.preview.is_some() {
            if active.allowed_url(url.as_str()).is_none() {
                return Err("此跳转不在已选择的网页范围内".into());
            }
        } else if active.info.local_file_name.is_some() {
            return Err("本地网页不能跳转到网站，请关闭后从网页入口打开".into());
        }
        // Only this explicit user command may authorize a different origin.
        if active.preview.is_none() {
            active.origin = url.clone();
        }
        active.navigation += 1;
        active.info.revision += 1;
        active.info.url = url.to_string();
        active.info.phase = "loading".into();
        active.info.error = None;
        Ok(active.info.clone())
    }

    pub(super) fn is_preview(&self, id: u64) -> bool {
        self.0
            .lock()
            .is_ok_and(|s| s.pages.get(&id).is_some_and(|a| a.preview.is_some()))
    }

    pub(super) fn can_operate(&self, id: u64, navigation: Option<u64>) -> bool {
        self.0.lock().ok().is_some_and(|store| {
            !store.shutting_down
                && store
                    .pages
                    .get(&id)
                    .is_some_and(|a| !a.closing && navigation.is_none_or(|n| n == a.navigation))
        })
    }

    pub(super) fn manual_activity(&self, id: u64) -> Option<(u64, BrowserInfo)> {
        let mut store = self.0.lock().ok()?;
        let active = store
            .pages
            .get_mut(&id)
            .filter(|a| !a.closing && a.info.phase == "ready")?;
        active.navigation = active.navigation.checked_add(1)?;
        active.info.revision = active.info.revision.checked_add(1)?;
        Some((active.navigation, active.info.clone()))
    }

    pub(super) fn navigation(&self, id: u64) -> Result<u64, String> {
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        Ok(store
            .pages
            .get(&id)
            .filter(|a| !a.closing)
            .ok_or("网页已关闭或正在关闭")?
            .navigation)
    }

    pub(super) fn policy(&self, id: u64, text: &str) -> bool {
        let Ok(store) = self.0.lock() else {
            return false;
        };
        let Some(active) = store.pages.get(&id).filter(|a| !a.closing) else {
            return false;
        };
        if active.preview.is_some() {
            return active.allowed_url(text).is_some();
        }
        if active.info.local_file_name.is_some() {
            // Only the exact initial in-memory load is admitted. No local path,
            // subframe or later same-origin navigation acquires a file grant.
            return active.info.phase == "loading" && text == active.origin.as_str();
        }
        policy::validate_public_url(text).is_ok_and(|url| policy::same_origin(&active.origin, &url))
    }

    // A link is claimed BEFORE native loadRequest; didStart never invents a token.
    pub(super) fn link_navigation(&self, id: u64, text: &str) -> Option<(u64, BrowserInfo)> {
        let mut store = self.0.lock().ok()?;
        let a = store.pages.get_mut(&id).filter(|a| !a.closing)?;
        if !a.shareable() {
            return None;
        }
        let url = a.allowed_url(text)?;
        a.navigation = a.navigation.checked_add(1)?;
        a.info.revision += 1;
        a.info.url = url.to_string();
        a.info.phase = "loading".into();
        a.info.error = None;
        Some((a.navigation, a.info.clone()))
    }

    pub(super) fn event(
        &self,
        id: u64,
        navigation: u64,
        kind: i32,
        raw_url: &str,
    ) -> Option<BrowserInfo> {
        let mut store = self.0.lock().ok()?;
        let active = store
            .pages
            .get_mut(&id)
            .filter(|a| !a.closing && a.navigation == navigation)?;
        // Navigation terminal callbacks cannot revive ready/blocked/error states.
        if matches!(kind, 0..=2) && active.info.phase != "loading" {
            return None;
        }
        match kind {
            0 => {}
            1 => {
                let valid = active.allowed_url(raw_url);
                if let Some(url) = valid {
                    if active.shareable() {
                        active.info.url = url.to_string();
                    }
                    active.info.phase = "ready".into();
                    active.info.error = None;
                } else {
                    active.info.phase = "blocked".into();
                    active.info.error = Some("此页面未获准读取，请输入公开网页地址".into());
                }
            }
            2 | 5 => {
                active.info.phase = "error".into();
                active.info.error = Some("网页未能加载，请重新打开后再试".into());
            }
            3 => {
                active.info.phase = "blocked".into();
                active.info.error =
                    Some("此跳转未打开；请明确输入公开网页地址。脚本和表单跳转暂不支持".into());
            }
            _ => return None,
        }
        if active.withdrawing {
            active.info.error = Some("网页切换尚未确认，请重试或关闭原网页".into());
        }
        active.info.revision += 1;
        Some(active.info.clone())
    }

    pub(super) fn read_ticket(&self, task: &str, label: &str) -> Result<ReadTicket, String> {
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        let page = store
            .pages
            .values()
            .find(|page| {
                page.info.task_key == task
                    && page.info.label == label
                    && store.selected_page(page)
                    && page.info.phase == "ready"
                    && page.shareable()
            })
            .ok_or("请等待此对话选中的公开网页加载完成后再读取")?;
        Ok(ReadTicket {
            id: page.id,
            task_key: task.into(),
            label: label.into(),
            navigation: page.navigation,
            selection_revision: store.selections.get(task).ok_or("网页已变化")?.revision,
        })
    }

    pub(super) fn complete_read(
        &self,
        ticket: &ReadTicket,
        raw: &str,
    ) -> Result<PageSnapshot, String> {
        if raw.len() > 300_000 {
            return Err("网页返回内容过大".into());
        }
        let page: NativeSnapshot = serde_json::from_str(raw).map_err(|_| "未能读取网页内容")?;
        self.with_read_ticket(ticket, |active| {
            if page.blocked {
                return Err("页面含登录输入，已停止读取；请关闭并改用公开网页".into());
            }
            let url = active
                .allowed_url(&page.url)
                .ok_or("网页已变化，本次读取已取消")?;
            if page.title.chars().count() > 512 || page.text.chars().count() > 65_536 {
                return Err("网页返回内容过大".into());
            }
            Ok(PageSnapshot {
                task_key: ticket.task_key.clone(),
                label: ticket.label.clone(),
                url: url.to_string(),
                title: page.title,
                text: page.text,
                revision: active.info.revision,
                observed_at_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
                    .min(u64::MAX as u128) as u64,
            })
        })
    }

    pub(super) fn with_read_ticket<T>(
        &self,
        ticket: &ReadTicket,
        action: impl FnOnce(&Active) -> Result<T, String>,
    ) -> Result<T, String> {
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        let page = store
            .pages
            .get(&ticket.id)
            .filter(|page| {
                store.selected_page(page)
                    && page.info.task_key == ticket.task_key
                    && page.info.label == ticket.label
                    && page.navigation == ticket.navigation
                    && page.info.phase == "ready"
                    && page.shareable()
                    && store
                        .selections
                        .get(&ticket.task_key)
                        .is_some_and(|s| s.revision == ticket.selection_revision)
            })
            .ok_or("网页已变化，本次读取已取消，请重新读取")?;
        action(page)
    }

    pub(super) fn close(
        &self,
        task: &str,
        label: &str,
    ) -> Result<Option<(u64, BrowserInfo)>, String> {
        let (id, info, gate, preview) = {
            let mut store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
            let Some(id) = store
                .pages
                .values()
                .find(|p| p.info.task_key == task && p.info.label == label)
                .map(|p| p.id)
            else {
                return Ok(None);
            };
            let first = !store.pages[&id].closing;
            if first
                && let Some(selected) = store.selections.get_mut(task)
                && selected.label.as_deref() == Some(label)
            {
                selected.revision = selected.revision.checked_add(1).ok_or("请重开应用后再试")?;
                selected.switching = false;
            }
            let page = store.pages.get_mut(&id).ok_or("网页已关闭")?;
            page.closing = true;
            page.withdrawing = true;
            page.info.phase = "loading".into();
            page.info.revision += 1;
            page.info.error = None;
            (
                id,
                page.info.clone(),
                page.read_gate.clone(),
                page.preview.clone(),
            )
        };
        // Lease -> Store is the read lock order; never revoke while holding Store.
        gate.revoke();
        if let Some(preview) = preview {
            preview.revoke();
        }
        Ok(Some((id, info)))
    }

    pub(super) fn acknowledge_close(&self, id: u64) -> Option<BrowserInfo> {
        let mut store = self.0.lock().ok()?;
        if !store.pages.get(&id).is_some_and(|a| a.closing) {
            return None;
        }
        let mut page = store.pages.remove(&id)?;
        if let Some(selected) = store.selections.get_mut(&page.info.task_key)
            && selected.label.as_deref() == Some(&page.info.label)
        {
            selected.label = None;
            selected.switching = false;
        }
        if store.presented == Some(id) {
            store.presented = None;
        }
        if store.presentation_uncertain == Some(id) {
            store.presentation_uncertain = None;
        }
        page.info.phase = "closed".into();
        page.info.revision += 1;
        page.info.error = None;
        Some(page.info)
    }

    pub(super) fn close_failed(&self, id: u64) -> Option<BrowserInfo> {
        let mut store = self.0.lock().ok()?;
        let page = store.pages.get_mut(&id).filter(|a| a.closing)?;
        page.info.phase = "error".into();
        page.info.error = Some("网页关闭未确认，请重试关闭".into());
        page.info.revision += 1;
        Some(page.info.clone())
    }

    #[cfg(test)]
    pub(super) fn active_info(&self) -> Result<Option<BrowserInfo>, String> {
        Ok(self
            .0
            .lock()
            .map_err(|_| "网页状态暂时不可用")?
            .pages
            .values()
            .next()
            .map(|p| p.info.clone()))
    }

    pub(super) fn begin_shutdown(&self) {
        let retiring = {
            let mut store = self.0.lock().unwrap_or_else(|error| error.into_inner());
            store.shutting_down = true;
            store
                .pages
                .values_mut()
                .map(|page| {
                    page.closing = true;
                    page.withdrawing = true;
                    page.info.phase = "loading".into();
                    page.info.revision = page.info.revision.saturating_add(1);
                    (page.read_gate.clone(), page.preview.clone())
                })
                .collect::<Vec<_>>()
        };
        for (gate, preview) in retiring {
            gate.revoke();
            if let Some(preview) = preview {
                preview.revoke();
            }
        }
    }

    pub(super) fn acknowledge_shutdown(&self) {
        let mut store = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if store.shutting_down {
            store.pages.clear();
            store.selections.clear();
            store.presented = None;
            store.presentation_uncertain = None;
        }
    }
}
