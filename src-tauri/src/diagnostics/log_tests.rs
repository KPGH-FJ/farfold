use super::*;
use serde_json::json;

fn startup(ts: u64) -> Value {
    json!({
        "version": 2, "event": "startup", "ts": ts,
        "phase": "cleanup", "failurePhase": "initialize", "startupOutcome": "ended",
        "initializeResponse": "not_observed", "initializeAccepted": false,
        "childStarted": true, "childReaped": true, "waitFailed": false,
        "termRequested": false, "killRequested": false, "exitObservedBeforeTerm": true,
        "groupEnded": true, "connectionRemoved": true,
        "exitCode": 1, "exitSignal": null, "candidateCleanup": "deleted"
    })
}

fn event(ts: u64) -> Value {
    json!({"version": 1, "ts": ts, "dir": "in", "event": "response", "bytes": 24, "error": "none"})
}

fn line(value: &Value) -> String {
    format!("{value}\n")
}

fn records(entries: &[ZipEntry]) -> Vec<Value> {
    entries
        .iter()
        .flat_map(|entry| {
            std::str::from_utf8(&entry.data)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
        })
        .collect()
}

#[test]
fn log_windows_bounds_total_io_and_reads_small_files_only_once() {
    struct CountedReader {
        cursor: std::io::Cursor<Vec<u8>>,
        bytes: usize,
    }
    impl std::io::Read for CountedReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let count = std::io::Read::read(&mut self.cursor, buffer)?;
            self.bytes += count;
            Ok(count)
        }
    }
    impl std::io::Seek for CountedReader {
        fn seek(&mut self, from: std::io::SeekFrom) -> std::io::Result<u64> {
            std::io::Seek::seek(&mut self.cursor, from)
        }
    }
    for length in [
        0,
        MAX_LOG_READ / 2,
        MAX_LOG_READ,
        MAX_LOG_READ + 1,
        2 * 1024 * 1024,
    ] {
        let mut reader = CountedReader {
            cursor: std::io::Cursor::new(vec![b'\n'; length as usize]),
            bytes: 0,
        };
        let windows = log_windows(&mut reader, length).unwrap();
        assert_eq!(reader.bytes, length.min(MAX_LOG_READ) as usize);
        assert!(windows.iter().map(Vec::len).sum::<usize>() <= reader.bytes);
    }
}

#[test]
fn safe_logs_keeps_the_last_valid_startup_from_a_large_file_tail() {
    let dir = tempfile::tempdir().unwrap();
    let mut body = line(&startup(1));
    body.push_str(&"private-filler-canary\n".repeat(110_000));
    let mut latest = startup(2);
    latest["raw"] = json!("secret-canary");
    body.push_str(&line(&latest));
    assert!(body.len() > 2 * 1024 * 1024);
    std::fs::write(dir.path().join("protocol-v1-tail.jsonl"), body).unwrap();

    let entries = safe_logs(dir.path());
    let exported = records(&entries);
    assert_eq!(exported, vec![startup(2)]);
    assert!(
        !String::from_utf8(entries[0].data.clone())
            .unwrap()
            .contains("canary")
    );
}

#[test]
fn safe_logs_reserves_global_budget_for_each_files_latest_startup() {
    let dir = tempfile::tempdir().unwrap();
    let filler = line(&event(1)).repeat(2200);
    for index in 0..MAX_LOG_FILES {
        let body = format!("{filler}{}", line(&startup(index as u64 + 100)));
        std::fs::write(
            dir.path().join(format!("protocol-v1-{index:02}.jsonl")),
            body,
        )
        .unwrap();
    }

    let entries = safe_logs(dir.path());
    assert!(entries.iter().map(|entry| entry.data.len()).sum::<usize>() <= MAX_SAFE_LOG_BYTES);
    let exported = records(&entries);
    let mut timestamps: Vec<_> = exported
        .iter()
        .filter(|record| record["event"] == "startup")
        .map(|record| record["ts"].as_u64().unwrap())
        .collect();
    timestamps.sort();
    assert_eq!(
        timestamps,
        (100..100 + MAX_LOG_FILES as u64).collect::<Vec<_>>()
    );
    assert!(exported.iter().any(|record| record["version"] == 1));
}

#[test]
fn safe_logs_does_not_duplicate_overlapping_windows_or_drop_repeated_events() {
    let dir = tempfile::tempdir().unwrap();
    let mut body = line(&event(1));
    body.push_str(&"not-a-record\n".repeat(12_000));
    body.push_str(&line(&event(1)));
    body.push_str(&line(&startup(2)));
    assert!(body.len() > MAX_LOG_READ as usize / 2);
    assert!(body.len() < MAX_LOG_READ as usize);
    std::fs::write(dir.path().join("protocol-v1-overlap.jsonl"), body).unwrap();
    assert_eq!(
        records(&safe_logs(dir.path())),
        vec![event(1), event(1), startup(2)]
    );
}

#[test]
fn safe_logs_skips_incomplete_or_invalid_tail_without_replacing_valid_summary() {
    let dir = tempfile::tempdir().unwrap();
    let mut body = line(&startup(1));
    body.push_str(&"x".repeat(2 * 1024 * 1024));
    body.push('\n');
    let mut invalid = startup(2);
    invalid["initializeResponse"] = json!("secret-canary");
    body.push_str(&line(&invalid));
    body.push_str(&line(&event(3)));
    // A concurrent partial write that happens to be valid JSON is still not a complete record.
    body.push_str(&startup(4).to_string());
    std::fs::write(dir.path().join("protocol-v1-partial.jsonl"), body).unwrap();
    assert_eq!(records(&safe_logs(dir.path())), vec![startup(1), event(3)]);
}

#[test]
fn safe_logs_ignores_a_json_record_until_its_terminating_newline_is_present() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("protocol-v1-concurrent-write.jsonl");
    std::fs::write(&path, format!("{}{}", line(&event(1)), event(2))).unwrap();
    assert_eq!(records(&safe_logs(dir.path())), vec![event(1)]);
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    assert_eq!(records(&safe_logs(dir.path())), vec![event(1), event(2)]);
}

#[test]
fn startup_tail_changes_after_preview_do_not_enter_the_reviewed_zip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("protocol-v1-snapshot.jsonl");
    std::fs::write(&path, line(&startup(1))).unwrap();
    let store = MetaStore::open(&dir.path().join("meta.sqlite3")).unwrap();
    let state = DiagnosticsState::default();
    let preview = state.preview(&store, dir.path(), "").unwrap();
    let log = preview
        .entries
        .iter()
        .find(|entry| entry.name.starts_with("logs/"))
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&log.text).unwrap(),
        startup(1)
    );
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(line(&startup(2)).as_bytes())
        .unwrap();
    let bundle = state
        .export(&preview.preview_id, &dir.path().join("out"))
        .unwrap();
    let output = std::process::Command::new("unzip")
        .args(["-p", &bundle, &log.name])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap(), log.text);
    let refreshed = state.preview(&store, dir.path(), "").unwrap();
    let refreshed_log = refreshed
        .entries
        .iter()
        .find(|entry| entry.name.starts_with("logs/"))
        .unwrap();
    let refreshed_records: Vec<Value> = refreshed_log
        .text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(refreshed_records, vec![startup(2)]);
}
