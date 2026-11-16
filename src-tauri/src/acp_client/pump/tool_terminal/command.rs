use agent_client_protocol::schema::v1::CreateTerminalRequest;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;

const SYSTEM_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
const MAX_OUTPUT: u64 = 1024 * 1024;
const MAX_ARGUMENT_BYTES: usize = 32 * 1024;

pub(super) struct ReviewedCommand {
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
    #[cfg(unix)]
    directory: std::fs::File,
    pub(super) output_limit: usize,
}

impl ReviewedCommand {
    pub(super) fn from_request(raw: Value, session: &str, root: &Path) -> Option<Self> {
        let args = raw.get("args").map(Value::as_array);
        if args.is_some_and(|args| {
            args.is_none_or(|args| {
                args.len() > 128
                    || args
                        .iter()
                        .any(|arg| arg.as_str().is_none_or(|arg| arg.contains('\0')))
            })
        }) || raw
            .get("env")
            .is_some_and(|env| env.as_array().is_none_or(|env| !env.is_empty()))
            || raw
                .get("cwd")
                .is_some_and(|cwd| !cwd.is_string() && !cwd.is_null())
            || raw
                .get("outputByteLimit")
                .is_some_and(|limit| !limit.is_u64() && !limit.is_null())
        {
            return None;
        }
        let request: CreateTerminalRequest = serde_json::from_value(raw).ok()?;
        if request.session_id.0.as_ref() != session
            || request.args.iter().map(String::len).sum::<usize>() > MAX_ARGUMENT_BYTES
            || request.command.is_empty()
            || request.command.len() > 4096
            || request.command.chars().any(char::is_control)
            || !request.env.is_empty()
        {
            return None;
        }
        let root = root.canonicalize().ok()?;
        let cwd = request.cwd.unwrap_or_else(|| root.clone());
        if !cwd.is_absolute() {
            return None;
        }
        let cwd = cwd.canonicalize().ok()?;
        if !cwd.starts_with(&root) || !cwd.is_dir() {
            return None;
        }
        let path = Path::new(&request.command);
        let program = if path.is_absolute() {
            path.canonicalize().ok()?
        } else if path.components().count() == 1 && path.file_name() == Some(path.as_os_str()) {
            SYSTEM_PATH
                .split(':')
                .map(|dir| Path::new(dir).join(path))
                .find(|path| path.is_file())?
                .canonicalize()
                .ok()?
        } else {
            return None;
        };
        if !program.is_file()
            || !SYSTEM_PATH
                .split(':')
                .any(|dir| program.parent() == Some(Path::new(dir)))
            || program.to_str().is_none()
            || cwd.to_str().is_none()
        {
            return None;
        }
        #[cfg(unix)]
        let directory = {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&cwd)
                .ok()?
        };
        Some(Self {
            program,
            args: request.args,
            cwd,
            #[cfg(unix)]
            directory,
            output_limit: request
                .output_byte_limit
                .unwrap_or(MAX_OUTPUT)
                .min(MAX_OUTPUT) as usize,
        })
    }

    pub(super) fn review(&self) -> Value {
        json!({"program":self.program, "args":self.args, "cwd":self.cwd})
    }

    pub(super) fn into_process_command(self) -> Option<Command> {
        // Revalidate the exact reviewed paths. The tool never inherits the
        // service credentials configured for the separate Agent process.
        if self.program.canonicalize().ok()? != self.program
            || self.cwd.canonicalize().ok()? != self.cwd
        {
            return None;
        }
        let mut command = Command::new(self.program);
        command
            .args(self.args)
            .current_dir(&self.cwd)
            .env_clear()
            .env("PATH", SYSTEM_PATH);
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::{fs::MetadataExt, process::CommandExt};
            let expected = self.directory.metadata().ok()?;
            let current = self.cwd.metadata().ok()?;
            if expected.dev() != current.dev() || expected.ino() != current.ino() {
                return None;
            }
            let directory = self.directory;
            // SAFETY: fchdir and errno capture are async-signal-safe. The
            // original reviewed directory descriptor stays open until exec.
            unsafe {
                command.pre_exec(move || {
                    if libc::fchdir(directory.as_raw_fd()) == 0 {
                        Ok(())
                    } else {
                        Err(std::io::Error::last_os_error())
                    }
                });
            }
        }
        Some(command)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_exact_executable_working_directory_and_arguments() {
        let root = tempfile::tempdir().unwrap();
        let cmd = ReviewedCommand::from_request(json!({
            "sessionId":"s", "command":"sh", "args":["-c", "printf '%s' \"$1\"", "--", "two words"],
            "cwd":root.path(), "env":[], "outputByteLimit":17
        }), "s", root.path()).unwrap();
        assert!(Path::new(cmd.review()["program"].as_str().unwrap()).is_absolute());
        assert_eq!(cmd.review()["args"][3], "two words");
        assert_eq!(cmd.output_limit, 17);
        let command = cmd.into_process_command().unwrap();
        assert_eq!(command.get_args().last().unwrap(), "two words");
        assert_eq!(command.get_envs().count(), 1);
    }

    #[test]
    fn rejects_drift_and_malformed_values_the_protocol_can_skip() {
        let root = tempfile::tempdir().unwrap();
        for extra in [
            json!({"args":["-c", 5]}),
            json!({"args":["\u{0000}"]}),
            json!({"cwd":"/"}),
            json!({"cwd":"."}),
            json!({"env":[{"name":"EXTRA","value":"text"}]}),
            json!({"cwd":12}),
            json!({"outputByteLimit":-1}),
        ] {
            let mut raw = json!({"sessionId":"s","command":"sh"});
            raw.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            assert!(ReviewedCommand::from_request(raw, "s", root.path()).is_none());
        }
    }
}
