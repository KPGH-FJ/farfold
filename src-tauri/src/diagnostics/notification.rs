//! Only the last reminder's fixed decision fields enter the reviewed snapshot.
//! The renderer's correlation values are validated and used only for lookup.
use crate::desktop_notifications::{DiagnosticSnapshot, diagnostic_for};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NotificationInput {
    version: u8,
    frontend: FrontendDecision,
    backend_attempt: Option<BackendAttempt>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrontendDecision {
    kind: Option<Kind>,
    source: Option<Source>,
    phase: Phase,
    reason: Reason,
    background: Option<bool>,
    ready: bool,
    enabled: bool,
    saving: bool,
}

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Approval,
    Question,
    Interrupted,
}
#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Source {
    Agent,
    Browser,
}
#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    None,
    Observed,
    Skipped,
    Submitting,
    Submitted,
    Suppressed,
    Unconfirmed,
}
#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Reason {
    None,
    Foreground,
    NotReady,
    Disabled,
    Saving,
    PreferencesChanged,
    ConnectionChanged,
    NotPending,
    Submitted,
    Suppressed,
    Unconfirmed,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackendAttempt {
    renderer_nonce: String,
    sequence: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportedDecision<'a> {
    version: u8,
    native_result_coverage: &'static str,
    frontend: &'a FrontendDecision,
    backend: Option<DiagnosticSnapshot>,
}

impl NotificationInput {
    fn validate(&self) -> Result<(), String> {
        let invalid = || "提醒诊断格式未确认，请重新预览".to_owned();
        if self.version != 1
            || (self.frontend.phase == Phase::None) != self.frontend.kind.is_none()
            || self.frontend.kind.is_none() != self.frontend.source.is_none()
        {
            return Err(invalid());
        }
        if let Some(attempt) = &self.backend_attempt
            && (!matches!(
                self.frontend.phase,
                Phase::Submitting | Phase::Submitted | Phase::Suppressed | Phase::Unconfirmed
            ) || attempt.renderer_nonce.len() != 32
                || !attempt
                    .renderer_nonce
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || !(1..=9_007_199_254_740_991).contains(&attempt.sequence))
        {
            return Err(invalid());
        }
        Ok(())
    }

    pub(super) fn entry(&self, app: &AppHandle) -> Result<super::ZipEntry, String> {
        self.validate()?;
        let backend = self
            .backend_attempt
            .as_ref()
            .and_then(|attempt| diagnostic_for(app, &attempt.renderer_nonce, attempt.sequence));
        self.freeze(backend)
    }

    fn freeze(&self, backend: Option<DiagnosticSnapshot>) -> Result<super::ZipEntry, String> {
        self.validate()?;
        Ok(super::ZipEntry {
            name: "notification.json".into(),
            data: serde_json::to_vec_pretty(&ExportedDecision {
                version: 1,
                native_result_coverage: if cfg!(target_os = "macos") {
                    "macos_submission_and_callbacks"
                } else {
                    "not_available"
                },
                frontend: &self.frontend,
                backend,
            })
            .map_err(|_| "提醒诊断格式未确认，请重新预览")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn submitting() -> Value {
        json!({"version": 1, "frontend": {
            "kind":"approval", "source":"agent", "phase":"submitting", "reason":"none",
            "background":true, "ready":true, "enabled":true, "saving":false
        }, "backendAttempt": {"rendererNonce":"0123456789abcdef0123456789abcdef", "sequence": 77}})
    }

    #[test]
    fn strips_lookup_ids_and_does_not_attach_an_unmatched_backend() {
        let input: NotificationInput = serde_json::from_value(submitting()).unwrap();
        let entry = input.freeze(None).unwrap();
        let text = String::from_utf8(entry.data).unwrap();
        assert!(!text.contains("0123456789abcdef"));
        assert!(!text.contains("rendererNonce"));
        assert!(!text.contains("sequence"));
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap()["backend"],
            Value::Null
        );
    }

    #[test]
    fn rejects_arbitrary_strings_extra_fields_and_invalid_correlation() {
        for (path, value) in [
            (vec!["content"], json!("private-canary")),
            (vec!["frontend", "path"], json!("private-canary")),
            (vec!["frontend", "reason"], json!("private-canary")),
            (vec!["backendAttempt", "target"], json!("private-canary")),
        ] {
            let mut input = submitting();
            let mut target = &mut input;
            for key in &path[..path.len() - 1] {
                target = &mut target[*key];
            }
            target[path[path.len() - 1]] = value;
            assert!(serde_json::from_value::<NotificationInput>(input).is_err());
        }
        for (field, value) in [
            ("rendererNonce", json!("private-canary")),
            ("sequence", json!(0)),
            ("sequence", json!(9_007_199_254_740_992_u64)),
        ] {
            let mut input = submitting();
            input["backendAttempt"][field] = value;
            let input: NotificationInput = serde_json::from_value(input).unwrap();
            assert!(input.validate().is_err());
        }
        let mut skipped = submitting();
        skipped["frontend"]["phase"] = json!("skipped");
        assert!(
            serde_json::from_value::<NotificationInput>(skipped)
                .unwrap()
                .validate()
                .is_err()
        );
    }

    #[test]
    fn exports_only_the_reviewed_notification_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let store =
            crate::meta_store::MetaStore::open(&directory.path().join("meta.sqlite3")).unwrap();
        let input: NotificationInput = serde_json::from_value(submitting()).unwrap();
        let state = super::super::DiagnosticsState::default();
        let preview = state
            .preview(
                &store,
                directory.path(),
                "",
                Some(input.freeze(None).unwrap()),
            )
            .unwrap();
        let reviewed = preview
            .entries
            .iter()
            .find(|e| e.name == "notification.json")
            .unwrap();
        // A newer candidate after preview cannot be collected by export.
        let mut newer = submitting();
        newer["frontend"]["phase"] = json!("skipped");
        newer["frontend"]["reason"] = json!("foreground");
        newer["backendAttempt"] = Value::Null;
        let newer: NotificationInput = serde_json::from_value(newer).unwrap();
        assert_ne!(newer.freeze(None).unwrap().data, reviewed.text.as_bytes());
        let path = state
            .export(&preview.preview_id, &directory.path().join("out"))
            .unwrap();
        let content = std::process::Command::new("unzip")
            .args(["-p", &path, "notification.json"])
            .output()
            .unwrap();
        assert!(content.status.success());
        assert_eq!(content.stdout, reviewed.text.as_bytes());
        let manifest: Value = serde_json::from_str(
            &preview
                .entries
                .iter()
                .find(|e| e.name == "manifest.json")
                .unwrap()
                .text,
        )
        .unwrap();
        assert_eq!(manifest["includesNotificationDiagnostic"], true);
    }
}
