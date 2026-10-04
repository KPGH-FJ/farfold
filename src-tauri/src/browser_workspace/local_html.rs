//! Executable previews of one verified UTF-8 HTML file. No directory/file grant
//! is given to WebKit; CSP precedes every byte of the user document.
use crate::file_delivery::{self, VerifiedFile};
use std::path::Path;
use tauri::Url;

pub(super) const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

pub(super) fn origin(id: u64) -> Url {
    Url::parse(&format!("https://preview-{id}.invalid/")).expect("generated HTTPS origin")
}

pub(super) fn read_document(file: &VerifiedFile) -> Result<(String, String), String> {
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
    Ok((preview.file.name, document(&preview.text)))
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

    #[test]
    fn complete_verified_html_is_read_without_altering_original_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("game.HTML");
        let input = "<!doctype html><html lang='zh'><head><title>fixture</title></head><body><script>localStorage.setItem('fixture','ok')</script><svg></svg></body></html>";
        fs::write(&path, input).unwrap();
        let file = file_delivery::inspect(dir.path(), &path).unwrap();
        let (name, result) = read_document(&file).unwrap();
        assert_eq!(name, "game.HTML");
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
        assert!(read_document(&file).is_err());
        let file = file_delivery::inspect(dir.path(), &path).unwrap();
        let mut spoofed = file.clone();
        spoofed.name = "another.htm".into();
        assert!(read_document(&spoofed).is_err());
        fs::remove_file(&path).unwrap();
        assert!(read_document(&file).is_err());
        let text = dir.path().join("source.txt");
        fs::write(&text, "<h1>source</h1>").unwrap();
        assert!(read_document(&file_delivery::inspect(dir.path(), &text).unwrap()).is_err());
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
            assert!(read_document(&file).is_err());
        }
    }

    #[test]
    fn origins_are_unique_and_never_admitted_as_public_pages() {
        assert_ne!(origin(1), origin(2));
        assert!(super::super::policy::validate_public_url(origin(1).as_str()).is_err());
    }
}
