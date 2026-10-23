//! Owned test fixtures. Production path admission and environment stay unchanged.
pub(crate) fn tempdir() -> std::io::Result<tempfile::TempDir> {
    #[cfg(windows)]
    {
        // Runner TEMP may contain an 8.3 ancestor. The production pin deliberately
        // rejects aliases; tests select the actual long-name directory instead.
        let original = std::env::temp_dir();
        let canonical = original.canonicalize()?;
        // Git for Windows does not accept a verbatim DOS spelling for every
        // worktree argument. Keep the resolved long components, then verify
        // the ordinary absolute spelling still selects that same directory.
        let actual = plain_temp_path(&canonical)?;
        if actual.canonicalize()? != canonical {
            return Err(std::io::Error::other("fixture TEMP identity changed"));
        }
        // Canonical spellings alone are not object identity. Keep both actual
        // directory handles through fixture creation and compare the existing
        // volume/128-bit file identity, without relaxing production admission.
        let canonical_owner = crate::file_access::open_directory(&canonical)?;
        let plain_owner = crate::file_access::open_directory(&actual)?;
        if !crate::file_access::same_object(&canonical_owner, &plain_owner)? {
            return Err(std::io::Error::other("fixture TEMP object changed"));
        }
        static OBSERVED: std::sync::Once = std::sync::Once::new();
        OBSERVED.call_once(|| {
            eprintln!(
                "FARFOLD_OWNED_FIXTURE_TEMP original={} selected={}",
                original.display(),
                actual.display()
            );
        });
        let directory = tempfile::tempdir_in(actual);
        drop((canonical_owner, plain_owner));
        directory
    }
    #[cfg(not(windows))]
    tempfile::tempdir()
}

#[cfg(windows)]
fn plain_temp_path(path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    use std::path::{Component, PathBuf, Prefix};
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return Err(std::io::Error::other("fixture TEMP has no volume"));
    };
    let Prefix::VerbatimDisk(drive) = prefix.kind() else {
        return Err(std::io::Error::other("fixture TEMP needs a local drive"));
    };
    if components.next() != Some(Component::RootDir) {
        return Err(std::io::Error::other("fixture TEMP is not absolute"));
    }
    let mut plain = PathBuf::from(format!("{}:\\", char::from(drive)));
    for component in components {
        if !matches!(component, Component::Normal(_)) {
            return Err(std::io::Error::other(
                "fixture TEMP has unresolved components",
            ));
        }
        plain.push(component.as_os_str());
    }
    Ok(plain)
}

#[cfg(windows)]
#[test]
fn tempdir_has_long_absolute_git_compatible_spelling() {
    let directory = tempdir().unwrap();
    let path = directory.path();
    assert!(path.is_absolute());
    assert!(!path.as_os_str().to_string_lossy().starts_with(r"\\?\"));
    assert_eq!(
        plain_temp_path(&path.canonicalize().unwrap()).unwrap(),
        path
    );
    let plain_owner = crate::file_access::open_directory(path).unwrap();
    let canonical_owner =
        crate::file_access::open_directory(&path.canonicalize().unwrap()).unwrap();
    assert!(crate::file_access::same_object(&plain_owner, &canonical_owner).unwrap());
    let file = path.join("owned fixture.txt");
    std::fs::write(&file, b"actual same object").unwrap();
    assert_eq!(
        std::fs::read(file.canonicalize().unwrap()).unwrap(),
        b"actual same object"
    );
}
