//! Owned test fixtures. Production path admission and environment stay unchanged.
pub(crate) fn tempdir() -> std::io::Result<tempfile::TempDir> {
    #[cfg(windows)]
    {
        // Runner TEMP may contain an 8.3 ancestor. The production pin deliberately
        // rejects aliases; tests select the actual long-name directory instead.
        let original = std::env::temp_dir();
        let actual = original.canonicalize()?;
        static OBSERVED: std::sync::Once = std::sync::Once::new();
        OBSERVED.call_once(|| {
            eprintln!(
                "FARFOLD_OWNED_FIXTURE_TEMP original={} selected={}",
                original.display(),
                actual.display()
            );
        });
        tempfile::tempdir_in(actual)
    }
    #[cfg(not(windows))]
    tempfile::tempdir()
}
