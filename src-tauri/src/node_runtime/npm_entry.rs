//! npm may replace a JavaScript bin with a platform executable during install.
//! Inspect only bounded executable headers; initialize still decides compatibility.
use super::NpmLaunch;
use std::fs::File;
#[cfg(unix)]
use std::os::unix::fs::{FileExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const INVALID: &str = "无法确认程序入口格式，请检查安装后重试";
const OUTSIDE: &str = "程序入口不在本次安装目录中，原选择保持不变";
const MAX_ARCHES: u32 = 16;

pub(super) fn modules_root(install_dir: &Path) -> Result<PathBuf, String> {
    let root = install_dir.canonicalize().map_err(|_| OUTSIDE)?;
    let expected = root.join("node_modules");
    let actual = expected.canonicalize().map_err(|_| OUTSIDE)?;
    if expected != actual {
        return Err(OUTSIDE.into());
    }
    Ok(actual)
}

pub(super) fn owned_path(path: &Path, root: &Path) -> Result<PathBuf, String> {
    let path = path.canonicalize().map_err(|_| OUTSIDE)?;
    if !path.starts_with(root) || path == root {
        return Err(OUTSIDE.into());
    }
    Ok(path)
}

pub(super) fn launch(node: PathBuf, entry: PathBuf) -> Result<NpmLaunch, String> {
    // Check before opening so a directory, socket or FIFO is never read as a bin.
    if !entry.symlink_metadata().map_err(|_| INVALID)?.is_file() {
        return Err(INVALID.into());
    }
    let mut options = File::options();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    #[cfg(windows)]
    options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    let file = options.open(&entry).map_err(|_| INVALID)?;
    let metadata = file.metadata().map_err(|_| INVALID)?;
    if !metadata.is_file() {
        return Err(INVALID.into());
    }
    #[cfg(windows)]
    if metadata.file_attributes()
        & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
        != 0
    {
        return Err(INVALID.into());
    }
    let native = if cfg!(windows) {
        is_pe_executable(&file, metadata.len())?
    } else {
        is_mach_executable(&file, metadata.len())?
    };
    if native {
        if !crate::process_platform::executable(&entry) {
            return Err("程序入口没有执行权限，请重新安装".into());
        }
        Ok(NpmLaunch {
            command: entry,
            prefix_args: vec![],
        })
    } else {
        // Text/script entries keep the existing absolute, selected Node launch;
        // neither the extension nor an arbitrary shebang selects another shell.
        Ok(NpmLaunch {
            command: node,
            prefix_args: vec![entry.to_string_lossy().into_owned()],
        })
    }
}

fn read<const N: usize>(file: &File, offset: u64) -> Result<[u8; N], String> {
    let mut bytes = [0; N];
    #[cfg(unix)]
    file.read_exact_at(&mut bytes, offset)
        .map_err(|_| INVALID)?;
    #[cfg(windows)]
    {
        let mut used = 0;
        while used < N {
            let count = file
                .seek_read(&mut bytes[used..], offset + used as u64)
                .map_err(|_| INVALID)?;
            if count == 0 {
                return Err(INVALID.into());
            }
            used += count;
        }
    }
    Ok(bytes)
}

// Microsoft PE/COFF: DOS pointer at 0x3c, PE signature and executable image
// characteristic. Bounded header reads distinguish PE bins from JavaScript.
fn is_pe_executable(file: &File, len: u64) -> Result<bool, String> {
    if len < 2 || read::<2>(file, 0)? != *b"MZ" {
        return Ok(false);
    }
    if len < 64 {
        return Err(INVALID.into());
    }
    let offset = u32::from_le_bytes(read::<4>(file, 60)?) as u64;
    if offset < 64 || offset.checked_add(24).is_none_or(|end| end > len) {
        return Err(INVALID.into());
    }
    let header = read::<24>(file, offset)?;
    let characteristics = u16::from_le_bytes([header[22], header[23]]);
    if &header[..4] != b"PE\0\0" || characteristics & 0x0002 == 0 || characteristics & 0x2000 != 0 {
        return Err(INVALID.into());
    }
    Ok(true)
}

fn u32_at(bytes: &[u8], little: bool) -> u32 {
    let bytes = bytes[..4].try_into().expect("fixed header field");
    if little {
        u32::from_le_bytes(bytes)
    } else {
        u32::from_be_bytes(bytes)
    }
}

fn u64_at(bytes: &[u8], little: bool) -> u64 {
    let bytes = bytes[..8].try_into().expect("fixed header field");
    if little {
        u64::from_le_bytes(bytes)
    } else {
        u64::from_be_bytes(bytes)
    }
}

// Apple mach-o/{loader,fat}.h: MH_EXECUTE is 2; a universal binary contains
// independent Mach headers at its arch table offsets. Header reads total at most
// 4 + 8 + 16 * (32 + 32) bytes, regardless of executable size.
fn is_mach_executable(file: &File, len: u64) -> Result<bool, String> {
    if len < 4 {
        return Ok(false);
    }
    let magic = read::<4>(file, 0)?;
    if thin_kind(magic).is_some() {
        thin_executable(file, 0, len)?;
        return Ok(true);
    }
    let (little, wide) = match magic {
        [0xca, 0xfe, 0xba, 0xbe] => (false, false),
        [0xbe, 0xba, 0xfe, 0xca] => (true, false),
        [0xca, 0xfe, 0xba, 0xbf] => (false, true),
        [0xbf, 0xba, 0xfe, 0xca] => (true, true),
        _ => return Ok(false),
    };
    let header = read::<8>(file, 0)?;
    let count = u32_at(&header[4..], little);
    if !(1..=MAX_ARCHES).contains(&count) {
        return Err(INVALID.into());
    }
    let width = if wide { 32 } else { 20 };
    let table_end = 8 + u64::from(count) * width;
    if table_end > len {
        return Err(INVALID.into());
    }
    for index in 0..count {
        let position = 8 + u64::from(index) * width;
        let (cpu, offset, size) = if wide {
            let arch = read::<32>(file, position)?;
            (
                u32_at(&arch, little),
                u64_at(&arch[8..], little),
                u64_at(&arch[16..], little),
            )
        } else {
            let arch = read::<20>(file, position)?;
            (
                u32_at(&arch, little),
                u64::from(u32_at(&arch[8..], little)),
                u64::from(u32_at(&arch[12..], little)),
            )
        };
        if offset < table_end
            || offset.checked_add(size).is_none_or(|end| end > len)
            || thin_executable(file, offset, size)? != cpu
        {
            return Err(INVALID.into());
        }
    }
    Ok(true)
}

fn thin_kind(magic: [u8; 4]) -> Option<(bool, u64)> {
    match magic {
        [0xce, 0xfa, 0xed, 0xfe] => Some((true, 28)),
        [0xcf, 0xfa, 0xed, 0xfe] => Some((true, 32)),
        [0xfe, 0xed, 0xfa, 0xce] => Some((false, 28)),
        [0xfe, 0xed, 0xfa, 0xcf] => Some((false, 32)),
        _ => None,
    }
}

fn thin_executable(file: &File, offset: u64, size: u64) -> Result<u32, String> {
    if size < 28 {
        return Err(INVALID.into());
    }
    let header = read::<28>(file, offset)?;
    let (little, length) = thin_kind(header[..4].try_into().unwrap()).ok_or(INVALID)?;
    if size < length
        || u32_at(&header[12..], little) != 2
        || u64::from(u32_at(&header[20..], little)) > size - length
    {
        return Err(INVALID.into());
    }
    Ok(u32_at(&header[4..], little))
}

#[cfg(test)]
mod pe_tests {
    use super::*;
    #[test]
    fn distinguishes_bounded_executable_headers_from_text_dlls_and_bad_offsets() {
        let mut bytes = vec![0u8; 128];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[60..64].copy_from_slice(&64u32.to_le_bytes());
        bytes[64..68].copy_from_slice(b"PE\0\0");
        bytes[86..88].copy_from_slice(&2u16.to_le_bytes());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.exe");
        let check = |body: &[u8]| {
            std::fs::write(&path, body).unwrap();
            is_pe_executable(&File::open(&path).unwrap(), body.len() as u64)
        };
        assert_eq!(check(&bytes), Ok(true));
        bytes[86..88].copy_from_slice(&0x2002u16.to_le_bytes());
        assert!(check(&bytes).is_err());
        bytes[60..64].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(check(&bytes).is_err());
        assert_eq!(check(b"#!/usr/bin/env node\n"), Ok(false));
    }
}
