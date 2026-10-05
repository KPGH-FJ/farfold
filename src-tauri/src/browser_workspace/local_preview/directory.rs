use super::{DIRECTORY_CSP, MAX_RESOURCE_BYTES, MAX_TEXT_BYTES, PreviewLease, storage_identifier};
use std::{
    ffi::CString,
    fs::{File, Metadata},
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path, PathBuf},
    sync::Arc,
};

const INVALID: &str = "预览资源位置无效";
const DENIED: &str = "此文件不在允许的网页资源范围内";
const CHANGED: &str = "预览文件或目录已变化，请重新打开";

/// The scheme handler accepts only the private source's URL path, never an
/// absolute file path or a root supplied by page JavaScript. No listing API.
#[derive(Clone)]
pub(crate) struct DirectoryPreview {
    root: PathBuf,
    root_handle: Arc<File>,
    entry: String,
    storage: String,
    lease: PreviewLease,
}

pub(crate) struct Resource {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

impl Resource {
    /// Apply these to responses as well as the mandatory leading HTML policy.
    pub(crate) fn headers(&self) -> [(&'static str, &'static str); 3] {
        [
            ("Content-Security-Policy", DIRECTORY_CSP),
            ("X-Content-Type-Options", "nosniff"),
            ("Cache-Control", "no-store"),
        ]
    }
}

impl DirectoryPreview {
    pub(crate) fn select(root: &Path, entry: &Path) -> Result<Self, String> {
        // A selected root may itself be an OS/user alias; grant its canonical
        // directory once. Reject traversal syntax before canonicalization.
        absolute(root)?;
        absolute(entry)?;
        let original_root = root;
        let root = root.canonicalize().map_err(|_| INVALID)?;
        if root.parent().is_none() {
            return Err("请选择具体的网页资源文件夹".into());
        }
        let relative = entry
            .strip_prefix(original_root)
            .or_else(|_| entry.strip_prefix(&root))
            .map_err(|_| DENIED)?;
        let relative = relative.to_str().ok_or(INVALID)?;
        validate_relative(relative)?;
        if !matches!(
            Path::new(relative)
                .extension()
                .and_then(|s| s.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("html" | "htm")
        ) {
            return Err("请选择资源文件夹内的 HTML 文件".into());
        }
        let root_handle = Arc::new(open_directory(&root)?);
        let storage = storage_identifier("directory", &root, relative)?;
        let preview = Self {
            root,
            root_handle,
            entry: relative.into(),
            storage,
            lease: PreviewLease::default(),
        };
        // Verify the selected entry before accepting the source. It grants no
        // other filesystem root, even if the document asks for one later.
        preview.read_relative(&preview.entry)?;
        Ok(preview)
    }

    pub(crate) fn entry_path(&self) -> String {
        // URL path encoding is performed by URL's segment encoder, not shell or
        // HTML escaping. A generated private scheme/origin is supplied by caller.
        let mut url = tauri::Url::parse("https://preview.invalid/").expect("fixed URL");
        url.path_segments_mut()
            .expect("hierarchical URL")
            .extend(self.entry.split('/'));
        url.path().into()
    }
    pub(crate) fn storage_identifier(&self) -> &str {
        &self.storage
    }
    pub(crate) fn lease(&self) -> PreviewLease {
        self.lease.clone()
    }
    pub(crate) fn revoke(&self) {
        self.lease.revoke();
    }

    /// Pass the encoded URL path only, after checking the exact private scheme
    /// and authority. No SPA fallback, directory index or arbitrary file route.
    pub(crate) fn read_resource(&self, encoded_path: &str) -> Result<Resource, String> {
        self.read_relative(&decode_path(encoded_path)?)
    }

    fn read_relative(&self, relative: &str) -> Result<Resource, String> {
        self.read_with_check(relative, || {})
    }

    fn read_with_check(
        &self,
        relative: &str,
        after_read: impl FnOnce(),
    ) -> Result<Resource, String> {
        self.lease.check()?;
        validate_relative(relative)?;
        let (mime, text) = media_type(relative)?;
        let max = if text {
            MAX_TEXT_BYTES
        } else {
            MAX_RESOURCE_BYTES
        };
        self.check_root()?;
        let file = open_relative(&self.root_handle, relative)?;
        let before = stamp(&file.metadata().map_err(|_| CHANGED)?)?;
        if before.size > max {
            return Err("网页资源超过当前大小限制".into());
        }
        let mut bytes = Vec::with_capacity(before.size as usize);
        (&file)
            .take(max + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "网页资源无法读取")?;
        if bytes.len() as u64 > max {
            return Err("网页资源超过当前大小限制".into());
        }
        after_read();
        if stamp(&file.metadata().map_err(|_| CHANGED)?)? != before
            || bytes.len() as u64 != before.size
        {
            return Err(CHANGED.into());
        }
        self.check_root()?;
        if stamp(
            &open_relative(&self.root_handle, relative)?
                .metadata()
                .map_err(|_| CHANGED)?,
        )? != before
        {
            return Err(CHANGED.into());
        }
        if text {
            let value =
                std::str::from_utf8(&bytes).map_err(|_| "网页文字资源需要使用 UTF-8 编码")?;
            if value.contains('\0') {
                return Err("网页文字资源含有不支持的字符".into());
            }
            if mime == "text/html; charset=utf-8" {
                bytes = format!("<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{DIRECTORY_CSP}\">{value}</html>").into_bytes();
            }
        }
        self.lease.check()?;
        Ok(Resource { bytes, mime })
    }

    fn check_root(&self) -> Result<(), String> {
        let expected = self.root_handle.metadata().map_err(|_| CHANGED)?;
        let current = open_directory(&self.root)?
            .metadata()
            .map_err(|_| CHANGED)?;
        if current.dev() != expected.dev() || current.ino() != expected.ino() {
            return Err(CHANGED.into());
        }
        Ok(())
    }
}

#[derive(PartialEq, Eq)]
struct Stamp {
    device: u64,
    inode: u64,
    size: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}

fn stamp(meta: &Metadata) -> Result<Stamp, String> {
    // Hard-linked files could expose another folder's secret through an innocent
    // asset name. Symlinks are refused by openat, hard links by the metadata.
    if !meta.is_file() || meta.nlink() != 1 {
        return Err(DENIED.into());
    }
    Ok(Stamp {
        device: meta.dev(),
        inode: meta.ino(),
        size: meta.len(),
        modified: (meta.mtime(), meta.mtime_nsec()),
        changed: (meta.ctime(), meta.ctime_nsec()),
    })
}

fn absolute(path: &Path) -> Result<(), String> {
    let text = path.to_str().ok_or(INVALID)?;
    if !path.is_absolute()
        || text.contains("//")
        || text.contains('\\')
        || text.chars().any(char::is_control)
        || text.split('/').any(|p| matches!(p, "." | ".."))
    {
        return Err(INVALID.into());
    }
    Ok(())
}

fn open_directory(path: &Path) -> Result<File, String> {
    let mut directory = File::open("/").map_err(|_| CHANGED)?;
    for part in path.components() {
        match part {
            Component::RootDir => {}
            Component::Normal(name) => directory = open_at(&directory, name.as_bytes(), true)?,
            _ => return Err(INVALID.into()),
        }
    }
    Ok(directory)
}

fn open_relative(root: &File, relative: &str) -> Result<File, String> {
    let mut directory = root.try_clone().map_err(|_| CHANGED)?;
    let parts: Vec<_> = relative.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        directory = open_at(&directory, part.as_bytes(), index + 1 < parts.len())?;
    }
    Ok(directory)
}

fn open_at(parent: &File, name: &[u8], directory: bool) -> Result<File, String> {
    let name = CString::new(name).map_err(|_| INVALID)?;
    let flags = libc::O_RDONLY
        | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | if directory {
            libc::O_DIRECTORY
        } else {
            libc::O_NONBLOCK
        };
    // SAFETY: live owned parent descriptor and terminated filename; successful
    // openat returns a fresh descriptor transferred immediately to File.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err(CHANGED.into());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn decode_path(path: &str) -> Result<String, String> {
    if path.len() > 8192 || !path.starts_with('/') || path.starts_with("//") {
        return Err(INVALID.into());
    }
    let mut output = Vec::new();
    let mut input = path[1..].bytes();
    while let Some(b) = input.next() {
        let b = if b == b'%' {
            let h = input
                .next()
                .and_then(|c| (c as char).to_digit(16))
                .ok_or(INVALID)?;
            let l = input
                .next()
                .and_then(|c| (c as char).to_digit(16))
                .ok_or(INVALID)?;
            let decoded = (h * 16 + l) as u8;
            if matches!(decoded, b'/' | b'\\' | b'%') {
                return Err(INVALID.into());
            }
            decoded
        } else {
            b
        };
        output.push(b);
    }
    let value = String::from_utf8(output).map_err(|_| INVALID)?;
    validate_relative(&value)?;
    Ok(value)
}

fn validate_relative(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > 4096
        || path.chars().any(char::is_control)
        || path.contains(['\\', ':', '?', '#', '%'])
    {
        return Err(INVALID.into());
    }
    for part in path.split('/') {
        let lower = part.to_ascii_lowercase();
        if part.is_empty()
            || part.starts_with('.')
            || part.ends_with(['.', ' '])
            || part.trim() != part
            || blocked_name(&lower)
        {
            return Err(DENIED.into());
        }
    }
    Ok(())
}

fn blocked_name(name: &str) -> bool {
    // Filename policy, not a secret scanner. Selecting a resource directory must
    // not silently publish common hidden/config/credential files. Arbitrary
    // secrets embedded in allowed application assets cannot be detected here.
    matches!(
        name,
        "node_modules"
            | "config"
            | "configs"
            | "configuration"
            | "credentials"
            | "secrets"
            | "private"
            | "package.json"
            | "package-lock.json"
            | "composer.json"
            | "deno.json"
            | "deno.jsonc"
            | "tsconfig.json"
            | "jsconfig.json"
            | "manifest.lock"
    ) || name.starts_with("credentials.")
        || name.starts_with("secrets.")
        || name.starts_with("secret.")
        || name.starts_with("env.")
        || name.starts_with("environment.")
        || name.starts_with("config.")
        || name.starts_with("tsconfig.")
        || name.starts_with("service-account")
        || name.starts_with("service_account")
        || name.contains(".config.")
        || name.contains(".credentials.")
        || name.contains(".secret.")
}

fn media_type(path: &str) -> Result<(&'static str, bool), String> {
    let extension = Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .ok_or(DENIED)?
        .to_ascii_lowercase();
    Ok(match extension.as_str() {
        "html" | "htm" => ("text/html; charset=utf-8", true),
        "css" => ("text/css; charset=utf-8", true),
        "js" | "mjs" => ("text/javascript; charset=utf-8", true),
        "json" => ("application/json; charset=utf-8", true),
        "svg" => ("image/svg+xml; charset=utf-8", true),
        "png" => ("image/png", false),
        "jpg" | "jpeg" => ("image/jpeg", false),
        "gif" => ("image/gif", false),
        "webp" => ("image/webp", false),
        "avif" => ("image/avif", false),
        "ico" => ("image/x-icon", false),
        "woff" => ("font/woff", false),
        "woff2" => ("font/woff2", false),
        "ttf" => ("font/ttf", false),
        "otf" => ("font/otf", false),
        "mp3" => ("audio/mpeg", false),
        "wav" => ("audio/wav", false),
        "ogg" => ("audio/ogg", false),
        "mp4" => ("video/mp4", false),
        "webm" => ("video/webm", false),
        _ => return Err(DENIED.into()),
    })
}

#[cfg(test)]
#[path = "directory_tests.rs"]
mod tests;
