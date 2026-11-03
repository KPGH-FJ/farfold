//! Synthetic OS-only fixture. Never loads an Agent, account or model.
#[cfg(windows)]
#[path = "windows_process_fixture/git_job_probe.rs"]
mod git_job_probe;
#[cfg(windows)]
#[path = "windows_process_fixture/manual_privileges.rs"]
mod manual_privileges;
#[cfg(windows)]
#[path = "../src/windows_process.rs"]
#[allow(dead_code)]
mod ownership;

#[cfg(windows)]
#[allow(clippy::zombie_processes)]
fn leave_descendant_after_leader_exit(marker: &std::ffi::OsStr) {
    // Deliberately do not wait: behavior_tests verifies the leader can exit
    // while a descendant remains owned, then terminates the parent's Job and
    // observes the descendant exiting.
    // Waiting here would remove the ownership failure this fixture detects.
    std::process::Command::new(std::env::current_exe().unwrap())
        .arg("wait")
        .arg(marker)
        .spawn()
        .unwrap();
}

#[cfg(windows)]
fn settlement_gate(directory: &std::path::Path, name: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while !directory.join(name).exists() {
        assert!(std::time::Instant::now() < deadline, "fixture gate expired");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

#[cfg(windows)]
fn stdout_eof(args: &[std::ffi::OsString]) {
    use std::io::Write;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{FILE_TYPE_PIPE, GetFileType},
        System::{
            Console::{GetStdHandle, STD_OUTPUT_HANDLE, SetStdHandle},
            Pipes::GetNamedPipeInfo,
        },
    };
    let directory = std::path::Path::new(&args[1]);
    let case = args[2].to_str().unwrap();
    assert!(matches!(case, "held-open" | "closed"));
    std::fs::write(
        directory.join("selected-pid"),
        std::process::id().to_string(),
    )
    .unwrap();
    // Only this synthetic selected process's own inherited pipe is eligible.
    // No stdout cache, duplicate writer, helper or foreign handle is touched.
    let output = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    assert!(!output.is_null() && output != INVALID_HANDLE_VALUE);
    assert_eq!(unsafe { GetFileType(output) }, FILE_TYPE_PIPE);
    assert_ne!(
        unsafe {
            GetNamedPipeInfo(
                output,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        },
        0
    );
    let closed = case == "closed";
    if closed {
        assert_ne!(
            unsafe { SetStdHandle(STD_OUTPUT_HANDLE, std::ptr::null_mut()) },
            0
        );
        assert_ne!(unsafe { CloseHandle(output) }, 0);
    }
    let mut stderr = std::io::stderr().lock();
    writeln!(
        stderr,
        "FARFOLD_STDIO_SELECTED {}",
        serde_json::json!({"case":case,"pipeConfirmed":true,"closeAttempted":closed,"closeSucceeded":closed})
    )
    .unwrap();
    stderr.flush().unwrap();
    drop(stderr);
    settlement_gate(directory, "stdout-release");
    std::process::exit(23);
}

#[cfg(windows)]
fn stdout_handoff_guards(directory: &std::path::Path) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, DuplicateHandle, ERROR_ACCESS_DENIED, GENERIC_WRITE, GetHandleInformation,
            GetLastError, HANDLE, HANDLE_FLAG_INHERIT, HANDLE_FLAG_PROTECT_FROM_CLOSE,
            INVALID_HANDLE_VALUE, SetHandleInformation,
        },
        Security::SECURITY_ATTRIBUTES,
        Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TYPE_PIPE,
            FILE_WRITE_DATA, GetFileType, OPEN_EXISTING, ReadFile, SYNCHRONIZE, WriteFile,
        },
        System::{
            Console::{
                GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, SetStdHandle,
            },
            Pipes::{CreatePipe, GetNamedPipeInfo},
            Threading::GetCurrentProcess,
        },
    };
    struct Owned(HANDLE);
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe {
                // Only fixture-created handles reach this owner. Clear our own
                // protected-case bit before their ordinary final cleanup.
                SetHandleInformation(self.0, HANDLE_FLAG_PROTECT_FROM_CLOSE, 0);
                CloseHandle(self.0);
            }
        }
    }
    fn slots() -> [HANDLE; 3] {
        unsafe {
            [
                GetStdHandle(STD_INPUT_HANDLE),
                GetStdHandle(STD_OUTPUT_HANDLE),
                GetStdHandle(STD_ERROR_HANDLE),
            ]
        }
    }
    struct RestoreSlots([HANDLE; 3]);
    impl Drop for RestoreSlots {
        fn drop(&mut self) {
            for (kind, handle) in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE]
                .into_iter()
                .zip(self.0)
            {
                assert_ne!(unsafe { SetStdHandle(kind, handle) }, 0);
            }
        }
    }
    fn flags(handle: HANDLE) -> Option<u32> {
        let mut value = 0;
        (unsafe { GetHandleInformation(handle, &mut value) } != 0).then_some(value)
    }
    fn pipe() -> (Owned, Owned) {
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };
        let mut read = std::ptr::null_mut();
        let mut write = std::ptr::null_mut();
        assert_ne!(
            unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) },
            0
        );
        (Owned(read), Owned(write))
    }
    fn pipe_query(handle: HANDLE) -> (bool, Option<u32>) {
        let ok = unsafe {
            GetNamedPipeInfo(
                handle,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } != 0;
        (ok, (!ok).then(|| unsafe { GetLastError() }))
    }
    fn observe(
        name: &str,
        output: HANDLE,
        expected: Option<bool>,
        reader: Option<HANDLE>,
        writable: bool,
    ) -> serde_json::Value {
        assert_ne!(unsafe { SetStdHandle(STD_OUTPUT_HANDLE, output) }, 0);
        let before = slots();
        let before_flags = before.map(flags);
        let file_type = unsafe { GetFileType(output) };
        let (query_ok, query_error) = pipe_query(output);
        let native_eligible = !output.is_null()
            && output != INVALID_HANDLE_VALUE
            && output != before[0]
            && output != before[2]
            && file_type == FILE_TYPE_PIPE
            && query_ok
            && before_flags[1].is_some_and(|value| value & HANDLE_FLAG_PROTECT_FROM_CLOSE == 0);
        let handoff = ownership::stdout_handoff::prepare();
        let prepared = handoff.is_some();
        let during_flags = slots().map(flags);
        let during_slots_unchanged = slots() == before;
        drop(handoff);
        let after_flags = slots().map(flags);
        let slots_unchanged = slots() == before;
        let flags_restored = before_flags == after_flags;
        let handles_retained = before_flags
            .iter()
            .zip(after_flags)
            .all(|(before, after)| before.is_none() || after.is_some());
        let prepared_flags_safe = if prepared {
            during_flags[0] == before_flags[0]
                && during_flags[2] == before_flags[2]
                && during_flags[1] == before_flags[1].map(|value| value & !HANDLE_FLAG_INHERIT)
        } else {
            during_flags == before_flags
        };
        let bytes = b"stdout-guard-write\n";
        let mut written = 0;
        let write_ok = writable.then(|| unsafe {
            WriteFile(
                output,
                bytes.as_ptr(),
                bytes.len() as u32,
                &mut written,
                std::ptr::null_mut(),
            ) != 0
                && written as usize == bytes.len()
        });
        let write_error = (write_ok == Some(false)).then(|| unsafe { GetLastError() });
        // Never issue a blocking read without the successful bounded write.
        let read_ok = reader.map(|read| {
            if write_ok != Some(true) {
                return false;
            }
            let mut actual = [0; 19];
            let mut count = 0;
            unsafe {
                ReadFile(
                    read,
                    actual.as_mut_ptr(),
                    bytes.len() as u32,
                    &mut count,
                    std::ptr::null_mut(),
                ) != 0
                    && count as usize == bytes.len()
                    && actual[..bytes.len()] == bytes[..]
            }
        });
        let passed = expected.is_none_or(|value| value == prepared)
            && during_slots_unchanged
            && slots_unchanged
            && flags_restored
            && handles_retained
            && prepared_flags_safe
            && write_ok.is_none_or(|value| value)
            && read_ok.is_none_or(|value| value);
        serde_json::json!({
            "case":name,"expectedPrepared":expected,"prepared":prepared,
            "nativeEligible":native_eligible,"stdoutEqualsStdin":output == before[0],
            "stdoutEqualsStderr":output == before[2],"outputHandleValid":before_flags[1].is_some(),
            "fileType":file_type,"pipeQuerySucceeded":query_ok,"pipeQueryError":query_error,
            "flagsBefore":before_flags,"flagsDuring":during_flags,"flagsAfter":after_flags,
            "slotsUnchangedDuring":during_slots_unchanged,"slotsUnchangedAfterDrop":slots_unchanged,
            "flagsRestored":flags_restored,"handlesRetained":handles_retained,
            "preparedFlagsSafe":prepared_flags_safe,"writeSucceeded":write_ok,"writeError":write_error,
            "pipeBytesReadBack":read_ok,"passed":passed
        })
    }
    // This process is the isolated native fixture, not the libtest process.
    // All slots below point only at its inherited or freshly owned handles.
    let original = slots();
    let restore = RestoreSlots(original);
    let (input, _input_write) = pipe();
    let (_error_read, error) = pipe();
    assert_ne!(unsafe { SetStdHandle(STD_INPUT_HANDLE, input.0) }, 0);
    assert_ne!(unsafe { SetStdHandle(STD_ERROR_HANDLE, error.0) }, 0);
    let mut cases = Vec::new();
    for inherit in [true, false] {
        let (read, write) = pipe();
        assert_ne!(
            unsafe {
                SetHandleInformation(
                    write.0,
                    HANDLE_FLAG_INHERIT,
                    if inherit { HANDLE_FLAG_INHERIT } else { 0 },
                )
            },
            0
        );
        cases.push(observe(
            if inherit {
                "exclusive-inheritable"
            } else {
                "exclusive-noninheritable"
            },
            write.0,
            Some(true),
            Some(read.0),
            true,
        ));
    }
    for alias in [STD_ERROR_HANDLE, STD_INPUT_HANDLE] {
        let (read, write) = pipe();
        let old = unsafe { GetStdHandle(alias) };
        assert_ne!(unsafe { SetStdHandle(alias, write.0) }, 0);
        cases.push(observe(
            if alias == STD_ERROR_HANDLE {
                "stdout-equals-stderr"
            } else {
                "stdout-equals-stdin"
            },
            write.0,
            Some(false),
            Some(read.0),
            true,
        ));
        assert_ne!(unsafe { SetStdHandle(alias, old) }, 0);
    }
    let nul_name: Vec<u16> = "NUL\0".encode_utf16().collect();
    let nul = unsafe {
        CreateFileW(
            nul_name.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    assert!(!nul.is_null() && nul != INVALID_HANDLE_VALUE);
    let nul = Owned(nul);
    cases.push(observe("nul", nul.0, Some(false), None, true));
    let file_path = directory.join("owned-output.bin");
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file_path)
        .unwrap();
    cases.push(observe(
        "ordinary-file",
        file.as_raw_handle().cast(),
        Some(false),
        None,
        true,
    ));
    drop(file);
    let file_read_back =
        std::fs::read(file_path).is_ok_and(|bytes| bytes == b"stdout-guard-write\n");
    let file_case = cases.last_mut().unwrap();
    file_case["fileBytesReadBack"] = serde_json::json!(file_read_back);
    if !file_read_back {
        file_case["passed"] = serde_json::json!(false);
    }
    cases.push(observe(
        "null",
        std::ptr::null_mut(),
        Some(false),
        None,
        false,
    ));
    cases.push(observe(
        "invalid",
        INVALID_HANDLE_VALUE,
        Some(false),
        None,
        false,
    ));
    let (read, protected) = pipe();
    assert_ne!(
        unsafe {
            SetHandleInformation(
                protected.0,
                HANDLE_FLAG_PROTECT_FROM_CLOSE,
                HANDLE_FLAG_PROTECT_FROM_CLOSE,
            )
        },
        0
    );
    cases.push(observe(
        "protect-from-close",
        protected.0,
        Some(false),
        Some(read.0),
        true,
    ));
    let (read, write) = pipe();
    let mut restricted = std::ptr::null_mut();
    assert_ne!(
        unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                write.0,
                GetCurrentProcess(),
                &mut restricted,
                FILE_WRITE_DATA | SYNCHRONIZE,
                1,
                0,
            )
        },
        0
    );
    let restricted = Owned(restricted);
    let (query_ok, query_error) = pipe_query(restricted.0);
    let denied = !query_ok && query_error == Some(ERROR_ACCESS_DENIED);
    let mut restricted_case = observe(
        "write-only-query-denied",
        restricted.0,
        denied.then_some(false),
        Some(read.0),
        true,
    );
    restricted_case["requestedAccess"] = serde_json::json!(FILE_WRITE_DATA | SYNCHRONIZE);
    restricted_case["negativePrerequisiteAvailable"] = serde_json::json!(denied);
    restricted_case["negativeStatus"] = serde_json::json!(if denied {
        "exercised"
    } else {
        "not-exercised-query-denial-unavailable"
    });
    if !denied {
        // A writable duplicate which remains queryable does not exercise the
        // denied-query branch. Preserve the actual facts and fail the group.
        restricted_case["passed"] = serde_json::json!(false);
    }
    cases.push(restricted_case);
    drop(restore);
    let original_slots_restored = slots() == original;
    let report = serde_json::json!({
        "schemaVersion":1,"fixture":"stdout-handoff-guards","caseCount":cases.len(),
        "requiredCaseCount":10,"queryDeniedCaseCount":1,
        "queryDeniedNegativeExercised":denied,"originalSlotsRestored":original_slots_restored,
        "cases":cases
    });
    use std::io::Write;
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join("stdout-handoff-guards.json"))
        .unwrap();
    serde_json::to_writer(&mut output, &report).unwrap();
    output.write_all(b"\n").unwrap();
    output.flush().unwrap();
}

