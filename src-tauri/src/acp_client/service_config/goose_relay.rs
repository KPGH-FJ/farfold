//! A single Goose connection's adapter for one selected Chat Completions service.
use std::{
    collections::VecDeque, convert::Infallible, io, net::Ipv4Addr, sync::Arc, time::Duration,
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use http_body_util::{BodyExt, Full, Limited, StreamBody, combinators::UnsyncBoxBody};
use hyper::{
    HeaderMap, Method, Request, Response, StatusCode,
    body::{Body, Bytes, Frame, Incoming},
    header::{ACCEPT, AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, HOST, HeaderName, HeaderValue},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::{
    net::TcpListener,
    task::{JoinHandle, JoinSet},
    time::timeout,
};

const CONNECTIONS: usize = 8;
const HEADER_LIMIT: usize = 32 * 1024;
const REQUEST_LIMIT: usize = 8 * 1024 * 1024;
const RESPONSE_LIMIT: usize = 32 * 1024 * 1024;
const EVENT_LIMIT: usize = 1024 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(5);
const BODY_TIMEOUT: Duration = Duration::from_secs(10);
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(300);
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(320);
const START_ERROR: &str = "无法准备所选 API 服务，请检查配置后重试";

type RelayBody = UnsyncBoxBody<Bytes, io::Error>;

pub(crate) struct Relay {
    base_url: String,
    token: String,
    server: JoinHandle<()>,
}

impl Relay {
    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    pub(crate) fn token(&self) -> &str {
        &self.token
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        // Dropping the listener task's JoinSet cancels every accepted request,
        // including the corresponding upstream future or response stream.
        self.server.abort();
    }
}

// No Debug or serialization. Only the local credential crosses into Goose.
struct Route {
    host: String,
    authorization: String,
    model: String,
    upstream: reqwest::Url,
    upstream_authorization: HeaderValue,
    client: reqwest::Client,
}

pub(crate) async fn start(endpoint: String, model: String, key: String) -> Result<Relay, String> {
    let base = crate::credentials::validate_endpoint(&endpoint)?;
    let upstream =
        reqwest::Url::parse(&format!("{base}/chat/completions")).map_err(|_| START_ERROR)?;
    spawn(upstream, model, key, client(true)?).await
}

fn client(https_only: bool) -> Result<reqwest::Client, String> {
    crate::transport_security::ensure_rustls_crypto_provider();
    reqwest::Client::builder()
        .https_only(https_only)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(60))
        .timeout(UPSTREAM_TIMEOUT)
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|_| START_ERROR.into())
}

async fn spawn(
    upstream: reqwest::Url,
    model: String,
    key: String,
    client: reqwest::Client,
) -> Result<Relay, String> {
    if !crate::credentials::valid_model(&model) || key.trim().is_empty() || key.len() > 16384 {
        return Err(START_ERROR.into());
    }
    let mut upstream_authorization =
        HeaderValue::from_str(&format!("Bearer {key}")).map_err(|_| START_ERROR)?;
    upstream_authorization.set_sensitive(true);
    let mut random = [0_u8; 32];
    getrandom::fill(&mut random).map_err(|_| START_ERROR)?;
    let token = URL_SAFE_NO_PAD.encode(random);
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| START_ERROR)?;
    let address = listener.local_addr().map_err(|_| START_ERROR)?;
    let route = Arc::new(Route {
        host: address.to_string(),
        authorization: format!("Bearer {token}"),
        model,
        upstream,
        upstream_authorization,
        client,
    });
    Ok(Relay {
        base_url: format!("http://{address}/v1"),
        token,
        server: tokio::spawn(serve(listener, route)),
    })
}

async fn serve(listener: TcpListener, route: Arc<Route>) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = connections.join_next(), if !connections.is_empty() => {}
            incoming = listener.accept() => {
                let Ok((socket, peer)) = incoming else { break };
                if !peer.ip().is_loopback() || connections.len() >= CONNECTIONS {
                    continue;
                }
                let route = route.clone();
                connections.spawn(async move {
                    let service = service_fn(move |request| {
                        let route = route.clone();
                        async move { Ok::<_, Infallible>(dispatch(request, &route).await) }
                    });
                    let mut http = http1::Builder::new();
                    http.keep_alive(false)
                        .max_headers(32)
                        .max_buf_size(HEADER_LIMIT)
                        .timer(TokioTimer::new())
                        .header_read_timeout(HEAD_TIMEOUT);
                    let connection = http.serve_connection(TokioIo::new(socket), service);
                    let _ = timeout(CONNECTION_TIMEOUT, connection).await;
                });
            }
        }
    }
}

