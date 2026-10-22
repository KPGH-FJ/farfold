use super::*;

#[test]
fn archive_profiles_are_explicit_and_full_security_is_never_downgraded() {
    assert_eq!(
        ArchiveObservation::from_profile(Some(
            &MaterialProfile::WindowsDefaultDataEaStreamsOwnerGroupDaclLinksLabelV1
        ))
        .unwrap(),
        ArchiveObservation::Ordinary,
    );
    assert_eq!(
        ArchiveObservation::from_profile(Some(
            &MaterialProfile::WindowsDefaultDataEaStreamsLinksFullSecurityV1
        ))
        .unwrap(),
        ArchiveObservation::FullSecurity,
    );
    for unsupported in [
        None,
        Some(MaterialProfile::WindowsDefaultDataV1),
        Some(MaterialProfile::WindowsDefaultDataEaV1),
        Some(MaterialProfile::WindowsDefaultDataEaStreamsV1),
        Some(MaterialProfile::WindowsDefaultDataEaStreamsOwnerGroupDaclV1),
        Some(MaterialProfile::WindowsDefaultDataEaStreamsOwnerGroupDaclLinksV1),
        Some(MaterialProfile::WindowsRetainedTreeV1),
    ] {
        assert_eq!(
            ArchiveObservation::from_profile(unsupported.as_ref())
                .unwrap_err()
                .code,
            "unsupportedMaterial"
        );
    }
    #[cfg(windows)]
    assert_eq!(
        ArchiveObservation::from_profile(initial_archive_profile().as_ref()).unwrap(),
        ArchiveObservation::Ordinary
    );
    #[cfg(not(windows))]
    assert_eq!(initial_archive_profile(), None);
}
