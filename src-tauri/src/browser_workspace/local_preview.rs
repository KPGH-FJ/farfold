//! Explicit, revocable local preview sources. No listener, process launcher,
//! directory enumeration, credential reader, or application bridge lives here.
//! The trusted caller must obtain the directory/HTML or origin from the user.
//! These policies are not an operating-system or network sandbox.

#[path = "local_preview/directory.rs"]
mod directory;
#[path = "local_preview/policy.rs"]
mod policy;
#[cfg(test)]
#[path = "local_preview/tests.rs"]
mod tests;

pub(crate) use directory::DirectoryPreview;
pub(crate) use policy::DevServerOrigin;

use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub(crate) const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
pub(crate) const MAX_RESOURCE_BYTES: u64 = 8 * 1024 * 1024;
pub(crate) const DIRECTORY_CSP: &str = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
const STOPPED: &str = "本地预览已关闭，请重新打开";

/// Shared by the exact view and its resource callbacks, never persisted. The
/// native owner must use with_live around every final, nonblocking delivery.
#[derive(Clone, Default)]
pub(crate) struct PreviewLease(Arc<Mutex<bool>>);

impl PreviewLease {
    pub(crate) fn revoke(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = true;
    }

    pub(crate) fn with_live<T>(
        &self,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let stopped = self.0.lock().map_err(|_| STOPPED)?;
        if *stopped {
            return Err(STOPPED.into());
        }
        action()
    }

    fn check(&self) -> Result<(), String> {
        self.with_live(|| Ok(()))
    }
}

/// A separate opaque WebKit store identity for each explicit mode and source.
/// It contains no path, token, page bytes or external browser profile state.
pub(crate) fn storage_identifier(
    mode: &str,
    project: &Path,
    source: &str,
) -> Result<String, String> {
    let project = validate_project(project)?;
    let project = project.to_str().ok_or("工作文件夹位置无效")?;
    let mut digest = Sha256::new();
    digest.update(b"farfold-local-preview-v1\0");
    for part in [mode, project, source] {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part.as_bytes());
    }
    let digest = digest.finalize();
    let mut bytes: [u8; 16] = digest[..16].try_into().expect("digest length");
    bytes[6] = (bytes[6] & 15) | 0x80;
    bytes[8] = (bytes[8] & 63) | 0x80;
    let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    ))
}

fn validate_project(project: &Path) -> Result<PathBuf, String> {
    if !project.is_absolute() {
        return Err("请选择完整的工作文件夹位置".into());
    }
    let project = project.canonicalize().map_err(|_| "工作文件夹已无法访问")?;
    if !project.is_dir() {
        return Err("请选择工作文件夹".into());
    }
    Ok(project)
}
