//! Standalone spike: verify that the official `agent-client-protocol` crate can
//! drive a real ACP agent process as a client.
//!
//! Usage:
//!   acp-spike <agent-cmd> [agent-args...] [--prompt "text"] [--session] [--cwd <dir>]
//!
//! Output protocol on stdout:
//!   ---INITIALIZE---   followed by the pretty-printed initialize response JSON
//!   ---SESSION---      followed by the pretty-printed session/new response JSON
//!   ---UPDATE--- <kind> one line per session/update notification
//!   ---PROMPT-END--- <stopReason>
//!   ---TIMEOUT---      prompt exceeded 60s; session/cancel was sent
//!   ---ERROR--- <why>  any step failed (exit code != 0)

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CancelNotification, ClientCapabilities, FileSystemCapabilities, Implementation,
    InitializeRequest, PermissionOptionKind, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome, SessionNotification,
};
use agent_client_protocol::util::MatchDispatch;
use agent_client_protocol::{
    AcpAgent, AcpAgentConfig, Agent, Client, ConnectionTo, Dispatch, Error, Handled,
    SessionMessage, UntypedMessage,
};

const PROMPT_TIMEOUT: Duration = Duration::from_secs(60);

struct SpikeArgs {
    command: String,
    args: Vec<String>,
    prompt: Option<String>,
    session: bool,
    cwd: Option<PathBuf>,
}

fn parse_args() -> Result<SpikeArgs, String> {
    let mut positional: Vec<String> = Vec::new();
    let mut prompt = None;
    let mut session = false;
    let mut cwd = None;

    let mut argv = std::env::args().skip(1);
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--prompt" => {
                prompt = Some(argv.next().ok_or("--prompt requires a value")?);
            }
            "--session" => session = true,
            "--cwd" => {
                cwd = Some(PathBuf::from(argv.next().ok_or("--cwd requires a value")?));
            }
            "--" => positional.extend(argv.by_ref()),
            _ => positional.push(arg),
        }
    }

    let mut positional = positional.into_iter();
    let command = positional.next().ok_or_else(|| {
        "usage: acp-spike <agent-cmd> [agent-args...] [--prompt text] [--session] [--cwd dir]"
            .to_string()
    })?;

    Ok(SpikeArgs {
        command,
        args: positional.collect(),
        prompt,
        session,
        cwd,
    })
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };

    match run(args).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            println!("---ERROR--- {}", describe_error(&error));
            ExitCode::FAILURE
        }
    }
}

fn describe_error(error: &Error) -> String {
    match &error.data {
        Some(data) => format!("{error} | data={data}"),
        None => error.to_string(),
    }
}

