use std::io::Read;
#[cfg(unix)]
use std::io::Write as _;
use std::path::Path;
#[cfg(unix)]
use std::process::Command;

use crate::install_job::Job;

/// Archive extraction stays inside the unselected installation candidate.
/// macOS supplies bzip2/ditto; Job owns their cancellation, timeout and reaping.
/// Both tar encodings use the same path-safe tar crate after decoding.
pub(super) fn extract_archive(
    archive: &[u8],
    dest: &Path,
    label: &str,
    job: &Job,
) -> Result<(), String> {
    job.check()?;
    let path = label.split(['?', '#']).next().unwrap_or(label);
    if path.ends_with(".zip") {
        #[cfg(windows)]
        crate::archive_zip::extract(archive, dest, || job.check())?;
        #[cfg(unix)]
        {
            let mut tmp = tempfile::Builder::new()
                .prefix(".archive-")
                .suffix(".zip")
                .tempfile_in(dest)
                .map_err(|error| format!("cannot create archive staging: {error}"))?;
            tmp.write_all(archive)
                .map_err(|error| format!("cannot stage {label}: {error}"))?;
            job.run(
                Command::new("/usr/bin/ditto")
                    .args(["-x", "-k"])
                    .arg(tmp.path())
                    .arg(dest),
            )?;
        }
    } else if path.ends_with(".tar.bz2") {
        #[cfg(windows)]
        return Err("此压缩格式暂未支持，请选择已有程序".into());
        #[cfg(unix)]
        {
            let staging = tempfile::Builder::new()
                .prefix(".archive-")
                .tempdir_in(dest)
                .map_err(|_| "无法准备解压目录，请重试")?;
            let compressed = staging.path().join("download.tar.bz2");
            std::fs::write(&compressed, archive).map_err(|_| "无法暂存下载内容，请重试")?;
            // Decode only. External archive paths never reach a shell or an
            // extractor that could bypass tar::Archive's destination checks.
            job.run(
                Command::new("/usr/bin/bzip2")
                    .env_remove("BZIP")
                    .env_remove("BZIP2")
                    .arg("-d")
                    .arg(&compressed),
            )?;
            let decoded = std::fs::File::open(staging.path().join("download.tar"))
                .map_err(|_| "无法读取解压内容，请重试")?;
            unpack_tar(decoded, dest, label, job)?;
        }
    } else {
        // Preserve existing gzip behavior, including extensionless downloads.
        unpack_tar(flate2::read::GzDecoder::new(archive), dest, label, job)?;
    }
    job.check()
}

