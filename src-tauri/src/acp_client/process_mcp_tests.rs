use super::*;
use crate::acp_client::browser_capability::LaunchKind;
use crate::acp_client::transient_mcp::{McpUnavailable, launch_rejection};
use std::cell::Cell;
#[cfg(unix)]
use std::os::unix::ffi::OsStringExt;
#[cfg(windows)]
use std::os::windows::ffi::OsStringExt;

fn captured(logs: Option<&str>, config: Option<&str>) -> McpSpawnFacts {
    let mut command = std::process::Command::new("/controlled/never-executed");
    capture_mcp_spawn_facts(&mut command, |name| match name {
        "APP_SERVER_LOGS" => logs.map(OsString::from),
        "CODEX_CONFIG" => config.map(OsString::from),
        _ => unreachable!(),
    })
}

#[test]
fn mcp_launch_logs_use_node_nonempty_semantics() {
    for value in [None, Some("")] {
        assert!(captured(value, None).logs_safe);
    }
    for value in ["false", "0", " ", "/controlled/logs"] {
        assert!(!captured(Some(value), None).logs_safe);
    }
}

#[test]
fn mcp_launch_freezes_effective_overlay_without_changing_or_exposing_values() {
    let mut command = std::process::Command::new("/controlled/never-executed");
    command.env("APP_SERVER_LOGS", "").env("CODEX_CONFIG", "{}");
    let inherited_reads = Cell::new(0);
    let facts = capture_mcp_spawn_facts(&mut command, |_| {
        inherited_reads.set(inherited_reads.get() + 1);
        Some("must-not-overwrite-explicit".into())
    });
    assert!(facts.logs_safe && facts.inline_mcp_safe == Some(true));
    assert_eq!(inherited_reads.get(), 0);
    assert!(
        command
            .get_envs()
            .any(|(key, value)| key == "APP_SERVER_LOGS" && value == Some(OsStr::new("")))
    );
    assert!(
        command
            .get_envs()
            .any(|(key, value)| key == "CODEX_CONFIG" && value == Some(OsStr::new("{}")))
    );
    let mut removed = std::process::Command::new("/controlled/never-executed");
    removed
        .env_remove("APP_SERVER_LOGS")
        .env_remove("CODEX_CONFIG");
    assert!(
        capture_mcp_spawn_facts(&mut removed, |_| panic!("explicit removal cannot inherit"))
            .logs_safe
    );
    let mut inherited = std::process::Command::new("/controlled/never-executed");
    let facts = capture_mcp_spawn_facts(&mut inherited, |name| {
        (name == "APP_SERVER_LOGS").then(|| "0".into())
    });
    assert!(!facts.logs_safe);
    assert!(
        inherited
            .get_envs()
            .any(|(key, value)| key == "APP_SERVER_LOGS" && value == Some(OsStr::new("0")))
    );
    assert!(
        inherited
            .get_envs()
            .any(|(key, value)| key == "CODEX_CONFIG" && value.is_none())
    );
}

