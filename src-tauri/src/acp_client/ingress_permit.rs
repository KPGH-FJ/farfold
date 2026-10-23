//! One finite line at a time through the official SDK parser.
//! Wrap existing ByteStreams stdout; keep its official Lines parser/output actor.
//! This bounds the exposed SDK ingress queue, not pending dispatch or UI/history.
use agent_client_protocol::TransportFrame;
use futures_lite::io::AsyncRead;
use std::{
    future::Future,
    io,
    pin::Pin,
    sync::{Arc, Mutex, Weak},
    task::{Context, Poll, Waker},
};

#[derive(Clone, Copy, Debug)]
pub(super) struct QueueSnapshot {
    pub(super) queued: usize,
    pub(super) closed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    Reading,
    Offered { final_line: bool },
    Forwarding { final_line: bool },
    Eof,
    Failed,
}

#[derive(Clone, Copy, Default, Debug)]
pub(super) struct Counts {
    pub(super) started: u64,
    pub(super) offered: u64,
    pub(super) forwarded: u64,
    pub(super) empty_eof: u64,
    pub(super) failed: u64,
}

struct State {
    phase: Phase,
    waiter: Option<Waker>,
    queue_blocked: bool,
    counts: Counts,
}
struct Shared {
    cap: usize,
    pressure: Vec<super::transient_pressure::Admission>,
    queue: Box<dyn Fn() -> QueueSnapshot + Send + Sync>,
    state: Mutex<State>,
}
#[derive(Clone)]
pub(super) struct Gate(Arc<Shared>);

/// Holds no Channel sender itself. Installation is once per original connection.
/// The observer must surround the complete Client.connect_with future, not the
/// ready Channel future returned inside the current ProcessTransport adapter.
#[derive(Clone, Default)]
pub(super) struct ConsumerProbe(Arc<Mutex<Option<Weak<Shared>>>>);
impl ConsumerProbe {
    pub(super) fn install(&self, gate: &Gate) -> io::Result<()> {
        let mut current = self.0.lock().map_err(|_| unavailable())?;
        if current.is_some() {
            return Err(io::Error::other("ingress probe already installed"));
        }
        *current = Some(Arc::downgrade(&gate.0));
        Ok(())
    }
    fn after_poll(&self) {
        let gate = self
            .0
            .lock()
            .ok()
            .and_then(|value| value.as_ref().and_then(Weak::upgrade));
        if let Some(gate) = gate {
            Gate(gate).observe_actual_queue();
        }
    }
    pub(super) fn observe<F: Future>(self, future: F) -> Observed<F> {
        Observed {
            future: Box::pin(future),
            probe: self,
        }
    }
}
pub(super) struct Observed<F: Future> {
    future: Pin<Box<F>>,
    probe: ConsumerProbe,
}
impl<F: Future> Future for Observed<F> {
    type Output = F::Output;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let result = self.future.as_mut().poll(cx);
        // This observes queue ownership only, never SDK dispatch completion.
        self.probe.after_poll();
        result
    }
}

