//! Strict public version projection. Unparseable output is never shown as a version.
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RequirementState {
    Satisfied,
    Unsatisfied,
    Unknown,
}

pub(crate) fn public_version(text: &str) -> Option<String> {
    text.split_whitespace().find_map(|token| {
        let token = token.trim_matches(|c: char| matches!(c, '(' | ')' | ','));
        let token = token.strip_prefix('v').unwrap_or(token);
        semver::Version::parse(token)
            .ok()
            .map(|version| version.to_string())
    })
}

pub(crate) fn requirement_state(version: Option<&str>, range: &str) -> RequirementState {
    let Some(version) = version.and_then(|version| semver::Version::parse(version).ok()) else {
        return RequirementState::Unknown;
    };
    let Ok(requirement) = semver::VersionReq::parse(range) else {
        return RequirementState::Unknown;
    };
    if requirement.matches(&version) {
        RequirementState::Satisfied
    } else {
        RequirementState::Unsatisfied
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn support_range_is_a_three_way_diagnostic_and_preserves_unknown() {
        assert_eq!(
            requirement_state(Some("0.80.5"), ">=0.81.0"),
            RequirementState::Unsatisfied
        );
        assert_eq!(
            requirement_state(Some("0.81.0"), ">=0.81.0"),
            RequirementState::Satisfied
        );
        assert_eq!(
            requirement_state(Some("0.99.0"), ">=0.81.0"),
            RequirementState::Satisfied
        );
        assert_eq!(
            requirement_state(None, ">=0.81.0"),
            RequirementState::Unknown
        );
        assert_eq!(
            requirement_state(Some("unparsed"), ">=0.81.0"),
            RequirementState::Unknown
        );
        assert_eq!(
            requirement_state(Some("22.20.0"), "unsupported || format"),
            RequirementState::Unknown
        );
        assert_eq!(public_version("Pi v0.80.5\n").as_deref(), Some("0.80.5"));
        assert!(public_version("not a version").is_none());
    }
}
