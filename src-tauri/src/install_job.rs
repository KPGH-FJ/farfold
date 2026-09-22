//! One cancellable install per Agent. This is not an Agent execution service.
use serde::Serialize;
use std::collections::HashMap;
use std::process::{Command, Stdio};
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
}
impl Job {
    pub fn check(&self) -> Result<(), String> {
        if self.state.load(Ordering::Acquire) == 1 {
            Err("安装已取消，原设置保持不变".into())
        } else {
            Ok(())
        }
    }
    pub fn commit<T>(&self, operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        self.state
            .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "安装已取消，原设置保持不变")?;
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
        self.check()?;
        self.report("download", None, None);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "无法开始下载")?;
        runtime.block_on(async {
            let download=async {
                let client=reqwest::Client::builder().https_only(true).connect_timeout(std::time::Duration::from_secs(10)).timeout(timeout).build().map_err(|_|"无法开始下载")?;
                let mut response=client.get(url).send().await.and_then(|r|r.error_for_status()).map_err(|_|"下载失败，请检查网络后重试")?;
                let total=response.content_length();let mut bytes=Vec::new();
                while let Some(chunk)=response.chunk().await.map_err(|_|"下载中断，请重试")? { bytes.extend_from_slice(&chunk);self.report("download",Some(bytes.len() as u64),total); }
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
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "安装程序未能启动，请重试".to_string())?;
        let started = std::time::Instant::now();
        loop {
            if self.check().is_err() || started.elapsed() > std::time::Duration::from_secs(300) {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                self.check()?;
                return Err("安装等待超时，请重试".into());
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    return if status.success() {
                        Ok(())
                    } else {
                        Err("安装未完成，请检查网络后重试".into())
                    };
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
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
    let mut jobs = jobs().lock().map_err(|_| "无法开始安装")?;
    if jobs.contains_key(id) {
        return Err("此 Agent 正在安装，请稍候".into());
    }
    let job = Arc::new(Job {
        state: AtomicU8::new(0),
        changed: tokio::sync::Notify::new(),
        channel,
    });
    jobs.insert(id.into(), job.clone());
    Ok(Lease { job, id: id.into() })
}
#[tauri::command]
pub fn agent_install_cancel(agent_id: String) -> Result<(), String> {
    if let Some(job) = jobs().lock().map_err(|_| "无法取消安装")?.get(&agent_id) {
        if job
            .state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
            && job.state.load(Ordering::Acquire) == 2
        {
            return Err("安装已保存，可连接验证或返回上次安装".into());
        }
        job.changed.notify_one();
        job.report("cancelling", None, None);
    }
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
}
