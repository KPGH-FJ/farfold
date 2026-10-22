//! Finite private Git mutations before any source security is restored.
use super::*;
use std::io::Write;
impl GraphBundle<'_> {
    pub(in crate::worktrees) fn into_recovery_git(
        mut self,
        captured: &super::super::Capture,
        cancel: &AtomicBool,
    ) -> Result<PreparedRecoveryGit> {
        super::super::validate_profile(&captured.configs, &captured.attributes)?;
        self.owner.verify()?;
        self.owner.check_graph(false, cancel)?;
        // Only this generated private repository is rewritten. Keeping one
        // packed-refs file avoids spending one material node per retained root.
        // Release its old loose-ref directory pins before Git prunes them;
        // original source ownership, selected program and private root remain.
        self.owner.second_pins.clear();
        self.owner.second_action(Action::PackRefs, cancel)?;
        self.owner.second_pins = graph_pins(&self.owner.second, false)?;
        self.owner.second_pins.push(
            self.owner
                .second
                .child(&"HEAD".encode_utf16().collect::<Vec<_>>(), false)
                .map_err(|_| error("recoveryChanged"))?,
        );
        self.owner.check_graph(false, cancel)?;
        // The original file is modified by exact held FileObject, never by a
        // replace pathname or by executing a config read after dropping its pin.
        let (old, expected) = self.owner.config.take().ok_or(error("unknown"))?;
        let path = old.guid_path.clone();
        drop(old);
        let mut file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| error("recoveryChanged"))?;
        if crate::file_access::stamp(&file).map_err(|_| error("recoveryChanged"))? != expected {
            return Err(error("recoveryChanged"));
        }
        let mut config = format!(
            "[core]\n repositoryformatversion = {}\n bare = false\n hooksPath = /dev/null\n attributesFile = /dev/null\n fsmonitor = false\n",
            usize::from(captured.roots.format == "sha256")
        );
        for setting in &captured.configs {
            let (name, value) = setting.split_once('=').ok_or(error("recoveryInvalid"))?;
            let key = name.strip_prefix("core.").ok_or(error("recoveryInvalid"))?;
            config.push_str(&format!(" {key} = {value}\n"));
        }
        if captured.roots.format == "sha256" {
            config.push_str("[extensions]\n objectFormat = sha256\n");
        }
        file.set_len(0)
            .and_then(|_| file.rewind())
            .and_then(|_| file.write_all(config.as_bytes()))
            .and_then(|_| file.sync_all())
            .map_err(|_| error("unavailable"))?;
        let id = expected.identity;
        drop(file);
        let pin = self
            .owner
            .second
            .child(&"config".encode_utf16().collect::<Vec<_>>(), false)
            .map_err(|_| error("recoveryChanged"))?;
        let actual = crate::file_access::stamp(pin.file()).map_err(|_| error("recoveryChanged"))?;
        let mut bytes = Vec::new();
        pin.file()
            .take(65537)
            .read_to_end(&mut bytes)
            .map_err(|_| error("unavailable"))?;
        if pin.identity() != &id || bytes != config.as_bytes() {
            return Err(error("recoveryChanged"));
        }
        self.owner.config = Some((pin, actual));
        if !captured.attributes.is_empty() {
            // FILE_CREATE under the held private Git parent returns the actual
            // new objects. Reopening a pathname alone never establishes ownership.
            let mut created =
                crate::file_access::WorktreeCheckout::create_under(&self.owner.second, "info")
                    .map_err(|_| error("targetExists"))?;
            let info = PinnedPath::git_directory(&created.root().guid_path)
                .map_err(|_| error("recoveryChanged"))?;
            if info.identity() != created.root().identity() {
                return Err(error("recoveryChanged"));
            }
            let mut bytes = tempfile::tempfile().map_err(|_| error("unavailable"))?;
            bytes
                .write_all(&captured.attributes)
                .and_then(|_| bytes.sync_all())
                .map_err(|_| error("unavailable"))?;
            created
                .copy_regular(
                    "attributes",
                    &bytes,
                    captured.attributes.len() as u64,
                    cancel,
                )
                .map_err(|_| error("recoveryChanged"))?;
            created.verify().map_err(|_| error("recoveryChanged"))?;
            let produced =
                crate::file_access::metadata_child(info.file(), std::ffi::OsStr::new("attributes"))
                    .map_err(|_| error("recoveryChanged"))?
                    .ok_or(error("recoveryChanged"))?;
            drop(created);
            let attributes = info
                .child(&"attributes".encode_utf16().collect::<Vec<_>>(), false)
                .map_err(|_| error("recoveryChanged"))?;
            let mut actual = Vec::new();
            attributes
                .file()
                .take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut actual)
                .map_err(|_| error("unavailable"))?;
            if crate::file_access::metadata_file(attributes.file())
                .map_err(|_| error("recoveryChanged"))?
                != produced
                || actual != captured.attributes
            {
                return Err(error("recoveryChanged"));
            }
            self.owner.second_pins.extend([info, attributes]);
        }
        self.owner.second_action(Action::Index, cancel)?;
        let frozen = prepared::Frozen::capture(
            &self.owner.second,
            &self.owner.manifest,
            !captured.attributes.is_empty(),
            cancel,
        )?;
        self.owner.check_graph(false, cancel)?;
        let Context { root, _temp, .. } = self.owner;
        Ok(PreparedRecoveryGit::new(frozen, root, _temp))
    }
}
