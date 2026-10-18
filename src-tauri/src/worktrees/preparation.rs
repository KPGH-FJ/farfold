//! Fixed-name, no-content observations anchored to held directory descriptors.
#[cfg(target_os = "macos")]
use super::{
    preparation_git,
    preparation_types::{FIXED_NAMES, PreparationNodeKind},
};
use super::{
    preparation_git::GitObservation,
    preparation_types::PreparationFact,
    storage::SavedLocation,
    types::{Result, error},
};

pub(super) fn supported() -> Result<()> {
    if cfg!(any(target_os = "macos", windows)) {
        Ok(())
    } else {
        Err(error("unsupportedGit"))
    }
}

pub(super) fn relative_segments(relative: &str) -> Result<Vec<&str>> {
    if relative.is_empty() {
        return Ok(Vec::new());
    }
    if relative.len() > 1024 || relative.contains('\\') || relative.chars().any(char::is_control) {
        return Err(error("unsafePath"));
    }
    let segments: Vec<_> = relative.split('/').collect();
    if segments.len() > 8
        || segments
            .iter()
            .any(|s| s.is_empty() || matches!(*s, "." | "..") || s.eq_ignore_ascii_case(".git"))
    {
        return Err(error("unsafePath"));
    }
    Ok(segments)
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Observation {
    pub project_path: String,
    pub facts: Vec<PreparationFact>,
    pub git: GitObservation,
    #[cfg(target_os = "macos")]
    metadata: platform::MetadataObservation,
    #[cfg(windows)]
    metadata: super::preparation_windows::MetadataObservation,
}
pub(super) fn collect(saved: &SavedLocation, relative: &str) -> Result<Observation> {
    collect_with(saved, relative, || {})
}
// This sequencing seam is private to the module: tests mutate only owned fixtures.
// The public manager and IPC always use collect(), which supplies no callback.
pub(super) fn collect_with(
    saved: &SavedLocation,
    relative: &str,
    between: impl FnOnce(),
) -> Result<Observation> {
    let segments = relative_segments(relative)?;
    #[cfg(target_os = "macos")]
    {
        let scope = platform::Scope::open(saved, &segments)?;
        let before = scope.observe()?;
        let git = preparation_git::observe(saved)?;
        between();
        scope.recheck(saved)?;
        if scope.observe()? != before || preparation_git::observe(saved)? != git {
            return Err(error("changed"));
        }
        // The second Git observation may take time; finish with the original
        // descriptor chain and exact fixed-name metadata, never HEAD alone.
        scope.recheck(saved)?;
        if scope.observe()? != before {
            return Err(error("changed"));
        }
        Ok(Observation {
            project_path: scope.project_path(),
            facts: before.facts(),
            git,
            metadata: before,
        })
    }
    #[cfg(windows)]
    {
        let scope = super::preparation_windows::Scope::open(saved, &segments)?;
        let before = scope.observe()?;
        let git = scope.git(saved)?;
        between();
        scope.recheck(saved)?;
        if scope.observe()? != before || scope.git(saved)? != git {
            return Err(error("changed"));
        }
        scope.recheck(saved)?;
        if scope.observe()? != before {
            return Err(error("changed"));
        }
        Ok(Observation {
            project_path: scope.project_path(),
            facts: before.facts(),
            git,
            metadata: before,
        })
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (saved, segments, between);
        Err(error("unsupportedGit"))
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::{
        ffi::CString,
        fs::{self, File},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::MetadataExt},
        },
        path::{Path, PathBuf},
    };
    #[derive(Debug, Clone, PartialEq, Eq)]
    struct MetadataStamp {
        dev: u64,
        ino: u64,
        mode: u32,
        links: u64,
        size: i64,
        uid: u32,
        gid: u32,
        mtime: (i64, i64),
        ctime: (i64, i64),
        flags: u32,
    }
    impl From<libc::stat> for MetadataStamp {
        fn from(v: libc::stat) -> Self {
            Self {
                dev: v.st_dev as u64,
                ino: v.st_ino,
                mode: v.st_mode as u32,
                links: v.st_nlink as u64,
                size: v.st_size,
                uid: v.st_uid,
                gid: v.st_gid,
                mtime: (v.st_mtime, v.st_mtime_nsec),
                ctime: (v.st_ctime, v.st_ctime_nsec),
                flags: v.st_flags,
            }
        }
    }
    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Node {
        Missing,
        Present(MetadataStamp),
        Unreadable(i32),
    }
    impl Node {
        fn kind(&self) -> PreparationNodeKind {
            match self {
                Self::Missing => PreparationNodeKind::Missing,
                Self::Unreadable(_) => PreparationNodeKind::Unreadable,
                Self::Present(v) => match v.mode & libc::S_IFMT as u32 {
                    x if x == libc::S_IFREG as u32 => PreparationNodeKind::File,
                    x if x == libc::S_IFDIR as u32 => PreparationNodeKind::Directory,
                    x if x == libc::S_IFLNK as u32 => PreparationNodeKind::Symlink,
                    _ => PreparationNodeKind::Other,
                },
            }
        }
    }
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(super) struct MetadataObservation {
        directories: Vec<(u64, u64, u32)>,
        entries: Vec<Node>,
    }
    impl MetadataObservation {
        pub(super) fn facts(&self) -> Vec<PreparationFact> {
            FIXED_NAMES
                .iter()
                .zip(&self.entries)
                .map(|((name, role), node)| PreparationFact {
                    name,
                    role: *role,
                    node_kind: node.kind(),
                })
                .collect()
        }
    }
    fn metadata(dir: &File, name: &str) -> Node {
        let name = CString::new(name).expect("fixed ASCII name");
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                dir.as_raw_fd(),
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } == 0
        {
            Node::Present(unsafe { stat.assume_init() }.into())
        } else {
            metadata_error(std::io::Error::last_os_error().raw_os_error().unwrap_or(0))
        }
    }
    fn metadata_error(code: i32) -> Node {
        // ENOTDIR, EACCES, EIO, etc. are not evidence of absence.
        if code == libc::ENOENT {
            Node::Missing
        } else {
            Node::Unreadable(code)
        }
    }
    fn io_failure(e: std::io::Error) -> super::super::types::Failure {
        error(match e.raw_os_error() {
            Some(libc::ENOENT) => "missing",
            Some(libc::ELOOP | libc::ENOTDIR) => "unsafePath",
            _ => "unavailable",
        })
    }
    fn open_directory(parent: Option<&File>, name: &Path) -> Result<File> {
        let name = CString::new(name.as_os_str().as_bytes()).map_err(|_| error("unsafePath"))?;
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let fd = unsafe {
            match parent {
                Some(parent) => libc::openat(parent.as_raw_fd(), name.as_ptr(), flags),
                None => libc::open(name.as_ptr(), flags),
            }
        };
        if fd < 0 {
            Err(io_failure(std::io::Error::last_os_error()))
        } else {
            Ok(unsafe { File::from_raw_fd(fd) })
        }
    }
    fn identity(file: &File) -> Result<(u64, u64, u32)> {
        let m = file.metadata().map_err(io_failure)?;
        if !m.is_dir() {
            return Err(error("unsafePath"));
        }
        Ok((m.dev(), m.ino(), m.mode()))
    }
    pub(super) struct Scope {
        paths: Vec<PathBuf>,
        handles: Vec<File>,
        identities: Vec<(u64, u64, u32)>,
    }
    impl Scope {
        pub(super) fn open(saved: &SavedLocation, segments: &[&str]) -> Result<Self> {
            saved.identity.check()?;
            let root = PathBuf::from(&saved.location.path);
            let root_handle = open_directory(None, &root)?;
            let mut scope = Self {
                paths: vec![root],
                handles: vec![root_handle],
                identities: Vec::new(),
            };
            for segment in segments {
                let next = open_directory(scope.handles.last(), Path::new(segment))?;
                scope.paths.push(scope.paths.last().unwrap().join(segment));
                scope.handles.push(next);
            }
            scope.identities = scope.handles.iter().map(identity).collect::<Result<_>>()?;
            if scope.paths.last().unwrap().as_os_str().len() > 4096 {
                return Err(error("unsafePath"));
            }
            scope.recheck(saved)?;
            Ok(scope)
        }
        pub(super) fn project_path(&self) -> String {
            self.paths
                .last()
                .unwrap()
                .to_str()
                .expect("validated UTF-8 scope")
                .to_owned()
        }
        pub(super) fn observe(&self) -> Result<MetadataObservation> {
            let directories = self
                .handles
                .iter()
                .map(identity)
                .collect::<Result<Vec<_>>>()?;
            if directories != self.identities {
                return Err(error("changed"));
            }
            Ok(MetadataObservation {
                directories,
                entries: FIXED_NAMES
                    .iter()
                    .map(|(name, _)| metadata(self.handles.last().unwrap(), name))
                    .collect(),
            })
        }
        pub(super) fn recheck(&self, saved: &SavedLocation) -> Result<()> {
            saved.identity.check()?;
            // Rewalk from the selected canonical root. Opened handles cannot
            // silently retarget when a parent, subdirectory or link is replaced.
            let mut current = open_directory(None, &self.paths[0])?;
            for index in 0..self.handles.len() {
                if index > 0 {
                    current = open_directory(
                        Some(&current),
                        Path::new(self.paths[index].file_name().unwrap()),
                    )?;
                }
                if identity(&current)? != self.identities[index]
                    || identity(&self.handles[index])? != self.identities[index]
                {
                    return Err(error("changed"));
                }
            }
            let m = fs::symlink_metadata(&self.paths[0]).map_err(io_failure)?;
            if !m.is_dir() || (m.dev(), m.ino(), m.mode()) != self.identities[0] {
                return Err(error("changed"));
            }
            saved.identity.check()
        }
    }
    #[cfg(test)]
    #[test]
    fn only_enoent_is_missing() {
        assert_eq!(
            metadata_error(libc::ENOENT).kind(),
            PreparationNodeKind::Missing
        );
        for code in [libc::EACCES, libc::EIO, libc::ENOTDIR, libc::EBUSY] {
            assert_eq!(metadata_error(code).kind(), PreparationNodeKind::Unreadable);
        }
    }
}
