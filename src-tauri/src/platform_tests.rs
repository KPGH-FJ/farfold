//! Test-only OS receipts for owned synthetic subprocesses. Never a real Agent.

/// A temporary Python peer under an executable launch shape. The Windows stub
/// is the same owned launcher template used by installation, never an Agent.
pub(crate) fn python_peer(root: &std::path::Path, name: &str, code: &str) -> std::path::PathBuf {
    #[cfg(unix)]
    {
        let program = root.join(name);
        std::fs::write(&program, format!("#!/usr/bin/python3 -u\n{code}")).unwrap();
        crate::process_platform::set_executable(&program).unwrap();
        program
    }
    #[cfg(windows)]
    {
        let entry = root.join(format!("{name}-peer.py"));
        std::fs::write(&entry, code).unwrap();
        let (launcher, _) = crate::program_launch::create(
            root,
            std::path::Path::new(&python()),
            &entry,
            "synthetic-fixture",
        )
        .unwrap();
        let program = root.join(format!("{name}.exe"));
        std::fs::rename(launcher, &program).unwrap();
        program
    }
}

pub(crate) fn python() -> String {
    #[cfg(unix)]
    {
        "/usr/bin/python3".into()
    }
    #[cfg(windows)]
    {
        std::env::split_paths(&std::env::var_os("PATH").expect("test runner PATH"))
            .map(|directory| directory.join("python.exe"))
            .find(|path| path.is_file())
            .expect("the Windows test runner must provide Python 3 for synthetic ACP peers")
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }
}

pub(crate) fn process_check(pid: i32) -> i32 {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid, 0) }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{
                CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, GetLastError,
                WAIT_TIMEOUT,
            },
            System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
        };
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid as u32) };
        if handle.is_null() {
            return match unsafe { GetLastError() } {
                ERROR_INVALID_PARAMETER => -1,
                ERROR_ACCESS_DENIED => 0,
                code => panic!("owned process query failed: {code}"),
            };
        }
        let wait = unsafe { WaitForSingleObject(handle, 0) };
        unsafe {
            CloseHandle(handle);
        }
        if wait == WAIT_TIMEOUT {
            0
        } else if wait == 0 {
            -1
        } else {
            panic!("owned process wait failed: {wait}")
        }
    }
}

pub(crate) fn terminate(pid: i32) -> i32 {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid, libc::SIGTERM) }
    }
    #[cfg(windows)]
    {
        if !crate::windows_process::owns(pid as u32) {
            return -1;
        }
        crate::windows_process::terminate(pid as u32);
        0
    }
}
