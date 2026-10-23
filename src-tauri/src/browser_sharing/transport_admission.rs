//! The worker's sole page/permission admission path. Native execution remains
//! in Worker::begin_read and receives only the exact scope returned here.
use super::{
    FixedPageReadScope, PermissionWait, SharedPage, ToolRequest, Value, WaitingRead, Wire,
};

pub(super) struct AdmittedRead {
    pub id: Value,
    pub scope: FixedPageReadScope,
    pub request: ToolRequest,
}

impl Wire {
    pub(super) fn admit_read(
        &mut self,
        id: Value,
        request: ToolRequest,
        page: &SharedPage,
        permission: &dyn Fn(&ToolRequest) -> Result<PermissionWait, String>,
    ) -> Result<Option<AdmittedRead>, ()> {
        if self.pending.is_some()
            || self.waiting.is_some()
            || self.delivery.is_some()
            || self.screenshot_receipt.is_some()
        {
            return Err(());
        }
        let scope = page.lock().ok().and_then(|page| page.clone());
        if let Some(scope) =
            scope.filter(|scope| !request.requires_request_consent() && scope.is_valid())
        {
            return Ok(Some(AdmittedRead { id, scope, request }));
        }
        match permission(&request) {
            Ok(permission) => {
                self.waiting = Some(WaitingRead {
                    id,
                    permission,
                    request,
                })
            }
            Err(error) => self.reply(
                super::permission_error_reply(id, request.control(), &error),
                None,
                false,
            )?,
        }
        Ok(None)
    }

    pub(super) fn approved_read(&mut self) -> Result<Option<AdmittedRead>, ()> {
        let Some(waiting) = self.waiting.as_ref() else {
            return Ok(None);
        };
        let Some(result) = waiting.permission.poll() else {
            return Ok(None);
        };
        let id = waiting.id.clone();
        let request = waiting.request.clone();
        let retirement = waiting.permission.take_retirement();
        self.waiting = None;
        match result {
            Ok(scope) if scope.is_valid() => {
                self.screenshot_receipt = retirement.map(|receipt| (id.clone(), receipt));
                Ok(Some(AdmittedRead { id, scope, request }))
            }
            other => {
                if let Some(mut retirement) = retirement {
                    retirement.confirm();
                }
                let error = match other {
                    Ok(_) => "网页已变化，本次读取已取消".to_owned(),
                    Err(error) => error,
                };
                self.reply(super::protocol::tool_error(id, &error), None, false)?;
                Ok(None)
            }
        }
    }

    pub(super) fn finish_screenshot(&mut self, id: &Value) {
        if self
            .screenshot_receipt
            .as_ref()
            .is_some_and(|(current, _)| current == id)
            && let Some((_, mut retirement)) = self.screenshot_receipt.take()
        {
            retirement.confirm();
        }
    }

    pub(super) fn acknowledge_written(&mut self, number: u64) -> Option<bool> {
        if self
            .delivery
            .as_ref()
            .is_some_and(|delivery| delivery.number == number)
        {
            let delivery = self.delivery.take().expect("checked delivery");
            self.finish_screenshot(&delivery.id);
            Some(delivery.list)
        } else {
            None
        }
    }

    pub(super) fn finish_stopped_screenshot(&mut self) {
        if let Some((_, mut retirement)) = self.screenshot_receipt.take() {
            retirement.confirm();
        }
    }
}

#[cfg(test)]
#[path = "screenshot_permission_tests.rs"]
mod tests;
