//! ZIP extraction into a fresh installation candidate, with no external shell.
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

const TOTAL_LIMIT: u64 = 1024 * 1024 * 1024;
const ENTRY_LIMIT: usize = 100_000;

/// A single literal Windows filename, shared by owned archive extractors.
pub(crate) fn safe_component(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    !(name.is_empty()
        || name.chars().any(|ch| {
            ch.is_control() || ['<', '>', ':', '"', '/', '\\', '|', '?', '*'].contains(&ch)
        })
        || name.ends_with(['.', ' '])
        || ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            }))
}

/// The registry may publish a raw Windows executable instead of an archive.
/// This recognizes its public URL format and declared relative output only;
/// content/headers/version never establish protocol compatibility.
pub(crate) fn raw_executable_target(label: &str, command: &str) -> Option<PathBuf> {
    if !label.split(['?', '#']).next()?.ends_with(".exe") {
        return None;
    }
    let relative = command
        .strip_prefix("./")
        .or_else(|| command.strip_prefix(".\\"))
        .unwrap_or(command);
    let mut path = PathBuf::new();
    for part in relative.split(['/', '\\']) {
        if !safe_component(part) || matches!(part, "." | "..") {
            return None;
        }
        path.push(part);
    }
    path.extension()
        .and_then(std::ffi::OsStr::to_str)
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        .then_some(path)
}

pub(crate) fn extract(
    bytes: &[u8],
    destination: &Path,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| "下载的压缩文件无效")?;
    if archive.len() > ENTRY_LIMIT {
        return Err("下载内容的文件数超过允许范围".into());
    }
    let mut total = 0u64;
    for index in 0..archive.len() {
        check()?;
        let mut entry = archive.by_index(index).map_err(|_| "无法读取压缩文件")?;
        if entry.name().contains('\\') {
            return Err("压缩文件中的位置无效".into());
        }
        let path = entry.enclosed_name().ok_or("压缩文件中的位置无效")?;
        for component in path.components() {
            let Component::Normal(part) = component else {
                return Err("压缩文件中的位置无效".into());
            };
            let name = part.to_str().ok_or("压缩文件中的名称无效")?;
            if !safe_component(name) {
                return Err("压缩文件中的名称无效".into());
            }
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("压缩文件包含无法安全展开的链接".into());
        }
        let target = destination.join(&path);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|_| "无法创建程序目录")?;
            continue;
        }
        total = total
            .checked_add(entry.size())
            .filter(|n| *n <= TOTAL_LIMIT)
            .ok_or("解压内容超过允许大小")?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "无法创建程序目录")?;
        }
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(|_| "无法保存解压内容")?;
        let mut written = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            check()?;
            let count = entry
                .read(&mut buffer)
                .map_err(|_| "下载的压缩文件不完整")?;
            if count == 0 {
                break;
            }
            written += count as u64;
            if written > entry.size() {
                return Err("压缩内容大小不一致".into());
            }
            output
                .write_all(&buffer[..count])
                .map_err(|_| "无法保存解压内容")?;
        }
        if written != entry.size() {
            return Err("压缩内容大小不一致".into());
        }
    }
    check()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn archive(name: &str, body: &[u8]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(body).unwrap();
        writer.finish().unwrap().into_inner()
    }
    #[test]
    fn extracts_regular_files_and_preserves_existing_candidates() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = archive("node/node.exe", b"synthetic");
        extract(&bytes, dir.path(), || Ok(())).unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("node/node.exe")).unwrap(),
            b"synthetic"
        );
        assert!(extract(&bytes, dir.path(), || Ok(())).is_err());
        assert_eq!(
            std::fs::read(dir.path().join("node/node.exe")).unwrap(),
            b"synthetic"
        );
    }
    #[test]
    fn rejects_escape_and_windows_special_paths_before_writing() {
        for path in [
            "../outside",
            "drive:stream",
            "node/CON.txt",
            "node/LPT1",
            "node/COM¹.txt",
            "node/LPT²",
            "node/COM³",
            "node/CONIN$",
            "node/CONOUT$.txt",
            "node/trailing.",
            "node\\escape",
            "node\\nested/escape",
            "node/inner\\escape",
        ] {
            let dir = tempfile::tempdir().unwrap();
            assert!(
                extract(&archive(path, b"no"), dir.path(), || Ok(())).is_err(),
                "{path}"
            );
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        }
    }
    #[test]
    fn cancellation_does_not_create_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            extract(&archive("node.exe", b"no"), dir.path(), || Err(
                "cancelled".into()
            ))
            .is_err()
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn excessive_empty_entries_are_rejected_before_creating_files() {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for index in 0..=ENTRY_LIMIT {
            writer
                .start_file(format!("empty-{index}"), options)
                .unwrap();
        }
        let bytes = writer.finish().unwrap().into_inner();
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            extract(&bytes, directory.path(), || Ok(())).unwrap_err(),
            "下载内容的文件数超过允许范围"
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn windows_component_policy_rejects_devices_streams_and_reserved_characters() {
        for name in [
            "CONIN$",
            "conout$.txt",
            "COM¹",
            "lpt².txt",
            "LPT³",
            "name:stream",
            "a?b",
            "a|b",
            "trailing ",
            "a\u{1}b",
        ] {
            assert!(!safe_component(name), "{name:?}");
        }
        for name in [
            "node.exe",
            "uv.exe",
            "library-你好.py",
            "COM10",
            ".metadata",
        ] {
            assert!(safe_component(name), "{name}");
        }
    }
}