fn one_header(headers: &HeaderMap, name: HeaderName) -> Option<&HeaderValue> {
    let values = headers.get_all(name);
    let mut iter = values.iter();
    let value = iter.next()?;
    iter.next().is_none().then_some(value)
}

async fn dispatch(request: Request<Incoming>, route: &Route) -> Response<RelayBody> {
    if request.uri().authority().is_some()
        || request.uri().scheme().is_some()
        || one_header(request.headers(), HOST).map(HeaderValue::as_bytes)
            != Some(route.host.as_bytes())
    {
        return error(StatusCode::BAD_REQUEST, "地址无效");
    }
    if !one_header(request.headers(), AUTHORIZATION).is_some_and(|supplied| {
        bool::from(supplied.as_bytes().ct_eq(route.authorization.as_bytes()))
    }) {
        return error(StatusCode::UNAUTHORIZED, "当前连接未获授权");
    }
    match (
        request.method(),
        request.uri().path_and_query().map(|uri| uri.as_str()),
    ) {
        (&Method::GET, Some("/v1/models")) if request.body().is_end_stream() => {
            // The user already picked this model. A vendor model list is
            // optional and does not verify that the user's key can run it.
            json_response(
                StatusCode::OK,
                json!({
                    "object": "list",
                    "data": [{ "id": &route.model, "object": "model" }]
                }),
            )
        }
        (&Method::POST, Some("/v1/chat/completions")) => chat(request, route).await,
        _ => error(StatusCode::NOT_FOUND, "当前连接未提供此操作"),
    }
}

async fn chat(request: Request<Incoming>, route: &Route) -> Response<RelayBody> {
    if !has_mime(request.headers(), "application/json") {
        return error(StatusCode::BAD_REQUEST, "模型请求格式无效");
    }
    if request.body().size_hint().lower() > REQUEST_LIMIT as u64 {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "模型请求内容过大");
    }
    let input = match timeout(
        BODY_TIMEOUT,
        Limited::new(request.into_body(), REQUEST_LIMIT).collect(),
    )
    .await
    {
        Ok(Ok(body)) => body.to_bytes(),
        Ok(Err(cause)) if cause.is::<http_body_util::LengthLimitError>() => {
            return error(StatusCode::PAYLOAD_TOO_LARGE, "模型请求内容过大");
        }
        Ok(Err(_)) => return error(StatusCode::BAD_REQUEST, "无法读取模型请求"),
        Err(_) => return error(StatusCode::REQUEST_TIMEOUT, "读取模型请求超时"),
    };
    let Ok(body) = serde_json::from_slice::<Value>(&input) else {
        return error(StatusCode::BAD_REQUEST, "模型请求格式无效");
    };
    if body.get("model").and_then(Value::as_str) != Some(route.model.as_str())
        || body.get("messages").and_then(Value::as_array).is_none()
        || body.get("models").is_some()
    {
        return error(StatusCode::BAD_REQUEST, "模型请求与所选 API 服务不符");
    }
    let streaming = match body.get("stream") {
        None => false,
        Some(Value::Bool(value)) => *value,
        _ => return error(StatusCode::BAD_REQUEST, "模型请求格式无效"),
    };
    let content_type = if streaming {
        "text/event-stream"
    } else {
        "application/json"
    };
    // Re-encode validated JSON so duplicate input keys cannot be interpreted
    // differently by this relay and the selected service. No client headers
    // or client URL participate in this outbound request.
    let response = route
        .client
        .post(route.upstream.clone())
        .header(AUTHORIZATION, route.upstream_authorization.clone())
        .header(ACCEPT, content_type)
        .json(&body)
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(cause) if cause.is_timeout() => {
            return error(StatusCode::GATEWAY_TIMEOUT, "连接模型服务超时");
        }
        Err(_) => return error(StatusCode::BAD_GATEWAY, "无法连接所选模型服务"),
    };
    if !response.status().is_success() {
        return upstream_error(response.status());
    }
    if !has_mime(response.headers(), content_type)
        || response
            .content_length()
            .is_some_and(|len| len > RESPONSE_LIMIT as u64)
    {
        return error(StatusCode::BAD_GATEWAY, "模型服务返回了无效内容");
    }
    if streaming {
        return respond(StatusCode::OK, content_type, stream(response));
    }
    non_streaming(response).await
}

fn has_mime(headers: &HeaderMap, expected: &str) -> bool {
    one_header(headers, CONTENT_TYPE)
        .and_then(|header| header.to_str().ok()?.split(';').next())
        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case(expected))
}

