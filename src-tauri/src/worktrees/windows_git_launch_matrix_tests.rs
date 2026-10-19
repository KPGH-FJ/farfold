//! Owned path-representation observations only; never ReadContext admission.
//! The existing Git executor remains the sole Child/direct-Job owner.
use super::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    fs,
    io::{self, Read, Seek, SeekFrom},
};

#[derive(Default, Serialize)]
struct Observation {
    child_reaped: bool,
    direct_job_inactive: bool,
    original_output_cap_checks_passed: bool,
    input_mode: &'static str,
    owned_wrapper_exit: Option<i32>,
    stderr_observed: bool,
    stderr_prefix_bytes: usize,
    stderr_prefix_sha256: String,
    stderr_prefix_truncated: bool,
    stderr_observation_error: Option<i32>,
    stderr_class: &'static str,
    launcher_phase: Option<&'static str>,
    launcher_native_error: Option<i32>,
}
thread_local! {
    // Test-local and synchronous; no worker, environment flag or runtime map.
    static OBSERVATION: RefCell<Option<Observation>> = const { RefCell::new(None) };
}
fn active() -> bool {
    OBSERVATION
        .try_with(|cell| cell.try_borrow().is_ok_and(|value| value.is_some()))
        .unwrap_or(false)
}
fn classify_prefix(bytes: &[u8]) -> (&'static str, Option<&'static str>, Option<i32>) {
    if bytes.is_empty() {
        return ("empty", None, None);
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return ("otherRedacted", None, None);
    };
    let mut lines = text.lines();
    if lines.next() != Some("无法启动所选程序") {
        return ("otherRedacted", None, None);
    }
    let Some(line) = lines.next() else {
        return ("launcher", None, None);
    };
    for (prefix, phase) in [
        ("准备启动参数时失败，", "prepare"),
        ("加入进程保护时失败，", "enterJob"),
        ("执行或等待程序时失败，", "executeOrWait"),
    ] {
        if let Some(rest) = line.strip_prefix(prefix) {
            let code = rest
                .strip_prefix("系统错误：")
                .and_then(|value| value.parse::<i32>().ok());
            return ("launcher", Some(phase), code);
        }
    }
    ("launcher", None, None)
}
// A read-only test observer: no extra stderr work for any other Git call.
// The original nonzero stderr diagnostic block remains entirely unchanged.
pub(in crate::worktrees) fn observe_settlement(
    code: Option<i32>,
    typed_input: bool,
    stderr: &fs::File,
) {
    if !active() {
        return;
    }
    let sample = (|| -> io::Result<Vec<u8>> {
        let mut reader = stderr.try_clone()?;
        reader.seek(SeekFrom::Start(0))?;
        let mut sample = Vec::new();
        reader.take(513).read_to_end(&mut sample)?;
        Ok(sample)
    })();
    settled(code, typed_input, &sample);
}
// Called ONLY after the original executor observed/reaped the same Child,
// reached inactive direct Job, checked input and passed existing file caps.
// These are the facts of that exact branch, not new native queries or pipe EOF.
fn settled(code: Option<i32>, typed_input: bool, sample: &io::Result<Vec<u8>>) {
    let _ = OBSERVATION.try_with(|cell| {
        let Ok(mut value) = cell.try_borrow_mut() else {
            return;
        };
        let Some(value) = value.as_mut() else {
            return;
        };
        value.child_reaped = true;
        value.direct_job_inactive = true;
        value.original_output_cap_checks_passed = true;
        value.input_mode = if typed_input {
            "typedPrivateInputVerified"
        } else {
            "originalNullStdin"
        };
        value.owned_wrapper_exit = code;
        match sample {
            Ok(bytes) => {
                let prefix = &bytes[..bytes.len().min(512)];
                let (class, phase, native_error) = classify_prefix(prefix);
                value.stderr_observed = true;
                value.stderr_prefix_bytes = prefix.len();
                value.stderr_prefix_sha256 =
                    super::super::material_scan::hex(Sha256::digest(prefix));
                value.stderr_prefix_truncated = bytes.len() > prefix.len();
                value.stderr_class = class;
                value.launcher_phase = phase;
                value.launcher_native_error = native_error;
            }
            Err(error) => value.stderr_observation_error = error.raw_os_error(),
        }
    });
}
struct Capture;
impl Capture {
    fn begin() -> Self {
        OBSERVATION.with(|cell| {
            let mut value = cell.borrow_mut();
            assert!(
                value.is_none(),
                "one synchronous matrix observation at a time"
            );
            *value = Some(Observation::default());
        });
        Self
    }
    fn finish(self) -> Option<Observation> {
        OBSERVATION.with(|cell| cell.borrow_mut().take())
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        let _ = OBSERVATION.try_with(|cell| {
            if let Ok(mut value) = cell.try_borrow_mut() {
                *value = None;
            }
        });
    }
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum Form {
    Guid,
    Dos,
}
impl Form {
    fn label(self) -> &'static str {
        match self {
            Self::Guid => "G",
            Self::Dos => "D",
        }
    }
}
fn selected_path(pin: &PinnedPath, form: Form) -> &Path {
    match form {
        Form::Guid => &pin.guid_path,
        Form::Dos => Path::new(&pin.path),
    }
}
struct Owned {
    scope: Scope,
    program: PinnedPath,
    dos: Vec<PinnedPath>,
    // Drop/remove the owned directory only after all pins have been dropped.
    temporary: tempfile::TempDir,
}
impl Owned {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let git = root.join(".git");
        for path in [git.join("objects"), git.join("refs/heads")] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(git.join("HEAD"), b"ref: refs/heads/owned\n").unwrap();
        fs::write(
            git.join("config"),
            b"[core]\n repositoryformatversion = 0\n bare = false\n",
        )
        .unwrap();
        let scope = Scope::open(&root).unwrap();
        // Same original selector once; never substitute a different program.
        // Deliberately not ReadContext::open or a claim it has succeeded.
        let program = executable(&scope).unwrap();
        let mut dos = vec![PinnedPath::regular(Path::new(&program.path)).unwrap()];
        for pin in [&scope.root, &scope.git, &scope.common] {
            dos.push(PinnedPath::git_directory(Path::new(&pin.path)).unwrap());
        }
        let owner = Self {
            scope,
            program,
            dos,
            temporary,
        };
        owner.verify().unwrap();
        owner
    }
    fn verify(&self) -> Result<()> {
        self.scope.verify()?;
        if self.dos.len() != 4 {
            return Err(error("changed"));
        }
        let originals = [
            &self.program,
            &self.scope.root,
            &self.scope.git,
            &self.scope.common,
        ];
        for (original, dos) in originals.into_iter().zip(&self.dos) {
            original.verify().map_err(|_| error("changed"))?;
            dos.verify().map_err(|_| error("changed"))?;
            let left = crate::file_access::stamp(original.file()).map_err(|_| error("changed"))?;
            let right = crate::file_access::stamp(dos.file()).map_err(|_| error("changed"))?;
            if left.identity != *original.identity() || right.identity != left.identity {
                return Err(error("changed"));
            }
        }
        Ok(())
    }
    fn command(&self, program: Form, cwd: Form, args: Form) -> Command {
        let mut command = Command::new(selected_path(&self.program, program));
        command
            .env("GIT_NO_LAZY_FETCH", "1")
            // Deliberately fixed across all eight cells: not a fourth variable.
            .env("GIT_COMMON_DIR", &self.scope.common.guid_path)
            .args(["--no-pager", "--no-replace-objects", "-c"])
            .arg(format!(
                "core.hooksPath={}",
                selected_path(&self.program, args).display()
            ))
            .args([
                "-c",
                "core.fsmonitor=false",
                "-c",
                "maintenance.auto=false",
                "-c",
                "gc.auto=0",
                "-c",
                "submodule.recurse=false",
                "-c",
                "worktree.guessRemote=false",
                "-c",
                "credential.helper=",
            ])
            .arg("--git-dir")
            .arg(selected_path(&self.scope.git, args))
            .arg("--work-tree")
            .arg(selected_path(&self.scope.root, args))
            .arg("-C")
            .arg(selected_path(&self.scope.root, args))
            .args(["config", "--get", "core.worktree"])
            .current_dir(selected_path(&self.scope.root, cwd))
            .stdin(Stdio::null());
        command
    }
    fn close(self) -> std::result::Result<(), Option<i32>> {
        let Self {
            scope,
            program,
            dos,
            temporary,
        } = self;
        drop((scope, program, dos));
        temporary.close().map_err(|error| error.raw_os_error())
    }
}
struct KeepOnUnknown(Option<Owned>);
impl Drop for KeepOnUnknown {
    fn drop(&mut self) {
        // One test-local source/fixture only, not another process controller.
        // Any panic/unknown prevents source cleanup and further matrix launch.
        if let Some(owner) = self.0.take() {
            std::mem::forget(owner);
        }
    }
}
#[derive(Serialize)]
struct Cell {
    id: String,
    program: Form,
    cwd: Form,
    path_args: Form,
    full_identity_precheck: bool,
    full_identity_postcheck: bool,
    executor_error: Option<&'static str>,
    returned_code: Option<i32>,
    stdout_bytes: Option<usize>,
    owner: Option<Observation>,
    observation_complete: bool,
}
#[test]
fn owned_same_program_path_matrix_observes_original_executor_without_granting_admission() {
    let mut held = KeepOnUnknown(Some(Owned::new()));
    let mut cells = Vec::with_capacity(8);
    let forms = [Form::Guid, Form::Dos];
    'matrix: for program in forms {
        for cwd in forms {
            for path_args in forms {
                let owner = held.0.as_ref().expect("retained source owner");
                let id = format!("{}{}{}", program.label(), cwd.label(), path_args.label());
                let pre = owner.verify().is_ok();
                if !pre {
                    cells.push(Cell {
                        id,
                        program,
                        cwd,
                        path_args,
                        full_identity_precheck: false,
                        full_identity_postcheck: false,
                        executor_error: Some("preflightChanged"),
                        returned_code: None,
                        stdout_bytes: None,
                        owner: None,
                        observation_complete: false,
                    });
                    break 'matrix;
                }
                super::super::git::environment().unwrap();
                let capture = Capture::begin();
                // EXACT original executor, null branch and ten-second timeout.
                let result = super::super::git::execute_command(
                    owner.command(program, cwd, path_args),
                    &AtomicBool::new(false),
                    Duration::from_secs(10),
                );
                let observation = capture.finish();
                let post = owner.verify().is_ok();
                let complete = observation.as_ref().is_some_and(|value| {
                    value.child_reaped
                        && value.direct_job_inactive
                        && value.stderr_observed
                        && value.original_output_cap_checks_passed
                        && value.input_mode == "originalNullStdin"
                }) && post;
                let (executor_error, returned_code, stdout_bytes) = match result {
                    Ok(output) => (None, output.code, Some(output.bytes.len())),
                    Err(error) => (Some(error.code), None, None),
                };
                cells.push(Cell {
                    id,
                    program,
                    cwd,
                    path_args,
                    full_identity_precheck: true,
                    full_identity_postcheck: post,
                    executor_error,
                    returned_code,
                    stdout_bytes,
                    owner: observation,
                    observation_complete: complete,
                });
                if !complete {
                    break 'matrix;
                }
            }
        }
    }
    let all_cells_complete = cells.len() == 8 && cells.iter().all(|cell| cell.observation_complete);
    let (fixture_cleanup, fixture_cleanup_error) = if all_cells_complete {
        match held.0.take().expect("same owner").close() {
            Ok(()) => ("knownRemoved", None),
            Err(code) => ("failed", code),
        }
    } else {
        ("retainedUnknown", None)
    };
    let complete = all_cells_complete && fixture_cleanup == "knownRemoved";
    eprintln!(
        "FARFOLD_WINDOWS_GIT_LAUNCH_MATRIX {}",
        serde_json::json!({
            "schema": 1, "case": "OwnedSameProgramPathMatrix", "cells": cells,
            "fixtureCleanup": fixture_cleanup, "fixtureCleanupError": fixture_cleanup_error,
            "observationComplete": complete, "commonDirEnvironmentForm": "fixedGuid",
            "readContextAdmissionProven": false, "existingFailureFixed": false,
            "productOrAllWindowsComplete": false, "newProcessController": false,
        })
    );
    assert!(
        complete,
        "matrix observation incomplete; existing launch failure is unchanged"
    );
}

