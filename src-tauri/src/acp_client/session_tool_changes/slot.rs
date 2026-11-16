use super::{Change, ChangeError, Code, Item, Operation, Reply, State};
use serde_json::Value;
use std::{collections::HashSet, sync::Mutex};
use tokio::sync::Notify;

#[derive(Clone)]
pub(super) struct Reviewed {
    pub item: Item,
    pub key: String,
    pub descriptor: Value,
    pub inventory_digest: String,
}
#[derive(Default)]
struct Memory {
    operation: Option<(Change, Operation)>,
    used: HashSet<String>,
    targets: Vec<Reviewed>,
}
#[derive(Default)]
pub(crate) struct Slot {
    memory: Mutex<Memory>,
    changed: Notify,
}
impl Slot {
    pub(super) fn was_admitted(&self, id: &str) -> bool {
        self.memory
            .lock()
            .map(|m| m.used.contains(id))
            .unwrap_or(true)
    }
    pub(crate) fn busy(&self) -> bool {
        self.memory
            .lock()
            .map(|m| m.operation.as_ref().is_some_and(|(_, o)| !o.settled))
            .unwrap_or(true)
    }
    pub(super) fn items(&self) -> Result<Vec<Item>, ChangeError> {
        Ok(self
            .memory
            .lock()
            .map_err(|_| Code::Changed)?
            .targets
            .iter()
            .map(|o| o.item.clone())
            .collect())
    }
    pub(super) fn target(&self, item_ref: &str) -> Result<Reviewed, ChangeError> {
        self.memory
            .lock()
            .map_err(|_| Code::Changed)?
            .targets
            .iter()
            .find(|o| o.item.item_ref == item_ref)
            .cloned()
            .ok_or_else(|| Code::Changed.into())
    }
    pub(super) fn existing(
        &self,
        id: &str,
        change: &Change,
    ) -> Result<Option<Operation>, ChangeError> {
        let memory = self.memory.lock().map_err(|_| Code::Changed)?;
        if let Some((original, operation)) = &memory.operation {
            if operation.operation_id == id {
                return if original == change {
                    Ok(Some(operation.clone()))
                } else {
                    Err(Code::Changed.into())
                };
            }
            if !operation.settled || operation.state == State::Unknown {
                return Err(Code::Busy.into());
            }
        }
        if memory.used.contains(id) {
            return Err(Code::Changed.into());
        }
        Ok(None)
    }
    pub(super) fn admit(
        &self,
        change: Change,
        mut operation: Operation,
    ) -> Result<(), ChangeError> {
        let mut memory = self.memory.lock().map_err(|_| Code::Changed)?;
        if memory.used.len() >= 4096 {
            return Err(Code::Limit.into());
        }
        if !memory.used.insert(operation.operation_id.clone()) {
            return Err(Code::Changed.into());
        }
        operation.items = memory.targets.iter().map(|o| o.item.clone()).collect();
        memory.operation = Some((change, operation));
        Ok(())
    }
    pub(super) fn snapshot(&self, id: &str) -> Reply {
        self.memory
            .lock()
            .map_err(|_| Code::Changed)?
            .operation
            .as_ref()
            .filter(|(_, o)| o.operation_id == id)
            .map(|(_, o)| o.clone())
            .ok_or_else(|| Code::Changed.into())
    }
    pub(super) fn update(&self, id: &str, update: impl FnOnce(&mut Operation)) {
        if let Ok(mut memory) = self.memory.lock()
            && let Some((_, operation)) = memory
                .operation
                .as_mut()
                .filter(|(_, o)| o.operation_id == id)
        {
            update(operation);
        }
        self.changed.notify_waiters();
    }
    pub(super) fn confirmed(&self, id: &str, targets: Vec<Reviewed>) {
        if let Ok(mut memory) = self.memory.lock() {
            memory.targets = targets;
            let items = memory.targets.iter().map(|o| o.item.clone()).collect();
            if let Some((_, operation)) = memory
                .operation
                .as_mut()
                .filter(|(_, o)| o.operation_id == id)
            {
                operation.items = items;
            }
        }
    }
    pub(super) async fn wait(&self, id: &str, deadline: tokio::time::Instant) -> Reply {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let operation = self.snapshot(id)?;
            if operation.state != State::Pending || tokio::time::Instant::now() >= deadline {
                return Ok(operation);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return self.snapshot(id);
            }
        }
    }
}
