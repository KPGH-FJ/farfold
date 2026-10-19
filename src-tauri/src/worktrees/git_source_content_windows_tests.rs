//! Actual selected-HEAD blob bytes, test-registered prerequisite only.
//! A raw match is NOT Git checkout cleanliness or a complete material profile.
use super::super::content_stream::{self as stream, Budget, Comparison, Selection};
use super::{SourceGraph, cancelled, command};
use crate::{
    file_access::{Identity, MetadataKind, PinnedPath, metadata_file, stamp},
    worktrees::types::{Result, error},
};
use std::{
    fs::File,
    io::{Seek, SeekFrom},
    sync::atomic::AtomicBool,
};
use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};

fn failure(value: stream::Error) -> crate::worktrees::types::Failure {
    error(match value {
        stream::Error::Cancelled => "cancelled",
        stream::Error::Limit => "recoveryLimit",
        stream::Error::Changed => "materialChanged",
        stream::Error::Io { .. } => "unavailable",
        _ => "unsupportedGit",
    })
}
pub(super) struct RawBlob<'a> {
    graph: &'a SourceGraph,
    entry: Selection,
    output: File,
    work: Budget,
}
pub(super) struct RawDefaultComparison {
    pub(super) head: String,
    pub(super) path: Vec<u8>,
    pub(super) oid: String,
    pub(super) source: Identity,
    pub(super) raw: Comparison,
}
impl SourceGraph {
    pub(super) fn raw_selected_blob(
        &self,
        path: &[u8],
        cancel: &AtomicBool,
    ) -> Result<RawBlob<'_>> {
        self.recheck(cancel)?;
        super::super::environment()?;
        let (mut tree_command, tree_paths) = command(&self.owner.source)?;
        tree_command.args(["ls-tree", "-r", "-l", "-z", &self.owner.roots.head]);
        let tree = super::super::execute_command_input(
            tree_command,
            super::super::Input::null(),
            cancel,
            crate::worktrees::recovery_pack::COMMAND_TIME,
        );
        tree_paths.verify()?;
        self.recheck(cancel)?;
        let tree = tree?;
        if !tree.success {
            return Err(error("recoveryInvalid"));
        }
        let raw = tree.bytes;
        let entry = stream::select(
            &raw,
            path,
            self.objects(),
            self.owner.roots.head.len(),
            cancel,
        )
        .map_err(failure)?;
        self.recheck(cancel)?;
        super::super::environment()?;
        let (mut blob_command, blob_paths) = command(&self.owner.source)?;
        blob_command.args(["cat-file", "blob", &entry.oid]);
        let output = tempfile::tempfile().map_err(|_| error("unavailable"))?;
        // The original executor retains the same Child/direct Job and input.
        // collect=false writes into this actual anonymous FileObject, not Vec.
        // There is no Windows generic execute_to_file/mutation admission here.
        let result = super::super::execute_bounded(
            blob_command,
            Some(super::super::Input::null()),
            cancel,
            crate::worktrees::recovery_pack::COMMAND_TIME,
            output.try_clone().map_err(|_| error("unavailable"))?,
            entry.bytes,
            false,
        );
        blob_paths.verify()?;
        self.recheck(cancel)?;
        if !result?.success {
            return Err(error("recoveryInvalid"));
        }
        let metadata = output.metadata().map_err(|_| error("unavailable"))?;
        if !metadata.is_file() || metadata.len() != entry.bytes {
            return Err(error("materialChanged"));
        }
        // Returned stdout bytes and tree listing count against this component's
        // logical work budget; the original independent stderr cap stays 4MiB.
        let mut work = Budget::new(stream::WORK_LIMIT);
        work.charge(entry.tree_output_bytes).map_err(failure)?;
        work.charge(metadata.len()).map_err(failure)?;
        Ok(RawBlob {
            graph: self,
            entry,
            output,
            work,
        })
    }
}
fn selected_file(graph: &SourceGraph, path: &[u8], cancel: &AtomicBool) -> Result<PinnedPath> {
    let text = std::str::from_utf8(path).map_err(|_| error("unsafePath"))?;
    if text.len() > 4096 {
        return Err(error("unsafePath"));
    }
    let components = text.split('/').collect::<Vec<_>>();
    let mut directories = Vec::new();
    for (n, name) in components.iter().enumerate() {
        cancelled(cancel)?;
        if name.is_empty() || matches!(*name, "." | "..") || name.contains(['\\', ':', '\0']) {
            return Err(error("unsafePath"));
        }
        let raw = name.encode_utf16().collect::<Vec<_>>();
        // Never enter Git's administrative pointer/config namespace, including
        // native case aliases. Raw UTF-8 failures are refusals, never lossy names.
        for forbidden in [".git", ".gitmodules"] {
            let fixed = forbidden.encode_utf16().collect::<Vec<_>>();
            let result = unsafe {
                CompareStringOrdinal(
                    raw.as_ptr(),
                    raw.len() as i32,
                    fixed.as_ptr(),
                    fixed.len() as i32,
                    1,
                )
            };
            if result == 0 {
                return Err(error("unavailable"));
            }
            if result == CSTR_EQUAL {
                return Err(error("unsafePath"));
            }
        }
        let parent = directories.last().unwrap_or(&graph.owner.source.scope.root);
        let directory = n + 1 != components.len();
        let pin = parent
            .child(&raw, directory)
            .map_err(|_| error("unsafePath"))?;
        if directory {
            directories.push(pin);
        } else {
            return Ok(pin);
        }
    }
    Err(error("unsafePath"))
}
impl RawBlob<'_> {
    // Consumed once: successful native/default reads cannot reset a work budget
    // or repeat output reading through this API. No raw bytes enter metadata.
    pub(super) fn compare_source_default(
        mut self,
        cancel: &AtomicBool,
    ) -> Result<RawDefaultComparison> {
        self.graph.recheck(cancel)?;
        let source = selected_file(self.graph, &self.entry.path, cancel)?;
        source.verify().map_err(|_| error("materialChanged"))?;
        let before = stamp(source.file()).map_err(|_| error("unavailable"))?;
        let version = metadata_file(source.file()).map_err(|_| error("unavailable"))?;
        if !before.regular
            || version.kind != MetadataKind::File
            || version.attributes() & (0x400 | 0x1000 | 0x4000 | 0x40000 | 0x400000) != 0
        {
            return Err(error("specialFile"));
        }
        let mut actual = source
            .file()
            .try_clone()
            .map_err(|_| error("unavailable"))?;
        self.output
            .seek(SeekFrom::Start(0))
            .map_err(|_| error("unavailable"))?;
        actual
            .seek(SeekFrom::Start(0))
            .map_err(|_| error("unavailable"))?;
        let compared = stream::compare(
            &mut self.output,
            self.entry.bytes,
            &mut actual,
            before.size,
            &mut self.work,
            cancel,
        );
        source.verify().map_err(|_| error("materialChanged"))?;
        if stamp(source.file()).map_err(|_| error("unavailable"))? != before
            || metadata_file(source.file()).map_err(|_| error("unavailable"))? != version
            || self
                .output
                .metadata()
                .map_err(|_| error("unavailable"))?
                .len()
                != self.entry.bytes
        {
            return Err(error("materialChanged"));
        }
        self.graph.recheck(cancel)?;
        let raw = compared.map_err(failure)?;
        Ok(RawDefaultComparison {
            head: self.graph.owner.roots.head.clone(),
            path: self.entry.path,
            oid: self.entry.oid,
            source: before.identity,
            raw,
        })
    }
}