#[cfg(windows)]
#[allow(clippy::zombie_processes)]
fn settlement_parent(args: &[std::ffi::OsString]) {
    let directory = std::path::Path::new(&args[1]);
    // The parent deliberately exits first. Only the executing test's original
    // Job owns this descendant; the fixture never opens or terminates a PID.
    std::process::Command::new(std::env::current_exe().unwrap())
        .arg("settlement-descendant")
        .arg(directory)
        .arg(&args[2])
        .spawn()
        .unwrap();
    settlement_gate(directory, "parent-release");
    println!("selected-output");
    std::process::exit(args[3].to_str().unwrap().parse().unwrap());
}

#[cfg(windows)]
fn settlement_descendant(args: &[std::ffi::OsString]) {
    use std::io::Write;
    let directory = std::path::Path::new(&args[1]);
    std::fs::write(
        directory.join("descendant-pid"),
        std::process::id().to_string(),
    )
    .unwrap();
    settlement_gate(directory, "descendant-release");
    match args[2].to_str().unwrap() {
        "tail" => println!("descendant-output"),
        "stdout" => std::io::stdout()
            .write_all(&vec![b'x'; 4 * 1024 * 1024 + 1])
            .unwrap(),
        "stderr" => std::io::stderr()
            .write_all(&vec![b'x'; 4 * 1024 * 1024 + 1])
            .unwrap(),
        "input" => {
            use std::os::windows::io::AsHandle;
            let file =
                std::fs::File::from(std::io::stdin().as_handle().try_clone_to_owned().unwrap());
            file.set_len(0).unwrap();
        }
        _ => panic!("unknown fixture action"),
    }
    std::fs::write(directory.join("action-complete"), "ready").unwrap();
    settlement_gate(directory, "finish-release");
}

