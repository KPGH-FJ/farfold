//! Preview allowlisted diagnostics and an explicitly user-authored issue, then
//! export exactly that reviewed snapshot to a local ZIP for optional sharing.
//!
//! Every exported field is allowlisted. Legacy/raw and application logs are
//! excluded; new protocol records are reconstructed after schema validation.
//! Agent launch configuration, environment and conversation metadata are omitted.

use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

use crate::logging;
use crate::meta_store::MetaStore;

/// Entry in the zip being assembled.
#[derive(Clone)]
struct ZipEntry {
    name: String,
    data: Vec<u8>,
}

/// DOS `(date, time)` fields from unix seconds (civil algorithm).
fn dos_datetime(secs: u64) -> (u16, u16) {
    let days = (secs / 86_400) as i64;
    let secs_of_day = secs % 86_400;
    let (year, month, day) = crate::logging::civil_from_days(days);
    let year = year.clamp(1980, 2107) as u16;
    let date = ((year - 1980) << 9) | ((month as u16) << 5) | day as u16;
    let time = (((secs_of_day / 3600) as u16) << 11)
        | (((secs_of_day % 3600) / 60) as u16) << 5
        | ((secs_of_day % 60) as u16 / 2);
    (date, time)
}

/// Minimal ZIP writer (deflate entries + central directory). Avoids a
/// new dependency; `flate2` is already pinned.
fn write_zip(path: &Path, entries: &[ZipEntry]) -> Result<(), String> {
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let (dos_date, dos_time) = dos_datetime(now_secs);

    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();

    for entry in entries {
        let compressed = {
            let mut encoder =
                flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
            encoder
                .write_all(&entry.data)
                .map_err(|e| format!("zip deflate failed: {e}"))?;
            encoder
                .finish()
                .map_err(|e| format!("zip deflate finish failed: {e}"))?
        };
        let mut crc = flate2::Crc::new();
        crc.update(&entry.data);
        let crc32 = crc.sum();
        let name = entry.name.as_bytes();
        let offset = out.len() as u32;

        // Local file header.
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&8u16.to_le_bytes()); // method: deflate
        out.extend_from_slice(&dos_time.to_le_bytes());
        out.extend_from_slice(&dos_date.to_le_bytes());
        out.extend_from_slice(&crc32.to_le_bytes());
        out.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        out.extend_from_slice(&(entry.data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra len
        out.extend_from_slice(name);
        out.extend_from_slice(&compressed);

        // Central directory record.
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central.extend_from_slice(&0u16.to_le_bytes()); // flags
        central.extend_from_slice(&8u16.to_le_bytes()); // method
        central.extend_from_slice(&dos_time.to_le_bytes());
        central.extend_from_slice(&dos_date.to_le_bytes());
        central.extend_from_slice(&crc32.to_le_bytes());
        central.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        central.extend_from_slice(&(entry.data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra
        central.extend_from_slice(&0u16.to_le_bytes()); // comment
        central.extend_from_slice(&0u16.to_le_bytes()); // disk
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name);
    }

    let central_offset = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // disk
    out.extend_from_slice(&0u16.to_le_bytes()); // central disk
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment len

    let parent = path.parent().ok_or("missing diagnostic destination")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temporary.write_all(&out).map_err(|e| e.to_string())?;
    temporary
        .persist_noclobber(path)
        .map_err(|e| e.error.to_string())?;
    Ok(())
}

/// Only known, type-checked preferences enter diagnostics.
fn redact_settings(settings: Vec<(String, Value)>) -> Map<String, Value> {
    settings
        .into_iter()
        .filter(|(key, value)| match key.as_str() {
            "theme" => value
                .as_str()
                .is_some_and(|v| ["light", "dark", "system", "paper"].contains(&v)),
            "autoArchiveDays" => value.as_u64().is_some_and(|v| v <= 36500),
            _ => false,
        })
        .collect()
}

fn redact_agents(rows: &[crate::meta_store::AgentRow]) -> Value {
    Value::Array(rows.iter().enumerate().map(|(i, row)| serde_json::json!({
        "index": i, "source": match row.source.as_str() { "discovered" => "discovered", "registry" => "registry", _ => "custom" },
        "configured": !row.command.is_empty(), "hasHandshake": row.handshake.is_some()
    })).collect())
}

const MAX_LOG_FILES: usize = 32;
const MAX_LOG_READ: u64 = 256 * 1024;
const MAX_SAFE_LOG_BYTES: usize = 2 * 1024 * 1024;
const MAX_PREVIEW_BYTES: usize = 4 * 1024 * 1024;
const MAX_NOTE_CHARS: usize = 4000;
const PREVIEW_LIFETIME: Duration = Duration::from_secs(10 * 60);

fn safe_logs(log_dir: &Path) -> Vec<ZipEntry> {
    let mut entries = Vec::new();
    let Ok(read) = std::fs::read_dir(log_dir) else {
        return entries;
    };
    let mut paths: Vec<_> = read
        .flatten()
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            entry.file_type().is_ok_and(|t| t.is_file())
                && name.starts_with("protocol-v1-")
                && (name.ends_with(".jsonl") || name.ends_with(".jsonl.1"))
        })
        .map(|entry| entry.path())
        .collect();
    paths.sort();
    let mut bytes = 0;
    for path in paths.into_iter().rev().take(MAX_LOG_FILES) {
        let Ok(file) = std::fs::File::open(path) else {
            continue;
        };
        let mut body = String::new();
        if file.take(MAX_LOG_READ).read_to_string(&mut body).is_err() {
            continue;
        }
        let mut data = Vec::new();
        for line in body.lines() {
            if let Ok(value) = serde_json::from_str::<Value>(line)
                && let Some(safe) = crate::acp_client::tap::safe_record(&value)
                && let Ok(encoded) = serde_json::to_vec(&safe)
            {
                if bytes + encoded.len() + 1 > MAX_SAFE_LOG_BYTES {
                    break;
                }
                bytes += encoded.len() + 1;
                data.extend(encoded);
                data.push(b'\n');
            }
        }
        if !data.is_empty() {
            entries.push(ZipEntry {
                name: format!("logs/protocol-{}.jsonl", entries.len()),
                data,
            });
        }
    }
    entries
}

