//! An absent child of an identity-held parent, never an existing target adopted
//! as delete authority. FILE_CREATE grants ownership of every restored object.
use super::*;
use crate::file_access::material_raw_name;

pub(crate) struct MaterialTargetRequest {
    parent: PinnedPath,
    leaf: Vec<u16>,
    _memory: ResidentLease,
}
impl MaterialTargetRequest {
    pub(crate) fn new(
        parent: &Path,
        parent_id: &Identity,
        leaf: Vec<u16>,
        memory: &MixedMemory,
    ) -> Result<Self> {
        material_raw_name::check(&leaf).map_err(|_| Error::Unsupported)?;
        if parent.as_os_str().len() > 4096 || leaf.len() > 255 || parent_id.inode == 0 {
            return Err(Error::Invalid);
        }
        let reserved = memory.shared().lease(8 * records::BLOCK)?;
        let parent = PinnedPath::directory(parent).map_err(|e| io_error("restoreParent", e))?;
        if parent.identity() != parent_id {
            return Err(Error::Changed);
        }
        let value = Self {
            parent,
            leaf,
            _memory: reserved,
        };
        value.verify()?;
        Ok(value)
    }
    pub(super) fn require_pool(&mut self, resident: &Resident) -> Result<()> {
        resident.grow(&mut self._memory, 0)
    }
    pub(super) fn verify(&self) -> Result<()> {
        self.parent
            .verify()
            .map_err(|e| io_error("restoreParentVerify", e))?;
        let mut fs = [0u16; 32];
        if unsafe {
            GetVolumeInformationByHandleW(
                handle(self.parent.file()),
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                fs.as_mut_ptr(),
                fs.len() as u32,
            )
        } == 0
        {
            return Err(io_error("restoreTargetVolume", io::Error::last_os_error()));
        }
        if fs[..5] != [78, 84, 70, 83, 0] {
            return Err(Error::Unsupported);
        }
        Ok(())
    }
    pub(super) fn parent(&self) -> &File {
        self.parent.file()
    }
    pub(super) fn leaf(&self) -> &[u16] {
        &self.leaf
    }
}
