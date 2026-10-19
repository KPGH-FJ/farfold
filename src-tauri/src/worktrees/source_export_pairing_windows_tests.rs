//! Actual fixed-output factory/share controls, not real Git process receipts.
use super::*;
use std::{io::Write, sync::mpsc, time::Duration};
const PUBLIC: &[u8] = b"owned public producer bytes\n";
fn namespace() -> Namespace {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().canonicalize().unwrap();
    let root = PinnedPath::directory(&path).unwrap();
    Namespace { root, _temp: temp }
}
fn produce(namespace: &Namespace) -> Produced {
    let mut output = ProducedOutput::new(namespace).unwrap();
    let mut writer = output.take().unwrap();
    writer.write_all(PUBLIC).unwrap();
    writer.sync_all().unwrap();
    drop(writer);
    output.finish(&AtomicBool::new(false)).unwrap()
}
#[test]
fn actual_producer_factory_has_compatible_bridge_but_excludes_writers_and_early_strict_pin() {
    let namespace = namespace();
    let mut output = ProducedOutput::new(&namespace).unwrap();
    let path = namespace.root.guid_path.join("objects.pack");
    assert!(fs::OpenOptions::new().write(true).open(&path).is_err());
    assert!(
        namespace
            .root
            .child(&"objects.pack".encode_utf16().collect::<Vec<_>>(), false)
            .is_err()
    );
    assert!(fs::rename(&path, namespace.root.guid_path.join("replacement.pack")).is_err());
    let mut writer = output.take().unwrap();
    writer.write_all(PUBLIC).unwrap();
    writer.sync_all().unwrap();
    drop(writer);
    let produced = output.finish(&AtomicBool::new(false)).unwrap();
    assert_eq!(
        produced.sha256,
        crate::worktrees::material_scan::hex(Sha256::digest(PUBLIC))
    );
    let pin = produced.pin(&namespace, &AtomicBool::new(false)).unwrap();
    assert_eq!(
        digest(pin.file(), &AtomicBool::new(false)).unwrap().1,
        crate::worktrees::material_scan::hex(Sha256::digest(PUBLIC))
    );
    assert!(fs::OpenOptions::new().write(true).open(&path).is_err());
    assert!(fs::rename(&path, namespace.root.guid_path.join("replacement.pack")).is_err());
}
#[test]
fn real_owned_concurrent_writer_in_transition_prevents_strict_pin_and_is_joined_before_assertion() {
    let namespace = namespace();
    let produced = produce(&namespace);
    let path = namespace.root.guid_path.join("objects.pack");
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let writer = fs::OpenOptions::new()
            .write(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(path)
            .unwrap();
        ready_tx.send(()).unwrap();
        let released = release_rx.recv_timeout(Duration::from_secs(5));
        drop(writer);
        released.unwrap();
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let result = produced.pin(&namespace, &AtomicBool::new(false));
    let release = release_tx.send(());
    let joined = worker.join();
    release.unwrap();
    joined.unwrap();
    assert_eq!(result.err().unwrap().code, "changed");
    namespace.verify().unwrap();
}
#[test]
fn transition_is_writable_but_replacement_and_changed_content_cannot_gain_producer_authority() {
    let namespace = namespace();
    let produced = produce(&namespace);
    let path = namespace.root.guid_path.join("objects.pack");
    assert!(fs::rename(&path, namespace.root.guid_path.join("replacement.pack")).is_err());
    let mut changed = PUBLIC.to_vec();
    changed[0] ^= 1;
    assert_eq!(changed.len(), PUBLIC.len());
    fs::write(&path, &changed).unwrap();
    assert_eq!(
        produced
            .pin(&namespace, &AtomicBool::new(false))
            .err()
            .unwrap()
            .code,
        "changed"
    );
    namespace.verify().unwrap();
}
