//! Only transports original official frames; SDK owns JSON-RPC interpretation.
use super::{
    ingress_permit::{ConsumerProbe, Forwarded, Gate, PermittedRead, QueueSnapshot},
    process::{ProcessControl, PromptEscrow},
    startup_diagnostics::Diagnostics,
    tap::PermissionObservation,
};
use agent_client_protocol::{
    Agent, ByteStreams, Channel, Client, ConnectTo, RawJsonRpcMessage, TransportBatchEntry,
    TransportFrame,
};
use futures_lite::{
    StreamExt,
    io::{AsyncRead, AsyncWrite},
};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
fn inspect(
    frame: &TransportFrame,
    diagnostics: &Diagnostics,
    prompts: &PromptEscrow,
    outgoing: bool,
    wire_sequence: &AtomicU64,
    mut permission: Option<&mut PermissionObservation>,
) {
    let mut inspect_one = |message: &RawJsonRpcMessage| {
        diagnostics.inspect(message, outgoing);
        prompts.inspect(message, outgoing);
        if let Ok(line) = serde_json::to_string(message) {
            let mut record = if outgoing {
                super::tap::diagnostic_record(&line, "out")
            } else {
                super::tap::diagnostic_record_with_permission(
                    &line,
                    "in",
                    permission.as_deref_mut(),
                )
            };
            // Count before the bounded diagnostic queue so gaps remain visible.
            record["wireSequence"] = (wire_sequence.fetch_add(1, Ordering::Relaxed) + 1).into();
            if outgoing {
                diagnostics.annotate_outgoing_error(message, &mut record);
            } else {
                diagnostics.annotate_incoming_error(message, &mut record);
            }
            diagnostics.record(record);
        }
    };
    match frame {
        TransportFrame::Single(message) => inspect_one(message),
        TransportFrame::Malformed { .. } => {}
        TransportFrame::Batch(batch) => {
            for entry in batch.entries() {
                if let TransportBatchEntry::Message(message) = entry {
                    inspect_one(message);
                }
            }
        }
    }
}
pub(super) async fn run(
    stdin: impl AsyncWrite + Send + 'static,
    stdout: impl AsyncRead + Send + 'static,
    client: impl ConnectTo<Agent>,
    probe: ConsumerProbe,
    unclaimed: Arc<super::transient_pressure::Budget>,
    diagnostics: Arc<Diagnostics>,
    process: ProcessControl,
) -> Result<(), agent_client_protocol::Error> {
    let (endpoint, endpoint_future) = client.into_channel_and_future();
    let snapshot = endpoint.tx.clone();
    let gate = Gate::new(
        1,
        move || QueueSnapshot {
            queued: snapshot.len(),
            closed: snapshot.is_closed(),
        },
        unclaimed,
    )
    .map_err(agent_client_protocol::Error::into_internal_error)?;
    probe
        .install(&gate)
        .map_err(agent_client_protocol::Error::into_internal_error)?;
    let transport = ByteStreams::new(stdin, PermittedRead::new(stdout, gate.clone()));
    let (wire, wire_future) = ConnectTo::<Client>::into_channel_and_future(transport);
    let Channel {
        rx: mut outgoing,
        tx: destination,
    } = endpoint;
    let Channel {
        rx: mut incoming,
        tx: source,
    } = wire;
    let outgoing_diagnostics = diagnostics.clone();
    let prompts = process.prompt_escrow();
    let outgoing_prompts = prompts.clone();
    let wire_sequence = AtomicU64::new(0);
    let outgoing_wire_sequence = &wire_sequence;
    let outgoing = async move {
        while let Some(frame) = outgoing.next().await {
            inspect(
                &frame,
                &outgoing_diagnostics,
                &outgoing_prompts,
                true,
                outgoing_wire_sequence,
                None,
            );
            source
                .unbounded_send(frame)
                .map_err(agent_client_protocol::Error::into_internal_error)?;
        }
        source.close_channel();
        Ok::<(), agent_client_protocol::Error>(())
    };
    let incoming = async {
        let mut permission = PermissionObservation::default();
        while let Some(frame) = incoming.next().await {
            inspect(
                &frame,
                &diagnostics,
                &prompts,
                false,
                &wire_sequence,
                Some(&mut permission),
            );
            match gate.forward(frame, |frame| {
                destination
                    .unbounded_send(frame)
                    .map_err(|error| Box::new(error.into_inner()))
            }) {
                Ok(Forwarded::Transferred) => {}
                Ok(Forwarded::TransferredAccountingUnknown) => {
                    return Err(agent_client_protocol::Error::internal_error());
                }
                Err(rejected) => {
                    // Actual transfer failed. Preserve its transport failure;
                    // never retry, claim consumption or log the retained body.
                    drop(rejected.frame);
                    return Err(agent_client_protocol::util::internal_error(rejected.reason));
                }
            }
        }
        // The queue observer also holds a Sender. Explicit EOF is essential.
        destination.close_channel();
        Ok::<(), agent_client_protocol::Error>(())
    };
    tokio::select! {
        outcome = async {
            tokio::try_join!(wire_future, endpoint_future, outgoing, incoming)?;
            if !gate.clean_wire_eof().map_err(agent_client_protocol::Error::into_internal_error)? {
                return Err(agent_client_protocol::Error::internal_error());
            }
            Ok(())
        } => outcome,
        outcome = process.closed() => outcome.map_err(agent_client_protocol::util::internal_error),
    }
}
