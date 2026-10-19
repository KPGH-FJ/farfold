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

pub(super) fn capture(owner: &SourceOwner, cancel: &AtomicBool) -> Result<(Vec<String>, Vec<u8>)> {
    owner.recheck(cancel)?;
    let inputs = inputs::Inputs::capture(owner, cancel)?;
    let mut evaluator = evaluator::Evaluator::new(owner, &inputs.configs, cancel)?;
    let paths = evaluator.paths(cancel)?;
    evaluator.install(evaluator::Role::Original, &inputs.info(cancel)?, cancel)?;
    evaluator.install(evaluator::Role::Local, &[], cancel)?;
    let original = evaluator.attributes(
        evaluator::Role::Original,
        &paths,
        Some(inputs.attr_file()),
        cancel,
    )?;
    inputs.check_filter(owner, &original, cancel)?;
    let local = evaluator.attributes(evaluator::Role::Local, &paths, None, cancel)?;
    // This is the original Checkout mirror algorithm, using its original
    // parser and path quoting. No raw working-tree .gitattributes is consulted.
    let effective = mirror(&original, &local, cancel)?;
    evaluator.install(evaluator::Role::Mirror, &effective, cancel)?;
    let mirrored = evaluator.attributes(evaluator::Role::Mirror, &paths, None, cancel)?;
    // Original global/system default attribute files are interpreted by the
    // selected official Git. Evaluate them again rather than calling a mere
    // re-opened source pathname an atomic/full snapshot of those inputs.
    let repeated = evaluator.attributes(
        evaluator::Role::Original,
        &paths,
        Some(inputs.attr_file()),
        cancel,
    )?;
    if original != mirrored || original != repeated {
        return Err(error("unsupportedGit"));
    }
    inputs.verify(owner, cancel)?;
    owner.recheck(cancel)?;
    Ok((inputs.configs, effective))
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
