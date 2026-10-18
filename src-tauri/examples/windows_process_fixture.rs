//! Synthetic OS-only fixture. Never loads an Agent, account or model.
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
fn main() {
    // A synthetic-only barrier exercises cancellation before the trusted helper
    // opens/enters the Job. Production has no environment or timing test hook.
    let raw: Vec<_> = std::env::args_os().skip(1).collect();
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
