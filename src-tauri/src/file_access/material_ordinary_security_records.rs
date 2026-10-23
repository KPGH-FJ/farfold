//! Explicit readable security facets; never a complete SACL or full SD claim.
use super::{
    ea_records::WorkBudget,
    integrity_records,
    material_carrier_records::{
        BLOCK, Error, Resident, ResidentLease, Result, charge, check, record,
    },
    security_records,
};
use sha2::{Digest, Sha256};
use std::sync::atomic::AtomicBool;

const MAGIC: &[u8; 8] = b"FFORDS1\0";
const HEADER: usize = 16;
pub(super) const MAX_BYTES: usize = HEADER + 2 * BLOCK;
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Summary {
    pub bytes: u64,
    pub sha256: [u8; 32],
    pub dacl_aces: u64,
    pub dacl_sha256: [u8; 32],
    pub labels: u64,
    pub label_sha256: [u8; 32],
}
impl Summary {
    pub(super) fn same_facets(&self, other: &Self) -> bool {
        self.dacl_aces == other.dacl_aces
            && self.dacl_sha256 == other.dacl_sha256
            && self.labels == other.labels
            && self.label_sha256 == other.label_sha256
    }
    pub(super) fn bind_payload(&self, payload: [u8; 32]) -> [u8; 32] {
        let mut hash = Sha256::new();
        hash.update(b"FFORDINARYSEM1");
        hash.update(payload);
        hash.update(self.dacl_sha256);
        hash.update(self.label_sha256);
        hash.finalize().into()
    }
}
pub(super) struct Decoded<'a> {
    pub owner_group_dacl: &'a [u8],
    pub label: &'a [u8],
    pub summary: Summary,
}
pub(super) struct Owned {
    pub bytes: Vec<u8>,
    pub summary: Summary,
    _memory: ResidentLease,
}
pub(super) fn decode<'a>(
    bytes: &'a [u8],
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<Decoded<'a>> {
    check(cancel)?;
    charge(work, bytes.len())?;
    if bytes.len() < HEADER || bytes.len() > MAX_BYTES || &bytes[..8] != MAGIC {
        return Err(Error::Invalid);
    }
    let d = u32::from_le_bytes(bytes[8..12].try_into().expect("fixed")) as usize;
    let l = u32::from_le_bytes(bytes[12..16].try_into().expect("fixed")) as usize;
    if !(20..=BLOCK).contains(&d)
        || !(20..=BLOCK).contains(&l)
        || HEADER.checked_add(d).and_then(|n| n.checked_add(l)) != Some(bytes.len())
    {
        return Err(Error::Invalid);
    }
    let owner_group_dacl = &bytes[HEADER..HEADER + d];
    let label = &bytes[HEADER + d..];
    let acl = security_records::complete(owner_group_dacl, work, cancel).map_err(record)?;
    let integrity = integrity_records::complete(label, work, cancel).map_err(record)?;
    Ok(Decoded {
        owner_group_dacl,
        label,
        summary: Summary {
            bytes: bytes.len() as u64,
            sha256: Sha256::digest(bytes).into(),
            dacl_aces: acl.aces,
            dacl_sha256: acl.sha256,
            labels: integrity.labels,
            label_sha256: integrity.sha256,
        },
    })
}
pub(super) fn encode(
    owner_group_dacl: &[u8],
    label: &[u8],
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
) -> Result<Owned> {
    let length = HEADER
        .checked_add(owner_group_dacl.len())
        .and_then(|n| n.checked_add(label.len()))
        .ok_or(Error::Limit)?;
    if length > MAX_BYTES {
        return Err(Error::Limit);
    }
    let memory = resident.lease(length)?;
    check(cancel)?;
    charge(work, length)?;
    let mut bytes = Vec::with_capacity(length);
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&(owner_group_dacl.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&(label.len() as u32).to_le_bytes());
    bytes.extend_from_slice(owner_group_dacl);
    bytes.extend_from_slice(label);
    let summary = decode(&bytes, work, cancel)?.summary;
    Ok(Owned {
        bytes,
        summary,
        _memory: memory,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn descriptor(control: u16) -> Vec<u8> {
        let mut raw = vec![0; 20];
        raw[0] = 1;
        raw[2..4].copy_from_slice(&control.to_le_bytes());
        raw
    }
    #[test]
    fn ordinary_facets_roundtrip_binds_payload_and_keeps_absent_null_distinct() {
        let cancel = AtomicBool::new(false);
        let resident = Resident::new(1024);
        let mut work = WorkBudget::new(1_000_000);
        let absent = encode(
            &descriptor(0x8000),
            &descriptor(0x8000),
            &mut work,
            &cancel,
            &resident,
        )
        .unwrap();
        let null = encode(
            &descriptor(0x8004),
            &descriptor(0x8000),
            &mut work,
            &cancel,
            &resident,
        )
        .unwrap();
        let decoded = decode(&null.bytes, &mut work, &cancel).unwrap();
        assert_eq!(decoded.owner_group_dacl, descriptor(0x8004));
        assert_eq!(decoded.label, descriptor(0x8000));
        assert_eq!(decoded.summary, null.summary);
        assert!(!absent.summary.same_facets(&null.summary));
        assert_ne!(
            null.summary.bind_payload([0; 32]),
            null.summary.bind_payload([1; 32])
        );
    }
    #[test]
    fn ordinary_facets_reject_truncated_unknown_privileged_or_oversized_sections() {
        let cancel = AtomicBool::new(false);
        let resident = Resident::new(MAX_BYTES * 2);
        let mut work = WorkBudget::new(10_000_000);
        let owned = encode(
            &descriptor(0x8004),
            &descriptor(0x8000),
            &mut work,
            &cancel,
            &resident,
        )
        .unwrap();
        for length in 0..owned.bytes.len() {
            assert!(decode(&owned.bytes[..length], &mut work, &cancel).is_err());
        }
        let mut wrong = owned.bytes.clone();
        wrong[0] ^= 1;
        assert!(decode(&wrong, &mut work, &cancel).is_err());
        wrong = owned.bytes.clone();
        wrong[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(decode(&wrong, &mut work, &cancel).is_err());
        let mut unexpected = descriptor(0x8000);
        unexpected[4..8].copy_from_slice(&20u32.to_le_bytes());
        unexpected.extend([1, 0, 0, 0, 0, 0, 0, 0]);
        assert!(
            encode(
                &descriptor(0x8004),
                &unexpected,
                &mut work,
                &cancel,
                &resident
            )
            .is_err()
        );
    }
    #[test]
    fn ordinary_facets_charge_before_allocation_and_observe_cancel() {
        let d = descriptor(0x8004);
        let l = descriptor(0x8000);
        assert!(matches!(
            encode(
                &d,
                &l,
                &mut WorkBudget::new(1000),
                &AtomicBool::new(false),
                &Resident::new(55)
            ),
            Err(Error::Limit)
        ));
        assert!(matches!(
            encode(
                &d,
                &l,
                &mut WorkBudget::new(0),
                &AtomicBool::new(false),
                &Resident::new(1024)
            ),
            Err(Error::Limit)
        ));
        assert!(matches!(
            encode(
                &d,
                &l,
                &mut WorkBudget::new(1000),
                &AtomicBool::new(true),
                &Resident::new(1024)
            ),
            Err(Error::Cancelled)
        ));
    }
}
