//! New regular worktree bytes only: no reopen/reuse, overwrite or deletion.
use super::pinned::local_guid;
use super::*;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    sync::atomic::{AtomicBool, Ordering},
};

enum Root<'a> {
    Existing(&'a PinnedPath),
    New { pin: PinnedPath, _writer: File },
}
#[cfg(test)]
#[path = "worktree_checkout_tests.rs"]
mod tests;
impl Root<'_> {
    fn pin(&self) -> &PinnedPath {
        match self {
            Self::Existing(pin) => pin,
            Self::New { pin, .. } => pin,
        }
    }
}

struct Owned {
    file: File,
    identity: Identity,
    regular: bool,
    length: u64,
    scan: std::sync::Mutex<()>,
}
pub(crate) struct WorktreeCheckout<'a> {
    root: Root<'a>,
    directories: Vec<Owned>,
    names: BTreeMap<(usize, String), usize>,
    files: Vec<Owned>,
    children: Vec<BTreeMap<Vec<u16>, (Identity, bool)>>,
    registration: Option<PinnedPath>,
    index: Option<(TemporaryExport, PinnedPath)>,
    bytes: u64,
}
fn cancelled(cancel: &AtomicBool) -> io::Result<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(io::ErrorKind::Interrupted.into())
    } else {
        Ok(())
    }
}
fn components(path: &str) -> io::Result<Vec<&str>> {
    if path.is_empty() || path.len() > 4096 || path.contains('\\') {
        return Err(invalid());
    }
    let parts = path.split('/').collect::<Vec<_>>();
    for part in &parts {
        if part.is_empty() || matches!(*part, "." | "..") || part.eq_ignore_ascii_case(".git") {
            return Err(invalid());
        }
        name(OsStr::new(part))?;
    }
    Ok(parts)
}
// Unlike export temporaries this object will never be deleted or renamed by
// this owner. No DELETE access is requested, and no new writer/deleter can
// enter while its creation handle remains. Failure preserves the partial tree.
fn create(parent: &File, leaf: &OsStr, directory: bool) -> io::Result<File> {
    let mut raw = name(leaf)?;
    let unicode = UNICODE_STRING {
        Length: (raw.len() * 2) as u16,
        MaximumLength: (raw.len() * 2) as u16,
        Buffer: raw.as_mut_ptr(),
    };
    let object = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: handle(parent),
        ObjectName: &unicode,
        Attributes: OBJ_CASE_INSENSITIVE,
        ..Default::default()
    };
    let mut status = IO_STATUS_BLOCK::default();
    let mut result = ptr::null_mut();
    let code = unsafe {
        NtCreateFile(
            &mut result,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            &object,
            &mut status,
            ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ,
            FILE_CREATE,
            FILE_OPEN_REPARSE_POINT
                | FILE_SYNCHRONOUS_IO_NONALERT
                | if directory {
                    FILE_DIRECTORY_FILE
                } else {
                    FILE_NON_DIRECTORY_FILE
                },
            ptr::null(),
            0,
        )
    };
    if code < 0 {
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(code) } as i32,
        ));
    }
    let file = unsafe { File::from_raw_handle(result) };
    if stamp(&file)?.regular == directory {
        return Err(denied());
    }
    Ok(file)
}
impl Owned {
    fn new(file: File, regular: bool, length: u64) -> io::Result<Self> {
        let observed = stamp(&file)?;
        if observed.regular != regular
            || (regular && (observed.size != length || observed.links != 1))
        {
            return Err(denied());
        }
        Ok(Self {
            identity: observed.identity,
            file,
            regular,
            length,
            scan: std::sync::Mutex::new(()),
        })
    }
    fn verify(&self) -> io::Result<()> {
        let current = stamp(&self.file)?;
        if current.identity != self.identity
            || current.regular != self.regular
            || (self.regular && (current.size != self.length || current.links != 1))
        {
            return Err(denied());
        }
        Ok(())
    }
}
impl<'a> WorktreeCheckout<'a> {
    pub(crate) fn new(root: &'a PinnedPath) -> io::Result<Self> {
        root.verify()?;
        Ok(Self::from_root(Root::Existing(root)))
    }
    fn from_root(root: Root<'a>) -> Self {
        Self {
            root,
            directories: Vec::new(),
            names: BTreeMap::new(),
            files: Vec::new(),
            children: vec![BTreeMap::new()],
            registration: None,
            index: None,
            bytes: 0,
        }
    }
    pub(crate) fn create_under(parent: &PinnedPath, leaf: &str) -> io::Result<Self> {
        name(OsStr::new(leaf))?;
        parent.verify()?;
        let writer = create(parent.file(), OsStr::new(leaf), true)?;
        let guid = local_guid(&writer)?;
        let pin = PinnedPath::git_directory(&guid)?;
        if !crate::file_access::same_object(&writer, pin.file())? {
            return Err(denied());
        }
        parent.verify()?;
        Ok(Self::from_root(Root::New {
            pin,
            _writer: writer,
        }))
    }
    pub(crate) fn root(&self) -> &PinnedPath {
        self.root.pin()
    }
    // A reservation is an empty directory identity, not a checkout being
    // published. Retain its already-held no-DELETE pin continuously, but close
    // its creation writer before a move into it: FileRenameInformation opens
    // the destination parent for FILE_ADD_SUBDIRECTORY, which conflicts with
    // that writer's FILE_SHARE_READ-only admission. No namespace is reopened.
    // https://learn.microsoft.com/openspecs/windows_protocols/ms-fsa/87f86c9b-6c2a-4803-84b7-131a74a434fa
    pub(crate) fn into_reserved_directory(self, cancel: &AtomicBool) -> io::Result<PinnedPath> {
        cancelled(cancel)?;
        if !matches!(&self.root, Root::New { .. })
            || !self.directories.is_empty()
            || !self.names.is_empty()
            || !self.files.is_empty()
            || self.children.len() != 1
            || !self.children[0].is_empty()
            || self.registration.is_some()
            || self.index.is_some()
            || self.bytes != 0
        {
            return Err(denied());
        }
        self.verify()?;
        // Directory handles preserve identity, not exclusive membership. Any
        // observed foreign member is rejected; the later move also remains
        // strictly no-replace if a collision appears after this observation.
        for _ in 0..2 {
            if !super::directory::collect_from(self.root(), 1, cancel)
                .map_err(|_| denied())?
                .is_empty()
            {
                return Err(denied());
            }
        }
        let Root::New { pin, _writer } = self.root else {
            return Err(denied());
        };
        pin.verify()?;
        if !crate::file_access::same_object(&_writer, pin.file())? {
            return Err(denied());
        }
        cancelled(cancel)?;
        drop(_writer);
        pin.verify()?;
        Ok(pin)
    }
    pub(crate) fn retain_completed(&mut self, completed: WorktreeCheckout<'_>) -> io::Result<()> {
        if self.root().identity() != completed.root().identity()
            || self.root().guid_path != completed.root().guid_path
            || !self.directories.is_empty()
            || !self.files.is_empty()
            || self.registration.is_some()
            || self.index.is_some()
        {
            return Err(denied());
        }
        self.directories = completed.directories;
        self.names = completed.names;
        self.files = completed.files;
        self.children = completed.children;
        self.registration = completed.registration;
        self.index = completed.index;
        self.bytes = completed.bytes;
        self.verify()
    }
    pub(crate) fn validate_path(path: &str) -> io::Result<()> {
        components(path).map(|_| ())
    }
    // Git's fixed info/attributes mirror supplies the complete effective
    // selected-tree attributes. Empty pinned files at EVERY possible lookup
    // level prevent a foreign working-tree attribute file adding new rules.
    pub(crate) fn guard_attributes(
        &mut self,
        paths: &[String],
        cancel: &AtomicBool,
    ) -> io::Result<()> {
        let mut guards = BTreeSet::from([".gitattributes".to_owned()]);
        for path in paths {
            let parts = components(path)?;
            let mut prefix = String::new();
            for part in &parts[..parts.len() - 1] {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(part);
                guards.insert(format!("{prefix}/.gitattributes"));
                if guards.len() > 100_000 {
                    return Err(invalid());
                }
            }
        }
        let empty = tempfile::tempfile()?;
        for guard in guards {
            self.copy_regular(&guard, &empty, 0, cancel)?;
        }
        self.verify()
    }
    pub(crate) fn copy_regular(
        &mut self,
        path: &str,
        source: &File,
        length: u64,
        cancel: &AtomicBool,
    ) -> io::Result<()> {
        if stamp(source)?.size != length {
            return Err(denied());
        }
        self.copy_range(path, source, 0, length, cancel)
    }
    // The caller owns a completed anonymous Git stdout FileObject. Copy only
    // this verified frame; never reopen a Git-produced temporary pathname.
    pub(crate) fn copy_range(
        &mut self,
        path: &str,
        source: &File,
        offset: u64,
        length: u64,
        cancel: &AtomicBool,
    ) -> io::Result<()> {
        let parts = components(path)?;
        if length > 256 * 1024 * 1024
            || self.files.len() >= 100_000
            || self
                .bytes
                .checked_add(length)
                .is_none_or(|n| n > 1024 * 1024 * 1024)
        {
            return Err(invalid());
        }
        cancelled(cancel)?;
        self.root().verify()?;
        let before = stamp(source)?;
        if !before.regular || offset.checked_add(length).is_none_or(|n| n > before.size) {
            return Err(denied());
        }
        let mut parent = self.root().file().try_clone()?;
        let mut parent_index = 0;
        for part in &parts[..parts.len() - 1] {
            let key = (parent_index, (*part).to_owned());
            if let Some(index) = self.names.get(&key) {
                let owned = &self.directories[*index - 1];
                owned.verify()?;
                parent = owned.file.try_clone()?;
                parent_index = *index;
            } else {
                if self.directories.len() >= 100_000 {
                    return Err(invalid());
                }
                // FILE_CREATE against this actual parent never follows or
                // adopts an injected directory/junction, including case aliases.
                let file = create(&parent, OsStr::new(part), true)?;
                let owned = Owned::new(file, false, 0)?;
                parent = owned.file.try_clone()?;
                self.directories.push(owned);
                self.children[parent_index].insert(
                    part.encode_utf16().collect(),
                    (self.directories.last().unwrap().identity.clone(), true),
                );
                parent_index = self.directories.len();
                self.children.push(BTreeMap::new());
                self.names.insert(key, parent_index);
            }
        }
        let leaf = OsStr::new(parts.last().unwrap());
        let mut file = create(&parent, leaf, false)?;
        let mut reader = source.try_clone()?;
        use std::io::{Seek, SeekFrom};
        reader.seek(SeekFrom::Start(offset))?;
        let mut reader = reader.take(length);
        let mut copied = 0u64;
        let mut block = [0u8; 65_536];
        let mut digest = Sha256::new();
        loop {
            cancelled(cancel)?;
            let count = reader.read(&mut block)?;
            if count == 0 {
                break;
            }
            copied = copied
                .checked_add(count as u64)
                .filter(|n| *n <= length)
                .ok_or_else(invalid)?;
            file.write_all(&block[..count])?;
            digest.update(&block[..count]);
        }
        if copied != length || stamp(source)? != before {
            return Err(denied());
        }
        file.sync_all()?;
        let original = stamp(&file)?;
        let bridge = open_at_shared(
            &parent,
            leaf,
            false,
            false,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
        )?;
        if !crate::file_access::same_object(&file, &bridge)? {
            return Err(denied());
        }
        drop(file);
        let readonly = open_at_shared(&parent, leaf, false, false, FILE_SHARE_READ)?;
        let version = stamp(&readonly)?;
        if !crate::file_access::same_object(&bridge, &readonly)?
            || version.identity != original.identity
            || !version.regular
            || version.size != length
            || version.links != 1
        {
            return Err(denied());
        }
        let mut observed = Sha256::new();
        let mut reader = &readonly;
        let mut count_read = 0u64;
        loop {
            cancelled(cancel)?;
            let offer = (length - count_read)
                .saturating_add(1)
                .min(block.len() as u64) as usize;
            let count = reader.read(&mut block[..offer])?;
            if count == 0 {
                break;
            }
            count_read = count_read
                .checked_add(count as u64)
                .filter(|n| *n <= length)
                .ok_or_else(invalid)?;
            observed.update(&block[..count]);
        }
        if count_read != length
            || stamp(&readonly)? != version
            || digest.finalize() != observed.finalize()
        {
            return Err(denied());
        }
        let owned = Owned::new(readonly, true, length)?;
        self.children[parent_index].insert(
            parts.last().unwrap().encode_utf16().collect(),
            (owned.identity.clone(), false),
        );
        self.files.push(owned);
        self.bytes += length;
        self.root().verify()?;
        cancelled(cancel)
    }
    pub(crate) fn verify(&self) -> io::Result<()> {
        self.root().verify()?;
        for directory in &self.directories {
            directory.verify()?;
        }
        for file in &self.files {
            file.verify()?;
        }
        if let Some(pointer) = &self.registration {
            pointer.verify()?;
        }
        if let Some((index, parent)) = &self.index {
            parent.verify()?;
            let current = stamp(&index.file)?;
            if !current.regular
                || current.links != 1
                || local_guid(&index.file)? != parent.guid_path.join("index")
            {
                return Err(denied());
            }
        }
        Ok(())
    }
    pub(crate) fn retain_registration(&mut self) -> io::Result<()> {
        if self.registration.is_some() {
            return Err(invalid());
        }
        let pin = self
            .root()
            .child(&".git".encode_utf16().collect::<Vec<_>>(), false)?;
        let value = stamp(pin.file())?;
        if !value.regular || value.links != 1 || value.size > 4096 {
            return Err(denied());
        }
        self.registration = Some(pin);
        self.verify()
    }
    pub(crate) fn retain_index(
        &mut self,
        source: &File,
        parent: PinnedPath,
        cancel: &AtomicBool,
    ) -> io::Result<()> {
        if self.index.is_some() {
            return Err(invalid());
        }
        let publication = Self::publish_index(source, &parent, cancel)?;
        self.index = Some((publication, parent));
        self.verify()
    }
    // Observed namespace closure; this is not an atomic filesystem snapshot.
    // All selected files and every created directory retain their actual
    // owners through the caller's Ready publication. Foreign names are never
    // adopted, even if their current bytes happen to match selected content.
    pub(crate) fn verify_namespace(&self, cancel: &AtomicBool) -> io::Result<()> {
        self.verify()?;
        for _ in 0..2 {
            let mut remaining = 200_001u64;
            for directory in 0..=self.directories.len() {
                let mut expected = self.children[directory].clone();
                if directory == 0
                    && let Some(pointer) = &self.registration
                {
                    expected.insert(
                        ".git".encode_utf16().collect(),
                        (pointer.identity().clone(), false),
                    );
                }
                let observed = if directory == 0 {
                    super::directory::collect_from(self.root(), remaining, cancel)
                } else {
                    super::directory::collect_from(
                        &self.directories[directory - 1],
                        remaining,
                        cancel,
                    )
                }
                .map_err(|_| denied())?;
                remaining = remaining
                    .checked_sub(observed.len() as u64)
                    .ok_or_else(invalid)?;
                if observed.len() != expected.len() {
                    return Err(denied());
                }
                for (name, (identity, directory)) in expected {
                    let actual = observed.get(&name).ok_or_else(denied)?;
                    if actual.identity != identity
                        || (actual.attributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
                        || actual.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
                    {
                        return Err(denied());
                    }
                }
            }
        }
        self.verify()
    }
    // Publish the fixed new index only. A read+DELETE owner (no WRITE access)
    // excludes other writers/deleters during rename and final Git readback.
    pub(crate) fn publish_index(
        source: &File,
        parent: &PinnedPath,
        cancel: &AtomicBool,
    ) -> io::Result<TemporaryExport> {
        use std::{
            io::{Seek, SeekFrom},
            os::windows::fs::OpenOptionsExt,
        };
        cancelled(cancel)?;
        parent.verify()?;
        let before = stamp(source)?;
        if !before.regular || before.size > 32 * 1024 * 1024 {
            return Err(invalid());
        }
        let mut producer = TemporaryExport::create(parent.file().try_clone()?)?;
        let path = local_guid(&producer.file)?;
        let mut reader = source.try_clone()?;
        reader.seek(SeekFrom::Start(0))?;
        let mut digest = Sha256::new();
        let mut bytes = 0u64;
        let mut block = [0u8; 65_536];
        loop {
            cancelled(cancel)?;
            let count = reader.read(&mut block)?;
            if count == 0 {
                break;
            }
            bytes = bytes
                .checked_add(count as u64)
                .filter(|n| *n <= before.size)
                .ok_or_else(invalid)?;
            producer.file.write_all(&block[..count])?;
            digest.update(&block[..count]);
        }
        producer.file.sync_all()?;
        if bytes != before.size || stamp(source)? != before {
            return Err(denied());
        }
        let original = stamp(&producer.file)?;
        let anchor = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&path)?;
        if !crate::file_access::same_object(&producer.file, &anchor)? {
            return Err(denied());
        }
        // This transition is NON-ATOMIC. Original identity, original bytes,
        // exact parent/name and the final exclusive writer fence all recheck;
        // interference is an unknown result, never an overwrite or adoption.
        producer.retain_unknown();
        drop(producer);
        let mut readonly = std::fs::OpenOptions::new()
            .read(true)
            .access_mode(FILE_GENERIC_READ | DELETE)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&path)?;
        let post = stamp(&readonly)?;
        if !crate::file_access::same_object(&anchor, &readonly)?
            || post.identity != original.identity
            || !post.regular
            || post.links != 1
            || post.size != before.size
            || local_guid(&readonly)? != path
            || path.parent() != Some(parent.guid_path.as_path())
        {
            return Err(denied());
        }
        let mut observed = Sha256::new();
        let mut count = 0u64;
        loop {
            cancelled(cancel)?;
            let offer = (before.size - count)
                .saturating_add(1)
                .min(block.len() as u64) as usize;
            let read = readonly.read(&mut block[..offer])?;
            if read == 0 {
                break;
            }
            count = count
                .checked_add(read as u64)
                .filter(|n| *n <= before.size)
                .ok_or_else(invalid)?;
            observed.update(&block[..read]);
        }
        if count != before.size
            || stamp(&readonly)? != post
            || observed.finalize() != digest.finalize()
        {
            return Err(denied());
        }
        parent.verify()?;
        cancelled(cancel)?;
        let mut publication = TemporaryExport {
            directory: parent.file().try_clone()?,
            file: readonly,
            published: false,
        };
        publication.publish(OsStr::new("index"))?;
        if local_guid(&publication.file)? != parent.guid_path.join("index")
            || stamp(&publication.file)?.identity != post.identity
        {
            return Err(denied());
        }
        parent.verify()?;
        Ok(publication)
    }
}
impl super::directory::Owner for Owned {
    fn file(&self) -> &File {
        &self.file
    }
    fn verify(&self) -> io::Result<()> {
        Owned::verify(self)
    }
    fn directory_scan(&self) -> io::Result<std::sync::MutexGuard<'_, ()>> {
        self.scan
            .lock()
            .map_err(|_| io::Error::other("created directory observation owner poisoned"))
    }
}
