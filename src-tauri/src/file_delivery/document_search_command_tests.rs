use super::*;
use std::io::{Cursor, Write};
use std::sync::mpsc;
use std::time::Duration;
use zip::{ZipWriter, write::SimpleFileOptions};

#[tokio::test]
async fn docx_search_uses_the_production_shared_two_slot_gate() {
    let _serial = crate::file_read_check::tests::PRODUCTION_CHECKS
        .lock()
        .await;
    let mut requests = Vec::new();
    let mut releases = Vec::new();
    for _ in 0..2 {
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, blocked) = mpsc::channel();
        releases.push(release);
        requests.push(tokio::spawn(crate::file_read_check::run(move || {
            started.send(()).unwrap();
            blocked.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(())
        })));
        tokio::time::timeout(Duration::from_secs(1), ready)
            .await
            .unwrap()
            .unwrap();
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("selected.docx");
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for name in ["[Content_Types].xml", "_rels/.rels", "word/document.xml"] {
        writer
            .start_file(name, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"<root>author</root>").unwrap();
    }
    std::fs::write(&path, writer.finish().unwrap().into_inner()).unwrap();
    let file = file_delivery::inspect_text(&path).unwrap();
    let blocked = checked_docx_search(file.clone()).await;
    for release in releases {
        release.send(()).unwrap();
    }
    for request in requests {
        request.await.unwrap().unwrap();
    }
    assert_eq!(blocked.unwrap_err().code, "readBusy");
    assert_eq!(checked_docx_search(file.clone()).await.unwrap().file, file);
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(file_delivery::MAX_TEXT_BYTES + 1)
        .unwrap();
    assert_eq!(checked_docx_search(file).await.unwrap_err().code, "limit");
}
