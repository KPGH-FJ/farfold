//! Executable previews of one verified UTF-8 HTML file. No directory/file grant
//! is given to WebKit; CSP precedes every byte of the user document.
use crate::file_delivery::{self, VerifiedFile};
use sha2::{Digest, Sha256};
use std::path::Path;
use tauri::Url;

pub(super) const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/// Each verified file gets a separate WebKit data store inside its project
/// scope. No directory permission, file bytes, path or login state is copied in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct StoragePartition {
    pub identifier: String,
    pub origin: Url,
}

impl StoragePartition {
    fn for_file(project_directory: &str, file: &VerifiedFile) -> Self {
        let mut digest = Sha256::new();
        digest.update(b"farfold-offline-html-storage-v1\0");
        // Length delimiters keep even unusual canonical paths unambiguous.
        for path in [project_directory, &file.resolved_path] {
            digest.update((path.len() as u64).to_be_bytes());
            digest.update(path.as_bytes());
        }
        let hash = digest.finalize();
        let mut bytes: [u8; 16] = hash[..16].try_into().expect("digest length");
        // RFC 9562 version 8: application-defined, never the forbidden nil UUID.
        bytes[6] = (bytes[6] & 0x0f) | 0x80;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let hex = bytes.iter().map(|v| format!("{v:02x}")).collect::<String>();
        let identifier = format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        );
        let origin = Url::parse(&format!("https://file-{hex}.invalid/")).expect("generated origin");
        Self { identifier, origin }
    }
}

pub(super) struct Document {
    pub name: String,
    pub html: String,
    pub storage: StoragePartition,
}

pub(super) fn read_document(
    project_directory: &Path,
    file: &VerifiedFile,
) -> Result<Document, String> {
    // The trusted main UI supplies the current task's work folder. It names a
    // storage partition only; it is never used to read this file or grant WK a
    // directory. A file receipt's root differs between explicit file picks and
    // project-relative delivery, so it cannot be used as the project identity.
    if !project_directory.is_absolute() {
        return Err("工作文件夹位置无效，请重新选择".into());
    }
    let project = project_directory
        .canonicalize()
        .map_err(|_| "工作文件夹已无法访问，请重新选择")?;
    if !project.is_dir() {
        return Err("工作文件夹已无法访问，请重新选择".into());
    }
    let project = project.to_str().ok_or("工作文件夹位置无效，请重新选择")?;
    if !matches!(
        Path::new(&file.resolved_path)
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("html" | "htm")
    ) {
        return Err("请选择 HTML 或 HTM 网页文件".into());
    }
    // The existing reader opens by descriptor and validates the complete receipt,
    // including path, root, content hash and filesystem revision, before returning.
    let preview = file_delivery::read_text(file).map_err(|error| error.message().to_owned())?;
    if preview.text.contains('\0') {
        return Err("网页文件含有不支持的文字，请检查文件编码".into());
    }
    let storage = StoragePartition::for_file(project, &preview.file);
    Ok(Document {
        name: preview.file.name,
        html: document(&preview.text),
        storage,
    })
}

