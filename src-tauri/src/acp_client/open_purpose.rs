//! Local opening authority; never decoded from Agent response fields.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OpenPurpose {
    Conversation,
    ImportPreview,
    SearchReadOnly,
}

impl OpenPurpose {
    pub(crate) fn validate(
        self,
        native: Option<&str>,
        preview_token: Option<&str>,
        config_is_empty: bool,
        has_mcp: bool,
    ) -> Result<(), String> {
        if self != Self::Conversation
            && (native.is_none_or(str::is_empty)
                || preview_token.is_none_or(str::is_empty)
                || !config_is_empty
                || has_mcp)
        {
            return Err("读取对话的参数无法确认，本次尚未开始".into());
        }
        Ok(())
    }

    pub(crate) fn preview_name(self) -> Option<&'static str> {
        match self {
            Self::Conversation => None,
            Self::ImportPreview => Some("importPreview"),
            Self::SearchReadOnly => Some("searchReadOnly"),
        }
    }
}
