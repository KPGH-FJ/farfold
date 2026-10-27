//! Synthetic OS-only fixture. Never loads an Agent, account or model.
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
