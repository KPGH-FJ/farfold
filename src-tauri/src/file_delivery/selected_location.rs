//! An explicit location action does not attest to a captured content version.
use super::*;

pub(crate) fn document_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some(
            "txt"
                | "html"
                | "htm"
                | "md"
                | "markdown"
                | "mdown"
                | "pdf"
                | "png"
                | "jpg"
                | "jpeg"
                | "gif"
                | "webp"
                | "avif"
                | "flac"
                | "docx"
                | "xlsx"
                | "pptx"
                | "csv"
        )
    )
}

fn checked(opened: OpenedFile, document_only: bool) -> Result<String, DeliveryError> {
    if document_only {
        if !document_extension(&opened.resolved) {
            return Err(DeliveryError::UnsupportedOpen);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if opened
                .file
                .metadata()
                .map_err(|_| DeliveryError::Unreadable)?
                .permissions()
                .mode()
                & 0o111
                != 0
            {
                return Err(DeliveryError::UnsupportedOpen);
            }
        }
    }
    recheck(&opened)?;
    path_text(&opened.resolved)
}

/// Metadata only. No content/version receipt, access grant, or Agent access is
/// created. The caller immediately performs the explicit platform action; a
/// subsequent external pathname replacement is not made impossible by this.
pub(crate) fn selected_location(
    root: &Path,
    path: &Path,
    document_only: bool,
) -> Result<String, DeliveryError> {
    checked(open_source(root, path, u64::MAX)?, document_only)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_media_locations_keep_the_verified_file_identity_and_version() {
        let directory = tempfile::tempdir().unwrap();
        // Opening admission is extension/identity verification, not media decoding.
        let bytes: &[u8] = b"owned location-control bytes, not a decoder fixture";
        for name in [
            "图像-lower.avif",
            "图像-upper.AVIF",
            "音频-lower.flac",
            "音频-upper.FLAC",
        ] {
            let path = directory.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            let file = inspect(directory.path(), &path).unwrap();
            assert_eq!(file.name, name);
            assert_eq!(
                selected_location(directory.path(), &path, true).unwrap(),
                file.resolved_path
            );
            assert_eq!(revalidate_for_open(&file).unwrap(), file.resolved_path);
            assert_eq!(inspect(directory.path(), &path).unwrap(), file);
            assert_eq!(std::fs::read(&path).unwrap().as_slice(), bytes);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
                assert_eq!(
                    selected_location(directory.path(), &path, true),
                    Err(DeliveryError::UnsupportedOpen)
                );
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            }
            let fresh = inspect(directory.path(), &path).unwrap();
            assert_eq!(fresh.sha256, file.sha256);
            assert_eq!(fresh.resolved_path, file.resolved_path);
            assert_eq!(revalidate_for_open(&fresh).unwrap(), fresh.resolved_path);
            std::fs::write(&path, b"changed owned file bytes").unwrap();
            assert_eq!(revalidate_for_open(&fresh), Err(DeliveryError::Changed));
        }
    }
    #[test]
    fn oversized_selected_document_has_a_location_without_claiming_a_content_receipt() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.txt");
        File::create(&path)
            .unwrap()
            .set_len(MAX_VERIFIED_FILE_BYTES + 1)
            .unwrap();
        assert_eq!(
            inspect(directory.path(), &path),
            Err(DeliveryError::TooLarge)
        );
        let location = selected_location(directory.path(), &path, true).unwrap();
        assert_eq!(Path::new(&location), path.canonicalize().unwrap());
    }
    #[test]
    fn selected_location_rejects_directories_and_dangerous_open_types() {
        let directory = tempfile::tempdir().unwrap();
        for name in [
            "run.command",
            "setup.sh",
            "run.exe",
            "run.com",
            "setup.bat",
            "setup.cmd",
            "setup.ps1",
            "shortcut.lnk",
            "run.app",
            "macro.docm",
            "unknown.media",
        ] {
            let path = directory.path().join(name);
            std::fs::write(&path, "echo no").unwrap();
            assert_eq!(
                selected_location(directory.path(), &path, true),
                Err(DeliveryError::UnsupportedOpen),
                "{name} must not be admitted for opening"
            );
            assert!(
                selected_location(directory.path(), &path, false).is_ok(),
                "reveal never executes the selected item"
            );
        }
        assert!(selected_location(directory.path(), directory.path(), false).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn executable_documents_and_alias_redirects_are_rejected_before_open() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = directory.path().join("file.txt");
        std::fs::write(&path, "safe text").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            selected_location(directory.path(), &path, true),
            Err(DeliveryError::UnsupportedOpen)
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let alias = directory.path().join("alias.txt");
        symlink(&path, &alias).unwrap();
        let opened = open_source(directory.path(), &alias, u64::MAX).unwrap();
        let foreign = outside.path().join("foreign.txt");
        std::fs::write(&foreign, "safe text").unwrap();
        std::fs::remove_file(&alias).unwrap();
        symlink(&foreign, &alias).unwrap();
        assert_eq!(checked(opened, true), Err(DeliveryError::Changed));
        assert_eq!(
            selected_location(directory.path(), &alias, false),
            Err(DeliveryError::OutsideRoot)
        );
    }
}