fn unavailable() -> io::Error {
    io::Error::other("ingress permit state unavailable")
}
fn remember(waiter: &mut Option<Waker>, cx: &Context<'_>) {
    if !waiter.as_ref().is_some_and(|old| old.will_wake(cx.waker())) {
        *waiter = Some(cx.waker().clone());
    }
}
impl Gate {
    pub(super) fn new(
        cap: usize,
        actual_queue: impl Fn() -> QueueSnapshot + Send + Sync + 'static,
        unclaimed: Arc<super::transient_pressure::Budget>,
    ) -> io::Result<Self> {
        Self::with_budgets(
            cap,
            actual_queue,
            vec![super::transient_pressure::Budget::shared(), unclaimed],
        )
    }
    #[cfg(test)]
    pub(super) fn with_budget(
        cap: usize,
        actual_queue: impl Fn() -> QueueSnapshot + Send + Sync + 'static,
        budget: Arc<super::transient_pressure::Budget>,
    ) -> io::Result<Self> {
        Self::with_budgets(cap, actual_queue, vec![budget])
    }
    fn with_budgets(
        cap: usize,
        actual_queue: impl Fn() -> QueueSnapshot + Send + Sync + 'static,
        budgets: Vec<Arc<super::transient_pressure::Budget>>,
    ) -> io::Result<Self> {
        if cap == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "zero queue cap",
            ));
        }
        Ok(Self(Arc::new(Shared {
            cap,
            pressure: budgets.iter().map(|budget| budget.watch()).collect(),
            queue: Box::new(actual_queue),
            state: Mutex::new(State {
                phase: Phase::Idle,
                waiter: None,
                queue_blocked: false,
                counts: Counts::default(),
            }),
        })))
    }
    #[cfg(test)]
    pub(super) fn counts(&self) -> io::Result<Counts> {
        Ok(self.0.state.lock().map_err(|_| unavailable())?.counts)
    }
    fn begin(&self, cx: &mut Context<'_>) -> Poll<io::Result<bool>> {
        let mut state = match self.0.state.lock() {
            Ok(value) => value,
            Err(_) => return Poll::Ready(Err(unavailable())),
        };
        match state.phase {
            Phase::Eof => Poll::Ready(Ok(false)),
            Phase::Failed => Poll::Ready(Err(io::Error::other("ingress already failed"))),
            Phase::Reading => Poll::Ready(Ok(true)),
            Phase::Offered { .. } | Phase::Forwarding { .. } => {
                remember(&mut state.waiter, cx);
                Poll::Pending
            }
            Phase::Idle => {
                // Register before checking. after_poll takes this same lock,
                // avoiding a lost wake if the actual receiver just dequeued.
                remember(&mut state.waiter, cx);
                let snapshot = (self.0.queue)();
                state.queue_blocked = snapshot.queued >= self.0.cap;
                if snapshot.closed {
                    state.phase = Phase::Failed;
                    state.counts.failed = state.counts.failed.saturating_add(1);
                    Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "original SDK ingress receiver closed",
                    )))
                } else if snapshot.queued < self.0.cap
                    && self.0.pressure.iter().all(|budget| budget.ready(cx))
                {
                    // The only producer reserves this slot BEFORE any line
                    // bytes are exposed. Consumer activity can only free slots.
                    state.waiter = None;
                    state.phase = Phase::Reading;
                    state.counts.started = state.counts.started.saturating_add(1);
                    Poll::Ready(Ok(true))
                } else {
                    Poll::Pending
                }
            }
        }
    }
    fn offer(&self, final_line: bool) -> io::Result<()> {
        let mut state = self.0.state.lock().map_err(|_| unavailable())?;
        if state.phase != Phase::Reading {
            return Err(io::Error::other("line offer without original permit"));
        }
        state.phase = Phase::Offered { final_line };
        state.counts.offered = state.counts.offered.saturating_add(1);
        Ok(())
    }
    fn empty_eof(&self) -> io::Result<()> {
        let mut state = self.0.state.lock().map_err(|_| unavailable())?;
        if state.phase != Phase::Reading {
            return Err(io::Error::other("EOF without original read permit"));
        }
        state.phase = Phase::Eof;
        state.counts.empty_eof = state.counts.empty_eof.saturating_add(1);
        Ok(())
    }
    pub(super) fn abort(&self) {
        let wake = if let Ok(mut state) = self.0.state.lock() {
            if state.phase != Phase::Failed {
                state.phase = Phase::Failed;
                state.counts.failed = state.counts.failed.saturating_add(1);
            }
            state.waiter.take()
        } else {
            None
        };
        if let Some(wake) = wake {
            wake.wake();
        }
    }
    fn observe_actual_queue(&self) {
        let wake = if let Ok(mut state) = self.0.state.lock() {
            if state.phase == Phase::Idle && state.queue_blocked && state.waiter.is_some() {
                let snapshot = (self.0.queue)();
                (snapshot.closed || snapshot.queued < self.0.cap)
                    .then(|| state.waiter.take())
                    .flatten()
            } else {
                None
            }
        } else {
            None
        };
        if let Some(wake) = wake {
            wake.wake();
        }
    }

    /// Call once for the ACTUAL original frame received from official wire.rx.
    /// Not once per inspect_messages callback: a malformed frame may have none.
    /// The send closure must be the sole producer of the measured SDK queue.
    /// Failed sends return the unchanged owned frame rather than discard it.
    pub(super) fn forward(
        &self,
        frame: TransportFrame,
        send: impl FnOnce(TransportFrame) -> Result<(), Box<TransportFrame>>,
    ) -> Result<Forwarded, RejectedFrame> {
        let final_line = {
            let mut state = match self.0.state.lock() {
                Ok(value) => value,
                Err(_) => return Err(RejectedFrame::new(frame, "permit state unavailable")),
            };
            let Phase::Offered { final_line } = state.phase else {
                return Err(RejectedFrame::new(frame, "frame without offered line"));
            };
            let snapshot = (self.0.queue)();
            if snapshot.closed || snapshot.queued >= self.0.cap {
                state.phase = Phase::Failed;
                state.counts.failed = state.counts.failed.saturating_add(1);
                return Err(RejectedFrame::new(
                    frame,
                    "reserved ingress slot unavailable",
                ));
            }
            state.phase = Phase::Forwarding { final_line };
            final_line
        };
        // No application callback or Channel send runs under the permit lock.
        if let Err(frame) = send(frame) {
            self.abort();
            return Err(RejectedFrame::from_box(
                frame,
                "original receiver rejected frame",
            ));
        }
        let (wake, outcome) = {
            let mut state = match self.0.state.lock() {
                Ok(value) => value,
                Err(_) => {
                    // The frame was transferred. Do not return a fake owned
                    // copy or pretend the transfer can be retried.
                    return Ok(Forwarded::TransferredAccountingUnknown);
                }
            };
            let outcome = if state.phase != (Phase::Forwarding { final_line }) {
                state.phase = Phase::Failed;
                state.counts.failed = state.counts.failed.saturating_add(1);
                Forwarded::TransferredAccountingUnknown
            } else {
                state.counts.forwarded = state.counts.forwarded.saturating_add(1);
                state.phase = if final_line { Phase::Eof } else { Phase::Idle };
                Forwarded::Transferred
            };
            (state.waiter.take(), outcome)
        };
        if let Some(wake) = wake {
            wake.wake();
        }
        Ok(outcome)
    }

    /// Inspect only AFTER the physical official transport result is known.
    /// The transport's original I/O/UTF-8 error must remain authoritative.
    pub(super) fn clean_wire_eof(&self) -> io::Result<bool> {
        let state = self.0.state.lock().map_err(|_| unavailable())?;
        Ok(state.phase == Phase::Eof && state.counts.offered == state.counts.forwarded)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Forwarded {
    Transferred,
    // The Channel owns the frame. Never retry it, return its slot, or report a
    // clean transfer after local accounting became unavailable.
    TransferredAccountingUnknown,
}
#[derive(Debug)]
pub(super) struct RejectedFrame {
    pub(super) frame: Box<TransportFrame>,
    pub(super) reason: &'static str,
}
impl RejectedFrame {
    fn new(frame: TransportFrame, reason: &'static str) -> Self {
        Self::from_box(Box::new(frame), reason)
    }
    fn from_box(frame: Box<TransportFrame>, reason: &'static str) -> Self {
        Self { frame, reason }
    }
}

/// Fixed prefetch is charged separately from SDK's currently assembled line.
/// Only bytes through ONE newline are exposed, so ByteStreams' own BufReader
/// cannot parse a second buffered line without asking this owner again.
pub(super) struct PermittedRead<R> {
    source: Pin<Box<R>>,
    gate: Gate,
    buffer: [u8; 4096],
    position: usize,
    end: usize,
    line_has_bytes: bool,
}
impl<R> PermittedRead<R> {
    pub(super) fn new(source: R, gate: Gate) -> Self {
        Self {
            source: Box::pin(source),
            gate,
            buffer: [0; 4096],
            position: 0,
            end: 0,
            line_has_bytes: false,
        }
    }
}
impl<R: AsyncRead> AsyncRead for PermittedRead<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        if out.is_empty() {
            return Poll::Ready(Ok(0));
        }
        let this = self.as_mut().get_mut();
        match this.gate.begin(cx) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
            Poll::Ready(Ok(false)) => return Poll::Ready(Ok(0)),
            Poll::Ready(Ok(true)) => {}
        }
        if this.position == this.end {
            match this.source.as_mut().poll_read(cx, &mut this.buffer) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(error)) => {
                    this.gate.abort();
                    return Poll::Ready(Err(error));
                }
                Poll::Ready(Ok(0)) => {
                    let result = if this.line_has_bytes {
                        // Official Lines returns the final unterminated line
                        // before EOF; this still owns exactly one frame permit.
                        this.gate.offer(true)
                    } else {
                        this.gate.empty_eof()
                    };
                    this.line_has_bytes = false;
                    return Poll::Ready(result.map(|()| 0));
                }
                Poll::Ready(Ok(count)) => {
                    this.position = 0;
                    this.end = count;
                }
            }
        }
        let available = &this.buffer[this.position..this.end];
        let through_newline = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1);
        let count = out.len().min(through_newline.unwrap_or(available.len()));
        out[..count].copy_from_slice(&available[..count]);
        this.position += count;
        this.line_has_bytes = true;
        if through_newline == Some(count) {
            // Set the offer BEFORE returning its last bytes to the SDK.
            if let Err(error) = this.gate.offer(false) {
                this.gate.abort();
                return Poll::Ready(Err(error));
            }
            this.line_has_bytes = false;
        }
        Poll::Ready(Ok(count))
    }
}

#[cfg(test)]
#[path = "ingress_permit_tests.rs"]
mod tests;
