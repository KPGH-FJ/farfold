//! One cancellable install per Agent. This is not an Agent execution service.
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::os::fd::AsRawFd;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicU8, Ordering},
};
use tauri::ipc::Channel;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: String,
    pub bytes: Option<u64>,
    pub total: Option<u64>,
}

pub struct Job {
    state: AtomicU8,
    changed: tokio::sync::Notify,
    channel: Channel<Progress>,
    request_id: Option<String>,
    _admission: crate::managed_update::ActivityPermit,
}

/// Only known error codes leave the child-output boundary. npm can print
/// registry credentials, URLs and lifecycle-script output on stderr.
#[derive(Default)]
struct InstallDiagnostics {
    line: Vec<u8>,
    oversized: bool,
    code: Option<&'static str>,
}
impl InstallDiagnostics {
    fn feed(&mut self, bytes: &[u8]) {
        const CODES: &[&str] = &[
            "EACCES",
            "EPERM",
            "ENOSPC",
            "ENOENT",
            "ENOTFOUND",
            "EAI_AGAIN",
            "ECONNREFUSED",
            "ECONNRESET",
            "ETIMEDOUT",
            "E401",
            "E403",
            "E404",
            "E429",
            "EBADENGINE",
            "ERESOLVE",
            "EINTEGRITY",
            "CERT_HAS_EXPIRED",
            "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        ];
        for &byte in bytes {
            if byte == b'\n' {
                if !self.oversized {
                    let words: Vec<_> = self
                        .line
                        .split(|b| b.is_ascii_whitespace())
                        .filter(|word| !word.is_empty())
                        .collect();
                    if words.len() == 4
                        && words[0] == b"npm"
                        && matches!(words[1], b"error" | b"ERR!")
                        && words[2] == b"code"
                        && let Some(code) = CODES
                            .iter()
                            .copied()
                            .find(|code| code.as_bytes() == words[3])
                    {
                        self.code = Some(code);
                    }
                }
                self.line.clear();
                self.oversized = false;
            } else if self.line.len() < 1024 {
                self.line.push(byte);
            } else {
                self.oversized = true;
            }
        }
    }

    fn drain(&mut self, stderr: &mut impl Read) -> Result<(), std::io::Error> {
        let mut buffer = [0_u8; 8192];
        // Bounded work per poll, even when a child writes continuously.
        for _ in 0..8 {
            match stderr.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => self.feed(&buffer[..count]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn failure(&mut self, status: ExitStatus) -> String {
        self.feed(b"\n");
        let detail = match self.code {
            Some("EACCES" | "EPERM") => "请检查安装目录权限后重试",
            Some("ENOSPC") => "磁盘空间不足，请释放空间后重试",
            Some("E401" | "E403") => "下载源拒绝访问，请检查访问设置后重试",
            Some("E404") => "下载源中没有此安装包，请刷新目录后重试",
            Some("EBADENGINE") => "安装工具版本不符合要求，请查看官方安装说明",
            Some("ERESOLVE") => "安装包依赖冲突，请查看官方安装说明",
            Some("EINTEGRITY") => "下载内容校验未通过，请重试",
            Some("ENOTFOUND" | "EAI_AGAIN" | "ECONNREFUSED" | "ECONNRESET" | "ETIMEDOUT") => {
                "无法完成网络请求，请检查网络后重试"
            }
            Some("CERT_HAS_EXPIRED" | "UNABLE_TO_VERIFY_LEAF_SIGNATURE") => {
                "下载源的安全证书校验失败，请检查网络和系统时间"
            }
            _ => "请重试，或查看官方安装说明",
        };
        let exit = status
            .code()
            .map_or_else(|| "进程被终止".into(), |code| format!("退出码 {code}"));
        match self.code {
            Some(code) => format!("安装未完成（{code}，{exit}），{detail}"),
            None => format!("安装未完成（{exit}），{detail}"),
        }
    }
}

struct InstallChild(Child);
impl Drop for InstallChild {
    fn drop(&mut self) {
        // This command owns the process group. Descendants may still hold
        // stderr even after npm itself exits.
        unsafe {
            libc::kill(-(self.0.id() as i32), libc::SIGKILL);
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
impl Job {
    pub async fn configuration(
        &self,
        id: &str,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
        tokio::select! {
            biased;
            _ = self.cancelled() => Err("操作已取消，原设置保持不变".into()),
            guard = configuration_guard(id) => { self.check()?; Ok(guard) },
        }
    }

    pub async fn cancelled(&self) {
        loop {
            let changed = self.changed.notified();
            if self.state.load(Ordering::Acquire) == 1 {
                return;
            }
            changed.await;
        }
    }
    pub fn check(&self) -> Result<(), String> {
        if self.state.load(Ordering::Acquire) == 1 {
            Err("操作已取消，原设置保持不变".into())
        } else {
            Ok(())
        }
    }
    pub fn commit<T>(&self, operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        self.state
            .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "操作已取消，原设置保持不变")?;
        operation()
    }
    pub fn report(&self, stage: &str, bytes: Option<u64>, total: Option<u64>) {
        let _ = self.channel.send(Progress {
            stage: stage.into(),
            bytes,
            total,
        });
    }
    pub fn download(&self, url: &str, timeout: std::time::Duration) -> Result<Vec<u8>, String> {
        self.download_bounded(url, timeout, usize::MAX, None)
    }
    /// Explicit official dependency distributions never redirect to an undeclared origin.
    pub(crate) fn download_bounded(
        &self,
        url: &str,
        timeout: std::time::Duration,
        max_bytes: usize,
        origin: Option<&str>,
    ) -> Result<Vec<u8>, String> {
        self.check()?;
        let allowed = origin
            .map(reqwest::Url::parse)
            .transpose()
            .map_err(|_| "下载来源无效")?
            .map(|url| url.origin());
        if let Some(allowed) = &allowed {
            let parsed = reqwest::Url::parse(url).map_err(|_| "下载地址无效")?;
            if parsed.scheme() != "https" || &parsed.origin() != allowed {
                return Err("下载地址不属于已确认的官方来源".into());
            }
        }
        self.report("download", None, None);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "无法开始下载")?;
        runtime.block_on(async {
            let download=async {
                let mut builder=reqwest::Client::builder().https_only(true).connect_timeout(std::time::Duration::from_secs(10)).timeout(timeout);
                if let Some(origin) = allowed {
                    builder = builder.redirect(reqwest::redirect::Policy::custom(move |attempt| {
                        if attempt.previous().len() >= 5 || attempt.url().origin() != origin {
                            attempt.error("下载来源发生变化")
                        } else { attempt.follow() }
                    }));
                }
                let client=builder.build().map_err(|_|"无法开始下载")?;
                let mut response=client.get(url).send().await.and_then(|r|r.error_for_status()).map_err(|_|"下载失败，请检查网络后重试")?;
                let total=response.content_length();let mut bytes=Vec::new();
                if total.is_some_and(|total| total > max_bytes as u64) { return Err("下载内容超过允许大小，请查看官方说明".into()); }
                while let Some(chunk)=response.chunk().await.map_err(|_|"下载中断，请重试")? {
                    if chunk.len() > max_bytes.saturating_sub(bytes.len()) { return Err("下载内容超过允许大小，请查看官方说明".into()); }
                    bytes.extend_from_slice(&chunk);self.report("download",Some(bytes.len() as u64),total);
                }
                Ok(bytes)
            };
            tokio::select! { result=download=>result, _=self.changed.notified()=>Err("安装已取消，原设置保持不变".into()) }
        })
    }
    pub fn run(&self, command: &mut Command) -> Result<(), String> {
        self.check()?;
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = InstallChild(
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|_| "安装程序未能启动，请重试".to_string())?,
        );
        let mut stderr = child.0.stderr.take().ok_or("无法读取安装结果，请重试")?;
        let fd = stderr.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err("无法读取安装结果，请重试".into());
        }
        let mut diagnostics = InstallDiagnostics::default();
        let started = std::time::Instant::now();
        loop {
            if self.check().is_err() || started.elapsed() > std::time::Duration::from_secs(300) {
                self.check()?;
                return Err("安装等待超时，请重试".into());
            }
            diagnostics
                .drain(&mut stderr)
                .map_err(|_| "无法读取安装结果，请重试")?;
            match child.0.try_wait() {
                Ok(Some(status)) => {
                    diagnostics
                        .drain(&mut stderr)
                        .map_err(|_| "无法读取安装结果，请重试")?;
                    return if status.success() {
                        Ok(())
                    } else {
                        Err(diagnostics.failure(status))
                    };
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
                Err(_) => {
                    return Err("无法确认安装结果，请重试".into());
                }
            }
        }
    }
}
fn jobs() -> &'static Mutex<HashMap<String, Arc<Job>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Arc<Job>>>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}
pub struct Lease {
    pub job: Arc<Job>,
    id: String,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut jobs) = jobs().lock() {
            jobs.remove(&self.id);
        }
    }
}
pub fn begin(id: &str, channel: Channel<Progress>) -> Result<Lease, String> {
    begin_scoped(id, channel, None)
}
pub(crate) fn begin_scoped(
    id: &str,
    channel: Channel<Progress>,
    request_id: Option<String>,
) -> Result<Lease, String> {
    let admission = crate::managed_update::activity()?;
    if request_id.as_ref().is_some_and(|id| id.trim().is_empty()) {
        return Err("安装请求无效，请重试".into());
    }
    let mut jobs = jobs().lock().map_err(|_| "无法开始安装")?;
    if jobs.contains_key(id) {
        return Err("此 Agent 正在安装或检查程序，请稍候".into());
    }
    let job = Arc::new(Job {
        state: AtomicU8::new(0),
        changed: tokio::sync::Notify::new(),
        channel,
        request_id,
        _admission: admission,
    });
    jobs.insert(id.into(), job.clone());
    Ok(Lease { job, id: id.into() })
}
#[tauri::command]
pub fn agent_install_cancel(agent_id: String) -> Result<(), String> {
    if let Some(job) = jobs().lock().map_err(|_| "无法取消安装")?.get(&agent_id) {
        cancel_job(job)?;
    }
    Ok(())
}
pub(crate) fn cancel_matching(agent_id: &str, request_id: &str) -> Result<(), String> {
    if let Some(job) = jobs().lock().map_err(|_| "无法取消安装")?.get(agent_id)
        && job.request_id.as_deref() == Some(request_id)
    {
        cancel_job(job)?;
    }
    Ok(())
}
fn cancel_job(job: &Job) -> Result<(), String> {
    if job
        .state
        .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
        && job.state.load(Ordering::Acquire) == 2
    {
        return Err("已开始保存操作结果，无法取消，请等待结果".into());
    }
    job.changed.notify_one();
    job.report("cancelling", None, None);
    Ok(())
}
// Serialize launch preparation and configuration replacement, never prompt execution.
pub async fn configuration_guard(id: &str) -> tokio::sync::OwnedMutexGuard<()> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let lock = LOCKS
        .get_or_init(Default::default)
        .lock()
        .expect("configuration locks")
        .entry(id.into())
        .or_default()
        .clone();
    lock.lock_owned().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelling_while_waiting_for_configuration_does_not_wait_for_other_work() {
        let id = "cancel-waiting-install";
        let guard = configuration_guard(id).await;
        let lease = begin(id, Channel::new(|_| Ok(()))).unwrap();
        let job = lease.job.clone();
        let waiting = tokio::spawn(async move { job.configuration(id).await });
        agent_install_cancel(id.into()).unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), waiting)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        drop(guard);
    }
    #[test]
    fn failed_install_reports_safe_error_code_without_echoing_output() {
        let lease = begin("safe-install-error", Channel::new(|_| Ok(()))).unwrap();
        let error = lease
            .job
            .run(Command::new("/bin/sh").args([
                "-c",
                "printf '%s\\n' 'npm error code EACCES' 'Authorization: Bearer fixture-secret' 'https://user:password@example.invalid/private?token=secret' >&2; exit 13",
            ]))
            .unwrap_err();
        assert!(error.contains("EACCES"), "{error}");
        assert!(error.contains("13"), "{error}");
        for secret in ["fixture-secret", "password", "example.invalid", "Bearer"] {
            assert!(!error.contains(secret));
        }
    }

    #[test]
    fn failed_install_drains_large_stderr_without_losing_its_safe_error_code() {
        let lease = begin("large-install-error", Channel::new(|_| Ok(()))).unwrap();
        let error = lease
            .job
            .run(Command::new("/bin/sh").args([
                "-c",
                "i=0; while [ $i -lt 10000 ]; do printf 'untrusted-output-and-secret-value\\n' >&2; i=$((i + 1)); done; printf 'npm ERR! code ENOSPC\\n' >&2; exit 1",
            ]))
            .unwrap_err();
        assert!(error.contains("ENOSPC"), "{error}");
        assert!(error.len() < 300);
        assert!(!error.contains("secret"));
    }
    #[test]
    fn refused_download_is_retryable_and_never_commits() {
        crate::transport_security::ensure_rustls_crypto_provider();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let lease = begin("network-failure-fixture", Channel::new(|_| Ok(()))).unwrap();
        for _ in 0..2 {
            assert!(
                lease
                    .job
                    .download(
                        &format!("https://127.0.0.1:{port}/archive"),
                        std::time::Duration::from_secs(2)
                    )
                    .is_err()
            );
            assert_eq!(lease.job.state.load(Ordering::Acquire), 0);
        }
    }

    #[test]
    fn cancel_prevents_command_and_duplicate_install() {
        let lease = begin("fixture", Channel::new(|_| Ok(()))).unwrap();
        assert!(begin("fixture", Channel::new(|_| Ok(()))).is_err());
        agent_install_cancel("fixture".into()).unwrap();
        assert!(
            lease
                .job
                .run(Command::new("sh").args(["-c", "exit 0"]))
                .is_err()
        );
        drop(lease);
        assert!(begin("fixture", Channel::new(|_| Ok(()))).is_ok());
    }

    #[test]
    fn scoped_cancellation_cannot_cancel_a_later_dependency_or_program_job() {
        let id = "scoped-cancel-fixture";
        let old = begin_scoped(id, Channel::new(|_| Ok(())), Some("old".into())).unwrap();
        cancel_matching(id, "different").unwrap();
        assert!(old.job.check().is_ok());
        cancel_matching(id, "old").unwrap();
        assert!(old.job.check().is_err());
        drop(old);

        let next = begin_scoped(id, Channel::new(|_| Ok(())), Some("next".into())).unwrap();
        cancel_matching(id, "old").unwrap();
        assert!(next.job.check().is_ok());
        next.job.commit(|| Ok(())).unwrap();
        // A late foreign cancellation is a no-op even after the next job commits.
        cancel_matching(id, "old").unwrap();
        assert!(cancel_matching(id, "next").is_err());
        drop(next);

        let program = begin(id, Channel::new(|_| Ok(()))).unwrap();
        cancel_matching(id, "old").unwrap();
        cancel_matching(id, "next").unwrap();
        assert!(program.job.check().is_ok());
        agent_install_cancel(id.into()).unwrap();
        assert!(program.job.check().is_err());
        drop(program);
        // Missing ownership is already cancelled and does not reserve a future job.
        cancel_matching(id, "old").unwrap();
        assert!(begin_scoped(id, Channel::new(|_| Ok(())), Some(String::new())).is_err());
    }

    #[test]
    fn declared_download_rejects_other_origins_before_network_access() {
        let lease = begin("declared-origin", Channel::new(|_| Ok(()))).unwrap();
        for url in [
            "http://static.ampcode.com/program",
            "https://other.invalid/program",
        ] {
            let error = lease
                .job
                .download_bounded(
                    url,
                    std::time::Duration::from_secs(1),
                    1024,
                    Some("https://static.ampcode.com/cli"),
                )
                .unwrap_err();
            assert!(error.contains("官方来源"));
        }
    }
}
