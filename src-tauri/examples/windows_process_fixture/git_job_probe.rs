//! Launch only the fixed Git command and lend its exact wait handle to the controller.
use std::{
    ffi::OsString,
    os::windows::{io::AsRawHandle, process::CommandExt},
    path::Path,
    process::{Command, Stdio},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, DuplicateHandle},
    System::Threading::{
        DETACHED_PROCESS, GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE,
        PROCESS_QUERY_INFORMATION, PROCESS_SYNCHRONIZE,
    },
};

pub(super) fn run(args: &[OsString]) {
    assert_eq!(args.len(), 4);
    let program = Path::new(&args[1]);
    assert!(program.is_absolute());
    let directory = Path::new(&args[2]);
    let controller_pid = args[3].to_str().unwrap().parse().unwrap();
    let controller = unsafe { OpenProcess(PROCESS_DUP_HANDLE, 0, controller_pid) };
    assert!(!controller.is_null(), "{}", std::io::Error::last_os_error());
    let mut git = Command::new(program)
        .args(["hash-object", "--stdin", "--no-filters"])
        .current_dir(directory)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "NUL")
        .creation_flags(DETACHED_PROCESS)
        .stdin(Stdio::inherit())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut duplicate = std::ptr::null_mut();
    let result = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            git.as_raw_handle(),
            controller,
            &mut duplicate,
            PROCESS_QUERY_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            0,
        )
    };
    unsafe { CloseHandle(controller) };
    assert_ne!(result, 0, "{}", std::io::Error::last_os_error());
    // Publish only after the controller owns the duplicate. The pipe keeps
    // the selected process alive while the controller checks its membership.
    let staging = directory.join("git-handle.staging");
    std::fs::write(&staging, (duplicate as usize).to_string()).unwrap();
    std::fs::rename(staging, directory.join("git-handle")).unwrap();
    assert!(git.wait().unwrap().success());
}
