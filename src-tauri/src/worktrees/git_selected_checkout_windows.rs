//! Create's selected immutable tree; separate from Recovery's private-ref owner.
use super::*;
use crate::file_access::WorktreeCheckout;
use crate::worktrees::{storage::Intent, windows_git::ReadContext};
use std::{fs::File, io::SeekFrom};

struct Source {
    context: ReadContext,
    snapshot: crate::worktrees::inspect::Snapshot,
    oid: String,
    format: String,
}
impl EvaluationSource for Source {
    fn context(&self) -> &ReadContext {
        &self.context
    }
    fn snapshot(&self) -> &crate::worktrees::inspect::Snapshot {
        &self.snapshot
    }
    fn selected_oid(&self) -> &str {
        &self.oid
    }
    fn object_format(&self) -> &str {
        &self.format
    }
    fn recheck(&self, cancel: &AtomicBool) -> Result<()> {
        cancelled(cancel)?;
        self.context.scope.matches(&self.snapshot)?;
        self.context
            .selected_program()
            .verify()
            .map_err(|_| error("changed"))
    }
}
pub(in crate::worktrees) struct SelectedCheckout {
    owner: Source,
    configs: Vec<String>,
    attributes: Vec<u8>,
}
fn entries(
    evaluator: &evaluator::Evaluator<'_>,
    configs: &[String],
    cancel: &AtomicBool,
) -> Result<Vec<evaluator::Entry>> {
    let entries = evaluator.entries(cancel)?;
    // Git on Windows writes a link's literal blob as an ordinary file ONLY
    // when this is the source's explicit policy. Never silently disable real
    // symlinks or run a textual transform over their link target bytes.
    if entries.iter().any(|entry| entry.symlink)
        && !configs.iter().any(|v| v == "core.symlinks=false")
    {
        return Err(error("unsupportedGit"));
    }
    Ok(entries)
}
impl SelectedCheckout {
    pub(in crate::worktrees) fn prepare(
        snapshot: &crate::worktrees::inspect::Snapshot,
        oid: &str,
    ) -> Result<Self> {
        crate::worktrees::inspect::target_allowed(snapshot, oid)?;
        let cancel = AtomicBool::new(false);
        let context = ReadContext::open(Path::new(&snapshot.root))?;
        context.scope.matches(snapshot)?;
        let format =
            match super::super::query(&context, snapshot, super::super::Query::Format, &cancel)?
                .as_slice()
            {
                b"sha1\n" => "sha1",
                b"sha256\n" => "sha256",
                _ => return Err(error("unsupportedGit")),
            };
        let owner = Source {
            context,
            snapshot: snapshot.clone(),
            oid: oid.to_owned(),
            format: format.to_owned(),
        };
        let (configs, attributes) =
            with_profile(&owner, &cancel, |evaluator, configs, attributes| {
                entries(evaluator, configs, &cancel)?;
                Ok((configs.to_vec(), attributes.to_vec()))
            })?;
        Ok(Self {
            owner,
            configs,
            attributes,
        })
    }
    pub(in crate::worktrees) fn materialize(
        &self,
        intent: &Intent,
        cancel: &AtomicBool,
        created: &mut WorktreeCheckout<'_>,
    ) -> Result<()> {
        #[cfg(test)]
        let observation =
            crate::worktrees::create_observation_tests::Observation::new("materialize");
        if intent.input.branch.oid() != self.owner.oid
            || !intent.source.matches(&self.owner.snapshot)
        {
            return Err(error("changed"));
        }
        #[cfg(test)]
        observation.at("verify-created");
        let current = crate::worktrees::create::verify(intent)?;
        #[cfg(test)]
        observation.at("pin-target-and-git");
        let target =
            PinnedPath::directory(Path::new(&intent.target)).map_err(|_| error("changed"))?;
        let git_dir =
            PinnedPath::git_directory(Path::new(&current.git_dir)).map_err(|_| error("changed"))?;
        if crate::worktrees::inspect::pinned_stamp(&target)?
            != *intent.target_stamp.as_ref().ok_or(error("unknown"))?
            || crate::worktrees::inspect::pinned_stamp(&git_dir)? != current.git_stamp
        {
            return Err(error("changed"));
        }
        if created.root().identity() != target.identity()
            || created.root().guid_path != target.guid_path
        {
            return Err(error("changed"));
        }
        #[cfg(test)]
        observation.at("with-profile-enter");
        with_profile(&self.owner, cancel, |evaluator, configs, attributes| {
            #[cfg(test)]
            observation.at("with-profile-consume");
            if configs != self.configs || attributes != self.attributes {
                return Err(error("changed"));
            }
            #[cfg(test)]
            observation.at("selected-entries");
            let selected = entries(evaluator, configs, cancel)?;
            #[cfg(test)]
            observation.at("attribute-lookup-owner");
            let mut lookup = WorktreeCheckout::create_under(evaluator.root(), "attribute-lookups")
                .map_err(|_| error("changed"))?;
            lookup
                .guard_attributes(
                    &selected.iter().map(|v| v.path.clone()).collect::<Vec<_>>(),
                    cancel,
                )
                .map_err(|_| error("changed"))?;
            let paths = selected
                .iter()
                .flat_map(|entry| entry.path.as_bytes().iter().copied().chain(Some(0)))
                .collect::<Vec<_>>();
            #[cfg(test)]
            observation.at("mirror-attributes");
            let effective = evaluator.attributes(evaluator::Role::Mirror, &paths, None, cancel)?;
            #[cfg(test)]
            observation.at("destination-owner");
            let mut destination = WorktreeCheckout::new(&target).map_err(|_| error("changed"))?;
            destination
                .retain_registration()
                .map_err(|_| error("changed"))?;
            // No attributes plus Git's default autocrlf=false/eol does not
            // transform a regular blob. Every attributed file, including
            // unknown names, goes through official Git rather than a local
            // imitation of conversions. Symlink-as-text is always raw.
            let converted = |entry: &evaluator::Entry| {
                !entry.symlink
                    && (effective
                        .get(entry.path.as_bytes())
                        .is_some_and(|values| !values.is_empty())
                        || configs.iter().any(|v| {
                            v.starts_with("core.eol=")
                                || (v.starts_with("core.autocrlf=") && v != "core.autocrlf=false")
                        }))
            };
            let batch = selected
                .iter()
                .filter(|entry| !converted(entry))
                .cloned()
                .collect::<Vec<_>>();
            if !batch.is_empty() {
                #[cfg(test)]
                observation.at("batch-content");
                lookup.verify().map_err(|_| error("changed"))?;
                let output = evaluator.contents(lookup.root(), &batch, cancel)?;
                consume(&output, &batch, &mut destination, cancel)?;
                #[cfg(test)]
                observation.at("batch-consumed");
                lookup.verify().map_err(|_| error("changed"))?;
            }
            for entry in selected.iter().filter(|entry| converted(entry)) {
                #[cfg(test)]
                observation.at("filtered-content");
                lookup.verify().map_err(|_| error("changed"))?;
                let output = evaluator.filtered(lookup.root(), entry, cancel)?;
                let length = stamp(&output).map_err(|_| error("changed"))?.size;
                destination
                    .copy_regular(&entry.path, &output, length, cancel)
                    .map_err(|_| error("changed"))?;
                lookup.verify().map_err(|_| error("changed"))?;
            }
            #[cfg(test)]
            observation.at("retain-index");
            destination.verify().map_err(|_| error("changed"))?;
            destination
                .retain_index(evaluator.index()?, git_dir, cancel)
                .map_err(|_| error("changed"))?;
            destination.verify().map_err(|_| error("changed"))?;
            let after = crate::worktrees::create::verify(intent)?;
            if after.git_dir != current.git_dir || after.git_stamp != current.git_stamp {
                return Err(error("changed"));
            }
            #[cfg(test)]
            observation.at("verify-destination-namespace");
            destination
                .verify_namespace(cancel)
                .map_err(|_| error("changed"))?;
            created
                .retain_completed(destination)
                .map_err(|_| error("changed"))?;
            #[cfg(test)]
            observation.at("consume-complete");
            Ok(())
        })
    }
}
fn consume(
    file: &File,
    entries: &[evaluator::Entry],
    target: &mut WorktreeCheckout<'_>,
    cancel: &AtomicBool,
) -> Result<()> {
    let before = stamp(file).map_err(|_| error("changed"))?;
    let mut reader = file.try_clone().map_err(|_| error("unavailable"))?;
    reader.rewind().map_err(|_| error("unavailable"))?;
    for entry in entries {
        cancelled(cancel)?;
        let mut header = Vec::new();
        loop {
            let mut byte = [0];
            reader.read_exact(&mut byte).map_err(|_| error("changed"))?;
            if byte[0] == b'\n' {
                break;
            }
            if header.len() >= 128 {
                return Err(error("unsupportedGit"));
            }
            header.push(byte[0]);
        }
        let fields = std::str::from_utf8(&header)
            .map_err(|_| error("unsupportedGit"))?
            .split(' ')
            .collect::<Vec<_>>();
        if fields.len() != 3 || fields[0] != entry.oid || fields[1] != "blob" {
            return Err(error("changed"));
        }
        let length = fields[2]
            .parse::<u64>()
            .map_err(|_| error("unsupportedGit"))?;
        if length > 256 * 1024 * 1024 {
            return Err(error("tooLarge"));
        }
        let offset = reader.stream_position().map_err(|_| error("unavailable"))?;
        target
            .copy_range(&entry.path, file, offset, length, cancel)
            .map_err(|_| error("changed"))?;
        reader
            .seek(SeekFrom::Start(
                offset.checked_add(length).ok_or(error("tooLarge"))?,
            ))
            .map_err(|_| error("unavailable"))?;
        let mut newline = [0];
        reader
            .read_exact(&mut newline)
            .map_err(|_| error("changed"))?;
        if newline != [b'\n'] {
            return Err(error("changed"));
        }
    }
    let mut trailing = [0];
    if reader
        .read(&mut trailing)
        .map_err(|_| error("unavailable"))?
        != 0
        || stamp(file).map_err(|_| error("changed"))? != before
    {
        return Err(error("changed"));
    }
    Ok(())
}
