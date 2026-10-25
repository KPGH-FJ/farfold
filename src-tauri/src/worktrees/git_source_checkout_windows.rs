//! Fixed selected-HEAD profile observation. Does not materialize a worktree.
use super::{SourceOwner, cancelled};
use crate::{
    file_access::{PinnedPath, Stamp, stamp},
    worktrees::{
        git,
        types::{Result, error},
    },
};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::AtomicBool,
    time::Duration,
};
type Attributes = BTreeMap<Vec<u8>, BTreeMap<String, String>>;
const LIMIT: u64 = 4 * 1024 * 1024;
#[path = "git_source_checkout_evaluator_windows.rs"]
mod evaluator;
#[path = "git_source_checkout_inputs_windows.rs"]
mod inputs;
#[path = "git_selected_checkout_windows.rs"]
mod selected;
pub(in crate::worktrees) use selected::SelectedCheckout;

// Recovery keeps its original complete SourceOwner fence. Create supplies a
// separately admitted current repository and one explicit immutable tree.
pub(super) trait EvaluationSource {
    fn context(&self) -> &crate::worktrees::windows_git::ReadContext;
    fn snapshot(&self) -> &crate::worktrees::inspect::Snapshot;
    fn selected_oid(&self) -> &str;
    fn object_format(&self) -> &str;
    fn recheck(&self, cancel: &AtomicBool) -> Result<()>;
}
impl EvaluationSource for SourceOwner {
    fn context(&self) -> &crate::worktrees::windows_git::ReadContext {
        &self.source
    }
    fn snapshot(&self) -> &crate::worktrees::inspect::Snapshot {
        &self.expected
    }
    fn selected_oid(&self) -> &str {
        &self.roots.head
    }
    fn object_format(&self) -> &str {
        &self.roots.format
    }
    fn recheck(&self, cancel: &AtomicBool) -> Result<()> {
        SourceOwner::recheck(self, cancel)
    }
}

pub(super) fn capture(owner: &SourceOwner, cancel: &AtomicBool) -> Result<(Vec<String>, Vec<u8>)> {
    capture_source(owner, cancel)
}
pub(super) fn capture_source(
    owner: &dyn EvaluationSource,
    cancel: &AtomicBool,
) -> Result<(Vec<String>, Vec<u8>)> {
    with_profile(owner, cancel, |_, configs, attributes| {
        Ok((configs.to_vec(), attributes.to_vec()))
    })
}
fn with_profile<T>(
    owner: &dyn EvaluationSource,
    cancel: &AtomicBool,
    consume: impl FnOnce(&evaluator::Evaluator<'_>, &[String], &[u8]) -> Result<T>,
) -> Result<T> {
    #[cfg(test)]
    let observation = crate::worktrees::create_observation_tests::Observation::new("profile");
    #[cfg(test)]
    observation.at("source-recheck");
    owner.recheck(cancel)?;
    #[cfg(test)]
    observation.at("capture-inputs");
    let inputs = inputs::Inputs::capture(owner, cancel)?;
    #[cfg(test)]
    observation.at("evaluator-new");
    let mut evaluator = evaluator::Evaluator::new(owner, &inputs.configs, cancel)?;
    #[cfg(test)]
    observation.at("evaluator-paths");
    let paths = evaluator.paths(cancel)?;
    #[cfg(test)]
    observation.at("install-original-local");
    evaluator.install(evaluator::Role::Original, &inputs.info(cancel)?, cancel)?;
    evaluator.install(evaluator::Role::Local, &[], cancel)?;
    #[cfg(test)]
    observation.at("original-attributes");
    let original = evaluator.attributes(
        evaluator::Role::Original,
        &paths,
        Some(inputs.attr_source()?),
        cancel,
    )?;
    #[cfg(test)]
    observation.at("check-filter");
    inputs.check_filter(owner, &original, cancel)?;
    #[cfg(test)]
    observation.at("local-attributes");
    let local = evaluator.attributes(evaluator::Role::Local, &paths, None, cancel)?;
    // This is the original Checkout mirror algorithm, using its original
    // parser and path quoting. No raw working-tree .gitattributes is consulted.
    let effective = mirror(&original, &local, cancel)?;
    #[cfg(test)]
    observation.at("install-mirror");
    evaluator.install(evaluator::Role::Mirror, &effective, cancel)?;
    #[cfg(test)]
    observation.at("mirrored-attributes");
    let mirrored = evaluator.attributes(evaluator::Role::Mirror, &paths, None, cancel)?;
    // Original global/system default attribute files are interpreted by the
    // selected official Git. Evaluate them again rather than calling a mere
    // re-opened source pathname an atomic/full snapshot of those inputs.
    let repeated = evaluator.attributes(
        evaluator::Role::Original,
        &paths,
        Some(inputs.attr_source()?),
        cancel,
    )?;
    #[cfg(test)]
    observation.at("verify-inputs-before-consume");
    if original != mirrored || original != repeated {
        return Err(error("unsupportedGit"));
    }
    inputs.verify(owner, cancel)?;
    owner.recheck(cancel)?;
    #[cfg(test)]
    observation.at("consume-enter");
    let result = consume(&evaluator, &inputs.configs, &effective)?;
    #[cfg(test)]
    observation.at("verify-inputs-after-consume");
    inputs.verify(owner, cancel)?;
    owner.recheck(cancel)?;
    #[cfg(test)]
    observation.at("complete");
    Ok(result)
}
fn mirror(original: &Attributes, local: &Attributes, cancel: &AtomicBool) -> Result<Vec<u8>> {
    let keys: BTreeSet<_> = original.keys().chain(local.keys()).cloned().collect();
    let mut effective = Vec::new();
    for path in keys {
        cancelled(cancel)?;
        let source = original.get(&path);
        let internal = local.get(&path);
        let names: BTreeSet<_> = source
            .into_iter()
            .flat_map(|v| v.keys())
            .chain(internal.into_iter().flat_map(|v| v.keys()))
            .collect();
        let mut line = crate::worktrees::checkout::pattern(&path);
        for name in names {
            line.push(' ');
            match source.and_then(|v| v.get(name)).map(String::as_str) {
                None | Some("unspecified") => {
                    line.push('!');
                    line.push_str(name);
                }
                Some("unset") => {
                    line.push('-');
                    line.push_str(name);
                }
                Some("set") => line.push_str(name),
                Some(value) => {
                    line.push_str(name);
                    line.push('=');
                    line.push_str(value);
                }
            }
        }
        effective.extend_from_slice(line.as_bytes());
        effective.push(b'\n');
        if effective.len() as u64 > LIMIT {
            return Err(error("tooLarge"));
        }
    }
    Ok(effective)
}
#[cfg(test)]
#[path = "git_source_checkout_windows_tests.rs"]
mod tests;