// Five fixed observations, not a new Git admission path or a fallback.
#[test]
fn owned_same_program_known_config_extended_plain_observations_preserve_original_owner() {
    use std::{ffi::OsString, path::PathBuf};

    const CASE: &str = "OwnedSameProgramKnownConfigExtendedPlain";
    const CONFIG: &[u8] = b"[core]\n repositoryformatversion = 0\n bare = false\n";

    struct PlainPair {
        original: fs::File,
        alias: PinnedPath,
        plain: PathBuf,
        guid: PathBuf,
        before: crate::file_access::Stamp,
    }
    impl PlainPair {
        fn path(extended: &str) -> Result<PathBuf> {
            // Strip ONLY the exact local, absolute extended drive prefix.
            // No GUID/UNC/device, slash, dot, empty, ADS or trailing-dot rewrite.
            let text = extended.strip_prefix(r"\\?\").ok_or(error("changed"))?;
            let bytes = text.as_bytes();
            if text.contains('/')
                || bytes.len() < 4
                || !bytes[0].is_ascii_alphabetic()
                || bytes[1] != b':'
                || bytes[2] != b'\\'
                || text[3..]
                    .split('\\')
                    .any(|part| part.is_empty() || part == "." || part == "..")
            {
                return Err(error("changed"));
            }
            let plain = PathBuf::from(text);
            crate::file_access::absolute(&plain).map_err(|_| error("changed"))?;
            Ok(plain)
        }
        fn new(pin: &PinnedPath) -> Result<Self> {
            pin.verify().map_err(|_| error("changed"))?;
            let plain = Self::path(&pin.path)?;
            let before = crate::file_access::stamp(pin.file()).map_err(|_| error("changed"))?;
            let alias = Self::reopen(&plain, before.regular)?;
            let value = Self {
                original: pin.file().try_clone().map_err(|_| error("changed"))?,
                alias,
                plain,
                guid: pin.guid_path.clone(),
                before,
            };
            value.verify()?;
            Ok(value)
        }
        fn reopen(path: &Path, regular: bool) -> Result<PinnedPath> {
            let pin = if regular {
                PinnedPath::regular(path)
            } else {
                PinnedPath::git_directory(path)
            };
            pin.map_err(|_| error("changed"))
        }
        fn verify(&self) -> Result<()> {
            self.alias.verify().map_err(|_| error("changed"))?;
            let original =
                crate::file_access::stamp(&self.original).map_err(|_| error("changed"))?;
            let alias =
                crate::file_access::stamp(self.alias.file()).map_err(|_| error("changed"))?;
            let fresh = Self::reopen(&self.plain, self.before.regular)?;
            if original != self.before
                || alias != original
                || fresh.guid_path != self.guid
                || self.alias.guid_path != self.guid
                || crate::file_access::stamp(fresh.file()).map_err(|_| error("changed"))?
                    != original
            {
                return Err(error("changed"));
            }
            Ok(())
        }
    }
    struct Fixture {
        owned: Owned,
        // program/root/git/common/config, all retain the original objects.
        pairs: Vec<PlainPair>,
        config: PinnedPath,
    }
    impl Fixture {
        fn new() -> Self {
            let owned = Owned::new();
            let config =
                PinnedPath::regular(Path::new(&owned.scope.git.path).join("config").as_path())
                    .unwrap();
            let pins = [
                &owned.program,
                &owned.scope.root,
                &owned.scope.git,
                &owned.scope.common,
                &config,
            ];
            let pairs = pins
                .into_iter()
                .map(PlainPair::new)
                .collect::<Result<Vec<_>>>()
                .unwrap();
            let value = Self {
                owned,
                pairs,
                config,
            };
            value.verify().unwrap();
            value
        }
        fn verify(&self) -> Result<()> {
            self.owned.verify()?;
            self.config.verify().map_err(|_| error("changed"))?;
            if self.pairs.len() != 5 {
                return Err(error("changed"));
            }
            for pair in &self.pairs {
                pair.verify()?;
            }
            let mut config = self
                .config
                .file()
                .try_clone()
                .map_err(|_| error("changed"))?;
            config
                .seek(SeekFrom::Start(0))
                .map_err(|_| error("changed"))?;
            let mut bytes = Vec::new();
            config
                .take(4097)
                .read_to_end(&mut bytes)
                .map_err(|_| error("changed"))?;
            if bytes != CONFIG {
                return Err(error("changed"));
            }
            Ok(())
        }
        fn command(&self, call: usize) -> Command {
            assert!(call < 5);
            // Retain every original fixed prefix/explicit env entry. Only the
            // already-held path representation and this fixed diagnostic tail vary.
            let base = self.owned.command(Form::Dos, Form::Dos, Form::Dos);
            let mut args: Vec<OsString> = base.get_args().map(OsString::from).collect();
            assert!(args.ends_with(&["config".into(), "--get".into(), "core.worktree".into()]));
            args.truncate(args.len() - 3);
            let old_hook = format!("core.hooksPath={}", self.owned.program.path);
            let hook = args
                .iter()
                .position(|arg| arg.as_os_str() == std::ffi::OsStr::new(&old_hook))
                .unwrap();
            args[hook] = format!("core.hooksPath={}", self.pairs[0].plain.display()).into();
            for (flag, pair) in [("--git-dir", 2), ("--work-tree", 1), ("-C", 1)] {
                let index = args
                    .iter()
                    .position(|arg| arg.as_os_str() == std::ffi::OsStr::new(flag))
                    .unwrap();
                args[index + 1] = self.pairs[pair].plain.clone().into_os_string();
            }
            let mut command = Command::new(&self.pairs[0].plain);
            for (key, value) in base.get_envs() {
                match value {
                    Some(value) => {
                        command.env(key, value);
                    }
                    None => {
                        command.env_remove(key);
                    }
                }
            }
            command
                .args(args)
                .env(
                    "GIT_COMMON_DIR",
                    if call == 3 {
                        Path::new(&self.owned.scope.common.path)
                    } else {
                        &self.pairs[3].plain
                    },
                )
                .current_dir(&self.pairs[1].plain)
                .stdin(Stdio::null());
            match call {
                0 => {
                    command.arg("--version");
                }
                1 | 2 => {
                    command
                        .args(["config", "--type=bool", "--file"])
                        .arg(if call == 1 {
                            Path::new(&self.config.path)
                        } else {
                            &self.pairs[4].plain
                        })
                        .args(["--get", "core.bare"]);
                }
                3 | 4 => {
                    command.args(["config", "--type=bool", "--get", "core.bare"]);
                }
                _ => unreachable!(),
            }
            command
        }
        fn close(self) -> std::result::Result<(), Option<i32>> {
            let Self {
                owned,
                pairs,
                config,
            } = self;
            drop((pairs, config));
            owned.close()
        }
    }
    struct Retained(Option<Fixture>);
    impl Drop for Retained {
        fn drop(&mut self) {
            if let Some(owner) = self.0.take() {
                // Includes every new alias/config pin, not just the old Owned.
                std::mem::forget(owner);
            }
        }
    }

    for rejected in [
        r"\\?\Volume{00000000-0000-0000-0000-000000000000}\owned",
        r"\\?\UNC\server\share\owned",
        r"\\.\C:\owned",
        r"\\?\C:relative",
        r"\\?\C:\a\..\b",
        r"\\?\C:\a\\b",
        r"\\?\C:\a/b",
        r"\\?\C:\a.",
        r"\\?\C:\a:stream",
        r"\\?\C:\CON",
    ] {
        assert!(
            PlainPair::path(rejected).is_err(),
            "plain conversion must fail closed"
        );
    }
    let mut held = Retained(Some(Fixture::new()));
    let paired_objects = held
        .0
        .as_ref()
        .unwrap()
        .pairs
        .iter()
        .zip(["selectedProgram", "root", "git", "common", "ownedConfig"])
        .map(|(pair, role)| {
            serde_json::json!({
                "case": CASE, "role": role, "volume": pair.before.identity.device,
                "fileId128": format!("{:032x}", pair.before.identity.inode),
                "size": pair.before.size, "modified": pair.before.modified,
                "changed": pair.before.changed, "links": pair.before.links,
                "regular": pair.before.regular,
            })
        })
        .collect::<Vec<_>>();
    let mut calls = Vec::with_capacity(5);
    let mut plain_file_false = false;
    let mut plain_common_false = false;
    let mut version_recorded = false;
    let labels = [
        "selectedVersion",
        "fileExtended",
        "filePlain",
        "commonExtended",
        "commonPlain",
    ];
    for (index, label) in labels.into_iter().enumerate() {
        let owner = held.0.as_ref().expect("same retained fixture");
        let pre = owner.verify().is_ok();
        if !pre {
            calls.push(
                serde_json::json!({"case": CASE, "order": index + 1, "call": label,
                "fullIdentityAndStampPrecheck": false, "observationComplete": false}),
            );
            break;
        }
        super::super::git::environment().unwrap();
        eprintln!(
            "FARFOLD_WINDOWS_GIT_KNOWN_CONFIG_CALL {}",
            serde_json::json!({
                "case": CASE, "order": index + 1, "call": label, "phase": "beforeOriginalExecutor",
            })
        );
        let capture = Capture::begin();
        let result = super::super::git::execute_command(
            owner.command(index),
            &AtomicBool::new(false),
            Duration::from_secs(10),
        );
        let observation = capture.finish();
        let post = owner.verify().is_ok();
        let complete = observation.as_ref().is_some_and(|value| {
            value.child_reaped
                && value.direct_job_inactive
                && value.stderr_observed
                && value.original_output_cap_checks_passed
                && value.input_mode == "originalNullStdin"
        }) && post
            && result.as_ref().is_ok_and(|output| {
                observation
                    .as_ref()
                    .is_some_and(|value| value.owned_wrapper_exit == output.code)
            });
        let (executor_error, code, bytes, sha, public_value, known_false) = match &result {
            Ok(output) => {
                let known_false = output.success
                    && output.code == Some(0)
                    && matches!(output.bytes.as_slice(), b"false\n" | b"false\r\n");
                let public_value = if index == 0
                    && output.success
                    && output.code == Some(0)
                    && output.bytes.len() <= 128
                {
                    std::str::from_utf8(&output.bytes)
                        .ok()
                        .filter(|text| {
                            text.starts_with("git version ")
                                && text
                                    .trim_end_matches(['\r', '\n'])
                                    .chars()
                                    .all(|c| c.is_ascii_alphanumeric() || " .+-_()".contains(c))
                        })
                        .map(str::to_owned)
                } else {
                    None
                };
                (
                    None,
                    output.code,
                    Some(output.bytes.len()),
                    Some(super::super::material_scan::hex(Sha256::digest(
                        &output.bytes,
                    ))),
                    public_value,
                    known_false,
                )
            }
            Err(error) => (Some(error.code), None, None, None, None, false),
        };
        if index == 0 {
            version_recorded = public_value.is_some();
        }
        if index == 2 {
            plain_file_false = known_false;
        }
        if index == 4 {
            plain_common_false = known_false;
        }
        calls.push(serde_json::json!({
            "case": CASE, "order": index + 1, "call": label,
            "programForm": "pairedPlain", "cwdForm": "pairedPlain",
            "contextPathArgsForm": "pairedPlain",
            "commonDirForm": if index == 3 { "heldExtendedDrive" } else { "pairedPlain" },
            "fullIdentityAndStampPrecheck": pre, "fullIdentityAndStampPostcheck": post,
            "executorError": executor_error, "returnedCode": code,
            "stdoutBytes": bytes, "stdoutSha256": sha, "selectedVersionObservation": public_value,
            "knownOwnedConfigFalse": known_false, "owner": observation, "observationComplete": complete,
        }));
        eprintln!(
            "FARFOLD_WINDOWS_GIT_KNOWN_CONFIG_CALL {}",
            serde_json::json!({
                "case": CASE, "order": index + 1, "call": label, "phase": "afterOriginalExecutor",
                "facts": calls.last(),
            })
        );
        if !complete {
            break;
        }
    }
    let all_observed =
        calls.len() == 5 && calls.iter().all(|call| call["observationComplete"] == true);
    let (cleanup, cleanup_error) = if all_observed {
        match held.0.take().expect("same owner").close() {
            Ok(()) => ("knownRemoved", None),
            Err(code) => ("failed", code),
        }
    } else {
        ("retainedUnknown", None)
    };
    eprintln!(
        "FARFOLD_WINDOWS_GIT_KNOWN_CONFIG {}",
        serde_json::json!({
            "schema": 1, "case": CASE, "calls": calls, "pairedObjects": paired_objects,
            "fixtureCleanup": cleanup,
            "fixtureCleanupError": cleanup_error, "observationComplete": all_observed,
            "plainFileKnownFalse": plain_file_false, "plainCommonKnownFalse": plain_common_false,
            "selectedVersionRecorded": version_recorded, "versionPinned": false,
            "readContextAdmissionProven": false, "existingFailureFixed": false,
        })
    );
    assert!(
        all_observed && cleanup == "knownRemoved",
        "five-call owner observation incomplete"
    );
    assert!(
        version_recorded,
        "same selected program did not report its public version"
    );
    assert!(
        plain_file_false,
        "owned plain --file config must actually return exit 0 and false"
    );
    assert!(
        plain_common_false,
        "owned plain common-dir config must actually return exit 0 and false"
    );
}
