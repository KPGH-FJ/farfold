use super::*;
use std::{fs, os::unix::fs::symlink};

fn fixture() -> (tempfile::TempDir, DirectoryPreview) {
    let directory = tempfile::tempdir().unwrap();
    fs::write(
        directory.path().join("index.html"),
        "<title>Demo</title><script src='app.js'></script>",
    )
    .unwrap();
    fs::write(
        directory.path().join("app.js"),
        "document.title = 'updated';",
    )
    .unwrap();
    let preview =
        DirectoryPreview::select(directory.path(), &directory.path().join("index.html")).unwrap();
    (directory, preview)
}

#[test]
fn selected_entry_and_relative_assets_are_read_with_mime_and_mandatory_policy() {
    let (dir, preview) = fixture();
    fs::create_dir(dir.path().join("assets")).unwrap();
    fs::write(
        dir.path().join("assets/你好 world.css"),
        "body { color: blue }",
    )
    .unwrap();
    assert_eq!(preview.entry_path(), "/index.html");
    let html: Resource = preview.read_resource(&preview.entry_path()).unwrap();
    let body = String::from_utf8(html.bytes.clone()).unwrap();
    assert!(body.find(DIRECTORY_CSP).unwrap() < body.find("<script").unwrap());
    assert_eq!(html.headers()[1], ("X-Content-Type-Options", "nosniff"));
    let css = preview
        .read_resource("/assets/%E4%BD%A0%E5%A5%BD%20world.css")
        .unwrap();
    assert_eq!(css.mime, "text/css; charset=utf-8");
    assert_eq!(css.bytes, b"body { color: blue }");
    assert_eq!(
        preview.read_resource("/app.js").unwrap().mime,
        "text/javascript; charset=utf-8"
    );
    assert!(preview.read_resource("/missing.js").is_err());
    assert!(preview.read_resource("/assets/").is_err());
}

#[test]
fn path_aliases_and_encoded_traversal_cannot_escape_or_bypass_name_policy() {
    let (_dir, preview) = fixture();
    for path in [
        "index.html",
        "//index.html",
        "/../index.html",
        "/./index.html",
        "/assets//index.html",
        "/%2e%2e/index.html",
        "/assets/%2findex.html",
        "/assets/%5cindex.html",
        "/%252e%252e/index.html",
        "/.env",
        "/%2eenv",
        "/app.js?secret=x",
        "/app.js#fragment",
        "/app.js%00",
        "/app.js%",
        "/%FF.js",
        "/C:/app.js",
        "/assets\\app.js",
        "/app.js.",
        "/app.js%20",
    ] {
        assert!(preview.read_resource(path).is_err(), "{path}");
    }
}

#[test]
fn directory_selection_does_not_auto_expose_hidden_config_credentials_or_source_maps() {
    let (dir, preview) = fixture();
    for path in [
        ".git/config",
        ".env",
        "env.js",
        "environment.json",
        "config.json",
        "vite.config.js",
        "package.json",
        "package-lock.json",
        "tsconfig.app.json",
        "credentials.json",
        "secret.json",
        "secrets/dev.json",
        "service-account.json",
        "node_modules/pkg/index.js",
        "private/key.js",
        "app.js.map",
        "key.pem",
        "notes.md",
        "archive.zip",
        "program.wasm",
    ] {
        let full = dir.path().join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(&full, "private sample").unwrap();
        assert!(
            preview.read_resource(&format!("/{path}")).is_err(),
            "{path}"
        );
    }
    fs::write(dir.path().join("data.json"), "{\"count\":2}").unwrap();
    assert!(preview.read_resource("/data.json").is_ok());
}

#[test]
fn symlink_files_directories_and_hard_links_are_never_followed() {
    let (dir, preview) = fixture();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.js"), "private sample").unwrap();
    symlink(outside.path().join("secret.js"), dir.path().join("leak.js")).unwrap();
    symlink(outside.path(), dir.path().join("assets")).unwrap();
    symlink(dir.path().join("app.js"), dir.path().join("internal.js")).unwrap();
    fs::hard_link(outside.path().join("secret.js"), dir.path().join("hard.js")).unwrap();
    for path in ["/leak.js", "/assets/secret.js", "/internal.js", "/hard.js"] {
        assert!(preview.read_resource(path).is_err(), "{path}");
    }
    symlink(
        dir.path().join("index.html"),
        dir.path().join("linked.html"),
    )
    .unwrap();
    assert!(DirectoryPreview::select(dir.path(), &dir.path().join("linked.html")).is_err());
}

