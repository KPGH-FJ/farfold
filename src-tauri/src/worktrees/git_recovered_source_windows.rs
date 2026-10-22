//! Exact independent repository delivered from the unique recovery Manifest.
//! The linked source inventory is deliberately not broadened to arbitrary Git trees.
use super::*;
use crate::file_access::{EaWorkBudget, MATERIAL_WORK_LIMIT};
use crate::worktrees::recovery_pack::{Manifest, private_graph::Frozen};

pub(super) struct RecoveryOwner {
    pub(super) managed_root_git: super::super::super::windows_scope::managed_git::RootGit,
    source: ReadContext,
    expected: Snapshot,
    frozen: Frozen,
    manifest: Manifest,
}
impl RecoveryOwner {
    pub(super) fn recheck_with(&self, cancel: &AtomicBool, work: &mut EaWorkBudget) -> Result<()> {
        cancelled(cancel)?;
        self.source.scope.matches(&self.expected)?;
        self.managed_root_git.verify(&self.source)?;
        self.source
            .selected_program()
            .verify()
            .map_err(|_| error("changed"))?;
        self.frozen.verify_with(cancel, work)?;
        self.managed_root_git.verify(&self.source)
    }
    fn recheck(&self, cancel: &AtomicBool) -> Result<()> {
        self.recheck_with(cancel, &mut EaWorkBudget::new(MATERIAL_WORK_LIMIT))
    }
    fn query(&self, action: Query<'_>, cancel: &AtomicBool) -> Result<Vec<u8>> {
        self.recheck(cancel)?;
        let bytes = query(&self.source, &self.expected, action, cancel)?;
        self.recheck(cancel)?;
        Ok(bytes)
    }
    fn check_graph(&self, cancel: &AtomicBool) -> Result<()> {
        let m = &self.manifest;
        if self.expected.head.as_ref() != Some(&m.roots.head)
            || self.expected.branch.as_ref()
                != Some(&crate::worktrees::recovery_pack::expected_branch(m)?)
            || self.source.scope.git.identity() != self.source.scope.common.identity()
        {
            return Err(error("recoveryChanged"));
        }
        if self.query(Query::Format, cancel)? != format!("{}\n", m.roots.format).as_bytes() {
            return Err(error("recoveryChanged"));
        }
        self.query(Query::RecoveryFsck, cancel)?;
        let bytes = self.query(Query::RecoveryRefs, cancel)?;
        let refs = std::str::from_utf8(&bytes).map_err(|_| error("recoveryInvalid"))?;
        let mut actual = refs
            .lines()
            .map(|line| {
                line.split_once(' ')
                    .map(|(object, name)| (object.to_owned(), name.to_owned()))
                    .ok_or(error("recoveryInvalid"))
            })
            .collect::<Result<Vec<_>>>()?;
        let mut expected = m
            .roots
            .commits
            .iter()
            .enumerate()
            .map(|(index, object)| {
                (
                    object.clone(),
                    format!("refs/heads/recovery/root-{index:04}"),
                )
            })
            .collect::<Vec<_>>();
        actual.sort();
        expected.sort();
        if actual != expected {
            return Err(error("recoveryChanged"));
        }
        let input =
            super::super::Input::from_bytes(&m.roots.input(), super::super::OUTPUT_LIMIT, cancel)?;
        let objects = object_ids(
            &self.query(Query::Objects(input), cancel)?,
            &m.roots,
            cancel,
        )?;
        if objects != m.objects {
            return Err(error("recoveryChanged"));
        }
        let ids = (objects.join("\n") + "\n").into_bytes();
        let input = super::super::Input::from_bytes(&ids, super::super::OUTPUT_LIMIT, cancel)?;
        validate_sizes(&self.query(Query::Sizes(input), cancel)?, &objects, cancel)?;
        for commit in &m.roots.commits {
            if self.query(Query::CommitType(commit), cancel)? != b"commit\n" {
                return Err(error("recoveryChanged"));
            }
        }
        self.recheck(cancel)
    }
}
impl profile::EvaluationSource for RecoveryOwner {
    fn context(&self) -> &ReadContext {
        &self.source
    }
    fn snapshot(&self) -> &Snapshot {
        &self.expected
    }
    fn selected_oid(&self) -> &str {
        &self.manifest.roots.head
    }
    fn object_format(&self) -> &str {
        &self.manifest.roots.format
    }
    fn recheck(&self, cancel: &AtomicBool) -> Result<()> {
        RecoveryOwner::recheck(self, cancel)
    }
}
pub(in crate::worktrees) struct RecoveryGraph {
    owner: Arc<RecoveryOwner>,
}
impl RecoveryGraph {
    pub(in crate::worktrees) fn capture(
        snapshot: &Snapshot,
        manifest: &Manifest,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        crate::worktrees::recovery_pack::validate(manifest)?;
        let source = ReadContext::open(Path::new(&snapshot.root))?;
        source.scope.matches(snapshot)?;
        let managed_root_git = source.managed_root_git()?;
        let frozen = Frozen::capture_manifest(&source.scope.git, manifest, cancel)?;
        let owner = RecoveryOwner {
            managed_root_git,
            source,
            expected: snapshot.clone(),
            frozen,
            manifest: manifest.clone(),
        };
        owner.check_graph(cancel)?;
        Ok(Self {
            owner: Arc::new(owner),
        })
    }
    pub(in crate::worktrees) fn checkout_profile(
        &self,
        cancel: &AtomicBool,
    ) -> Result<(Vec<String>, Vec<u8>)> {
        profile::capture_source(self.owner.as_ref(), cancel)
    }
    pub(in crate::worktrees) fn managed_root_git_edge(&self) -> ManagedRootGitEdge {
        ManagedRootGitEdge::recovered(Arc::clone(&self.owner))
    }
    pub(in crate::worktrees) fn recheck(&self, cancel: &AtomicBool) -> Result<()> {
        self.owner.recheck(cancel)
    }
}
