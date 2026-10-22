//! One transient observation context; Unix keeps its existing command paths.
use super::{git, inspect::Snapshot, types::Result};
use std::{path::Path, sync::atomic::AtomicBool, time::Duration};

pub(super) struct Reader {
    #[cfg(windows)]
    context: super::windows_git::ReadContext,
}
impl Reader {
    #[cfg(windows)]
    pub(super) fn from_windows(context: super::windows_git::ReadContext) -> Self {
        Self { context }
    }
    pub fn open(_path: &Path) -> Result<Self> {
        Ok(Self {
            #[cfg(windows)]
            context: super::windows_git::ReadContext::open(_path)?,
        })
    }
    #[cfg(windows)]
    pub fn windows_scope(&self) -> &super::windows_scope::Scope {
        &self.context.scope
    }
    pub fn matches(&self, _snapshot: &Snapshot) -> Result<()> {
        #[cfg(windows)]
        self.context.scope.matches(_snapshot)?;
        Ok(())
    }
    pub fn read(&self, _root: &Path, args: &[&str]) -> Result<Vec<u8>> {
        #[cfg(unix)]
        {
            git::read(_root, args)
        }
        #[cfg(windows)]
        {
            self.context.read(args)
        }
    }
    pub fn text(&self, _root: &Path, args: &[&str]) -> Result<String> {
        #[cfg(unix)]
        {
            git::text(_root, args)
        }
        #[cfg(windows)]
        {
            self.context.text(args)
        }
    }
    pub fn config(&self, _root: &Path, name: &str, boolean: bool) -> Result<Option<String>> {
        #[cfg(unix)]
        {
            git::config(_root, name, boolean)
        }
        #[cfg(windows)]
        {
            self.context.config(name, boolean)
        }
    }
    pub fn execute(&self, _root: &Path, args: &[&str]) -> Result<git::Output> {
        #[cfg(unix)]
        {
            git::execute(
                _root,
                args,
                &AtomicBool::new(false),
                Duration::from_secs(10),
            )
        }
        #[cfg(windows)]
        {
            self.context
                .execute(args, &AtomicBool::new(false), Duration::from_secs(10))
        }
    }
}