#[test]
fn root_replacement_and_mutation_during_read_discard_the_bytes() {
    let (dir, preview) = fixture();
    assert!(
        preview
            .read_with_check("app.js", || {
                fs::write(dir.path().join("app.js"), "changed").unwrap();
            })
            .is_err()
    );
    let parent = tempfile::tempdir().unwrap();
    let moved = parent.path().join("moved");
    fs::rename(dir.path(), &moved).unwrap();
    fs::create_dir(dir.path()).unwrap();
    fs::write(dir.path().join("app.js"), "replacement").unwrap();
    assert!(preview.read_resource("/app.js").is_err());
}

#[test]
fn root_or_file_retargeted_to_symlink_after_selection_is_rejected() {
    let (dir, preview) = fixture();
    fs::remove_file(dir.path().join("app.js")).unwrap();
    symlink(dir.path().join("index.html"), dir.path().join("app.js")).unwrap();
    assert!(preview.read_resource("/app.js").is_err());
    let parent = tempfile::tempdir().unwrap();
    fs::rename(dir.path(), parent.path().join("moved")).unwrap();
    symlink(parent.path().join("moved"), dir.path()).unwrap();
    assert!(preview.read_resource("/index.html").is_err());
    fs::remove_file(dir.path()).unwrap();
}

#[test]
fn special_files_invalid_text_and_oversize_assets_return_errors() {
    let (dir, preview) = fixture();
    let fifo = CString::new(dir.path().join("pipe.js").as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert!(preview.read_resource("/pipe.js").is_err());
    fs::write(dir.path().join("bad.js"), [255, 0]).unwrap();
    assert!(preview.read_resource("/bad.js").is_err());
    fs::write(dir.path().join("nul.css"), b"a\0b").unwrap();
    assert!(preview.read_resource("/nul.css").is_err());
    File::create(dir.path().join("large.js"))
        .unwrap()
        .set_len(MAX_TEXT_BYTES + 1)
        .unwrap();
    File::create(dir.path().join("large.png"))
        .unwrap()
        .set_len(MAX_RESOURCE_BYTES + 1)
        .unwrap();
    assert!(preview.read_resource("/large.js").is_err());
    assert!(preview.read_resource("/large.png").is_err());
}

#[test]
fn cancel_during_read_and_cloned_readers_cannot_return_or_deliver_late_content() {
    let (_dir, preview) = fixture();
    let late = preview.clone();
    assert!(
        preview
            .read_with_check("app.js", || preview.revoke())
            .is_err()
    );
    assert!(late.read_resource("/app.js").is_err());
    let mut delivered = false;
    assert!(
        late.lease()
            .with_live(|| {
                delivered = true;
                Ok(())
            })
            .is_err()
    );
    assert!(!delivered);
}

#[test]
fn entry_must_be_explicit_html_inside_root_and_selected_alias_root_is_canonicalized() {
    let (dir, _preview) = fixture();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("outside.html"), "outside").unwrap();
    assert!(DirectoryPreview::select(dir.path(), &outside.path().join("outside.html")).is_err());
    assert!(DirectoryPreview::select(dir.path(), &dir.path().join("app.js")).is_err());
    assert!(DirectoryPreview::select(dir.path(), &dir.path().join("../index.html")).is_err());
    assert!(DirectoryPreview::select(dir.path(), &dir.path().join("./index.html")).is_err());
    let alias = outside.path().join("chosen");
    symlink(dir.path(), &alias).unwrap();
    let preview = DirectoryPreview::select(&alias, &alias.join("index.html")).unwrap();
    assert!(preview.read_resource("/app.js").is_ok());
}

#[test]
fn unicode_entry_path_round_trips_through_url_encoding() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("你好 world.html");
    fs::write(&path, "<p>hello</p>").unwrap();
    let preview = DirectoryPreview::select(directory.path(), &path).unwrap();
    assert_eq!(preview.entry_path(), "/%E4%BD%A0%E5%A5%BD%20world.html");
    assert!(preview.read_resource(&preview.entry_path()).is_ok());
}
