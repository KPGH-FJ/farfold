//! An ephemeral graph view used before the material carrier has an identity.
//! This is not serialized and does not authorize deletion or target publication.
use super::*;
#[derive(Clone)]
pub(super) struct Graph {
    pub roots: Roots,
    pub objects: Vec<String>,
}
pub(super) trait GraphSource {
    fn graph(&self) -> Result<Graph>;
}
impl Graph {
    pub(super) fn validate(&self) -> Result<()> {
        let width = match self.roots.format.as_str() {
            "sha1" => 40,
            "sha256" => 64,
            _ => return Err(error("recoveryInvalid")),
        };
        if self.roots.head.len() != width
            || !oid(&self.roots.head)
            || self.roots.commits.is_empty()
            || self.roots.commits.len() > recovery_roots::MAX_ROOTS
            || !self.roots.commits.contains(&self.roots.head)
            || self.objects.len() > MAX_OBJECTS
            || !self
                .roots
                .commits
                .iter()
                .chain(&self.objects)
                .all(|v| oid(v) && v.len() == width)
        {
            return Err(error("recoveryInvalid"));
        }
        Ok(())
    }
    pub(super) fn refs(&self) -> Vec<(String, String)> {
        self.roots
            .commits
            .iter()
            .enumerate()
            .map(|(i, oid)| (oid.clone(), format!("refs/heads/recovery/root-{i:04}")))
            .collect()
    }
    pub(super) fn branch(&self) -> Result<String> {
        self.refs()
            .into_iter()
            .find(|(oid, _)| oid == &self.roots.head)
            .map(|(_, name)| name)
            .ok_or(error("recoveryInvalid"))
    }
}
impl GraphSource for Manifest {
    fn graph(&self) -> Result<Graph> {
        validate(self)?;
        let graph = Graph {
            roots: self.roots.clone(),
            objects: self.objects.clone(),
        };
        graph.validate()?;
        Ok(graph)
    }
}
impl GraphSource for Capture {
    fn graph(&self) -> Result<Graph> {
        let graph = Graph {
            roots: self.roots.clone(),
            objects: self.objects.clone(),
        };
        graph.validate()?;
        Ok(graph)
    }
}
impl GraphSource for Graph {
    fn graph(&self) -> Result<Graph> {
        self.validate()?;
        Ok(self.clone())
    }
}