fn update_kind(notification: &SessionNotification) -> String {
    serde_json::to_value(&notification.update)
        .ok()
        .and_then(|value| {
            value
                .get("sessionUpdate")
                .and_then(|kind| kind.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "unknown".to_string())
}

async fn run(args: SpikeArgs) -> Result<(), Error> {
    let config = AcpAgentConfig::new(&args.command).args(args.args.iter().cloned());
    let agent = AcpAgent::new(config).with_debug(|line, direction| {
        eprintln!("[agent {direction:?}] {line}");
    });

    Client
        .builder()
        .name("farfold-spike")
        .on_receive_dispatch(
            async |message: Dispatch<UntypedMessage, UntypedMessage>, _cx| {
                eprintln!("[unhandled dispatch] {:?}", message.message());
                Ok(Handled::No {
                    message,
                    retry: false,
                })
            },
            agent_client_protocol::on_receive_dispatch!(),
        )
        .connect_with(agent, move |cx| async move { spike_main(cx, args).await })
        .await
}

async fn spike_main(cx: ConnectionTo<Agent>, args: SpikeArgs) -> Result<(), Error> {
    let init = InitializeRequest::new(ProtocolVersion::V1)
        .client_info(Implementation::new("farfold-spike", "0.1.7").title("Farfold"))
        .client_capabilities(
            ClientCapabilities::new()
                .fs(FileSystemCapabilities::new()
                    .read_text_file(false)
                    .write_text_file(false))
                .terminal(false),
        );

    let init_response = cx.send_request(init).block_task().await?;
    println!("---INITIALIZE---");
    println!(
        "{}",
        serde_json::to_string_pretty(&init_response).map_err(Error::into_internal_error)?
    );

    if args.session || args.prompt.is_some() {
        run_session(cx, args).await?;
    }

    Ok(())
}

async fn run_session(cx: ConnectionTo<Agent>, args: SpikeArgs) -> Result<(), Error> {
    let cwd = args
        .cwd
        .clone()
        .unwrap_or_else(|| std::env::temp_dir().join(format!("acp-spike-{}", std::process::id())));
    std::fs::create_dir_all(&cwd).map_err(Error::into_internal_error)?;

    let mut session = cx.build_session(&cwd).block_task().start_session().await?;
    println!("---SESSION---");
    println!(
        "{}",
        serde_json::to_string_pretty(&session.response()).map_err(Error::into_internal_error)?
    );

    if let Some(prompt) = args.prompt.as_deref() {
        run_prompt(&mut session, prompt).await?;
    }

    Ok(())
}

async fn run_prompt(
    session: &mut agent_client_protocol::ActiveSession<'static, Agent>,
    prompt: &str,
) -> Result<(), Error> {
    session.send_prompt(prompt)?;

    let read_loop = async {
        loop {
            match session.read_update().await? {
                SessionMessage::SessionMessage(dispatch) => {
                    handle_session_dispatch(dispatch).await?;
                }
                SessionMessage::StopReason(stop_reason) => {
                    println!("---PROMPT-END--- {stop_reason:?}");
                    return Ok::<(), Error>(());
                }
                _ => {}
            }
        }
    };

    match tokio::time::timeout(PROMPT_TIMEOUT, read_loop).await {
        Ok(result) => result,
        Err(_) => {
            println!("---TIMEOUT---");
            session.connection().send_notification_to(
                Agent,
                CancelNotification::new(session.session_id().clone()),
            )?;
            // Give the agent a short window to confirm cancellation.
            let drain = async {
                loop {
                    match session.read_update().await? {
                        SessionMessage::SessionMessage(dispatch) => {
                            handle_session_dispatch(dispatch).await?;
                        }
                        SessionMessage::StopReason(stop_reason) => {
                            println!("---PROMPT-END--- {stop_reason:?}");
                            return Ok::<(), Error>(());
                        }
                        _ => {}
                    }
                }
            };
            match tokio::time::timeout(Duration::from_secs(10), drain).await {
                Ok(result) => result,
                Err(_) => Ok(()),
            }
        }
    }
}

async fn handle_session_dispatch(dispatch: Dispatch) -> Result<(), Error> {
    MatchDispatch::new(dispatch)
        .if_notification(async |notification: SessionNotification| {
            println!("---UPDATE--- {}", update_kind(&notification));
            Ok(())
        })
        .await
        .if_request(async |request: RequestPermissionRequest, responder| {
            // Spike policy: pick the first allow-ish option; cancel otherwise.
            let outcome = request
                .options
                .iter()
                .find(|option| {
                    matches!(
                        option.kind,
                        PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways
                    )
                })
                .map_or(RequestPermissionOutcome::Cancelled, |option| {
                    RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                        option.option_id.clone(),
                    ))
                });
            eprintln!("[permission] auto-resolved -> {outcome:?}");
            responder.respond(RequestPermissionResponse::new(outcome))?;
            Ok(())
        })
        .await
        .otherwise(async |message| match message {
            Dispatch::Request(request, responder) => {
                eprintln!("[unhandled request] {}", request.method());
                responder.respond_with_error(agent_client_protocol::util::internal_error(
                    "farfold-spike: unsupported",
                ))
            }
            Dispatch::Notification(notification) => {
                eprintln!("[unhandled notification] {}", notification.method());
                Ok(())
            }
            Dispatch::Response(..) => Ok(()),
        })
        .await
}
