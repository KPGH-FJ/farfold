//! Bounded extraction of authenticated distribution-tool archives. This is
//! separate from package/Agent compatibility and never executes an installer.
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::install_job::Job;

const EXPANDED_LIMIT: u64 = 1024 * 1024 * 1024;
const ENTRY_LIMIT: usize = 100_000;

pub(super) fn verify(bytes: &[u8], expected: &str) -> Result<(), String> {
    let actual = Sha256::digest(bytes);
    let actual = actual
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if actual != expected {
        return Err("所需程序下载校验未通过，请重试".into());
    }
    Ok(())
}

fn inside(path: &Path) -> bool {
    let mut depth = 0;
    for part in path.components() {
        match part {
            Component::Normal(name) => {
                if name
                    .to_str()
                    .is_none_or(|name| !crate::archive_zip::safe_component(name))
                {
                    return false;
                }
                depth += 1;
            }
            Component::CurDir => {}
            Component::ParentDir if depth > 0 => depth -= 1,
            _ => return false,
        }
    }
    depth > 0
}

struct BoundedReader<'a, R> {
    reader: R,
    read: u64,
    limit: u64,
    job: &'a Job,
}
impl<R: Read> Read for BoundedReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.job.check().map_err(std::io::Error::other)?;
        let count = self.reader.read(buffer)?;
        self.read = self.read.saturating_add(count as u64);
        if self.read > self.limit {
            return Err(std::io::Error::other("展开内容超过允许大小"));
        }
        Ok(count)
    }
}

pub(super) fn extract(bytes: &[u8], destination: &Path, job: &Job) -> Result<(), String> {
    if bytes.starts_with(b"PK\x03\x04") {
        return crate::archive_zip::extract(bytes, destination, || job.check());
    }
    unpack(
        flate2::read::GzDecoder::new(bytes),
        destination,
        job,
        EXPANDED_LIMIT,
        ENTRY_LIMIT,
    )
}

fn unpack(
    reader: impl Read,
    destination: &Path,
    job: &Job,
    limit: u64,
    entry_limit: usize,
) -> Result<(), String> {
    job.check()?;
    let mut archive = tar::Archive::new(BoundedReader {
        reader,
        read: 0,
        limit,
        job,
    });
    let entries = archive
        .entries()
        .map_err(|_| "所需程序下载不完整，请重试")?;
    let mut declared = 0_u64;
    for (count, entry) in entries.enumerate() {
        job.check()?;
        if count >= entry_limit {
            return Err("下载内容的文件数超过允许范围".into());
        }
        let mut entry = entry.map_err(|_| "所需程序下载不完整，请重试")?;
        let path = entry
            .path()
            .map_err(|_| "下载内容的文件位置无效")?
            .into_owned();
        if !inside(&path) {
            return Err("下载内容的文件位置无效".into());
        }
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir() || kind.is_symlink() || kind.is_hard_link()) {
            return Err("下载内容包含不能使用的文件类型".into());
        }
        if cfg!(windows) && (kind.is_symlink() || kind.is_hard_link()) {
            return Err("下载内容包含无法安全展开的链接".into());
        }
        declared = declared.saturating_add(entry.size());
        if declared > limit {
            return Err("下载内容展开后超过允许大小".into());
        }
        if let Some(link) = entry.link_name().map_err(|_| "下载内容的链接位置无效")? {
            let target = if kind.is_symlink() {
                path.parent().unwrap_or(Path::new("")).join(link.as_ref())
            } else {
                PathBuf::from(link.as_ref())
            };
            if !inside(&target) {
                return Err("下载内容的链接位置无效".into());
            }
        }
        if !entry
            .unpack_in(destination)
            .map_err(|_| "无法展开所需程序，请重试")?
        {
            return Err("下载内容的文件位置无效".into());
        }
    }
    job.check()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lease(id: &str) -> crate::install_job::Lease {
        crate::install_job::begin(id, tauri::ipc::Channel::new(|_| Ok(()))).unwrap()
    }
    fn tar_file(path: &str, content: &[u8]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o755);
        builder.append_data(&mut header, path, content).unwrap();
        builder.into_inner().unwrap()
    }

    #[test]
    fn fixed_download_digest_is_mandatory_before_unpacking() {
        verify(
            b"hello",
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        )
        .unwrap();
        assert!(
            verify(
                b"modified archive",
                "25baa97c65b3f0aa90e21131b4f9e80aef8899e8144006db8a9d2c1ab9e807e3"
            )
            .is_err()
        );
        assert!(
            verify(
                b"hello!",
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
            )
            .is_err()
        );
    }

    #[test]
    fn expansion_size_and_entry_count_are_bounded() {
        let data = tempfile::tempdir().unwrap();
        let job = lease("uv-tool-archive-bounds");
        let bytes = tar_file("tool/uv", &[1; 1024]);
        assert!(unpack(&bytes[..], data.path(), &job.job, 512, 10).is_err());
        assert!(!data.path().join("tool/uv").exists());
        assert!(unpack(&bytes[..], data.path(), &job.job, 10_000, 0).is_err());
    }

    #[test]
    fn archive_links_and_parent_traversal_cannot_escape_owned_directory() {
        for path in [
            "/outside",
            "../outside",
            "tool/../../outside",
            "tool/name:stream",
            "tool/CON.txt",
            "tool/name.",
        ] {
            assert!(!inside(Path::new(path)));
        }
        assert!(inside(Path::new("python/bin/../lib/module.py")));
        let data = tempfile::tempdir().unwrap();
        let outside = data.path().join("outside");
        std::fs::write(&outside, "protected").unwrap();
        let destination = data.path().join("candidate");
        std::fs::create_dir(&destination).unwrap();
        let mut builder = tar::Builder::new(Vec::new());
        let mut link = tar::Header::new_gnu();
        link.set_size(0);
        link.set_mode(0o777);
        link.set_entry_type(tar::EntryType::Symlink);
        link.set_link_name("../../outside").unwrap();
        builder
            .append_data(&mut link, "python/link", std::io::empty())
            .unwrap();
        let bytes = builder.into_inner().unwrap();
        let job = lease("uv-tool-archive-link-boundary");
        assert!(unpack(&bytes[..], &destination, &job.job, 10_000, 10).is_err());
        assert_eq!(std::fs::read_to_string(outside).unwrap(), "protected");
    }

    #[test]
    fn cancelled_extraction_keeps_the_existing_runtime_and_never_starts_unpacking() {
        let data = tempfile::tempdir().unwrap();
        let previous = data.path().join("previous");
        std::fs::write(&previous, "existing").unwrap();
        let id = "uv-tool-cancelled-extraction";
        let job = lease(id);
        crate::install_job::agent_install_cancel(id.into()).unwrap();
        assert!(
            unpack(
                &tar_file("tool/uv", b"new")[..],
                data.path(),
                &job.job,
                10_000,
                10
            )
            .is_err()
        );
        assert_eq!(std::fs::read_to_string(previous).unwrap(), "existing");
        assert!(!data.path().join("tool").exists());
    }
}
