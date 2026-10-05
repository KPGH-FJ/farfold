use super::*;
use std::fs;

#[test]
fn developer_server_requires_explicit_literal_loopback_origin_and_port() {
    let project = tempfile::tempdir().unwrap();
    for url in [
        "http://127.0.0.1:5173",
        "https://[::1]:8443/",
        "http://127.0.0.1:80/",
        "https://[::1]:443/",
    ] {
        let preview = DevServerOrigin::select(project.path(), url).unwrap();
        assert!(preview.allows_navigation(preview.start_url().as_str()));
        if url == "https://[::1]:443/" {
            assert_eq!(preview.start_url().port(), None);
            assert!(preview.allows_navigation("https://[::1]/"));
            assert!(preview.allows_navigation("https://[::1]:443/"));
        }
        assert!(
            preview.allows_navigation(
                &preview
                    .start_url()
                    .join("page?a=1#top")
                    .unwrap()
                    .to_string()
            )
        );
    }
    for url in [
        "http://localhost:5173",
        "http://127.1:5173",
        "http://2130706433:5173",
        "http://0x7f000001:5173",
        "http://127.0.0.2:5173",
        "http://0.0.0.0:5173",
        "http://192.168.1.1:5173",
        "http://example.com:5173",
        "http://127.0.0.1",
        "http://[::1]",
        "http://127.0.0.1:0",
        "http://127.0.0.1:65536",
        "http://127.0.0.1:5173/a",
        "http://127.0.0.1:5173/?token=secret",
        "http://127.0.0.1:5173/#secret",
        "http://@127.0.0.1:5173",
        "http://user:pass@127.0.0.1:5173",
        "file:///tmp/index.html",
        "http://127.0.0.1:5173\\@evil.example",
        " http://127.0.0.1:5173",
        "http://127.0.0.1:51\n73",
    ] {
        assert!(
            DevServerOrigin::select(project.path(), url).is_err(),
            "{url}"
        );
    }
}

#[test]
fn server_navigation_cannot_change_selected_host_port_or_scheme() {
    let project = tempfile::tempdir().unwrap();
    let preview = DevServerOrigin::select(project.path(), "http://127.0.0.1:5173").unwrap();
    assert!(preview.allows_navigation("http://127.0.0.1:5173/app?view=2#item"));
    for url in [
        "http://127.0.0.1:5174/app",
        "https://127.0.0.1:5173/app",
        "http://[::1]:5173/app",
        "http://localhost:5173/app",
        "http://127.0.0.1:5173.evil.example/app",
        "http://127.0.0.1:5173@evil.example/app",
        "javascript:alert(1)",
    ] {
        assert!(!preview.allows_navigation(url), "{url}");
    }
    let clone = preview.clone();
    preview.revoke();
    assert!(!clone.allows_navigation("http://127.0.0.1:5173/app"));
    assert!(clone.lease().with_live(|| Ok(())).is_err());
}

#[test]
fn directory_storage_is_stable_and_separate_by_project_entry_and_mode() {
    let project = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    for root in [project.path(), other.path()] {
        fs::write(root.join("index.html"), "hello").unwrap();
        fs::write(root.join("other.html"), "other").unwrap();
    }
    let a = DirectoryPreview::select(project.path(), &project.path().join("index.html")).unwrap();
    let again =
        DirectoryPreview::select(project.path(), &project.path().join("index.html")).unwrap();
    assert_eq!(a.storage_identifier(), again.storage_identifier());
    assert_ne!(
        a.storage_identifier(),
        DirectoryPreview::select(other.path(), &other.path().join("index.html"))
            .unwrap()
            .storage_identifier()
    );
    assert_ne!(
        a.storage_identifier(),
        DirectoryPreview::select(project.path(), &project.path().join("other.html"))
            .unwrap()
            .storage_identifier()
    );
    let directory =
        DirectoryPreview::select(project.path(), &project.path().join("index.html")).unwrap();
    let resource = directory.read_resource(&directory.entry_path()).unwrap();
    assert_eq!(resource.mime, "text/html; charset=utf-8");
    assert_ne!(
        storage_identifier("single-html", project.path(), "index.html").unwrap(),
        directory.storage_identifier()
    );
    assert!(
        !directory
            .storage_identifier()
            .contains(project.path().to_str().unwrap())
    );
    assert_eq!(directory.storage_identifier().len(), 36);
}

#[test]
fn developer_server_still_requires_an_existing_selected_project() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("file"), "fixture").unwrap();
    for project in [
        std::path::PathBuf::from("relative"),
        root.path().join("gone"),
        root.path().join("file"),
    ] {
        assert!(DevServerOrigin::select(&project, "http://127.0.0.1:5173").is_err());
    }
}

#[test]
fn revocation_rejects_final_delivery_without_revoking_other_preview() {
    let a = PreviewLease::default();
    let b = PreviewLease::default();
    let late = a.clone();
    a.revoke();
    let mut delivered = false;
    assert!(
        late.with_live(|| {
            delivered = true;
            Ok(())
        })
        .is_err()
    );
    assert!(!delivered);
    assert!(b.with_live(|| Ok(())).is_ok());
}
