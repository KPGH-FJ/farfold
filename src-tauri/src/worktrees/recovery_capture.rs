//! Operation-local comparison baseline. The persistent representation remains
//! the unique Manifest; a carrier's own identity is not source-material identity.
use super::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::worktrees) struct Capture {
    pub(in crate::worktrees) roots: Roots,
    pub(in crate::worktrees) objects: Vec<String>,
    pub(in crate::worktrees) content: MaterialSummary,
    pub(in crate::worktrees) configs: Vec<String>,
    pub(in crate::worktrees) attributes: Vec<u8>,
}
impl Capture {
    pub(in crate::worktrees) fn matches(&self, manifest: &Manifest) -> bool {
        self.roots == manifest.roots
            && self.objects == manifest.objects
            && self.content == manifest.content
            && self.configs == manifest.configs
            && self.attributes == manifest.attributes
    }
    pub(in crate::worktrees) fn manifest(
        &self,
        material: Option<material_manifest::WindowsMaterial>,
    ) -> Result<Manifest> {
        let manifest = Manifest {
            version: if material.is_some() { 2 } else { 1 },
            roots: self.roots.clone(),
            objects: self.objects.clone(),
            content: self.content.clone(),
            configs: self.configs.clone(),
            attributes: self.attributes.clone(),
            windows_material: material,
        };
        validate(&manifest)?;
        Ok(manifest)
    }
}