#[cfg(unix)]
struct CheckedReader<'a, R> {
    reader: R,
    job: &'a Job,
}
#[cfg(unix)]
impl<R: Read> Read for CheckedReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.job.check().map_err(std::io::Error::other)?;
        self.reader.read(buffer)
    }
}
fn unpack_tar(reader: impl Read, dest: &Path, _label: &str, job: &Job) -> Result<(), String> {
    #[cfg(windows)]
    {
        super::windows_tar::unpack(reader, dest, || job.check())
    }
    #[cfg(unix)]
    tar::Archive::new(CheckedReader { reader, job })
        .unpack(dest)
        .map_err(|error| format!("cannot extract {_label}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(not(unix))]
    use std::io::Write as _;

    fn job(name: &str) -> crate::install_job::Lease {
        crate::install_job::begin(name, tauri::ipc::Channel::new(|_| Ok(()))).unwrap()
    }

    fn tar_file(name: &str, content: &[u8]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o755);
        builder.append_data(&mut header, name, content).unwrap();
        builder.into_inner().unwrap()
    }

    #[cfg(unix)]
    fn bzip2(content: &[u8]) -> Vec<u8> {
        let mut input = tempfile::NamedTempFile::new().unwrap();
        input.write_all(content).unwrap();
        let result = Command::new("/usr/bin/bzip2")
            .arg("-c")
            .arg(input.path())
            .output()
            .unwrap();
        assert!(result.status.success());
        result.stdout
    }

    fn gzip(content: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(content).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    #[cfg(unix)]
    fn extracts_bzip2_distribution_using_the_declared_relative_program() {
        let directory = tempfile::tempdir().unwrap();
        let lease = job("bzip2-distribution");
        let archive = bzip2(&tar_file("./agent", b"fixture program"));
        extract_archive(&archive, directory.path(), "agent.tar.bz2", &lease.job).unwrap();
        assert_eq!(
            std::fs::read(directory.path().join("agent")).unwrap(),
            b"fixture program"
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn gzip_and_url_suffixes_keep_the_same_tar_extraction_behavior() {
        let content = tar_file("bin/agent", b"fixture program");
        let lease = job("archive-format-regression");
        for (label, bytes) in [
            (
                "https://official.invalid/agent.tar.gz?download=1",
                gzip(&content),
            ),
            ("agent.tgz", gzip(&content)),
            ("https://official.invalid/download", gzip(&content)),
            #[cfg(unix)]
            (
                "https://official.invalid/agent.tar.bz2?download=1#asset",
                bzip2(&content),
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            extract_archive(&bytes, dir.path(), label, &lease.job).unwrap();
            assert_eq!(
                std::fs::read(dir.path().join("bin/agent")).unwrap(),
                b"fixture program"
            );
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        }
    }

    #[test]
    fn failed_bzip2_removes_only_its_staging_and_preserves_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        let previous = dir.path().join("previous-program");
        std::fs::write(&previous, "previous attempt").unwrap();
        let lease = job("bzip2-failed-cleanup");
        assert!(extract_archive(b"BZh-invalid", dir.path(), "agent.tar.bz2", &lease.job).is_err());
        assert_eq!(
            std::fs::read_to_string(previous).unwrap(),
            "previous attempt"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    #[cfg(unix)]
    fn bzip2_rejects_symlink_pivots_outside_the_candidate() {
        let root = tempfile::tempdir().unwrap();
        let outside = root.path().join("outside");
        let destination = root.path().join("candidate");
        std::fs::create_dir(&outside).unwrap();
        std::fs::create_dir(&destination).unwrap();
        std::fs::write(outside.join("protected"), "original").unwrap();
        let mut builder = tar::Builder::new(Vec::new());
        let mut link = tar::Header::new_gnu();
        link.set_size(0);
        link.set_mode(0o777);
        link.set_entry_type(tar::EntryType::Symlink);
        link.set_link_name("../outside").unwrap();
        builder
            .append_data(&mut link, "pivot", std::io::empty())
            .unwrap();
        let mut payload = tar::Header::new_gnu();
        payload.set_size(7);
        payload.set_mode(0o755);
        builder
            .append_data(&mut payload, "pivot/protected", &b"changed"[..])
            .unwrap();
        let bytes = bzip2(&builder.into_inner().unwrap());
        let lease = job("bzip2-symlink-boundary");
        assert!(extract_archive(&bytes, &destination, "agent.tar.bz2", &lease.job).is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("protected")).unwrap(),
            "original"
        );
        assert!(std::fs::read_dir(&destination).unwrap().all(|item| {
            !item
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".archive-")
        }));
    }

    #[test]
    #[cfg(unix)]
    fn bzip2_never_writes_parent_traversal_entries_outside_the_candidate() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("candidate");
        std::fs::create_dir(&destination).unwrap();
        std::fs::write(root.path().join("protected"), "original").unwrap();
        let mut builder = tar::Builder::new(Vec::new());
        let mut payload = tar::Header::new_gnu();
        payload.set_size(7);
        payload.set_mode(0o755);
        // The builder normally rejects traversal; create the hostile wire header directly.
        payload.as_mut_bytes()[..12].copy_from_slice(b"../protected");
        payload.set_cksum();
        builder.append(&payload, &b"changed"[..]).unwrap();
        let bytes = bzip2(&builder.into_inner().unwrap());
        let lease = job("bzip2-parent-boundary");
        let _ = extract_archive(&bytes, &destination, "agent.tar.bz2", &lease.job);
        assert_eq!(
            std::fs::read_to_string(root.path().join("protected")).unwrap(),
            "original"
        );
        assert_eq!(std::fs::read_dir(destination).unwrap().count(), 0);
    }

    #[test]
    #[cfg(unix)]
    fn cancelled_bzip2_never_creates_staging_or_commits() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = bzip2(&tar_file("agent", b"fixture program"));
        let id = "bzip2-cancel-before-extraction";
        let lease = job(id);
        crate::install_job::agent_install_cancel(id.into()).unwrap();
        assert!(
            extract_archive(&bytes, dir.path(), "agent.tar.bz2", &lease.job)
                .unwrap_err()
                .contains("取消")
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        assert!(lease.job.commit(|| Ok(())).is_err());
    }

    #[test]
    fn cancellation_during_tar_read_stops_extraction_before_commit() {
        struct CancelAfterRead<R> {
            reader: R,
            id: &'static str,
        }
        impl<R: Read> Read for CancelAfterRead<R> {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let count = self.reader.read(buffer)?;
                crate::install_job::agent_install_cancel(self.id.into()).unwrap();
                Ok(count)
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let id = "archive-cancel-during-read";
        let lease = job(id);
        let bytes = tar_file("agent", &[7; 4096]);
        let reader = CancelAfterRead {
            reader: &bytes[..],
            id,
        };
        assert!(unpack_tar(reader, dir.path(), "fixture.tar", &lease.job).is_err());
        assert!(lease.job.commit(|| Ok(())).is_err());
        assert!(!std::fs::read(dir.path().join("agent")).is_ok_and(|bytes| bytes.len() == 4096));
    }

    #[test]
    fn failed_zip_only_removes_its_own_staged_file() {
        let dir = tempfile::tempdir().unwrap();
        let previous = dir
            .path()
            .join(format!(".archive-{}.zip", std::process::id()));
        std::fs::write(&previous, "previous attempt").unwrap();
        let lease = job("zip-staging-cleanup");
        assert!(extract_archive(b"invalid zip", dir.path(), "fixture.zip", &lease.job).is_err());
        assert_eq!(
            std::fs::read_to_string(previous).unwrap(),
            "previous attempt"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
