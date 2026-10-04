use super::*;

fn parsed(value: &str) -> Url {
    Url::parse(value).unwrap()
}

#[test]
fn permits_public_https_and_normalizes_default_port() {
    let url =
        validate_public_url("https://www.rust-lang.org:443/learn?q=ownership#examples").unwrap();
    assert_eq!(url.port(), None);
    assert_eq!(url.host_str(), Some("www.rust-lang.org"));
}

#[test]
fn rejects_non_https_nonstandard_ports_and_ambiguous_inputs() {
    for input in [
        "http://example.com",
        "file:///tmp/index.html",
        "https://example.com:8443",
        " https://example.com",
        "https://exam\nple.com",
        "https://example.com\\login",
        "https:@example.com",
        "https:///@example.com",
    ] {
        assert!(validate_public_url(input).is_err(), "{input:?}");
    }
}

#[test]
fn rejects_userinfo_including_empty_and_encoded_credentials() {
    for input in [
        "https://user@example.com",
        "https://user:pass@example.com",
        "https://@example.com",
        "https://%75ser@example.com",
    ] {
        assert!(validate_public_url(input).is_err(), "{input}");
    }
}

#[test]
fn rejects_ip_literals_aliases_and_private_names() {
    for input in [
        "https://127.0.0.1",
        "https://8.8.8.8",
        "https://[::1]",
        "https://[2606:4700:4700::1111]",
        "https://2130706433",
        "https://0x7f000001",
        "https://127.1",
        "https://localhost",
        "https://printer",
        "https://a.local",
        "https://a.internal",
        "https://a.localhost",
        "https://a.home.arpa",
        "https://example.com.",
    ] {
        assert!(validate_public_url(input).is_err(), "{input}");
    }
}

#[test]
fn rejects_known_authorization_domains_and_encoded_routes() {
    for input in [
        "https://accounts.google.com/",
        "https://oauth2.googleapis.com/",
        "https://login.microsoftonline.com/",
        "https://appleid.apple.com/",
        "https://tenant.auth0.com/",
        "https://github.com/login/oauth/authorize",
        "https://example.com/o%61uth2/authorize",
        "https://example.com/%256cogin",
        "https://example.com/a%2Fsignin;next=home",
        "https://example.com/#/oauth/callback",
    ] {
        assert!(validate_public_url(input).is_err(), "{input}");
    }
}

#[test]
fn rejects_sensitive_query_and_fragment_parameters() {
    for input in [
        "https://example.com/?access_token=fixture",
        "https://example.com/?%63lient_secret=fixture",
        "https://example.com/?%2563ode=fixture",
        "https://example.com/?q=ok;PASSWORD=fixture",
        "https://example.com/?response_type=code",
        "https://example.com/#id_token=fixture",
        "https://example.com/?api-key=fixture",
    ] {
        assert!(validate_public_url(input).is_err(), "{input}");
    }
}

#[test]
fn compares_origin_not_path_prefix_or_opaque_identity() {
    let approved = parsed("https://example.com/start");
    assert!(same_origin(
        &approved,
        &parsed("https://EXAMPLE.com:443/next?q=ok")
    ));
    for different in [
        "http://example.com/start",
        "https://example.com:8443/start",
        "https://example.com.evil.com/start",
        "https://sub.example.com/start",
    ] {
        assert!(!same_origin(&approved, &parsed(different)));
    }
    assert!(same_origin(
        &parsed("tauri://localhost/a"),
        &parsed("tauri://localhost/b")
    ));
    assert!(!same_origin(
        &parsed("data:text/plain,a"),
        &parsed("data:text/plain,a")
    ));
}

#[test]
fn accepts_only_local_main_caller_in_packaged_mode() {
    assert!(caller_is_main(
        "main",
        &parsed("tauri://localhost/tasks/a"),
        None
    ));
    for (label, value) in [
        ("browser", "tauri://localhost"),
        ("main", "https://example.com"),
        ("main", "tauri://localhost.evil.com"),
        ("main", "tauri://user@localhost"),
        ("main", "tauri://localhost:1234"),
    ] {
        assert!(
            !caller_is_main(label, &parsed(value), None),
            "{label} {value}"
        );
    }
}

#[test]
fn dev_caller_requires_exact_configured_loopback_origin() {
    let dev = parsed("http://localhost:1420");
    assert_eq!(
        caller_is_main("main", &parsed("http://localhost:1420/tasks"), Some(&dev)),
        cfg!(debug_assertions)
    );
    for value in [
        "http://localhost:1421",
        "http://127.0.0.1:1420",
        "https://localhost:1420",
        "http://localhost.evil.com:1420",
    ] {
        assert!(
            !caller_is_main("main", &parsed(value), Some(&dev)),
            "{value}"
        );
    }
    let remote = parsed("https://example.com");
    assert!(!caller_is_main("main", &remote, Some(&remote)));
    assert!(!caller_is_main("browser", &dev, Some(&dev)));
}

#[test]
fn task_key_accepts_existing_keys_but_rejects_controls_and_excess_length() {
    for key in ["task-3", "project:thread/3", "中文", "a/b", "-task"] {
        assert!(validate_task_key(key).is_ok());
    }
    for key in ["", "a\n", "a\r", "a\t", "a\0b", "a\u{7f}b"] {
        assert!(validate_task_key(key).is_err(), "{key:?}");
    }
    assert!(validate_task_key(&"文".repeat(1024)).is_ok());
    assert!(validate_task_key(&"a".repeat(1025)).is_err());
}

#[test]
fn bounds_reject_nonfinite_negative_empty_and_oversized_values() {
    let valid = Bounds {
        x: 8.0,
        y: 64.0,
        width: 900.0,
        height: 600.0,
    };
    assert!(valid.validate().is_ok());
    for invalid in [
        Bounds { x: -1.0, ..valid },
        Bounds {
            y: f64::NAN,
            ..valid
        },
        Bounds {
            width: f64::INFINITY,
            ..valid
        },
        Bounds {
            width: 0.0,
            ..valid
        },
        Bounds {
            height: -1.0,
            ..valid
        },
        Bounds {
            x: 16_000.0,
            ..valid
        },
    ] {
        assert!(invalid.validate().is_err(), "{invalid:?}");
    }
}