#[test]
fn mcp_launch_inline_configuration_preserves_native_servers_or_refuses_injection() {
    for config in [
        None,
        Some(""),
        Some("{}"),
        Some(r#"{"model":"synthetic","model_providers":{"fixture":{"env_key":"SYNTHETIC"}}}"#),
    ] {
        assert_eq!(captured(None, config).inline_mcp_safe, Some(true));
    }
    for config in [
        r#"{"mcp_servers":{"user":{"command":"fixture"}}}"#,
        r#"{"mcp_servers":null}"#,
        r#"{"mcp_servers":{}}"#,
        r#"{"mcp_servers.user.command":"fixture"}"#,
    ] {
        assert_eq!(captured(None, Some(config)).inline_mcp_safe, Some(false));
    }
    for config in ["invalid", "null", "[]", "true", "5"] {
        assert_eq!(captured(None, Some(config)).inline_mcp_safe, None);
    }
    #[cfg(unix)]
    let non_utf8 = OsString::from_vec(vec![0xff]);
    #[cfg(windows)]
    let non_utf8 = OsString::from_wide(&[0xd800]);
    assert_eq!(inline_mcp_safe(Some(&non_utf8)), None);
}

#[test]
fn mcp_launch_gate_fails_closed_without_gating_ordinary_connections() {
    let safe = captured(None, None);
    assert_eq!(
        launch_rejection(None, Some(safe)),
        Some(McpUnavailable::SourceNotReviewed)
    );
    assert_eq!(
        launch_rejection(Some(LaunchKind::Node), None),
        Some(McpUnavailable::LaunchUnconfirmed)
    );
    assert_eq!(
        launch_rejection(Some(LaunchKind::Node), Some(captured(Some("false"), None))),
        Some(McpUnavailable::UnsafeLogging)
    );
    assert_eq!(
        launch_rejection(
            Some(LaunchKind::Node),
            Some(captured(None, Some(r#"{"mcp_servers":{}}"#)))
        ),
        Some(McpUnavailable::InlineMcpConflict)
    );
    assert_eq!(
        launch_rejection(Some(LaunchKind::Node), Some(captured(None, Some("[")))),
        Some(McpUnavailable::LaunchUnconfirmed)
    );
    assert_eq!(launch_rejection(Some(LaunchKind::Node), Some(safe)), None);
    assert_eq!(launch_rejection(Some(LaunchKind::Binary), Some(safe)), None);
    assert_eq!(launch_rejection(Some(LaunchKind::Binary), None), None);
    assert_eq!(
        launch_rejection(
            Some(LaunchKind::Binary),
            Some(captured(Some("1"), Some("invalid")))
        ),
        None
    );
}

#[test]
fn mcp_launch_spawn_fact_cell_is_once_only_and_not_shared_between_connections() {
    let first = OnceLock::new();
    let second = OnceLock::new();
    assert!(first.set(captured(Some("1"), None)).is_ok());
    assert!(second.set(captured(None, None)).is_ok());
    assert!(first.set(captured(None, None)).is_err());
    assert!(!first.get().unwrap().logs_safe);
    assert!(second.get().unwrap().logs_safe);
}

fn captured_opencode(heap: Option<&str>, telemetry: Option<&str>) -> Option<McpSpawnFacts> {
    let mut command = std::process::Command::new("/controlled/never-executed");
    capture_opencode_mcp_spawn_facts(&mut command, |name| match name {
        "OPENCODE_AUTO_HEAP_SNAPSHOT" => heap.map(OsString::from),
        "OTEL_EXPORTER_OTLP_ENDPOINT" => telemetry.map(OsString::from),
        _ => panic!("unrelated environment must not be read"),
    })
}

#[test]
fn opencode_logging_facts_use_two_distinct_official_flag_semantics() {
    for heap in [None, Some(""), Some("0"), Some("false"), Some(" true ")] {
        let facts = captured_opencode(heap, None).unwrap();
        assert!(facts.logs_safe);
        assert_eq!(
            launch_rejection(Some(LaunchKind::OpenCode), Some(facts)),
            None
        );
    }
    for heap in ["true", "TRUE", "True", "1"] {
        let facts = captured_opencode(Some(heap), None).unwrap();
        assert!(!facts.logs_safe);
        assert_eq!(
            launch_rejection(Some(LaunchKind::OpenCode), Some(facts)),
            Some(McpUnavailable::UnsafeLogging)
        );
    }
    for telemetry in ["0", "false", " ", "http://synthetic.invalid"] {
        assert!(!captured_opencode(None, Some(telemetry)).unwrap().logs_safe);
    }
    assert!(captured_opencode(None, Some("")).unwrap().logs_safe);
}

#[test]
fn opencode_requires_its_own_completed_spawn_facts() {
    assert_eq!(
        launch_rejection(Some(LaunchKind::OpenCode), None),
        Some(McpUnavailable::LaunchUnconfirmed)
    );
    assert_eq!(
        launch_rejection(Some(LaunchKind::OpenCode), Some(captured(None, None))),
        Some(McpUnavailable::LaunchUnconfirmed)
    );
    assert_eq!(
        launch_rejection(Some(LaunchKind::Node), captured_opencode(None, None)),
        Some(McpUnavailable::LaunchUnconfirmed)
    );
    #[cfg(unix)]
    let non_utf8 = OsString::from_vec(vec![0xff]);
    #[cfg(windows)]
    let non_utf8 = OsString::from_wide(&[0xd800]);
    for unknown_name in ["OPENCODE_AUTO_HEAP_SNAPSHOT", "OTEL_EXPORTER_OTLP_ENDPOINT"] {
        let mut command = std::process::Command::new("/controlled/never-executed");
        assert!(
            capture_opencode_mcp_spawn_facts(&mut command, |name| {
                (name == unknown_name).then(|| non_utf8.clone())
            })
            .is_none()
        );
        assert!(
            command
                .get_envs()
                .any(|(name, value)| name == unknown_name && value == Some(non_utf8.as_os_str()))
        );
    }
}

#[test]
fn opencode_effective_environment_is_frozen_without_rewriting_or_broadcasting_values() {
    let mut command = std::process::Command::new("/controlled/never-executed");
    command.env("OPENCODE_AUTO_HEAP_SNAPSHOT", "false");
    command.env_remove("OTEL_EXPORTER_OTLP_ENDPOINT");
    command.env("UNRELATED", "preserved");
    let facts =
        capture_opencode_mcp_spawn_facts(&mut command, |_| panic!("explicit values must win"))
            .unwrap();
    assert!(facts.logs_safe);
    assert!(
        command
            .get_envs()
            .any(|(key, value)| key == "OPENCODE_AUTO_HEAP_SNAPSHOT"
                && value == Some(OsStr::new("false")))
    );
    assert!(
        command
            .get_envs()
            .any(|(key, value)| key == "OTEL_EXPORTER_OTLP_ENDPOINT" && value.is_none())
    );
    assert!(
        command
            .get_envs()
            .any(|(key, value)| key == "UNRELATED" && value == Some(OsStr::new("preserved")))
    );
    let mut inherited = std::process::Command::new("/controlled/never-executed");
    let facts = capture_opencode_mcp_spawn_facts(&mut inherited, |name| {
        (name == "OPENCODE_AUTO_HEAP_SNAPSHOT").then(|| "TRUE".into())
    })
    .unwrap();
    assert!(!facts.logs_safe);
    assert!(
        inherited
            .get_envs()
            .any(|(key, value)| key == "OPENCODE_AUTO_HEAP_SNAPSHOT"
                && value == Some(OsStr::new("TRUE")))
    );
    assert_eq!(
        inherited.get_envs().count(),
        2,
        "only existing reviewed switches are frozen"
    );
}

#[test]
fn logging_key_matching_obeys_the_platform_environment_name_rules() {
    use crate::shell_env::EnvNames;
    assert!(launch_env_key_matches(
        OsStr::new("opencode_auto_heap_snapshot"),
        "OPENCODE_AUTO_HEAP_SNAPSHOT",
        EnvNames::Windows
    ));
    assert!(!launch_env_key_matches(
        OsStr::new("opencode_auto_heap_snapshot"),
        "OPENCODE_AUTO_HEAP_SNAPSHOT",
        EnvNames::CaseSensitive
    ));
    assert!(!launch_env_key_matches(
        OsStr::new("OTHER"),
        "OPENCODE_AUTO_HEAP_SNAPSHOT",
        EnvNames::Windows
    ));
}

#[cfg(windows)]
#[test]
fn opencode_windows_explicit_case_variant_overrides_inherited_safe_value() {
    let mut command = std::process::Command::new(r"C:\controlled\never-executed.exe");
    command
        .env("opencode_auto_heap_snapshot", "TRUE")
        .env_remove("otel_exporter_otlp_endpoint");
    let facts = capture_opencode_mcp_spawn_facts(&mut command, |_| {
        panic!("Windows explicit names are case-insensitive")
    })
    .unwrap();
    assert!(!facts.logs_safe);
}
