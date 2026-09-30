use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;

fn configuration(api: &str) -> ApiConfiguration {
    ApiConfiguration {
        endpoint: "https://example.test/v1".into(),
        api_type: api.into(),
        secret: "test-secret".into(),
    }
}

#[test]
fn format_selection_controls_endpoint_auth_and_response_shape() {
    let samples = [
        (
            "chat-completions",
            "chat/completions",
            json!({"choices":[{"message":{"content":"OK"}}]}),
        ),
        (
            "responses",
            "responses",
            json!({"output":[{"content":[{"type":"output_text","text":"OK"}]}]}),
        ),
        (
            "messages",
            "messages",
            json!({"content":[{"type":"text","text":"OK"}]}),
        ),
    ];
    for (api, path, response) in samples {
        let config = configuration(api);
        let request = request(&client().unwrap(), &config, Some("model-x"))
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(
            request.url().as_str(),
            format!("https://example.test/v1/{path}")
        );
        assert_eq!(
            request.headers().contains_key("x-api-key"),
            api == "messages"
        );
        assert_eq!(
            request.headers().contains_key("authorization"),
            api != "messages"
        );
        let body: Value =
            serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(body["model"], "model-x");
        assert_eq!(body["stream"], false);
        assert!(body.get("tools").is_none());
        assert!(!body.to_string().contains("test-secret"));
        assert_eq!(parse_text(&response, api, &config.secret).unwrap(), "OK");
    }
}

#[test]
fn errors_and_echoed_credentials_never_expose_the_key() {
    let error = json!({"error":{"message":"test-secret"}});
    assert!(
        !parse_text(&error, "responses", "test-secret")
            .unwrap_err()
            .contains("test-secret")
    );
    let response = json!({"choices":[{"message":{"content":"key=test-secret"}}]});
    assert!(
        !parse_text(&response, "chat-completions", "test-secret")
            .unwrap()
            .contains("test-secret")
    );
    assert_eq!(
        parse_models(&json!({"data":[{"id":"model-x"},{"id":"model-x"},{"id":"\nbad"}]})).unwrap(),
        ["model-x"]
    );
}

#[test]
fn diagnostic_output_limit_is_not_misreported_as_bad_configuration_or_success() {
    // Real Atria sample: all 64 output tokens were reasoning, no text yet.
    // Partial text is also incomplete, even if it includes the requested OK.
    for (api, sample) in [
        (
            "chat-completions",
            json!({"choices":[{"finish_reason":"length","message":{"content":null}}]}),
        ),
        (
            "chat-completions",
            json!({"choices":[{"finish_reason":"length","message":{"content":"OK"}}]}),
        ),
        (
            "responses",
            json!({"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}),
        ),
        (
            "messages",
            json!({"stop_reason":"max_tokens","content":[{"type":"text","text":"OK"}]}),
        ),
    ] {
        let error = parse_text(&sample, api, "test-secret").unwrap_err();
        assert!(error.contains("本次简短测试达到输出上限"));
        assert!(!error.contains("检查模型和接口格式"));
    }
}

async fn local_response(
    status: &str,
    headers: &str,
) -> Result<(Vec<String>, Option<String>), String> {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = server.local_addr().unwrap();
    let response = format!("HTTP/1.1 {status}\r\n{headers}\r\nConnection: close\r\n\r\n");
    let worker = std::thread::spawn(move || {
        let (mut socket, _) = server.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut buffer = [0; 4096];
        let _ = socket.read(&mut buffer);
        socket.write_all(response.as_bytes()).unwrap();
    });
    let mut config = configuration("responses");
    // Only this test bypasses public HTTPS validation to exercise actual HTTP handling.
    config.endpoint = format!("http://{addr}");
    let result = perform(config, None).await;
    worker.join().unwrap();
    result
}

#[tokio::test]
async fn redirects_are_not_followed_and_body_limit_applies_before_reading() {
    assert!(
        local_response(
            "302 Found",
            "Location: https://example.invalid/credential-trap\r\nContent-Length: 0"
        )
        .await
        .unwrap_err()
        .contains("没有跟随跳转")
    );
    assert!(
        local_response("200 OK", "Content-Length: 1048577")
            .await
            .unwrap_err()
            .contains("内容过大")
    );
}

#[tokio::test]
async fn cancel_is_bound_to_request_and_releases_its_registration() {
    let id = "api-cancel-test".to_string();
    let (started, ready) = tokio::sync::oneshot::channel();
    let worker_id = id.clone();
    let task = tokio::spawn(async move {
        run_operation(worker_id, true, |_| async move {
            started.send(()).unwrap();
            std::future::pending().await
        })
        .await
        .unwrap()
    });
    ready.await.unwrap();
    assert!(!api_test_cancel("another-request".into()));
    assert!(Job::start(&id).is_err());
    assert!(api_test_cancel(id.clone()));
    let result = tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.status, "cancelled");
    assert_eq!(result.request_id, id);
    assert!(!api_test_cancel(id.clone()));
    assert!(Job::start(&id).is_ok());
}

#[tokio::test]
async fn cancelled_keychain_worker_keeps_its_slot_until_it_really_finishes() {
    let id = "api-keychain-cancel-test".to_string();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let (finished, done) = tokio::sync::oneshot::channel();
    let worker_id = id.clone();
    let task = tokio::spawn(async move {
        run_operation(worker_id, true, |job| async move {
            tokio::task::spawn_blocking(move || {
                let job = job;
                started.send(()).unwrap();
                released.recv_timeout(Duration::from_secs(2)).unwrap();
                drop(job);
                finished.send(()).unwrap();
            })
            .await
            .unwrap();
            Ok((vec![], None))
        })
        .await
        .unwrap()
    });
    ready.await.unwrap();
    assert!(api_test_cancel(id.clone()));
    assert_eq!(task.await.unwrap().status, "cancelled");
    assert!(
        Job::start(&id).is_err(),
        "cancellation is not synchronous worker completion"
    );
    release.send(()).unwrap();
    done.await.unwrap();
    assert!(Job::start(&id).is_ok());
}
