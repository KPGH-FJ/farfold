//! Match std::process::Command's environment-name semantics before the final
//! unordered map reaches the process builder. Windows names preserve spelling
//! but ignore case; all configured environment names are ASCII identifiers.
//! https://doc.rust-lang.org/std/process/struct.Command.html#method.env
use std::collections::HashMap;

#[derive(Clone, Copy)]
pub(crate) enum EnvNames {
    CaseSensitive,
    Windows,
}
impl EnvNames {
    pub(crate) fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::CaseSensitive
        }
    }
    pub(crate) fn matches(self, left: &str, right: &str) -> bool {
        match self {
            Self::Windows => left.eq_ignore_ascii_case(right),
            Self::CaseSensitive => left == right,
        }
    }
    pub(crate) fn contains(self, env: &HashMap<String, String>, name: &str) -> bool {
        env.keys().any(|key| self.matches(key, name))
    }
    pub(crate) fn get<'a>(
        self,
        env: &'a HashMap<String, String>,
        name: &str,
    ) -> Result<Option<&'a String>, String> {
        let mut values = env
            .iter()
            .filter(|(key, _)| self.matches(key, name))
            .map(|(_, value)| value);
        let first = values.next();
        if values.any(|value| Some(value) != first) {
            return Err("环境变量存在大小写冲突，请检查设置".into());
        }
        Ok(first)
    }
    pub(crate) fn insert(self, env: &mut HashMap<String, String>, name: String, value: String) {
        if matches!(self, Self::Windows) {
            env.retain(|existing, _| !self.matches(existing, &name));
        }
        env.insert(name, value);
    }
    pub(crate) fn extend(
        self,
        env: &mut HashMap<String, String>,
        values: impl IntoIterator<Item = (String, String)>,
    ) {
        for (name, value) in values {
            self.insert(env, name, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_selected_secret_replaces_every_inherited_case_variant() {
        let mut env = HashMap::from([
            ("api_key".into(), "synthetic-other-account".into()),
            ("Api_Key".into(), "synthetic-third-account".into()),
        ]);
        EnvNames::Windows.extend(&mut env, [("API_KEY".into(), "synthetic-selected".into())]);
        assert_eq!(
            env,
            HashMap::from([("API_KEY".into(), "synthetic-selected".into())])
        );
    }
    #[test]
    fn unix_names_and_unrelated_variables_are_preserved() {
        let mut env = HashMap::from([
            ("api_key".into(), "ordinary-lowercase".into()),
            ("KEEP".into(), "ordinary".into()),
        ]);
        EnvNames::CaseSensitive.insert(&mut env, "API_KEY".into(), "synthetic-selected".into());
        assert_eq!(env.len(), 3);
        assert_eq!(env["api_key"], "ordinary-lowercase");
        assert_eq!(env["KEEP"], "ordinary");
    }
    #[test]
    fn windows_conflicts_are_detected_without_guessing_between_different_values() {
        let env = HashMap::from([
            ("Token".into(), "one".into()),
            ("TOKEN".into(), "two".into()),
        ]);
        assert!(EnvNames::Windows.contains(&env, "token"));
        assert!(EnvNames::Windows.get(&env, "token").is_err());
        assert_eq!(EnvNames::CaseSensitive.get(&env, "token").unwrap(), None);
    }
}
