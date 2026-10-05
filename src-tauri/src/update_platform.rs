//! The signed feed scope follows the installer this product actually builds.
//! A platform change never reuses a macOS release URL or signature scope.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct UpdatePlatform {
    pub(crate) target: &'static str,
    pub(crate) bundle: &'static str,
}
impl UpdatePlatform {
    pub(crate) fn current() -> Self {
        Self::for_os(std::env::consts::OS).expect("supported desktop update platform")
    }
    pub(crate) fn for_os(os: &str) -> Option<Self> {
        match os {
            "macos" => Some(Self {
                target: "darwin",
                bundle: "app",
            }),
            "windows" => Some(Self {
                target: "windows",
                bundle: "nsis",
            }),
            _ => None,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_does_not_request_a_mac_app_or_accept_its_target_scope() {
        let mac = UpdatePlatform::for_os("macos").unwrap();
        let windows = UpdatePlatform::for_os("windows").unwrap();
        assert_eq!((mac.target, mac.bundle), ("darwin", "app"));
        assert_eq!((windows.target, windows.bundle), ("windows", "nsis"));
        assert_ne!(windows, mac);
        assert!(UpdatePlatform::for_os("unknown").is_none());
    }
}