fn timestamp_name() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default();
    let days = millis.div_euclid(86_400_000);
    let secs = millis.rem_euclid(86_400_000) / 1000;
    let (y, m, d) = crate::logging::civil_from_days(days);
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEntry {
    name: String,
    text: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticPreview {
    preview_id: String,
    generated_at: String,
    entries: Vec<DiagnosticEntry>,
}
struct PreparedBundle {
    preview: DiagnosticPreview,
    created: Instant,
    exported: Option<String>,
}
#[derive(Default)]
struct PreviewStore {
    sequence: u64,
    bundle: Option<PreparedBundle>,
}
/// One bounded, app-lifetime snapshot. No user logs or diagnostics are persisted here.
#[derive(Default)]
pub struct DiagnosticsState(Mutex<PreviewStore>);

fn diagnostic_entries(
    store: &MetaStore,
    log_dir: &Path,
    note: &str,
) -> Result<(String, Vec<ZipEntry>), String> {
    if note.chars().count() > MAX_NOTE_CHARS {
        return Err("问题说明请控制在 4000 字以内".into());
    }
    let mut entries = safe_logs(log_dir);
    entries.push(ZipEntry {
        name: "settings.json".into(),
        data: serde_json::to_vec_pretty(&Value::Object(redact_settings(store.list_settings()?)))
            .map_err(|e| e.to_string())?,
    });
    let agent_rows = store.list_agents()?;
    entries.push(ZipEntry {
        name: "agents.json".into(),
        data: serde_json::to_vec_pretty(&redact_agents(&agent_rows)).map_err(|e| e.to_string())?,
    });
    let sessions = store.list_sessions()?;
    entries.push(ZipEntry {
        name: "sessions.json".into(),
        data: serde_json::to_vec_pretty(&serde_json::json!({"count": sessions.len(), "archived": sessions.iter().filter(|s| s.archived).count()})).map_err(|e| e.to_string())?,
    });
    // User-authored text is explicitly shown in full before export; never treated as a log.
    if !note.trim().is_empty() {
        entries.push(ZipEntry {
            name: "user-note.txt".into(),
            data: note.as_bytes().to_vec(),
        });
    }
    let generated_at = timestamp_name();
    let manifest = serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"), "generatedAt": generated_at,
        "agentCount": agent_rows.len(), "sessionCount": sessions.len(),
        "logFiles": entries.iter().filter(|e| e.name.starts_with("logs/")).count(),
        "limitedLogs": true, "includesUserNote": !note.trim().is_empty(),
    });
    entries.push(ZipEntry {
        name: "manifest.json".into(),
        data: serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    });
    if entries.iter().map(|entry| entry.data.len()).sum::<usize>() > MAX_PREVIEW_BYTES {
        return Err("诊断内容过多，暂时无法预览".into());
    }
    Ok((generated_at, entries))
}
impl DiagnosticsState {
    fn preview(
        &self,
        store: &MetaStore,
        log_dir: &Path,
        note: &str,
    ) -> Result<DiagnosticPreview, String> {
        let (generated_at, entries) = diagnostic_entries(store, log_dir, note)?;
        let mut state = self.0.lock().map_err(|_| "暂时无法读取诊断预览")?;
        state.sequence = state.sequence.wrapping_add(1);
        let preview = DiagnosticPreview {
            preview_id: format!("{}-{}", generated_at, state.sequence),
            generated_at,
            entries: entries
                .into_iter()
                .map(|entry| DiagnosticEntry {
                    name: entry.name,
                    text: String::from_utf8(entry.data).expect("diagnostics are UTF-8"),
                })
                .collect(),
        };
        state.bundle = Some(PreparedBundle {
            preview: preview.clone(),
            created: Instant::now(),
            exported: None,
        });
        Ok(preview)
    }
    fn export(&self, preview_id: &str, dest_dir: &Path) -> Result<String, String> {
        let mut state = self.0.lock().map_err(|_| "暂时无法导出诊断")?;
        let bundle = state
            .bundle
            .as_mut()
            .filter(|bundle| bundle.preview.preview_id == preview_id)
            .ok_or("预览已经变化，请重新预览后再导出")?;
        if bundle.created.elapsed() > PREVIEW_LIFETIME {
            return Err("预览已过期，请重新预览后再导出".into());
        }
        if let Some(path) = &bundle.exported {
            return Ok(path.clone());
        }
        let entries: Vec<_> = bundle
            .preview
            .entries
            .iter()
            .map(|entry| ZipEntry {
                name: entry.name.clone(),
                data: entry.text.as_bytes().to_vec(),
            })
            .collect();
        std::fs::create_dir_all(dest_dir).map_err(|_| "无法访问诊断保存位置")?;
        let dest = dest_dir.join(format!(
            "farfold-diagnostics-{}.zip",
            bundle.preview.preview_id
        ));
        write_zip(&dest, &entries).map_err(|_| "诊断文件写入失败，请检查保存位置后重试")?;
        let path = dest.to_string_lossy().into_owned();
        bundle.exported = Some(path.clone());
        logging::info("diagnostics", format_args!("exported reviewed diagnostics"));
        Ok(path)
    }
}

