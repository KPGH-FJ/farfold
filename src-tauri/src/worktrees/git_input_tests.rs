use super::*;
use crate::worktrees::git::{execute_bounded, execute_command, execute_command_input};
use sha2::{Digest, Sha256};
use std::{fs, io::SeekFrom, time::Duration};

const BODY: &[u8] = b"controlled-private-input\0\xff\n";
const PEER: &str = "import sys,hashlib; b=sys.stdin.buffer.read(); sys.stdout.write(str(len(b))+':'+hashlib.sha256(b).hexdigest())";
fn peer() -> Command {
    let mut command = Command::new(crate::platform_tests::python());
    command.args(["-c", PEER]);
    command
}
fn expected(body: &[u8]) -> Vec<u8> {
    let digest: String = Sha256::digest(body)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{}:{digest}", body.len()).into_bytes()
}
fn run(input: Input) -> crate::worktrees::git::Output {
    execute_command_input(
        peer(),
        input,
        &AtomicBool::new(false),
        Duration::from_secs(5),
    )
    .unwrap()
}
#[test]
fn real_runner_delivers_opaque_finite_bytes_and_true_eof_after_platform_command_rebuild() {
    let input = Input::from_bytes(BODY, BODY.len() as u64, &AtomicBool::new(false)).unwrap();
    let out = run(input);
    assert!(out.success);
    assert_eq!(out.bytes, expected(BODY));
    assert!(
        !String::from_utf8(out.bytes)
            .unwrap()
            .contains("controlled-private-input")
    );
}
#[test]
fn explicit_null_replaces_preconfigured_stdin_while_generic_platform_behavior_is_preserved() {
    fn configured() -> Command {
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(BODY).unwrap();
        file.rewind().unwrap();
        let mut command = peer();
        command.stdin(file);
        command
    }
    let out = execute_command_input(
        configured(),
        Input::null(),
        &AtomicBool::new(false),
        Duration::from_secs(5),
    )
    .unwrap();
    assert!(out.success);
    assert_eq!(out.bytes, expected(b""));
    let generic = execute_command(
        configured(),
        &AtomicBool::new(false),
        Duration::from_secs(5),
    )
    .unwrap();
    assert!(generic.success);
    #[cfg(unix)]
    assert_eq!(generic.bytes, expected(BODY)); // original Unix configured-stdin contract
    #[cfg(windows)]
    assert_eq!(generic.bytes, expected(b"")); // original Windows no-input contract
}
#[test]
fn selected_held_file_range_is_snapshotted_from_its_current_offset_without_prefix_or_later_edits() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("owned-input");
    let prefix = b"excluded-prefix:";
    let mut original = prefix.to_vec();
    original.extend(BODY);
    fs::write(&path, &original).unwrap();
    let mut source = File::open(&path).unwrap();
    source.seek(SeekFrom::Start(prefix.len() as u64)).unwrap();
    let input = Input::from_file(source, BODY.len() as u64, &AtomicBool::new(false)).unwrap();
    fs::write(&path, vec![b'x'; original.len()]).unwrap();
    let out = run(input);
    assert!(out.success);
    assert_eq!(out.bytes, expected(BODY));
}
#[test]
fn factory_caps_cancel_and_invalid_offset_refuse_without_exposing_payload_in_errors() {
    let cancel = AtomicBool::new(false);
    let code = Input::from_bytes(BODY, 1, &cancel).err().unwrap();
    assert_eq!(code.code, "tooLarge");
    assert!(
        !serde_json::to_string(&code)
            .unwrap()
            .contains("controlled-private-input")
    );
    assert_eq!(
        Input::from_bytes(BODY, 100, &AtomicBool::new(true))
            .err()
            .unwrap()
            .code,
        "cancelled"
    );
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("owned-input");
    fs::write(&path, BODY).unwrap();
    assert_eq!(
        Input::from_file(File::open(&path).unwrap(), 1, &cancel)
            .err()
            .unwrap()
            .code,
        "tooLarge"
    );
    let mut source = File::open(&path).unwrap();
    source.seek(SeekFrom::Start(BODY.len() as u64 + 1)).unwrap();
    assert_eq!(
        Input::from_file(source, 100, &cancel).err().unwrap().code,
        "changed"
    );
    assert_eq!(fs::read(path).unwrap(), BODY);
}
#[test]
fn empty_finite_file_is_valid_and_not_a_failed_or_truncated_input() {
    let input = Input::from_bytes(b"", 0, &AtomicBool::new(false)).unwrap();
    assert!(input.file.is_some());
    let out = run(input);
    assert!(out.success);
    assert_eq!(out.bytes, expected(b""));
}
#[test]
fn cancellation_before_spawn_and_staged_size_drift_cannot_dispatch_the_selected_peer() {
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("entered");
    fn marker_peer(marker: &std::path::Path) -> Command {
        let mut command = Command::new(crate::platform_tests::python());
        command
            .args([
                "-c",
                "import pathlib,sys;pathlib.Path(sys.argv[1]).write_bytes(b'owned')",
            ])
            .arg(marker);
        command
    }
    let input = Input::from_bytes(BODY, 100, &AtomicBool::new(false)).unwrap();
    let err = execute_command_input(
        marker_peer(&marker),
        input,
        &AtomicBool::new(true),
        Duration::from_secs(5),
    )
    .err()
    .unwrap();
    assert_eq!(err.code, "cancelled");
    assert!(!marker.exists());
    let input = Input::from_bytes(BODY, 100, &AtomicBool::new(false)).unwrap();
    input.file.as_ref().unwrap().set_len(1).unwrap();
    let err = execute_command_input(
        marker_peer(&marker),
        input,
        &AtomicBool::new(false),
        Duration::from_secs(5),
    )
    .err()
    .unwrap();
    assert_eq!(err.code, "changed");
    assert!(!marker.exists());
}
#[test]
fn common_file_output_path_retains_exact_input_and_original_output_limit_cleanup() {
    // Internal runner branch only, not a Windows public mutation-gate bypass.
    let cancel = AtomicBool::new(false);
    let input = Input::from_bytes(BODY, 100, &cancel).unwrap();
    let mut output = tempfile::tempfile().unwrap();
    let receipt = execute_bounded(
        peer(),
        Some(input),
        &cancel,
        Duration::from_secs(5),
        output.try_clone().unwrap(),
        1024,
        false,
    )
    .unwrap();
    assert!(receipt.success);
    assert!(receipt.bytes.is_empty());
    let mut bytes = Vec::new();
    output.rewind().unwrap();
    output.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, expected(BODY));
    let mut command = Command::new(crate::platform_tests::python());
    command.args([
        "-c",
        "import sys;sys.stdin.buffer.read();sys.stdout.buffer.write(b'x'*1025)",
    ]);
    assert_eq!(
        execute_bounded(
            command,
            Some(Input::from_bytes(BODY, 100, &cancel).unwrap()),
            &cancel,
            Duration::from_secs(5),
            tempfile::tempfile().unwrap(),
            1024,
            false
        )
        .err()
        .unwrap()
        .code,
        "tooLarge"
    );
}
