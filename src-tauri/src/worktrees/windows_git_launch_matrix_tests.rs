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