fn document(html: &str) -> String {
    // The leading doctype preserves standards mode. The first real head has the
    // mandatory policy before any resource/script; later policies only restrict.
    // The HTML parser ignores duplicate html/head/doctype from full documents.
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{CSP}\">{html}</html>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[tokio::test]
    async fn complete_verified_html_is_checked_without_altering_original_file() {
        let _checks = crate::file_read_check::tests::PRODUCTION_CHECKS
            .lock()
            .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("game.HTML");
        let input = "<!doctype html><html lang='zh'><head><title>fixture</title></head><body><script>localStorage.setItem('fixture','ok')</script><svg></svg></body></html>";
        fs::write(&path, input).unwrap();
        let file = file_delivery::inspect(dir.path(), &path).unwrap();
        let project = dir.path().to_owned();
        let result = crate::file_read_check::run(move || read_document(&project, &file))
            .await
            .unwrap();
        assert_eq!(result.name, "game.HTML");
        let result = result.html;
        assert!(result.starts_with("<!doctype html><html><head><meta charset="));
        assert!(result.find(CSP).unwrap() < result.find("<script>").unwrap());
        assert!(result.contains(input));
        assert_eq!(fs::read_to_string(path).unwrap(), input);
    }

    #[test]
    fn changed_deleted_or_mislabelled_file_cannot_run() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("game.htm");
        fs::write(&path, "<h1>old</h1>").unwrap();
        let file = file_delivery::inspect(dir.path(), &path).unwrap();
        fs::write(&path, "<h1>new</h1>").unwrap();
        assert!(read_document(dir.path(), &file).is_err());
        let file = file_delivery::inspect(dir.path(), &path).unwrap();
        let mut spoofed = file.clone();
        spoofed.name = "another.htm".into();
        assert!(read_document(dir.path(), &spoofed).is_err());
        fs::remove_file(&path).unwrap();
        assert!(read_document(dir.path(), &file).is_err());
        let text = dir.path().join("source.txt");
        fs::write(&text, "<h1>source</h1>").unwrap();
        assert!(
            read_document(
                dir.path(),
                &file_delivery::inspect(dir.path(), &text).unwrap()
            )
            .is_err()
        );
    }

    #[test]
    fn invalid_utf8_nul_and_oversized_documents_cannot_run() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("game.html");
        for bytes in [
            vec![0xff],
            b"<html>\0</html>".to_vec(),
            vec![b'x'; file_delivery::MAX_TEXT_BYTES as usize + 1],
        ] {
            fs::write(&path, bytes).unwrap();
            let file = file_delivery::inspect(dir.path(), &path).unwrap();
            assert!(read_document(dir.path(), &file).is_err());
        }
    }

    #[test]
    fn storage_survives_file_updates_but_isolated_by_project_and_canonical_file() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("game.html");
        let second = dir.path().join("other.html");
        fs::write(&first, "<p>first</p>").unwrap();
        fs::write(&second, "<p>second</p>").unwrap();
        let original = read_document(
            dir.path(),
            &file_delivery::inspect(dir.path(), &first).unwrap(),
        )
        .unwrap()
        .storage;
        fs::write(&first, "<p>updated</p>").unwrap();
        assert_eq!(
            original,
            read_document(
                dir.path(),
                &file_delivery::inspect(dir.path(), &first).unwrap()
            )
            .unwrap()
            .storage
        );
        assert_ne!(
            original,
            read_document(
                dir.path(),
                &file_delivery::inspect(dir.path(), &second).unwrap()
            )
            .unwrap()
            .storage
        );
        let other_root = tempfile::tempdir().unwrap();
        let other_file = other_root.path().join("game.html");
        fs::write(&other_file, "<p>first</p>").unwrap();
        assert_ne!(
            original,
            read_document(
                other_root.path(),
                &file_delivery::inspect(other_root.path(), &other_file).unwrap()
            )
            .unwrap()
            .storage
        );
        assert!(super::super::policy::validate_public_url(original.origin.as_str()).is_err());
        assert!(
            !original
                .origin
                .as_str()
                .contains(dir.path().to_str().unwrap())
        );
        assert_eq!(original.identifier.len(), 36);
        assert!(original.origin.host_str().unwrap().len() < 64);
    }

    #[cfg(unix)]
    #[test]
    fn storage_project_is_independent_of_file_receipt_root_and_path_alias() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("nested");
        fs::create_dir(&folder).unwrap();
        let file = folder.join("game.html");
        let alias = folder.join("alias.html");
        fs::write(&file, "<p>file</p>").unwrap();
        symlink(&file, &alias).unwrap();
        let project_receipt = file_delivery::inspect(dir.path(), &file).unwrap();
        let explicit_file_receipt = file_delivery::inspect(&folder, &file).unwrap();
        assert_ne!(project_receipt.root, explicit_file_receipt.root);
        let storage = read_document(dir.path(), &project_receipt).unwrap().storage;
        assert_eq!(
            storage,
            read_document(dir.path(), &explicit_file_receipt)
                .unwrap()
                .storage
        );
        let file_alias = file_delivery::inspect(dir.path(), &alias).unwrap();
        assert_eq!(
            storage,
            read_document(dir.path(), &file_alias).unwrap().storage
        );
        let project_alias = dir.path().join("project-alias");
        symlink(dir.path(), &project_alias).unwrap();
        assert_eq!(
            storage,
            read_document(&project_alias, &explicit_file_receipt)
                .unwrap()
                .storage
        );
        let other_project = tempfile::tempdir().unwrap();
        assert_ne!(
            storage,
            read_document(other_project.path(), &explicit_file_receipt)
                .unwrap()
                .storage
        );
        assert_ne!(
            storage,
            read_document(&folder, &explicit_file_receipt)
                .unwrap()
                .storage
        );
        let escape = folder.join("escape.html");
        let target = other_project.path().join("outside.html");
        fs::write(&target, "<p>outside</p>").unwrap();
        symlink(&target, &escape).unwrap();
        assert!(file_delivery::inspect(dir.path(), &escape).is_err());
        assert!(read_document(Path::new("relative"), &project_receipt).is_err());
        assert!(read_document(&file, &project_receipt).is_err());
        assert!(read_document(&dir.path().join("missing"), &project_receipt).is_err());
    }
}
