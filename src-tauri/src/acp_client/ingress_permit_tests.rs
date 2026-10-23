use super::{ConsumerProbe, Forwarded, Gate, PermittedRead, QueueSnapshot};
use agent_client_protocol::{ByteStreams, Channel, Client, ConnectTo, TransportFrame};
use futures_lite::{Stream, io};
use std::{
    future::{Future, poll_fn},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll, Wake, Waker},
};

#[derive(Default)]
struct Wakes(AtomicUsize);
impl Wake for Wakes {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
    fn wake_by_ref(self: &Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
struct Harness {
    gate: Gate,
    probe: ConsumerProbe,
    wire: Channel,
    destination: Channel,
    consumer: Channel,
    transport: agent_client_protocol::BoxFuture<'static, agent_client_protocol::Result<()>>,
    wakes: Arc<Wakes>,
    waker: Waker,
}
impl Harness {
    fn new(bytes: Vec<u8>) -> Self {
        Self::with_source(io::Cursor::new(bytes))
    }
    fn with_source(source: impl io::AsyncRead + Send + 'static) -> Self {
        let (destination, consumer) = Channel::duplex();
        let snapshot = destination.tx.clone();
        let gate = Gate::with_budget(
            1,
            move || QueueSnapshot {
                queued: snapshot.len(),
                closed: snapshot.is_closed(),
            },
            super::super::transient_pressure::Budget::new(4096, 8),
        )
        .unwrap();
        let probe = ConsumerProbe::default();
        probe.install(&gate).unwrap();
        let transport = ByteStreams::new(io::sink(), PermittedRead::new(source, gate.clone()));
        let (wire, transport) = ConnectTo::<Client>::into_channel_and_future(transport);
        let wakes = Arc::new(Wakes::default());
        let waker = Waker::from(wakes.clone());
        Self {
            gate,
            probe,
            wire,
            destination,
            consumer,
            transport,
            wakes,
            waker,
        }
    }
    fn drive_parser(&mut self) -> Poll<agent_client_protocol::Result<()>> {
        self.transport
            .as_mut()
            .poll(&mut Context::from_waker(&self.waker))
    }
    fn parsed(&mut self) -> Option<TransportFrame> {
        match Pin::new(&mut self.wire.rx).poll_next(&mut Context::from_waker(&self.waker)) {
            Poll::Ready(frame) => frame,
            Poll::Pending => None,
        }
    }
    fn forward(&mut self, frame: TransportFrame) {
        assert_eq!(
            self.gate
                .forward(frame, |frame| {
                    self.destination
                        .tx
                        .unbounded_send(frame)
                        .map_err(|error| Box::new(error.into_inner()))
                })
                .unwrap(),
            Forwarded::Transferred
        );
        assert!(self.destination.tx.len() <= 1);
    }
    fn dequeue_via_actual_consumer_probe(&mut self) -> TransportFrame {
        let receive = poll_fn(|cx| Pin::new(&mut self.consumer.rx).poll_next(cx));
        let mut observed = Box::pin(self.probe.clone().observe(receive));
        match observed
            .as_mut()
            .poll(&mut Context::from_waker(&self.waker))
        {
            Poll::Ready(Some(frame)) => frame,
            other => panic!("expected actual queued frame, got {other:?}"),
        }
    }
    fn finish_clean(&mut self) {
        assert!(self.drive_parser().is_pending());
        assert!(self.gate.clean_wire_eof().unwrap());
        assert!(matches!(
            Pin::new(&mut self.wire.rx).poll_next(&mut Context::from_waker(&self.waker)),
            Poll::Ready(None)
        ));
        // An observation clone is still alive. Explicit close propagates EOF
        // without waiting for that clone to disappear. Queued frames drain first.
        self.destination.tx.close_channel();
        self.wire.tx.close_channel();
        assert!(matches!(self.drive_parser(), Poll::Ready(Ok(()))));
    }
}

#[test]
fn actual_queue_full_stops_second_official_frame_and_real_dequeue_wakes_gate() {
    let mut h = Harness::new(b"{bad-json}\n[]\n".to_vec());
    assert!(h.drive_parser().is_pending());
    assert_eq!(h.gate.counts().unwrap().offered, 1);
    let first = h.parsed().expect("one actual SDK frame");
    assert!(matches!(&first, TransportFrame::Malformed { raw, .. } if raw == "{bad-json}"));
    h.forward(first);
    assert!(h.drive_parser().is_pending());
    assert_eq!(h.gate.counts().unwrap().started, 1);
    assert_eq!(h.destination.tx.len(), 1);
    assert!(h.parsed().is_none());
    let before = h.wakes.0.load(Ordering::SeqCst);
    let _first = h.dequeue_via_actual_consumer_probe();
    assert!(h.wakes.0.load(Ordering::SeqCst) > before);
    assert!(h.drive_parser().is_pending());
    let second = h
        .parsed()
        .expect("second frame only after actual queue capacity");
    assert!(matches!(&second, TransportFrame::Malformed { raw, .. } if raw == "[]"));
    h.forward(second);
    let _second = h.dequeue_via_actual_consumer_probe();
    h.finish_clean();
    let c = h.gate.counts().unwrap();
    assert_eq!(
        (c.offered, c.forwarded, c.empty_eof, c.failed),
        (2, 2, 1, 0)
    );
}

#[test]
fn final_unterminated_mixed_batch_is_one_actual_frame_then_eof() {
    let line = r#"[{"jsonrpc":"2.0","id":991,"result":{"extra":[null,false]}},17,{"jsonrpc":"2.0","method":"unknown_notice","params":{"keep":"原样","n":3}}]"#;
    let mut h = Harness::new(line.as_bytes().to_vec());
    assert!(h.drive_parser().is_pending());
    let frame = h
        .parsed()
        .expect("the SDK emits its final unterminated line");
    let TransportFrame::Batch(batch) = &frame else {
        panic!("batch boundary was lost")
    };
    assert_eq!(batch.len(), 3);
    assert_eq!(
        serde_json::to_value(batch).unwrap(),
        serde_json::from_str::<serde_json::Value>(line).unwrap()
    );
    assert_eq!(h.gate.counts().unwrap().offered, 1);
    h.forward(frame);
    let received = h.dequeue_via_actual_consumer_probe();
    assert!(matches!(received, TransportFrame::Batch(_)));
    h.finish_clean();
    let c = h.gate.counts().unwrap();
    assert_eq!(
        (c.offered, c.forwarded, c.empty_eof, c.failed),
        (1, 1, 0, 0)
    );
}

#[test]
fn invalid_utf8_is_original_transport_error_not_a_fabricated_frame_ack() {
    let mut h = Harness::new(vec![0xff, b'\n']);
    assert!(matches!(h.drive_parser(), Poll::Ready(Err(_))));
    assert!(h.parsed().is_none());
    let c = h.gate.counts().unwrap();
    assert_eq!((c.offered, c.forwarded), (1, 0));
    assert!(!h.gate.clean_wire_eof().unwrap());
    // The containing connection observes the original error before retirement.
    h.gate.abort();
    assert_eq!(h.gate.counts().unwrap().forwarded, 0);
}

#[test]
fn crlf_and_blank_line_remain_two_real_frames_without_spurious_wake_progress() {
    let mut h = Harness::new(b"{}\r\n\r\n".to_vec());
    assert!(h.drive_parser().is_pending());
    let first = h.parsed().unwrap();
    assert!(matches!(&first, TransportFrame::Malformed { raw, .. } if raw == "{}"));
    h.forward(first);
    let wakes = h.wakes.0.load(Ordering::SeqCst);
    for _ in 0..8 {
        assert!(h.drive_parser().is_pending());
        assert_eq!(h.gate.counts().unwrap().offered, 1);
        assert!(h.parsed().is_none());
    }
    assert_eq!(h.wakes.0.load(Ordering::SeqCst), wakes);
    let _ = h.dequeue_via_actual_consumer_probe();
    assert!(h.drive_parser().is_pending());
    let blank = h.parsed().unwrap();
    assert!(matches!(&blank, TransportFrame::Malformed { raw, .. } if raw.is_empty()));
    h.forward(blank);
    let _ = h.dequeue_via_actual_consumer_probe();
    h.finish_clean();
}

struct OriginalReadError;
impl io::AsyncRead for OriginalReadError {
    fn poll_read(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        _: &mut [u8],
    ) -> Poll<std::io::Result<usize>> {
        Poll::Ready(Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "prototype-original-read-failure",
        )))
    }
}
#[test]
fn original_io_error_is_not_replaced_by_gate_eof_or_a_fabricated_frame() {
    let mut h = Harness::with_source(OriginalReadError);
    let Poll::Ready(Err(error)) = h.drive_parser() else {
        panic!("real SDK transport error required")
    };
    assert!(format!("{error:?}").contains("prototype-original-read-failure"));
    assert!(h.parsed().is_none());
    let c = h.gate.counts().unwrap();
    assert_eq!(
        (c.started, c.offered, c.forwarded, c.empty_eof, c.failed),
        (1, 0, 0, 0, 1)
    );
    assert!(!h.gate.clean_wire_eof().unwrap());
}

#[test]
fn destination_close_returns_original_frame_without_counting_a_transfer() {
    let mut h = Harness::new(b"{bad-json}\n".to_vec());
    assert!(h.drive_parser().is_pending());
    let frame = h.parsed().unwrap();
    h.destination.tx.close_channel();
    let failure = h
        .gate
        .forward(frame, |_| {
            panic!("must not send after original receiver closed")
        })
        .unwrap_err();
    assert!(
        matches!(failure.frame.as_ref(), TransportFrame::Malformed { raw, .. } if raw == "{bad-json}")
    );
    assert_eq!(h.gate.counts().unwrap().forwarded, 0);
    assert!(!h.gate.clean_wire_eof().unwrap());
}
