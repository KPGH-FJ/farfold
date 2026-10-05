//! Raw registry executables are saved only inside the fresh, unselected candidate.
use std::io::Write;
use std::path::Path;

pub(super) const MAX_BYTES: usize = 1024 * 1024 * 1024;

fn regular_directory(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return false;
        }
    }
    true
}

pub(super) fn write(
    bytes: &[u8],
    destination: &Path,
    label: &str,
    command: &str,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    check()?;
    let relative = crate::archive_zip::raw_executable_target(label, command)
        .ok_or("下载内容中的执行文件位置无效")?;
    if bytes.len() > MAX_BYTES {
        return Err("下载内容超过允许大小，请查看官方说明".into());
    }
    if !regular_directory(destination) {
        return Err("无法确认安装目录".into());
    }
    let mut parent = destination.to_path_buf();
    if let Some(parents) = relative.parent() {
        for component in parents.components() {
            check()?;
            parent.push(component);
            match std::fs::create_dir(&parent) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err("无法创建程序目录".into()),
            }
            if !regular_directory(&parent) {
                return Err("下载内容中的执行文件位置无效".into());
            }
        }
    }
    check()?;
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination.join(relative))
        .map_err(|_| "无法保存下载的程序")?;
    for chunk in bytes.chunks(64 * 1024) {
        check()?;
        output.write_all(chunk).map_err(|_| "无法保存下载的程序")?;
    }
    // Cancellation/error leaves only this unselected candidate, owned and
    // removed by prepare_from_registry's TempDir. No selected file is replaced.
    check()
}

#[cfg(test)]
mod tests;
