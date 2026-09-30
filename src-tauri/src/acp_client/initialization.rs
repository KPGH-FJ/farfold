//! Content-free startup outcomes. SDK error bodies never enter this receipt.
use agent_client_protocol::schema::v1::InitializeResponse;
use std::time::Duration;
use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    Failed,
    Timeout,
    Ended,
    StartFailed,
}

impl Failure {
    pub fn code(self) -> &'static str {
        match self {
            Self::Failed => "AGENT_INITIALIZE_FAILED",
            Self::Timeout => "AGENT_INITIALIZE_TIMEOUT",
            Self::Ended => "AGENT_CONNECTION_ENDED",
            Self::StartFailed => "AGENT_START_FAILED",
        }
    }

    pub fn from_request(error: &agent_client_protocol::Error) -> Self {
        // The SDK's typed result can fail locally while decoding a response.
        // Neither its numeric error code nor message proves a remote rejection.
        if agent_client_protocol::is_incoming_transport_closed(error) {
            Self::Ended
        } else {
            Self::Failed
        }
    }
}

pub(crate) async fn receive(
    response: oneshot::Receiver<Result<InitializeResponse, Failure>>,
    timeout: Duration,
) -> Result<InitializeResponse, Failure> {
    match tokio::time::timeout(timeout, response).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(Failure::Ended),
        Err(_) => Err(Failure::Timeout),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn timeout_closes_receipt_and_late_success_cannot_replace_it() {
        let (send, receive_channel) = oneshot::channel();
        assert_eq!(
            receive(receive_channel, Duration::from_millis(10)).await,
            Err(Failure::Timeout)
        );
        assert!(
            send.send(Ok(InitializeResponse::new(
                agent_client_protocol::schema::ProtocolVersion::V1,
            )))
            .is_err()
        );
    }

    #[test]
    fn sdk_code_and_sensitive_body_do_not_define_remote_rejection() {
        let mut error = agent_client_protocol::Error::invalid_params();
        error.message = "fixture-sensitive-startup-canary".into();
        error.data = Some(serde_json::json!({"path":"sensitive-file.py"}));
        assert_eq!(Failure::from_request(&error), Failure::Failed);
        assert_eq!(
            Failure::from_request(&error).code(),
            "AGENT_INITIALIZE_FAILED"
        );
    }
}
