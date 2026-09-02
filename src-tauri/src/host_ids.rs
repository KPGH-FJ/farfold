use serde::{Deserialize, Serialize};
use std::{error::Error, fmt, str::FromStr};

const MAX_ID_BYTES: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostIdError {
    kind: &'static str,
    reason: &'static str,
}

impl HostIdError {
    fn new(kind: &'static str, reason: &'static str) -> Self {
        Self { kind, reason }
    }
}

impl fmt::Display for HostIdError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} {}", self.kind, self.reason)
    }
}

impl Error for HostIdError {}

fn validate_id(kind: &'static str, value: String) -> Result<String, HostIdError> {
    if value.is_empty() {
        return Err(HostIdError::new(kind, "cannot be empty"));
    }
    if value.len() > MAX_ID_BYTES {
        return Err(HostIdError::new(kind, "is too long"));
    }
    if value.trim() != value {
        return Err(HostIdError::new(
            kind,
            "cannot contain surrounding whitespace",
        ));
    }
    if !value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'@' | b'+')
    }) {
        return Err(HostIdError::new(kind, "contains an unsafe character"));
    }
    Ok(value)
}

macro_rules! host_id {
    ($name:ident, $kind:literal) => {
        #[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, Hash)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, HostIdError> {
                validate_id($kind, value.into()).map(Self)
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_inner(self) -> String {
                self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl FromStr for $name {
            type Err = HostIdError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::parse(value)
            }
        }

        impl TryFrom<String> for $name {
            type Error = HostIdError;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::parse(value)
            }
        }
    };
}

host_id!(RuntimeProductId, "Runtime product ID");
host_id!(InstallationId, "Runtime installation ID");
host_id!(RuntimeBuildId, "Runtime build ID");
host_id!(AdapterId, "Runtime Adapter ID");
host_id!(ConnectionId, "Runtime connection ID");
host_id!(ProjectId, "Project ID");
host_id!(WorkingCopyId, "Working Copy ID");
host_id!(FarfoldSessionId, "Farfold Session ID");
host_id!(NativeSessionId, "native Session ID");
host_id!(NativeTurnId, "native Turn ID");
host_id!(NativeItemId, "native item ID");
host_id!(NativeInteractionId, "native interaction ID");

#[cfg(test)]
mod tests {
    use super::{FarfoldSessionId, InstallationId, NativeSessionId, RuntimeBuildId};

    #[test]
    fn typed_ids_accept_stable_runtime_and_session_shapes() {
        assert_eq!(
            RuntimeBuildId::parse("pi@0.84.3+sha256:e844dc14")
                .unwrap()
                .as_str(),
            "pi@0.84.3+sha256:e844dc14"
        );
        assert_eq!(
            NativeSessionId::parse("ses_cross-runtime-1")
                .unwrap()
                .as_str(),
            "ses_cross-runtime-1"
        );
    }

    #[test]
    fn typed_ids_reject_empty_whitespace_path_and_control_characters() {
        for value in ["", " session", "session ", "../session", "a/b", "a\nb"] {
            assert!(FarfoldSessionId::parse(value).is_err(), "{value:?}");
        }
    }

    #[test]
    fn identity_dimensions_remain_distinct_serialized_values() {
        let installation = InstallationId::parse("managed-pi").unwrap();
        let session = FarfoldSessionId::parse("managed-pi").unwrap();

        assert_eq!(installation.as_str(), session.as_str());
        assert_eq!(
            serde_json::to_string(&installation).unwrap(),
            "\"managed-pi\""
        );
        assert_eq!(serde_json::to_string(&session).unwrap(), "\"managed-pi\"");
    }
}