fn stream(response: reqwest::Response) -> RelayBody {
    let source = Sse {
        response,
        pending: VecDeque::new(),
        remaining: RESPONSE_LIMIT,
        cursor: 0,
        line_start: 0,
    };
    let chunks = futures_lite::stream::try_unfold(source, |mut source| async move {
        Ok::<_, io::Error>(
            source
                .next_event()
                .await?
                .map(|bytes| (Frame::data(bytes), source)),
        )
    });
    StreamBody::new(chunks).boxed_unsync()
}

struct Sse {
    response: reqwest::Response,
    pending: VecDeque<u8>,
    remaining: usize,
    cursor: usize,
    line_start: usize,
}

impl Sse {
    async fn next_event(&mut self) -> Result<Option<Bytes>, io::Error> {
        let mut end_of_body = false;
        loop {
            if let Some(end) = self.event_end(end_of_body) {
                if end > EVENT_LIMIT {
                    return Err(response_interrupted());
                }
                let bytes: Vec<_> = self.pending.drain(..end).collect();
                self.cursor = 0;
                self.line_start = 0;
                if usable_event(&bytes) {
                    return Ok(Some(Bytes::from(bytes)));
                }
                return Err(response_interrupted());
            }
            if self.pending.len() > EVENT_LIMIT {
                return Err(response_interrupted());
            }
            if end_of_body {
                return if self.pending.is_empty() {
                    Ok(None)
                } else {
                    Err(response_interrupted())
                };
            }
            match self
                .response
                .chunk()
                .await
                .map_err(|_| response_interrupted())?
            {
                Some(chunk) => {
                    self.remaining = self
                        .remaining
                        .checked_sub(chunk.len())
                        .ok_or_else(response_interrupted)?;
                    self.pending.extend(chunk.iter().copied());
                }
                None => end_of_body = true,
            }
        }
    }

    fn event_end(&mut self, end_of_body: bool) -> Option<usize> {
        while let Some(byte) = self.pending.get(self.cursor) {
            let end = match *byte {
                b'\n' => self.cursor + 1,
                b'\r' => match self.pending.get(self.cursor + 1) {
                    Some(b'\n') => self.cursor + 2,
                    Some(_) => self.cursor + 1,
                    None if end_of_body => self.cursor + 1,
                    None => return None,
                },
                _ => {
                    self.cursor += 1;
                    continue;
                }
            };
            if self.line_start == self.cursor {
                return Some(end);
            }
            self.cursor = end;
            self.line_start = end;
        }
        None
    }
}

fn usable_event(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let mut data = String::new();
    for line in text.split_terminator(['\r', '\n']) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.strip_prefix(' ').unwrap_or(value);
        match name {
            "event" if value.trim().eq_ignore_ascii_case("error") => return false,
            "data" => {
                data.push_str(value);
                data.push('\n');
            }
            _ => {}
        }
    }
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return true;
    }
    serde_json::from_str::<Value>(data).is_ok_and(|value| usable_json(&value))
}

fn usable_json(value: &Value) -> bool {
    value.is_object()
        && value.get("error").is_none_or(Value::is_null)
        && value.get("type").and_then(Value::as_str) != Some("error")
}

fn response_interrupted() -> io::Error {
    io::Error::other("无法继续读取模型服务的响应")
}

async fn non_streaming(mut response: reqwest::Response) -> Response<RelayBody> {
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if body.len() + chunk.len() <= RESPONSE_LIMIT => {
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            _ => return error(StatusCode::BAD_GATEWAY, "无法读取模型服务的响应"),
        }
    }
    match serde_json::from_slice::<Value>(&body) {
        Ok(value) if usable_json(&value) => {
            respond(StatusCode::OK, "application/json", full(Bytes::from(body)))
        }
        _ => error(StatusCode::BAD_GATEWAY, "模型服务返回了无效内容"),
    }
}

fn upstream_error(status: StatusCode) -> Response<RelayBody> {
    let (status, message) = match status {
        status if status.is_redirection() => (
            StatusCode::BAD_REQUEST,
            "模型服务返回跳转，请检查 API 基础地址",
        ),
        StatusCode::UNAUTHORIZED => (status, "所选 API 未接受密钥，请检查密钥"),
        StatusCode::FORBIDDEN => (status, "模型服务拒绝访问，请检查账号与模型权限"),
        StatusCode::NOT_FOUND => (status, "模型服务未找到所选接口或模型"),
        StatusCode::TOO_MANY_REQUESTS => (status, "模型服务已限流或额度不足"),
        StatusCode::REQUEST_TIMEOUT | StatusCode::GATEWAY_TIMEOUT => (status, "模型服务响应超时"),
        status if status.is_client_error() => (StatusCode::BAD_REQUEST, "模型服务未接受请求"),
        _ => (StatusCode::BAD_GATEWAY, "模型服务暂时不可用"),
    };
    error(status, message)
}