#[cfg(windows)]
fn main() {
    // A synthetic-only barrier exercises cancellation before the trusted helper
    // opens/enters the Job. Production has no environment or timing test hook.
    let raw: Vec<_> = std::env::args_os().skip(1).collect();
    if raw
        .first()
        .is_some_and(|arg| arg == "manual-granted-privileges")
    {
        std::process::exit(manual_privileges::run(&raw));
    }
    if raw
        .first()
        .is_some_and(|arg| arg == "--farfold-owned-process")
        && raw.get(4).is_some_and(|arg| arg == "settlement-parent")
    {
        // Test-only handshake before the selected child can exit: the test
        // opens this exact live helper and holds its handle across exit.
        let directory = std::path::Path::new(&raw[5]);
        std::fs::write(directory.join("helper-pid"), std::process::id().to_string()).unwrap();
    }
    if raw
        .first()
        .is_some_and(|arg| arg == "--farfold-owned-process")
        && raw
            .get(raw.len().saturating_sub(2))
            .is_some_and(|arg| arg == "--fixture-delay-helper")
    {
        let ready = std::path::Path::new(raw.last().unwrap());
        std::fs::write(ready, "waiting before Job entry").unwrap();
        while ready.exists() {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    if let Some(code) = ownership::run_if_requested() {
        std::process::exit(code);
    }
    let mut args: Vec<_> = std::env::args_os().skip(1).collect();
    let entry = args
        .first()
        .filter(|path| {
            std::path::Path::new(path)
                .extension()
                .is_some_and(|extension| extension == "ff-node-fixture")
        })
        .cloned();
    if entry.is_some() {
        args.remove(0);
    }
    if args.first().is_some_and(|arg| arg == "--version") {
        println!("{}", if entry.is_some() { "1.0.0" } else { "v22.20.0" });
        return;
    }
    match args.first().and_then(|v| v.to_str()) {
        Some("git-job-probe") => git_job_probe::run(&args),
        Some("wait") => {
            std::fs::write(&args[1], std::process::id().to_string()).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
        Some("orphan") => {
            leave_descendant_after_leader_exit(&args[1]);
        }
        Some("settlement-parent") => settlement_parent(&args),
        Some("settlement-descendant") => settlement_descendant(&args),
        Some("stdout-eof") => stdout_eof(&args),
        Some("stdout-handoff-guards") => stdout_handoff_guards(std::path::Path::new(&args[1])),
        Some("parent") => {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command.arg("wait").arg(&args[1]);
            let pending = ownership::prepare_command(&mut command).unwrap();
            let mut child = command.spawn().unwrap();
            let _group = pending
                .attach_or_reap(Some(child.id()), || {
                    let _ = child.kill();
                    matches!(child.try_wait(), Ok(Some(_)))
                })
                .unwrap();
            std::fs::write(&args[2], "ready").unwrap();
            let _ = child.wait();
        }
        Some("argv") => {
            let mut input = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut input).unwrap();
            println!(
                "{}",
                serde_json::json!({"entry":entry.as_ref().map(|path|path.to_string_lossy()),"args":args.iter().skip(1).map(|s|s.to_string_lossy()).collect::<Vec<_>>(),"input":input,"cwd":std::env::current_dir().unwrap(),"env":std::env::var("FIXTURE_LITERAL").unwrap_or_default()})
            );
            std::process::exit(23);
        }
        Some("install-error") => {
            eprintln!(
                "npm error code EACCES\nAuthorization: Bearer fixture-secret\nhttps://user:password@example.invalid/private?token=secret"
            );
            std::process::exit(13);
        }
        Some("install-large-error") => {
            for _ in 0..10_000 {
                eprintln!("untrusted-output-and-secret-value");
            }
            eprintln!("npm ERR! code ENOSPC");
            std::process::exit(1);
        }
        _ => std::process::exit(125),
    }
}
#[cfg(not(windows))]
fn main() {}