#[tauri::command]
pub fn diagnostics_preview(app: AppHandle, note: String) -> Result<DiagnosticPreview, String> {
    let store = app.state::<MetaStore>();
    app.state::<DiagnosticsState>()
        .preview(&store, &logging::default_log_dir(), &note)
}

/// Only the currently reviewed snapshot can be written. Never recollect on export.
#[tauri::command]
pub fn export_diagnostics(app: AppHandle, preview_id: String) -> Result<String, String> {
    let desktop = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("无法找到诊断保存位置")?
        .join("Desktop");
    app.state::<DiagnosticsState>()
        .export(&preview_id, &desktop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_reads_only_validated_content_free_records() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("app-old.log"), "secret-canary").unwrap();
        std::fs::write(dir.path().join("acp-old.jsonl"), "secret-canary").unwrap();
        std::fs::write(dir.path().join("protocol-v1-fixture.jsonl"), concat!(
            "{\"version\":1,\"ts\":1,\"dir\":\"in\",\"event\":\"session/update\",\"bytes\":99,\"error\":\"none\",\"line\":\"secret-canary\"}\n",
            "{\"version\":1,\"ts\":1,\"dir\":\"in\",\"event\":\"secret-canary\",\"bytes\":99,\"error\":\"none\"}\n"
        )).unwrap();
        let entries = safe_logs(dir.path());
        assert_eq!(entries.len(), 1);
        let body = String::from_utf8(entries[0].data.clone()).unwrap();
        assert!(!body.contains("secret-canary"));
        assert_eq!(body.lines().count(), 1);
        let settings = redact_settings(vec![
            ("theme".into(), serde_json::json!("secret-canary")),
            (
                "custom".into(),
                serde_json::json!({"token":"secret-canary"}),
            ),
        ]);
        assert!(settings.is_empty());
    }

    #[test]
    fn zip_round_trip_unzips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("test.zip");
        write_zip(
            &path,
            &[
                ZipEntry {
                    name: "a.txt".to_string(),
                    data: b"hello world".to_vec(),
                },
                ZipEntry {
                    name: "logs/app.log".to_string(),
                    data: b"[ts] [INFO] [m] line\n".to_vec(),
                },
            ],
        )
        .expect("write zip");
        // `unzip -p` streams an entry; verifies headers end-to-end.
        let output = std::process::Command::new("unzip")
            .arg("-p")
            .arg(&path)
            .arg("a.txt")
            .output()
            .expect("unzip");
        assert!(output.status.success());
        assert_eq!(output.stdout, b"hello world");
        let listing = std::process::Command::new("unzip")
            .arg("-l")
            .arg(&path)
            .output()
            .expect("unzip -l");
        let text = String::from_utf8_lossy(&listing.stdout);
        assert!(text.contains("logs/app.log"), "{text}");
    }

    #[test]
    fn preview_is_exact_bounded_and_required_for_export() {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("meta.sqlite3")).unwrap();
        store
            .set_setting("theme", &serde_json::json!("light"))
            .unwrap();
        store
            .set_setting(
                "unsentWork.v1",
                &serde_json::json!({"text":"private-draft-canary"}),
            )
            .unwrap();
        let state = DiagnosticsState::default();
        let dest = dir.path().join("out");
        assert!(state.export("not-reviewed", &dest).is_err());
        assert!(!dest.exists());
        let preview = state
            .preview(&store, dir.path(), "My exact issue\nsecond line")
            .unwrap();
        assert!(
            !serde_json::to_string(&preview)
                .unwrap()
                .contains("private-draft-canary")
        );
        store
            .set_setting("theme", &serde_json::json!("dark"))
            .unwrap();
        let path = state.export(&preview.preview_id, &dest).unwrap();
        assert_eq!(state.export(&preview.preview_id, &dest).unwrap(), path);
        for entry in &preview.entries {
            let output = std::process::Command::new("unzip")
                .args(["-p", &path, &entry.name])
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(String::from_utf8(output.stdout).unwrap(), entry.text);
        }
        let newer = state.preview(&store, dir.path(), "Updated issue").unwrap();
        assert_ne!(newer.preview_id, preview.preview_id);
        assert!(state.export(&preview.preview_id, &dest).is_err());
        assert!(
            state
                .preview(&store, dir.path(), &"x".repeat(MAX_NOTE_CHARS + 1))
                .is_err()
        );
        state.0.lock().unwrap().bundle.as_mut().unwrap().created =
            Instant::now() - PREVIEW_LIFETIME - Duration::from_secs(1);
        assert!(state.export(&newer.preview_id, &dest).is_err());
    }

    #[test]
    fn redaction_masks_secret_values() {
        let settings = vec![
            ("theme".to_string(), Value::String("light".to_string())),
            (
                "codex.apiKey".to_string(),
                Value::String("sk-123".to_string()),
            ),
            (
                "agent.token.env".to_string(),
                Value::String("x".to_string()),
            ),
        ];
        let out = redact_settings(settings);
        assert_eq!(out["theme"], Value::String("light".to_string()));
        assert!(!out.contains_key("codex.apiKey"));
        assert!(!out.contains_key("agent.token.env"));
    }

    #[test]
    fn export_writes_unzippable_bundle_with_manifest() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = MetaStore::open(&dir.path().join("farfold.sqlite3")).expect("store");
        store
            .set_setting("theme", &Value::String("paper".to_string()))
            .unwrap();
        store
            .set_setting("codex.apiKey", &Value::String("sk-secret".to_string()))
            .unwrap();
        let dest_dir = dir.path().join("Desktop");
        let state = DiagnosticsState::default();
        let preview = state
            .preview(&store, &dir.path().join("logs"), "A user-authored issue")
            .unwrap();
        let path = state
            .export(&preview.preview_id, &dest_dir)
            .expect("export");
        assert!(path.contains("farfold-diagnostics-"));
        let zip = std::path::Path::new(&path);
        assert!(zip.exists());

        let listing = std::process::Command::new("unzip")
            .arg("-l")
            .arg(zip)
            .output()
            .expect("unzip -l");
        let text = String::from_utf8_lossy(&listing.stdout);
        for entry in [
            "manifest.json",
            "settings.json",
            "agents.json",
            "sessions.json",
        ] {
            assert!(text.contains(entry), "missing {entry} in {text}");
        }
        // Secret values are redacted before they enter the archive.
        let settings_json = std::process::Command::new("unzip")
            .arg("-p")
            .arg(zip)
            .arg("settings.json")
            .output()
            .expect("unzip -p");
        let body = String::from_utf8_lossy(&settings_json.stdout);
        assert!(!body.contains("sk-secret"), "{body}");
        assert!(!body.contains("codex.apiKey"), "{body}");
        let manifest = std::process::Command::new("unzip")
            .arg("-p")
            .arg(zip)
            .arg("manifest.json")
            .output()
            .expect("unzip manifest");
        let manifest: Value = serde_json::from_slice(&manifest.stdout).expect("manifest parses");
        assert_eq!(manifest["version"], env!("CARGO_PKG_VERSION"));
        assert!(manifest["sessionCount"].is_number());
    }
}