fn error(status: StatusCode, message: &'static str) -> Response<RelayBody> {
    json_response(
        status,
        json!({ "error": {
            "message": message,
            "type": "api_error",
            "code": status.as_u16(),
        }}),
    )
}

fn json_response(status: StatusCode, body: Value) -> Response<RelayBody> {
    respond(
        status,
        "application/json",
        full(Bytes::from(body.to_string())),
    )
}

fn full(bytes: Bytes) -> RelayBody {
    Full::new(bytes)
        .map_err(|never| match never {})
        .boxed_unsync()
}

fn respond(status: StatusCode, content_type: &'static str, body: RelayBody) -> Response<RelayBody> {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::LOCATION;
    use tokio::sync::{mpsc, oneshot};

    const MODEL: &str = "synthetic_model";
    const KEY: &str = "synthetic-upstream-key";
    const PRIVATE_ERROR: &str = "secret upstream error canary";

    struct Observation {
        path: String,
        headers: HeaderMap,
        body: Bytes,
    }

    async fn mocked_upstream(
        reply: impl Fn(&Observation) -> Response<RelayBody> + Send + Sync + 'static,
    ) -> (String, mpsc::UnboundedReceiver<Observation>, JoinHandle<()>) {
        let socket = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let base = format!("http://{}/selected", socket.local_addr().unwrap());
        let (seen, received) = mpsc::unbounded_channel();
        let reply = Arc::new(reply);
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    _ = connections.join_next(), if !connections.is_empty() => {}
                    accepted = socket.accept() => {
                        let (socket, _) = accepted.unwrap();
                        let reply = reply.clone();
                        let seen = seen.clone();
                        connections.spawn(async move {
                            let service = service_fn(move |request: Request<Incoming>| {
                                let reply = reply.clone();
                                let seen = seen.clone();
                                async move {
                                    let (parts, body) = request.into_parts();
                                    let observation = Observation {
                                        path: parts.uri.to_string(),
                                        headers: parts.headers,
                                        body: body.collect().await.unwrap().to_bytes(),
                                    };
                                    let response = reply(&observation);
                                    let _ = seen.send(observation);
                                    Ok::<_, Infallible>(response)
                                }
                            });
                            let _ = http1::Builder::new()
                                .serve_connection(TokioIo::new(socket), service).await;
                        });
                    }
                }
            }
        });
        (base, received, task)
    }

    async fn start_for_fixture(base: &str) -> Relay {
        spawn(
            reqwest::Url::parse(&format!("{base}/chat/completions")).unwrap(),
            MODEL.into(),
            KEY.into(),
            client(false).unwrap(),
        )
        .await
        .unwrap()
    }

    fn post(relay: &Relay, body: &Value) -> reqwest::RequestBuilder {
        client(false)
            .unwrap()
            .post(format!("{}/chat/completions", relay.base_url()))
            .bearer_auth(relay.token())
            .json(body)
    }

    fn prompt(model: &str, streaming: bool) -> Value {
        json!({
            "model": model,
            "stream": streaming,
            "messages": [{ "role": "user", "content": "synthetic prompt" }],
        })
    }

    #[tokio::test]
    async fn only_the_selected_request_reaches_the_fixed_endpoint() {
        let (upstream, mut received, fixture) =
            mocked_upstream(|_| json_response(StatusCode::OK, json!({ "choices": [] }))).await;
        let relay = start_for_fixture(&upstream).await;
        let local = client(false).unwrap();
        let list = format!("{}/models", relay.base_url());
        let models: Value = local
            .get(&list)
            .bearer_auth(relay.token())
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(models["data"], json!([{ "id": MODEL, "object": "model" }]));
        for request in [
            local.get(&list).bearer_auth("another-local-token"),
            local
                .get(format!("{list}?unexpected"))
                .bearer_auth(relay.token()),
            local
                .get(&list)
                .bearer_auth(relay.token())
                .header(HOST, "unselected.test"),
            post(&relay, &prompt("unselected", false)),
            post(
                &relay,
                &json!({"model":MODEL,"models":["unselected"],"messages":[]}),
            ),
        ] {
            assert!(!request.send().await.unwrap().status().is_success());
        }
        assert!(received.try_recv().is_err());
        let reply = post(&relay, &prompt(MODEL, false))
            .header("x-client-private", "local secret")
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), StatusCode::OK);
        let wire = received.recv().await.unwrap();
        assert_eq!(wire.path, "/selected/chat/completions");
        assert_eq!(wire.headers[AUTHORIZATION], format!("Bearer {KEY}"));
        assert!(!wire.headers.contains_key("x-client-private"));
        assert_eq!(
            serde_json::from_slice::<Value>(&wire.body).unwrap(),
            prompt(MODEL, false)
        );
        assert!(received.try_recv().is_err());
        fixture.abort();
    }

    #[tokio::test]
    async fn never_follows_redirects_or_returns_private_error_content() {
        let (other, mut escaped, other_fixture) =
            mocked_upstream(|_| json_response(StatusCode::OK, json!({ "choices": [] }))).await;
        let destination = HeaderValue::from_str(&format!("{other}/unexpected")).unwrap();
        let (upstream, mut received, fixture) = mocked_upstream(move |request| {
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            let status = if body["stream"] == true {
                StatusCode::TEMPORARY_REDIRECT
            } else {
                StatusCode::UNAUTHORIZED
            };
            let mut response = json_response(status, json!({ "error": PRIVATE_ERROR }));
            response.headers_mut().insert(LOCATION, destination.clone());
            response
                .headers_mut()
                .insert("x-private-error", HeaderValue::from_static(PRIVATE_ERROR));
            response
        })
        .await;
        let relay = start_for_fixture(&upstream).await;
        for (streaming, expected) in [
            (true, StatusCode::BAD_REQUEST),
            (false, StatusCode::UNAUTHORIZED),
        ] {
            let response = post(&relay, &prompt(MODEL, streaming))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            assert!(!response.headers().contains_key(LOCATION));
            assert!(!response.headers().contains_key("x-private-error"));
            assert!(!response.text().await.unwrap().contains(PRIVATE_ERROR));
            received.recv().await.unwrap();
        }
        assert!(received.try_recv().is_err());
        assert!(escaped.try_recv().is_err());
        fixture.abort();
        other_fixture.abort();
    }

    struct StreamWitness(Option<oneshot::Sender<()>>);

    impl Drop for StreamWitness {
        fn drop(&mut self) {
            if let Some(signal) = self.0.take() {
                let _ = signal.send(());
            }
        }
    }

    #[test]
    fn rejects_explicit_and_json_stream_errors_before_forwarding_the_event() {
        assert!(usable_event(b"data: {\"choices\":[]}\r\n\r\n"));
        assert!(usable_event(b"data: [DONE]\n\n"));
        assert!(!usable_event(
            b"event: error\r\ndata: {\"message\":\"private diagnostic\"}\r\n\r\n"
        ));
        assert!(!usable_event(
            b"data: {\"error\":\ndata: {\"message\":\"private diagnostic\"}}\n\n"
        ));
    }

    #[tokio::test]
    async fn streams_before_upstream_completion_and_drop_cancels_open_connections() {
        let (signal, closed) = oneshot::channel();
        let signal = std::sync::Mutex::new(Some(signal));
        let first = "data: {\"choices\":[]}\n\n";
        let (upstream, _, fixture) = mocked_upstream(move |_| {
            let witness = StreamWitness(signal.lock().unwrap().take());
            let frames =
                futures_lite::stream::unfold((witness, false), move |(witness, sent)| async move {
                    if sent {
                        std::future::pending().await
                    } else {
                        Some((
                            Ok(Frame::data(Bytes::from_static(first.as_bytes()))),
                            (witness, true),
                        ))
                    }
                });
            respond(
                StatusCode::OK,
                "text/event-stream",
                StreamBody::new(frames).boxed_unsync(),
            )
        })
        .await;
        let relay = start_for_fixture(&upstream).await;
        let address = reqwest::Url::parse(relay.base_url())
            .unwrap()
            .socket_addrs(|| None)
            .unwrap()[0];
        let mut response = post(&relay, &prompt(MODEL, true)).send().await.unwrap();
        let chunk = timeout(Duration::from_secs(3), response.chunk())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(chunk, first);
        drop(relay);
        let rest = timeout(Duration::from_secs(3), response.chunk())
            .await
            .unwrap();
        assert!(matches!(rest, Ok(None) | Err(_)));
        timeout(Duration::from_secs(3), closed)
            .await
            .unwrap()
            .unwrap();
        assert!(tokio::net::TcpStream::connect(address).await.is_err());
        fixture.abort();
    }
}
