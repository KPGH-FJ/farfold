#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AcpSessionOperationKind {
    New,
    Load,
    Configure,
    Turn,
    #[cfg(test)]
    Close,
}

impl AcpSessionOperationKind {
    fn label(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Load => "load",
            Self::Configure => "configure",
            Self::Turn => "turn",
            #[cfg(test)]
            Self::Close => "close",
        }
    }
}

struct PendingSessionOperation {
    id: u64,
    kind: AcpSessionOperationKind,
    session_id: Option<String>,
}

/// Scoped to one connection generation and guarded by that connection's existing lock.
pub(crate) struct AcpSessionOperations {
    pending: Option<PendingSessionOperation>,
    next_id: u64,
    next_config_id: u64,
    latest_config_id: u64,
}

impl Default for AcpSessionOperations {
    fn default() -> Self {
        Self {
            pending: None,
            next_id: 1,
            next_config_id: 1,
            latest_config_id: 0,
        }
    }
}

impl AcpSessionOperations {
    /// Authentication may configure an owned connection before any native Session exists.
    /// This uses the same Configure occupancy and completion token, not a fake Session.
    pub(crate) fn begin_connection_config(&mut self, unresolved_work: bool) -> Result<u64, String> {
        if self.pending.is_some() || unresolved_work {
            return Err("ACP 连接仍有活动或未确认操作；不能开始配置".into());
        }
        let id = self.next_id;
        self.next_id = self.next_id.checked_add(1).ok_or("ACP 操作序号耗尽")?;
        self.pending = Some(PendingSessionOperation {
            id,
            kind: AcpSessionOperationKind::Configure,
            session_id: None,
        });
        Ok(id)
    }
    pub(crate) fn is_pending(&self) -> bool {
        self.pending.is_some()
    }

    pub(crate) fn is_config_pending(&self) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|operation| operation.kind == AcpSessionOperationKind::Configure)
    }

    pub(crate) fn begin(
        &mut self,
        kind: AcpSessionOperationKind,
        requested_session_id: Option<String>,
        bound_session_id: Option<&str>,
        unresolved_work: bool,
    ) -> Result<u64, String> {
        if let Some(pending) = &self.pending {
            return Err(format!(
                "ACP 正在执行 {}；{} 的结果尚未确认",
                pending.kind.label(),
                pending.session_id.as_deref().unwrap_or("当前会话操作")
            ));
        }
        if unresolved_work {
            return Err("ACP 仍有活动或未确认请求；不能关闭或切换 Session".into());
        }
        match kind {
            AcpSessionOperationKind::New | AcpSessionOperationKind::Load
                if bound_session_id.is_some() =>
            {
                return Err("ACP 已绑定 Session；请先断开当前连接".into());
            }
            #[cfg(test)]
            AcpSessionOperationKind::Close if bound_session_id.is_none() => {
                return Err("ACP 当前没有已绑定 Session".into());
            }
            AcpSessionOperationKind::Configure | AcpSessionOperationKind::Turn
                if bound_session_id.is_none() =>
            {
                return Err("ACP 当前没有可配置的 Session".into());
            }
            _ => {}
        }
        let id = self.next_id;
        self.next_id = self.next_id.checked_add(1).ok_or("ACP 操作序号耗尽")?;
        self.pending = Some(PendingSessionOperation {
            id,
            kind,
            session_id: requested_session_id,
        });
        Ok(id)
    }

    pub(crate) fn complete(&mut self, id: u64) -> Result<AcpSessionOperationKind, String> {
        if self.pending.as_ref().is_none_or(|pending| pending.id != id) {
            return Err("ACP 操作已被新的连接状态取代；晚到结果已丢弃".into());
        }
        Ok(self.pending.take().expect("checked pending operation").kind)
    }

    pub(crate) fn begin_config(&mut self) -> Result<u64, String> {
        let id = self.next_config_id;
        self.next_config_id = self
            .next_config_id
            .checked_add(1)
            .ok_or("ACP 配置序号耗尽")?;
        self.latest_config_id = id;
        Ok(id)
    }

    pub(crate) fn is_current_config(&self, id: u64) -> bool {
        id != 0 && self.latest_config_id == id
    }
}

#[cfg(test)]
mod tests {
    use super::{AcpSessionOperationKind as Kind, AcpSessionOperations};

    #[test]
    fn connection_config_uses_shared_occupancy_without_inventing_a_session() {
        let mut operations = AcpSessionOperations::default();
        assert!(operations.begin_connection_config(true).is_err());
        let id = operations.begin_connection_config(false).unwrap();
        assert!(operations.is_config_pending());
        assert!(operations.begin_connection_config(false).is_err());
        assert!(operations.begin(Kind::New, None, None, false).is_err());
        assert!(operations.complete(id + 1).is_err());
        assert_eq!(operations.complete(id).unwrap(), Kind::Configure);
        assert!(!operations.is_pending());
    }

    #[test]
    fn session_operations_preserve_occupancy_until_matching_completion() {
        let mut operations = AcpSessionOperations::default();
        let id = operations
            .begin(Kind::Load, Some("native".into()), None, false)
            .unwrap();
        assert!(operations.begin(Kind::New, None, None, false).is_err());
        assert!(operations.complete(id + 1).is_err());
        assert!(operations.is_pending());
        assert_eq!(operations.complete(id).unwrap(), Kind::Load);
        assert!(!operations.is_pending());
        assert!(operations.complete(id).is_err());
        let next = operations.begin(Kind::New, None, None, false).unwrap();
        assert_ne!(id, next);
    }

    #[test]
    fn bound_and_unresolved_sessions_reject_replacement() {
        let mut operations = AcpSessionOperations::default();
        for kind in [Kind::New, Kind::Load] {
            assert!(operations.begin(kind, None, Some("native"), false).is_err());
        }
        assert!(operations.begin(Kind::Close, None, None, false).is_err());
        assert!(
            operations
                .begin(Kind::Close, None, Some("native"), true)
                .is_err()
        );
        assert!(!operations.is_pending());
        let id = operations
            .begin(Kind::Close, Some("native".into()), Some("native"), false)
            .unwrap();
        assert_eq!(operations.complete(id).unwrap(), Kind::Close);
    }

    #[test]
    fn only_latest_configuration_response_can_apply() {
        let mut operations = AcpSessionOperations::default();
        assert!(!operations.is_current_config(0));
        let first = operations.begin_config().unwrap();
        let second = operations.begin_config().unwrap();
        assert!(!operations.is_current_config(first));
        assert!(operations.is_current_config(second));
    }

    #[test]
    fn bound_configuration_operation_blocks_admission_until_confirmed() {
        let mut operations = AcpSessionOperations::default();
        assert!(
            operations
                .begin(Kind::Configure, None, None, false)
                .is_err()
        );
        assert!(
            operations
                .begin(Kind::Configure, None, Some("native"), true)
                .is_err()
        );
        let id = operations
            .begin(
                Kind::Configure,
                Some("native".into()),
                Some("native"),
                false,
            )
            .unwrap();
        assert!(operations.is_pending());
        assert!(
            operations
                .begin(Kind::Configure, None, Some("native"), false)
                .is_err()
        );
        assert!(operations.complete(id + 1).is_err());
        assert_eq!(operations.complete(id).unwrap(), Kind::Configure);
        assert!(!operations.is_pending());
    }
}
