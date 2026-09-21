//! `export_diagnostics`: bundle content-free diagnostics + safe settings + a small
//! manifest into `~/Desktop/farfold-diagnostics-<ts>.zip` for support.
//!
//! Every exported field is allowlisted. Legacy/raw and application logs are
//! excluded; new protocol records are reconstructed after schema validation.
//! Agent launch configuration, environment and conversation metadata are omitted.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

use crate::acp_client::manager::AcpManager;
use crate::logging;
use crate::meta_store::MetaStore;

/// Entry in the zip being assembled.
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

    std::fs::write(path, out).map_err(|e| format!("cannot write {}: {e}", path.display()))
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

fn safe_logs(log_dir: &Path) -> Vec<ZipEntry> {
    let mut entries = Vec::new();
    let Ok(read) = std::fs::read_dir(log_dir) else {
        return entries;
    };
    for entry in read.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("protocol-v1-")
            || !(name.ends_with(".jsonl") || name.ends_with(".jsonl.1"))
        {
            continue;
        }
        let Ok(body) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let mut data = Vec::new();
        for line in body.lines() {
            if let Ok(value) = serde_json::from_str::<Value>(line)
                && let Some(safe) = crate::acp_client::tap::safe_record(&value)
                && let Ok(encoded) = serde_json::to_vec(&safe)
            {
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

/// `export_diagnostics` → path of the generated zip on the Desktop.
#[tauri::command]
pub fn export_diagnostics(app: AppHandle) -> Result<String, String> {
    let desktop = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Desktop");
    let store = app.state::<MetaStore>();
    let manager = app.state::<AcpManager>();
    export_diagnostics_impl(&store, &manager, &desktop, &logging::default_log_dir())
}

/// Core of the export, split from the command so tests can drive it
/// without an `AppHandle`.
fn export_diagnostics_impl(
    store: &MetaStore,
    _manager: &AcpManager,
    dest_dir: &Path,
    log_dir: &Path,
) -> Result<String, String> {
    let mut entries = safe_logs(log_dir);

    // Redacted settings / agents / session index.
    let settings = redact_settings(store.list_settings()?);
    entries.push(ZipEntry {
        name: "settings.json".to_string(),
        data: serde_json::to_vec_pretty(&Value::Object(settings)).map_err(|e| e.to_string())?,
    });

    let agent_rows = store.list_agents()?;
    entries.push(ZipEntry {
        name: "agents.json".to_string(),
        data: serde_json::to_vec_pretty(&redact_agents(&agent_rows)).map_err(|e| e.to_string())?,
    });

    let sessions = store.list_sessions()?;
    entries.push(ZipEntry {
        name: "sessions.json".to_string(),
        data: serde_json::to_vec_pretty(&serde_json::json!({"count": sessions.len(), "archived": sessions.iter().filter(|s| s.archived).count()})).map_err(|e| e.to_string())?,
    });

    let manifest = serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "generatedAt": timestamp_name(),
        "agentCount": agent_rows.len(),
        "sessionCount": sessions.len(),
        "logFiles": entries.iter().filter(|e| e.name.starts_with("logs/")).count(),
    });
    entries.push(ZipEntry {
        name: "manifest.json".to_string(),
        data: serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    });

    std::fs::create_dir_all(dest_dir)
        .map_err(|e| format!("cannot access {}: {e}", dest_dir.display()))?;
    let dest = dest_dir.join(format!("farfold-diagnostics-{}.zip", timestamp_name()));
    write_zip(&dest, &entries)?;

    logging::info(
        "diagnostics",
        format_args!("exported diagnostics to {}", dest.display()),
    );
    Ok(dest.to_string_lossy().into_owned())
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
        let manager = AcpManager::new(dir.path().join("logs"), dir.path().to_path_buf());
        let dest_dir = dir.path().join("Desktop");
        let path = export_diagnostics_impl(&store, &manager, &dest_dir, &dir.path().join("logs"))
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
