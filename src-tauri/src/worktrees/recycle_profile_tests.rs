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
        Some(MaterialProfile::WindowsOrdinaryRetainedTreeV1),
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

#[test]
fn stored_archive_profiles_share_the_exact_same_object_observation_admission() {
    for profile in [
        MaterialProfile::WindowsDefaultDataEaStreamsOwnerGroupDaclLinksLabelV1,
        MaterialProfile::WindowsDefaultDataEaStreamsLinksFullSecurityV1,
    ] {
        assert!(archive_profile_supported(Some(&profile)));
    }
    for profile in [
        None,
        Some(MaterialProfile::WindowsDefaultDataV1),
        Some(MaterialProfile::WindowsDefaultDataEaV1),
        Some(MaterialProfile::WindowsDefaultDataEaStreamsV1),
        Some(MaterialProfile::WindowsDefaultDataEaStreamsOwnerGroupDaclV1),
        Some(MaterialProfile::WindowsDefaultDataEaStreamsOwnerGroupDaclLinksV1),
        Some(MaterialProfile::WindowsRetainedTreeV1),
        Some(MaterialProfile::WindowsOrdinaryRetainedTreeV1),
    ] {
        assert!(!archive_profile_supported(profile.as_ref()));
    }
}

#[test]
fn stored_archive_profile_admission_is_platform_specific_and_rejects_retained_carriers() {
    let validate = super::super::storage::archive_material_profile_valid;
    assert_eq!(validate(None), !cfg!(windows));
    for profile in [
        MaterialProfile::WindowsDefaultDataEaStreamsOwnerGroupDaclLinksLabelV1,
        MaterialProfile::WindowsDefaultDataEaStreamsLinksFullSecurityV1,
    ] {
        assert_eq!(validate(Some(&profile)), cfg!(windows));
    }
    for profile in [
        MaterialProfile::WindowsDefaultDataV1,
        MaterialProfile::WindowsDefaultDataEaV1,
        MaterialProfile::WindowsDefaultDataEaStreamsV1,
        MaterialProfile::WindowsDefaultDataEaStreamsOwnerGroupDaclV1,
        MaterialProfile::WindowsDefaultDataEaStreamsOwnerGroupDaclLinksV1,
        MaterialProfile::WindowsRetainedTreeV1,
        MaterialProfile::WindowsOrdinaryRetainedTreeV1,
    ] {
        assert!(!validate(Some(&profile)));
    }
}
