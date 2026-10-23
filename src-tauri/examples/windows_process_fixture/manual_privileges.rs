//! Explicit owned manual tests only. Never linked into the desktop product.
//! Enable an already granted right in a distinct suspended test child's token;
//! never adjust the launcher/ordinary-test token or an account/security policy.
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    io,
    mem::size_of,
    os::windows::{ffi::OsStrExt, io::AsRawHandle},
    path::Path,
    ptr,
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, GetLastError, HANDLE,
        INVALID_HANDLE_VALUE, LUID, SetLastError, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    Security::{
        AdjustTokenPrivileges, GetTokenInformation, LookupPrivilegeValueW, SE_PRIVILEGE_ENABLED,
        TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY, TOKEN_STATISTICS, TokenPrivileges,
        TokenStatistics,
    },
    System::{
        Console::{GetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE},
        Threading::{
            CREATE_SUSPENDED, CreateProcessW, GetCurrentProcess, GetExitCodeProcess, INFINITE,
            OpenProcessToken, PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES,
            STARTUPINFOW, TerminateProcess, WaitForSingleObject,
        },
    },
};

const MARKER: &str = "FARFOLD_MANUAL_GRANTED_PRIVILEGES";
const MANUAL_TIMEOUT_MS: u32 = 300_000;
const NAMES: [&str; 3] = [
    "SeSecurityPrivilege",
    "SeBackupPrivilege",
    "SeRestorePrivilege",
];
type Privileges = BTreeMap<(i32, u32), u32>;
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct Token {
    handle: Handle,
    id: (i32, u32),
    privileges: Privileges,
}
fn failure(phase: &'static str) -> io::Error {
    io::Error::other(phase)
}
fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut raw: Vec<_> = value.encode_wide().collect();
    if raw.is_empty() || raw.len() > 32_000 || raw.contains(&0) {
        return Err(failure("invalidOwnedArgument"));
    }
    raw.push(0);
    Ok(raw)
}
fn luid(name: &str) -> io::Result<LUID> {
    let name = wide(OsStr::new(name))?;
    let mut id = LUID::default();
    if unsafe { LookupPrivilegeValueW(ptr::null(), name.as_ptr(), &mut id) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(id)
}
fn table(token: HANDLE) -> io::Result<Privileges> {
    let mut length = 0;
    unsafe {
        GetTokenInformation(token, TokenPrivileges, ptr::null_mut(), 0, &mut length);
    }
    if length < size_of::<u32>() as u32 || length > 65_536 {
        return Err(failure("tokenPrivilegeLength"));
    }
    let mut buffer = vec![0u64; (length as usize).div_ceil(size_of::<u64>())];
    let capacity = length;
    if unsafe {
        GetTokenInformation(
            token,
            TokenPrivileges,
            buffer.as_mut_ptr().cast(),
            capacity,
            &mut length,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if length > capacity {
        return Err(failure("tokenPrivilegeChangedLength"));
    }
    let raw = buffer.as_ptr().cast::<TOKEN_PRIVILEGES>();
    let count = unsafe { (*raw).PrivilegeCount } as usize;
    let offset = std::mem::offset_of!(TOKEN_PRIVILEGES, Privileges);
    let entry_size = size_of::<windows_sys::Win32::Security::LUID_AND_ATTRIBUTES>();
    if count > 1024
        || count
            .checked_mul(entry_size)
            .and_then(|n| offset.checked_add(n))
            .is_none_or(|n| n > length as usize)
    {
        return Err(failure("tokenPrivilegeShape"));
    }
    let entries = unsafe {
        std::slice::from_raw_parts(
            ptr::addr_of!((*raw).Privileges)
                .cast::<windows_sys::Win32::Security::LUID_AND_ATTRIBUTES>(),
            count,
        )
    };
    let mut result = BTreeMap::new();
    for entry in entries {
        if result
            .insert((entry.Luid.HighPart, entry.Luid.LowPart), entry.Attributes)
            .is_some()
        {
            return Err(failure("tokenPrivilegeDuplicate"));
        }
    }
    Ok(result)
}
fn open_token(process: HANDLE, adjust: bool) -> io::Result<Token> {
    let mut raw = ptr::null_mut();
    if unsafe {
        OpenProcessToken(
            process,
            TOKEN_QUERY | if adjust { TOKEN_ADJUST_PRIVILEGES } else { 0 },
            &mut raw,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let handle = Handle(raw);
    let mut statistics = TOKEN_STATISTICS::default();
    let mut length = 0;
    if unsafe {
        GetTokenInformation(
            handle.0,
            TokenStatistics,
            (&mut statistics as *mut TOKEN_STATISTICS).cast(),
            size_of::<TOKEN_STATISTICS>() as u32,
            &mut length,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if length as usize != size_of::<TOKEN_STATISTICS>() {
        return Err(failure("tokenStatisticsShape"));
    }
    let privileges = table(handle.0)?;
    Ok(Token {
        handle,
        id: (statistics.TokenId.HighPart, statistics.TokenId.LowPart),
        privileges,
    })
}
fn states(privileges: &Privileges) -> io::Result<serde_json::Value> {
    let mut values = serde_json::Map::new();
    for name in NAMES {
        let id = luid(name)?;
        let attributes = privileges.get(&(id.HighPart, id.LowPart));
        values.insert(
            name.into(),
            serde_json::json!({
                "present": attributes.is_some(),
                "enabled": attributes.is_some_and(|value| value & SE_PRIVILEGE_ENABLED != 0),
                "attributes": attributes,
            }),
        );
    }
    Ok(values.into())
}
struct Child {
    process: Handle,
    thread: Handle,
    done: bool,
}
fn inherited(handle: HANDLE) -> io::Result<Handle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(failure("inheritedStandardHandleUnavailable"));
    }
    let mut duplicate = ptr::null_mut();
    if unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            handle,
            GetCurrentProcess(),
            &mut duplicate,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(Handle(duplicate))
}
impl Drop for Child {
    fn drop(&mut self) {
        if !self.done {
            // Exact object created by this launcher, never a PID lookup.
            unsafe {
                TerminateProcess(self.process.0, 78);
                WaitForSingleObject(self.process.0, INFINITE);
            }
        }
    }
}
fn launch(binary: &Path, case: &str) -> io::Result<Child> {
    if !binary.is_absolute() || binary.extension() != Some(OsStr::new("exe")) {
        return Err(failure("invalidSelectedBinary"));
    }
    let app = wide(binary.as_os_str())?;
    if app[..app.len() - 1]
        .iter()
        .any(|c| *c == b'"' as u16 || *c < 32)
    {
        return Err(failure("invalidSelectedBinarySpelling"));
    }
    // Closed ASCII FQN and fixed libtest arguments; no shell or caller options.
    let mut command = vec![b'"' as u16];
    command.extend_from_slice(&app[..app.len() - 1]);
    command.extend("\" ".encode_utf16());
    command
        .extend(format!("{case} --ignored --exact --nocapture --test-threads=1\0").encode_utf16());
    let mut startup = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        dwFlags: STARTF_USESTDHANDLES,
        ..Default::default()
    };
    // Original libtest stdout/stderr flow directly into the caller's raw files.
    // These three duplicates explicitly inherit. Token/process/thread handles
    // created here do not; this is not a parent-wide handle allowlist.
    let null_input = std::fs::File::open("NUL")?;
    let stdin = inherited(null_input.as_raw_handle())?;
    let stdout = inherited(unsafe { GetStdHandle(STD_OUTPUT_HANDLE) })?;
    let stderr = inherited(unsafe { GetStdHandle(STD_ERROR_HANDLE) })?;
    startup.hStdInput = stdin.0;
    startup.hStdOutput = stdout.0;
    startup.hStdError = stderr.0;
    let mut child = PROCESS_INFORMATION::default();
    if unsafe {
        CreateProcessW(
            app.as_ptr(),
            command.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            CREATE_SUSPENDED,
            ptr::null(),
            ptr::null(),
            &startup,
            &mut child,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(Child {
        process: Handle(child.hProcess),
        thread: Handle(child.hThread),
        done: false,
    })
}
fn manual_case(case: &str) -> bool {
    [
        include_str!("../../../.github/scripts/windows-capability-closeout-cases.json"),
        include_str!("../../../.github/scripts/windows-legacy-full-security-cases.json"),
    ]
    .into_iter()
    .any(|source| {
        let Ok(manifest) = serde_json::from_str::<serde_json::Value>(source) else {
            return false;
        };
        manifest.get("schema").and_then(|v| v.as_u64()) == Some(1)
            && manifest
                .get("cases")
                .and_then(|v| v.as_array())
                .is_some_and(|cases| {
                    cases
                        .iter()
                        .any(|row| row["manual"] == true && row["test"] == case)
                })
    })
}
fn execute(args: &[OsString]) -> io::Result<i32> {
    if args.len() != 3 || args[0] != "manual-granted-privileges" {
        return Err(failure("invalidManualInvocation"));
    }
    let case = args[2]
        .to_str()
        .filter(|name| manual_case(name))
        .ok_or_else(|| failure("notSelectedManualCase"))?;
    let parent = open_token(unsafe { GetCurrentProcess() }, false)?;
    let mut child = launch(Path::new(&args[1]), case)?;
    let token = open_token(child.process.0, true)?;
    let distinct = token.id != parent.id;
    let security = luid(NAMES[0])?;
    let security_key = (security.HighPart, security.LowPart);
    let granted = token.privileges.contains_key(&security_key);
    let mut adjusted = None;
    let mut adjust_error = None;
    if distinct && granted {
        let update = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [windows_sys::Win32::Security::LUID_AND_ATTRIBUTES {
                Luid: security,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        unsafe {
            SetLastError(0);
        }
        let ok = unsafe {
            AdjustTokenPrivileges(
                token.handle.0,
                0,
                &update,
                0,
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        let error = unsafe { GetLastError() };
        adjusted = Some(ok != 0);
        adjust_error = Some(error);
    }
    let child_after = table(token.handle.0)?;
    let parent_ready = table(parent.handle.0)?;
    let only_requested = token.privileges.len() == child_after.len()
        && token.privileges.iter().all(|(id, value)| {
            child_after.get(id).is_some_and(|now| {
                if *id == security_key {
                    *now == (*value | SE_PRIVILEGE_ENABLED)
                } else {
                    now == value
                }
            })
        });
    let ready = distinct
        && granted
        && adjusted == Some(true)
        && adjust_error == Some(0)
        && child_after
            .get(&security_key)
            .is_some_and(|value| value & SE_PRIVILEGE_ENABLED != 0)
        && only_requested
        && parent_ready == parent.privileges;
    let mut exit = None;
    let mut timed_out = false;
    let mut timeout_termination = None;
    let mut timeout_termination_error = None;
    if ready {
        if unsafe { ResumeThread(child.thread.0) } != 1 {
            return Err(failure("testResumeNotConfirmed"));
        }
        match unsafe { WaitForSingleObject(child.process.0, MANUAL_TIMEOUT_MS) } {
            WAIT_OBJECT_0 => {}
            WAIT_TIMEOUT => {
                timed_out = true;
                let stopped = unsafe { TerminateProcess(child.process.0, 124) };
                timeout_termination = Some(stopped != 0);
                timeout_termination_error = (stopped == 0).then(|| unsafe { GetLastError() });
                // Cleanup never abandons the same actual object. A timeout
                // cannot supply a successful test completion, even if exit
                // raced with the termination request.
                if unsafe { WaitForSingleObject(child.process.0, INFINITE) } != WAIT_OBJECT_0 {
                    return Err(failure("timedOutTestRetirementNotConfirmed"));
                }
            }
            _ => return Err(failure("testExitNotConfirmed")),
        }
        child.done = true;
        let mut code = 0;
        if unsafe { GetExitCodeProcess(child.process.0, &mut code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        exit = Some(code);
    } else {
        if unsafe { TerminateProcess(child.process.0, 77) } == 0
            || unsafe { WaitForSingleObject(child.process.0, INFINITE) } != WAIT_OBJECT_0
        {
            return Err(failure("unstartedTestRetirementNotConfirmed"));
        }
        child.done = true;
    }
    let parent_after = table(parent.handle.0)?;
    let parent_unchanged = parent_ready == parent.privileges && parent_after == parent.privileges;
    eprintln!(
        "{MARKER} {}",
        serde_json::json!({
            "schema": 1, "case": case,
        "status": if !ready { "conditionUnavailable" } else if timed_out { "testTimedOut" } else if !parent_unchanged { "launcherError" } else { "testCompleted" },
            "testExecuted": ready, "testExitCode": exit,
        "manualTestDeadlineMs": MANUAL_TIMEOUT_MS, "testTimedOut": timed_out,
        "timeoutTerminationSucceeded": timeout_termination,
        "timeoutTerminationError": timeout_termination_error,
            "distinctChildToken": distinct, "privilegeRequested": NAMES[0],
            "childBefore": states(&token.privileges)?, "childAfter": states(&child_after)?,
        "childStateObservation": "before and after enablement, both before the test primary thread resumes",
            "adjustCalled": adjusted.is_some(), "adjustSucceeded": adjusted, "adjustLastError": adjust_error,
            "onlyRequestedPrivilegeChanged": only_requested,
            "parentBefore": states(&parent.privileges)?, "parentAfter": states(&parent_after)?,
            "parentPrivilegeTableUnchanged": parent_unchanged,
            "backupRestoreAdjusted": false, "accountOrPolicyChanged": false,
            "scope": "owned selected manual test child only; default ordinary caller token untouched",
        })
    );
    if !parent_unchanged {
        return Ok(78);
    }
    if timed_out {
        return Ok(124);
    }
    Ok(exit.map_or(77, |code| code as i32))
}
pub(super) fn run(args: &[OsString]) -> i32 {
    match execute(args) {
        Ok(code) => code,
        Err(error) => {
            // Non-native errors above are fixed guards, never caller strings.
            let phase = if error.raw_os_error().is_some() {
                "nativeCall".to_owned()
            } else {
                error.to_string()
            };
            eprintln!(
                "{MARKER} {}",
                serde_json::json!({
                "schema": 1, "status": "launcherError", "testExecuted": null,
                    "phase": phase,
                    "nativeCode": error.raw_os_error(),
                    "scope": "condition/result not confirmed; never counted as test pass",
                })
            );
            78
        }
    }
}
