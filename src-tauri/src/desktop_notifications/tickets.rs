//! Volatile, bounded notification decisions. No conversation or delivery ledger.
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

const LIMIT: usize = 256;
const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Pending,
    Withdrawn,
    NotDispatched,
    DispatchStarted,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Key {
    renderer: String,
    sequence: u64,
}
struct Record {
    key: Key,
    phase: Arc<Mutex<Phase>>,
}
#[derive(Default)]
struct Book {
    // Never evict a renderer watermark within this app process: an evicted
    // early-withdraw tombstone must not authorize a very late submit again.
    watermarks: HashMap<String, u64>,
    records: VecDeque<Record>,
}
#[derive(Default)]
pub(super) struct Tickets(Mutex<Book>);
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Rejection {
    Invalid,
    Duplicate,
    OutOfOrder,
    Capacity,
    Unavailable,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum WithdrawalState {
    Withdrawn,
    AlreadySubmitted,
    Unknown,
}
#[derive(Serialize)]
pub struct Withdrawal {
    state: WithdrawalState,
}
impl Withdrawal {
    fn new(state: WithdrawalState) -> Self {
        Self { state }
    }
}
#[derive(Debug)]
pub(super) struct Ticket {
    phase: Arc<Mutex<Phase>>,
}
impl Ticket {
    pub(super) fn pending(&self) -> bool {
        self.phase
            .lock()
            .is_ok_and(|phase| *phase == Phase::Pending)
    }
    /// Keep the exact withdrawal/dispatch decision locked across the actual
    /// nonblocking native API call. Starting that call is not proof of display
    /// or even acceptance, and a later withdrawal cannot make such a claim.
    pub(super) fn dispatch<T>(&self, call: impl FnOnce() -> T) -> Option<T> {
        let mut phase = self.phase.lock().ok()?;
        if *phase != Phase::Pending {
            return None;
        }
        *phase = Phase::DispatchStarted;
        Some(call())
    }
}
impl Drop for Ticket {
    fn drop(&mut self) {
        if let Ok(mut phase) = self.phase.lock()
            && *phase == Phase::Pending
        {
            *phase = Phase::NotDispatched;
        }
    }
}
fn valid(renderer: &str, sequence: u64) -> bool {
    super::diagnostic::valid_renderer(renderer) && (1..=MAX_SEQUENCE).contains(&sequence)
}
impl Book {
    fn watermark(&mut self, renderer: &str, sequence: u64) -> Result<(), Rejection> {
        if let Some(last) = self.watermarks.get_mut(renderer) {
            if sequence <= *last {
                return Err(Rejection::OutOfOrder);
            }
            *last = sequence;
            return Ok(());
        }
        if self.watermarks.len() == LIMIT {
            return Err(Rejection::Capacity);
        }
        self.watermarks.insert(renderer.to_owned(), sequence);
        Ok(())
    }
    fn make_room(&mut self) -> Result<(), Rejection> {
        while self.records.len() >= LIMIT {
            let Some(index) = self.records.iter().position(|record| {
                record
                    .phase
                    .lock()
                    .is_ok_and(|phase| *phase != Phase::Pending)
            }) else {
                return Err(Rejection::Capacity);
            };
            self.records.remove(index);
        }
        Ok(())
    }
}
impl Tickets {
    pub(super) fn claim(&self, renderer: &str, sequence: u64) -> Result<Ticket, Rejection> {
        if !valid(renderer, sequence) {
            return Err(Rejection::Invalid);
        }
        let mut book = self.0.lock().map_err(|_| Rejection::Unavailable)?;
        let key = Key {
            renderer: renderer.into(),
            sequence,
        };
        if book.records.iter().any(|record| record.key == key) {
            return Err(Rejection::Duplicate);
        }
        // Concurrent IPC can arrive out of order. An older unadmitted sequence
        // is conservatively refused; this never retires another live ticket.
        book.watermark(renderer, sequence)?;
        book.make_room()?;
        let phase = Arc::new(Mutex::new(Phase::Pending));
        book.records.push_back(Record {
            key,
            phase: phase.clone(),
        });
        Ok(Ticket { phase })
    }
    pub(super) fn withdraw(&self, renderer: &str, sequence: u64) -> Withdrawal {
        if !valid(renderer, sequence) {
            return Withdrawal::new(WithdrawalState::Unknown);
        }
        let Ok(mut book) = self.0.lock() else {
            return Withdrawal::new(WithdrawalState::Unknown);
        };
        let key = Key {
            renderer: renderer.into(),
            sequence,
        };
        if let Some(record) = book.records.iter().find(|record| record.key == key) {
            return Withdrawal::new(match record.phase.lock() {
                Ok(mut phase) => match *phase {
                    Phase::Pending => {
                        *phase = Phase::Withdrawn;
                        WithdrawalState::Withdrawn
                    }
                    Phase::Withdrawn | Phase::NotDispatched => WithdrawalState::Withdrawn,
                    Phase::DispatchStarted => WithdrawalState::AlreadySubmitted,
                },
                Err(_) => WithdrawalState::Unknown,
            });
        }
        if book.watermark(renderer, sequence).is_err() {
            // Missing old history cannot prove whether an earlier native call
            // happened. Its watermark still rejects a duplicate late submit.
            return Withdrawal::new(WithdrawalState::Unknown);
        }
        if book.make_room().is_ok() {
            book.records.push_back(Record {
                key,
                phase: Arc::new(Mutex::new(Phase::Withdrawn)),
            });
        }
        // Even with all live slots full, this fresh key was never admitted and
        // its newly retained watermark now prevents admission of a late submit.
        Withdrawal::new(WithdrawalState::Withdrawn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Barrier, mpsc};
    const RENDERER: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn early_withdrawal_blocks_late_submit_even_after_terminal_record_eviction() {
        let tickets = Tickets::default();
        assert_eq!(
            tickets.withdraw(RENDERER, 1).state,
            WithdrawalState::Withdrawn
        );
        for sequence in 2..400 {
            drop(tickets.claim(RENDERER, sequence).unwrap());
        }
        assert_eq!(
            tickets.claim(RENDERER, 1).unwrap_err(),
            Rejection::OutOfOrder
        );
        assert_eq!(
            tickets.withdraw(RENDERER, 1).state,
            WithdrawalState::Unknown
        );
    }
    #[test]
    fn high_sequence_only_rejects_unadmitted_older_ipc_not_a_live_lower_ticket() {
        let tickets = Tickets::default();
        let admitted = tickets.claim(RENDERER, 1).unwrap();
        assert_eq!(
            tickets.withdraw(RENDERER, 20).state,
            WithdrawalState::Withdrawn
        );
        assert_eq!(
            tickets.claim(RENDERER, 19).unwrap_err(),
            Rejection::OutOfOrder
        );
        assert!(admitted.pending());
        assert_eq!(admitted.dispatch(|| 7), Some(7));
        assert_eq!(
            tickets.withdraw(RENDERER, 1).state,
            WithdrawalState::AlreadySubmitted
        );
        assert!(tickets.claim(RENDERER, 21).is_ok());
    }
    #[test]
    fn exact_withdrawal_does_not_retire_another_key_or_renderer() {
        let tickets = Tickets::default();
        let first = tickets.claim(RENDERER, 1).unwrap();
        let other = tickets.claim(RENDERER, 2).unwrap();
        let renderer = "abcdef0123456789abcdef0123456789";
        let another = tickets.claim(renderer, 1).unwrap();
        assert_eq!(
            tickets.withdraw(RENDERER, 1).state,
            WithdrawalState::Withdrawn
        );
        assert!(first.dispatch(|| panic!("must not dispatch")).is_none());
        assert!(other.dispatch(|| ()).is_some());
        assert!(another.pending());
    }
    #[test]
    fn queued_owner_stays_live_after_observer_drop_until_actual_worker_finishes() {
        let tickets = Tickets::default();
        let held = tickets.claim(RENDERER, 1).unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (observer_tx, observer_rx) = mpsc::channel::<()>();
        let worker = std::thread::spawn(move || {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            assert!(held.pending());
            drop(held);
            let _ = observer_tx.send(());
        });
        entered_rx.recv().unwrap();
        drop(observer_rx);
        let held_others: Vec<_> = (2..=LIMIT as u64)
            .map(|id| tickets.claim(RENDERER, id).unwrap())
            .collect();
        assert_eq!(
            tickets.claim(RENDERER, 257).unwrap_err(),
            Rejection::Capacity
        );
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        assert!(tickets.claim(RENDERER, 258).is_ok());
        assert!(held_others.iter().all(Ticket::pending));
    }
    #[test]
    fn actual_dispatch_and_withdrawal_are_one_atomic_decision_not_a_delivery_claim() {
        let tickets = Arc::new(Tickets::default());
        let ticket = tickets.claim(RENDERER, 1).unwrap();
        let entered = Arc::new(Barrier::new(2));
        let released = Arc::new(Barrier::new(2));
        let worker_entered = entered.clone();
        let worker_released = released.clone();
        let worker = std::thread::spawn(move || {
            ticket.dispatch(|| {
                worker_entered.wait();
                worker_released.wait();
                false // Native API may reject; crossing the boundary is not display.
            })
        });
        entered.wait();
        let withdrawing = tickets.clone();
        let withdraw = std::thread::spawn(move || withdrawing.withdraw(RENDERER, 1).state);
        released.wait();
        assert_eq!(worker.join().unwrap(), Some(false));
        assert_eq!(withdraw.join().unwrap(), WithdrawalState::AlreadySubmitted);
    }
    #[test]
    fn renderer_capacity_does_not_evict_live_or_block_existing_exact_withdrawal() {
        let tickets = Tickets::default();
        let mut held = Vec::new();
        for id in 0..LIMIT {
            held.push(tickets.claim(&format!("{id:032x}"), 1).unwrap());
        }
        assert_eq!(
            tickets.claim(&format!("{:032x}", LIMIT), 1).unwrap_err(),
            Rejection::Capacity
        );
        assert_eq!(
            tickets.withdraw(&format!("{:032x}", LIMIT), 1).state,
            WithdrawalState::Unknown
        );
        assert_eq!(
            tickets.withdraw(&format!("{:032x}", 0), 1).state,
            WithdrawalState::Withdrawn
        );
        assert!(tickets.claim(&format!("{:032x}", 0), 2).is_ok());
        assert!(held.iter().skip(1).all(Ticket::pending));
    }
    #[test]
    fn invalid_keys_never_reserve_or_claim_a_dispatch() {
        let tickets = Tickets::default();
        for (renderer, sequence) in [("invalid", 1), (RENDERER, 0), (RENDERER, MAX_SEQUENCE + 1)] {
            assert_eq!(
                tickets.claim(renderer, sequence).unwrap_err(),
                Rejection::Invalid
            );
            assert_eq!(
                tickets.withdraw(renderer, sequence).state,
                WithdrawalState::Unknown
            );
        }
        assert!(tickets.0.lock().unwrap().watermarks.is_empty());
    }
    #[test]
    fn withdrawal_during_settings_wait_blocks_the_actual_dispatch_after_resume() {
        let tickets = Arc::new(Tickets::default());
        let ticket = tickets.claim(RENDERER, 1).unwrap();
        assert!(ticket.pending());
        let (resume_tx, resume_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            resume_rx.recv().unwrap();
            ticket.dispatch(|| panic!("withdrawn settings wait must not reach native submit"))
        });
        assert_eq!(
            tickets.withdraw(RENDERER, 1).state,
            WithdrawalState::Withdrawn
        );
        resume_tx.send(()).unwrap();
        assert!(worker.join().unwrap().is_none());
    }
    #[test]
    fn observer_drop_does_not_prevent_withdrawing_the_queued_execution_owner() {
        let tickets = Tickets::default();
        let ticket = tickets.claim(RENDERER, 1).unwrap();
        let (tx, observer) = mpsc::channel::<bool>();
        let queued = move || {
            let result = ticket.dispatch(|| panic!("late queue must honor withdrawal"));
            let _ = tx.send(result.is_some());
        };
        drop(observer);
        assert_eq!(
            tickets.withdraw(RENDERER, 1).state,
            WithdrawalState::Withdrawn
        );
        queued();
        assert_eq!(
            tickets.withdraw(RENDERER, 1).state,
            WithdrawalState::Withdrawn
        );
    }
    #[test]
    fn synchronous_native_observation_and_reply_do_not_reenter_ticket_lock() {
        use super::super::diagnostic::{AddResult, DiagnosticStore};
        let tickets = Tickets::default();
        let ticket = tickets.claim(RENDERER, 1).unwrap();
        let diagnostic = DiagnosticStore::default();
        let attempt = diagnostic.begin(RENDERER, 1);
        let (reply, receive) = mpsc::channel();
        drop(receive); // Observer timeout before synchronous platform callback.
        assert_eq!(
            ticket.dispatch(|| {
                diagnostic.update(&attempt, |d| {
                    d.native_event(0, true, true, true, false, 0, 0)
                });
                diagnostic.update(&attempt, |d| {
                    d.native_event(1, false, false, false, false, 0, 0)
                });
                let _ = reply.send(true);
                true
            }),
            Some(true)
        );
        assert_eq!(
            tickets.withdraw(RENDERER, 1).state,
            WithdrawalState::AlreadySubmitted
        );
        diagnostic.update(&attempt, |d| d.unconfirmed());
        assert_eq!(
            diagnostic.for_attempt(RENDERER, 1).unwrap().add_result,
            AddResult::Accepted
        );
        drop(ticket);
        assert_eq!(
            tickets.withdraw(RENDERER, 1).state,
            WithdrawalState::AlreadySubmitted
        );
    }
}
