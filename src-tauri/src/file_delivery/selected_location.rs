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
        let path = directory.path().join("run.command");
        std::fs::write(&path, "echo no").unwrap();
        assert_eq!(
            selected_location(directory.path(), &path, true),
            Err(DeliveryError::UnsupportedOpen)
        );
        assert!(
            selected_location(directory.path(), &path, false).is_ok(),
            "reveal never executes the selected item"
        );
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
