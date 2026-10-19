//! Logical request charge; no serialized prompt/body allocation.
use super::history_admission::{Charge, Failure, Owner};
use agent_client_protocol::schema::v1::ContentBlock;
use serde_json::Value;
use std::io::Write;

// The queue owns the final blocks, never both the old input Value and blocks.
// `_meta` and future typed wire fields are included by their actual Serialize.
// This is not a Tauri-deserialization, SDK-buffer, stack, allocator or RSS cap.
pub(super) fn whole_request(
    owner: &Owner,
    blocks: &[ContentBlock],
    expected_current: &Value,
    target_labels: [&str; 3], // canonical cwd, exact session and connection IDs
    coordination_bytes: usize, // server-only sum of actual retained type sizes
    limit: usize,
) -> Result<usize, Failure> {
    let mut charge = Charge::new(limit);
    owner.charge(&mut charge)?;
    owner.charge(&mut charge)?; // progress/cancel coordination labels; no body copy
    // The caller supplies size_of sums for its actual Request/Waiting/Grant,
    // observation/escrow resource and fixed channel handles. No wire argument
    // can select this value. Dynamic blocks/config/labels are charged below.
    // This is a logical accounting domain, not total allocated memory.
    if coordination_bytes == 0 {
        return Err(Failure::Invalid);
    }
    charge.add(coordination_bytes)?;
    for _ in 0..3 {
        for label in target_labels {
            charge.text(label)?;
        }
    }
    charge.add(
        blocks
            .len()
            .checked_mul(std::mem::size_of::<ContentBlock>())
            .ok_or(Failure::Payload)?,
    )?;
    charge.json(expected_current)?;
    struct Counter<'a>(&'a mut Charge);
    impl Write for Counter<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0
                .add(bytes.len())
                .map_err(|_| std::io::Error::other("payload"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(Counter(&mut charge), blocks).map_err(|_| Failure::Payload)?;
    Ok(charge.finish())
}
