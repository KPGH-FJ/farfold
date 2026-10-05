//! Content-free Windows toast markup. Only fixed application copy reaches here.
pub(super) fn toast_xml(body: &str, sound: bool) -> String {
    let body = body
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let audio = if sound {
        "<audio src=\"ms-winsoundevent:Notification.Default\"/>"
    } else {
        "<audio silent=\"true\"/>"
    };
    // The classic template supports the running-process Activated callback.
    // No protocol, command, path or cold-start launch argument is embedded.
    format!(
        "<toast><visual><binding template=\"ToastText02\"><text id=\"1\">Farfold</text><text id=\"2\">{body}</text></binding></visual>{audio}</toast>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn markup_cannot_add_actions_and_silent_really_sets_the_native_flag() {
        let xml = toast_xml("notice </text><actions>&", false);
        assert!(xml.contains("notice &lt;/text&gt;&lt;actions&gt;&amp;"));
        assert!(xml.contains("<audio silent=\"true\"/>"));
        assert!(!xml.contains("launch="));
        assert!(!xml.contains("<actions>"));
        let audible = toast_xml("notice", true);
        assert!(!audible.contains("silent="));
        assert!(audible.contains("ms-winsoundevent:Notification.Default"));
    }
}
