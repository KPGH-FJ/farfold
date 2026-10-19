//! Opt-in local namespace pins. Existing delivery/browser sharing is unchanged.
use super::*;
use std::{
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};
use windows_sys::Win32::System::WindowsProgramming::{
    DRIVE_CDROM, DRIVE_FIXED, DRIVE_RAMDISK, DRIVE_REMOVABLE,
};

pub(crate) struct PinnedPath {
    files: Vec<File>,
    // This owner has one FileObject cursor. All directory queries use this lock.
    directory_scan: Mutex<()>,
    identities: Vec<Identity>,
    pub path: String,
    pub guid_path: PathBuf,
}
fn final_path(file: &File, flags: u32) -> io::Result<String> {
    let count = unsafe { GetFinalPathNameByHandleW(handle(file), ptr::null_mut(), 0, flags) };
    if count == 0 || count > 32768 {
        return Err(denied());
    }
    let mut text = vec![0u16; count as usize + 1];
    let length = unsafe {
        GetFinalPathNameByHandleW(handle(file), text.as_mut_ptr(), text.len() as u32, flags)
    };
    if length == 0 || length as usize >= text.len() {
        return Err(denied());
    }
    String::from_utf16(&text[..length as usize]).map_err(|_| invalid())
}
fn local_guid(file: &File) -> io::Result<PathBuf> {
    // Microsoft documents that network shares have no volume GUID path. Query
    // this actual handle, never infer locality from FILE_TYPE_DISK or a letter.
    let path = final_path(file, FILE_NAME_NORMALIZED | VOLUME_NAME_GUID)?;
    let tail = path.strip_prefix(r"\\?\Volume{").ok_or_else(denied)?;
    let (id, _) = tail.split_once("}\\").ok_or_else(denied)?;
    if id.len() != 36
        || !id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return Err(denied());
    }
    let root = format!(r"\\?\Volume{{{id}}}\");
    let wide: Vec<_> = root.encode_utf16().chain(Some(0)).collect();
    if !matches!(
        unsafe { GetDriveTypeW(wide.as_ptr()) },
        DRIVE_FIXED | DRIVE_REMOVABLE | DRIVE_CDROM | DRIVE_RAMDISK
    ) {
        return Err(denied());
    }
    Ok(PathBuf::from(path))
}
impl PinnedPath {
    pub(crate) fn directory(path: &Path) -> io::Result<Self> {
        Self::open(path, false, false)
    }
    pub(crate) fn git_directory(path: &Path) -> io::Result<Self> {
        Self::open(path, false, true)
    }
    pub(crate) fn regular(path: &Path) -> io::Result<Self> {
        Self::open(path, true, false)
    }
    pub(crate) fn git_regular(path: &Path) -> io::Result<Self> {
        Self::open(path, true, true)
    }
    fn open(path: &Path, regular: bool, git_guid: bool) -> io::Result<Self> {
        if !git_guid {
            absolute(path)?;
        }
        let mut parts = path.components();
        let Component::Prefix(prefix) = parts.next().ok_or_else(invalid)? else {
            return Err(invalid());
        };
        let root = match prefix.kind() {
            Prefix::Disk(d) | Prefix::VerbatimDisk(d) => format!("\\\\?\\{}:\\", d as char),
            Prefix::Verbatim(volume) if git_guid => {
                let value = volume.to_str().ok_or_else(invalid)?;
                let id = value
                    .strip_prefix("Volume{")
                    .and_then(|v| v.strip_suffix('}'))
                    .ok_or_else(invalid)?;
                if id.len() != 36
                    || !id.bytes().enumerate().all(|(i, b)| {
                        if [8, 13, 18, 23].contains(&i) {
                            b == b'-'
                        } else {
                            b.is_ascii_hexdigit()
                        }
                    })
                {
                    return Err(invalid());
                }
                format!("\\\\?\\{value}\\")
            }
            _ => return Err(invalid()),
        };
        if !matches!(parts.next(), Some(Component::RootDir)) {
            return Err(invalid());
        }
        let root: Vec<_> = root.encode_utf16().chain(Some(0)).collect();
        let raw = unsafe {
            CreateFileW(
                root.as_ptr(),
                FILE_GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                ptr::null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let root = unsafe { File::from_raw_handle(raw) };
        if stamp(&root)?.regular {
            return Err(denied());
        }
        local_guid(&root)?;
        let mut files = vec![root];
        let components: Vec<_> = parts.filter(|c| *c != Component::RootDir).collect();
        if regular && components.is_empty() {
            return Err(denied());
        }
        for (index, component) in components.iter().enumerate() {
            let Component::Normal(name) = component else {
                return Err(invalid());
            };
            let is_file = regular && index + 1 == components.len();
            let share = FILE_SHARE_READ | if is_file { 0 } else { FILE_SHARE_WRITE };
            let next = open_at_shared(
                files.last().ok_or_else(invalid)?,
                name,
                !is_file,
                false,
                share,
            )?;
            files.push(next);
        }
        let leaf = files.last().ok_or_else(invalid)?;
        let path = final_path(leaf, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS)?;
        if path.len() > 4096 {
            return Err(invalid());
        }
        absolute(Path::new(&path))?;
        let guid_path = local_guid(leaf)?;
        let identities = files
            .iter()
            .map(|f| stamp(f).map(|s| s.identity))
            .collect::<io::Result<_>>()?;
        Ok(Self {
            directory_scan: Mutex::new(()),
            files,
            identities,
            path,
            guid_path,
        })
    }
    // Keep the guard for the complete restart-to-EOF scan. PinnedPath is not
    // Clone; any future aliasing FileObject constructor must share this owner.
    pub(super) fn directory_scan(&self) -> io::Result<MutexGuard<'_, ()>> {
        self.directory_scan
            .lock()
            .map_err(|_| io::Error::other("directory scan owner poisoned"))
    }
    // Opens a fresh child FileObject relative to this actual held parent.
    // Ancestor duplicates are used only for verification, never enumeration.
    pub(crate) fn child(&self, raw: &[u16], directory: bool) -> io::Result<Self> {
        self.verify()?;
        // Current local-path admission supports ordinary Unicode spelling only.
        // Unsupported raw names fail the whole observation; never lossy-convert.
        let text = String::from_utf16(raw).map_err(|_| invalid())?;
        let child = open_at_shared(
            self.file(),
            OsStr::new(&text),
            directory,
            false,
            FILE_SHARE_READ | if directory { FILE_SHARE_WRITE } else { 0 },
        )?;
        let mut files = self
            .files
            .iter()
            .map(File::try_clone)
            .collect::<io::Result<Vec<_>>>()?;
        let child_identity = stamp(&child)?.identity;
        let path = final_path(&child, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS)?;
        if path.len() > 4096 {
            return Err(invalid());
        }
        absolute(Path::new(&path))?;
        let guid_path = local_guid(&child)?;
        files.push(child);
        let mut identities = self.identities.clone();
        identities.push(child_identity);
        let result = Self {
            files,
            directory_scan: Mutex::new(()),
            identities,
            path,
            guid_path,
        };
        self.verify()?;
        result.verify()?;
        Ok(result)
    }
    pub(crate) fn file(&self) -> &File {
        self.files.last().expect("pinned leaf")
    }
    pub(crate) fn chain_identities(&self) -> &[Identity] {
        &self.identities
    }
    pub(crate) fn identity(&self) -> &Identity {
        self.identities.last().expect("pinned identity")
    }
    pub(crate) fn has_ancestor(&self, identity: &Identity) -> bool {
        self.identities.contains(identity)
    }
    pub(crate) fn verify(&self) -> io::Result<()> {
        for (file, identity) in self.files.iter().zip(&self.identities) {
            if stamp(file)?.identity != *identity {
                return Err(denied());
            }
        }
        if local_guid(self.file())? != self.guid_path {
            return Err(denied());
        }
        Ok(())
    }
}
