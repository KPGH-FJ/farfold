//! Each helper has its own protocol, request IDs and output acknowledgements.
//! Only the page authority and retirement barrier belong to the conversation.
use super::*;
use std::collections::BTreeMap;

// Preserve the exact old scope until ToolSession::tool_closed records the
// unresolved retirement. Taking it here would misreport unknown output as closed.
fn invalidate_page(page: &SharedPage) {
    if let Some(scope) = page.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        scope.revoke();
    }
}

pub(super) type Incoming = Box<dyn FnMut(&Gate) -> Result<Option<Stream>, ()> + Send>;
#[derive(Clone)]
pub(super) struct Callbacks {
    pub(super) ready: Callback,
    pub(super) closed: Closed,
    pub(super) permission: Permission,
    pub(super) invalidated: Invalidated,
}
struct Channel {
    controls: mpsc::Sender<Control>,
    shutdown: Arc<AtomicBool>,
    done: mpsc::Receiver<bool>,
    result: Option<bool>,
}
struct Retirement {
    epoch: u64,
    replies: Vec<(u64, oneshot::Receiver<Result<(), String>>)>,
    answer: Option<oneshot::Sender<Result<(), String>>>,
    deadline: Instant,
}
pub(super) struct Hub {
    pub(super) execution: Execution,
    pub(super) page: SharedPage,
    pub(super) callbacks: Callbacks,
    pub(super) gate: Arc<Gate>,
    pub(super) shutdown: Arc<AtomicBool>,
    pub(super) controls: mpsc::Receiver<Control>,
    pub(super) live: CallbackLive,
    pub(super) incoming: Incoming,
}
pub(super) type CallbackLive = Arc<dyn Fn() -> bool + Send + Sync>;
impl Hub {
    fn attach(&self, id: u64, stream: Stream) -> Result<Channel, ()> {
        stream.set_nonblocking(true).map_err(|_| ())?;
        let (controls, receive) = mpsc::channel();
        let shutdown = Arc::new(AtomicBool::new(false));
        let (send, done) = mpsc::channel();
        let lease = ChannelLease {
            id,
            gate: self.gate.clone(),
            live: self.live.clone(),
        };
        let ready = self.callbacks.ready.clone();
        let gate = self.gate.clone();
        let live = self.live.clone();
        let mut worker = Worker {
            execution: self.execution.clone(),
            page: self.page.clone(),
            shutdown: shutdown.clone(),
            controls: receive,
            on_ready: Arc::new(move || {
                if gate.available() && live() {
                    ready();
                }
            }),
            on_initialized: None,
            // Per-helper EOF must not retire the conversation owner.
            on_closed: Arc::new(|_| {}),
            on_permission: self.callbacks.permission.clone(),
            on_invalidated: self.callbacks.invalidated.clone(),
            closed_notified: false,
        };
        std::thread::Builder::new()
            .name("farfold-page-channel".into())
            .spawn(move || {
                let clean = worker.serve_channel(stream, Some(&lease));
                lease.finished(clean);
                let _ = send.send(clean);
            })
            .map_err(|_| ())?;
        Ok(Channel {
            controls,
            shutdown,
            done,
            result: None,
        })
    }
    fn retirement(
        &self,
        epoch: u64,
        answer: Option<oneshot::Sender<Result<(), String>>>,
        channels: &BTreeMap<u64, Channel>,
    ) -> Retirement {
        let mut replies = Vec::new();
        for (id, channel) in channels {
            if channel.result == Some(true) {
                continue;
            }
            let (send, receive) = oneshot::channel();
            // A disconnected control route is resolved only by that channel's
            // actual completion, never by another helper's stop ACK.
            let _ = channel.controls.send(Control::Quiesce(Some(send)));
            replies.push((*id, receive));
        }
        Retirement {
            epoch,
            replies,
            answer,
            deadline: Instant::now() + Duration::from_millis(2800),
        }
    }
    pub(super) fn run(mut self) -> bool {
        let mut channels: BTreeMap<u64, Channel> = BTreeMap::new();
        let mut retirements: Vec<Retirement> = Vec::new();
        let mut serial = 0u64;
        let mut ending = None;
        loop {
            for channel in channels.values_mut().filter(|c| c.result.is_none()) {
                match channel.done.try_recv() {
                    Ok(clean) => channel.result = Some(clean),
                    Err(mpsc::TryRecvError::Disconnected) => channel.result = Some(false),
                    Err(mpsc::TryRecvError::Empty) => {}
                }
                if channel.result == Some(false) {
                    self.gate.poison();
                }
            }
            while let Ok(control) = self.controls.try_recv() {
                let (epoch, answer) = match control {
                    Control::MultiQuiesce(epoch, answer) => (epoch, Some(answer)),
                    Control::Quiesce(answer) => (self.gate.retire(), answer),
                };
                invalidate_page(&self.page);
                retirements.push(self.retirement(epoch, answer, &channels));
            }
            retirements.retain_mut(|retirement| {
                let mut failed = self.gate.unknown();
                retirement
                    .replies
                    .retain_mut(|(id, reply)| match reply.try_recv() {
                        Ok(Ok(())) => false,
                        Ok(Err(_)) => {
                            failed = true;
                            false
                        }
                        Err(oneshot::error::TryRecvError::Closed) => {
                            match channels.get(id).and_then(|c| c.result) {
                                Some(true) => false,
                                Some(false) => {
                                    failed = true;
                                    false
                                }
                                None => true,
                            }
                        }
                        Err(oneshot::error::TryRecvError::Empty) => true,
                    });
                if !retirement.replies.is_empty() && Instant::now() >= retirement.deadline {
                    failed = true;
                }
                if failed || retirement.replies.is_empty() {
                    if failed {
                        self.gate.poison();
                    }
                    let clean = !failed && self.gate.settle(retirement.epoch);
                    if let Some(answer) = retirement.answer.take() {
                        let _ = answer.send(if clean {
                            Ok(())
                        } else {
                            Err("停止共享尚未确认，请重试".into())
                        });
                    }
                    false
                } else {
                    true
                }
            });
            // Keep a completed channel only while a barrier still needs its
            // exact completion witness. This is runtime state, not a ledger.
            channels.retain(|id, c| {
                c.result.is_none()
                    || retirements
                        .iter()
                        .any(|r| r.replies.iter().any(|(waiting, _)| waiting == id))
            });
            if self.shutdown.load(Ordering::Acquire) || !(self.live)() || self.gate.unknown() {
                self.gate.close();
                invalidate_page(&self.page);
                let deadline =
                    ending.get_or_insert_with(|| Instant::now() + Duration::from_secs(3));
                for channel in channels.values() {
                    channel.shutdown.store(true, Ordering::Release);
                }
                if channels.is_empty() {
                    return !self.gate.unknown();
                }
                if Instant::now() >= *deadline {
                    self.gate.poison();
                    return false;
                }
            }
            if ending.is_none() && channels.len() < 32 && self.gate.available() {
                match (self.incoming)(&self.gate) {
                    Ok(Some(stream)) if self.gate.available() && (self.live)() => {
                        let Some(id) = serial.checked_add(1) else {
                            self.gate.poison();
                            continue;
                        };
                        serial = id;
                        match self.attach(id, stream) {
                            Ok(channel) => {
                                channels.insert(id, channel);
                            }
                            Err(()) => self.gate.poison(),
                        }
                    }
                    Ok(_) => {}
                    Err(()) => self.gate.poison(),
                }
            } else {
                // Bounded control polling while admission is closed. This does
                // not block helper workers or native browser execution.
                std::thread::park_timeout(Duration::from_millis(10));
            }
        }
    }
}
