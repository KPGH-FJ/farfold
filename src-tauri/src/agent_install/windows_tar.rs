//! Windows registry tar content is copied only from ordinary files/directories.
//! macOS keeps its existing extractor and link behavior in archive.rs.
use std::io::Read;
use std::path::{Component, Path};

const EXPANDED_LIMIT: u64 = 1024 * 1024 * 1024;
const ENTRY_LIMIT: usize = 100_000;

struct BoundedReader<'a, R, F> {
    reader: R,
    read: u64,
    limit: u64,
    check: &'a F,
}
impl<R: Read, F: Fn() -> Result<(), String>> Read for BoundedReader<'_, R, F> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        (self.check)().map_err(std::io::Error::other)?;
        let count = self.reader.read(buffer)?;
        self.read = self.read.saturating_add(count as u64);
        if self.read > self.limit {
            return Err(std::io::Error::other("展开内容超过允许大小"));
        }
        Ok(count)
    }
}

pub(super) fn unpack(
    reader: impl Read,
    destination: &Path,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    unpack_bounded(reader, destination, check, EXPANDED_LIMIT, ENTRY_LIMIT)
}

fn unpack_bounded(
    reader: impl Read,
    destination: &Path,
    check: impl Fn() -> Result<(), String>,
    limit: u64,
    entry_limit: usize,
) -> Result<(), String> {
    check()?;
    let mut archive = tar::Archive::new(BoundedReader {
        reader,
        read: 0,
        limit,
        check: &check,
    });
    archive.set_overwrite(false);
    let entries = archive.entries().map_err(|_| "下载内容不完整，请重试")?;
    let mut declared = 0_u64;
    for (count, entry) in entries.enumerate() {
        check()?;
        if count >= entry_limit {
            return Err("下载内容的文件数超过允许范围".into());
        }
        let mut entry = entry.map_err(|_| "下载内容不完整，请重试")?;
        // Check the raw spelling too: on Windows a backslash is interpreted as
        // a separator before Path::components can expose the original input.
        if entry.path_bytes().contains(&b'\\') {
            return Err("下载内容的文件位置无效".into());
        }
        let path = entry.path().map_err(|_| "下载内容的文件位置无效")?;
        for component in path.components() {
            match component {
                Component::CurDir => {}
                Component::Normal(name)
                    if name
                        .to_str()
                        .is_some_and(crate::archive_zip::safe_component) => {}
                _ => return Err("下载内容的文件位置无效".into()),
            }
        }
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir()) {
            return Err("下载内容包含不能使用的文件类型".into());
        }
        declared = declared
            .checked_add(entry.size())
            .filter(|size| *size <= limit)
            .ok_or("下载内容展开后超过允许大小")?;
        if !entry
            .unpack_in(destination)
            .map_err(|_| "无法展开下载内容，请重试")?
        {
            return Err("下载内容的文件位置无效".into());
        }
    }
    check()
}

#[cfg(test)]
mod tests;
