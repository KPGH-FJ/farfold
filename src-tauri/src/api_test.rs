//! Bounded diagnostics for one explicitly chosen service; never a chat transport.
use crate::credentials::{self, ApiConfiguration, SaveInput};
use crate::meta_store::MetaStore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

const BODY_LIMIT: usize = 1024 * 1024;
static JOBS: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ApiSource {
    Saved { id: String },
    Draft { input: SaveInput },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiInput {
    pub request_id: String,
    pub source: ApiSource,
    pub model: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResult {
    request_id: String,
    status: &'static str,
    message: String,
    models: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latency_ms: Option<u64>,
}

struct Job(String);

impl Job {
    fn start(id: &str) -> Result<(Self, watch::Receiver<bool>), String> {
        if id.is_empty()
            || id.len() > 100
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("请求标识无效，请重新打开此操作".into());
        }
        let mut jobs = JOBS
            .get_or_init(Mutex::default)
            .lock()
            .map_err(|_| "API 测试暂时不可用")?;
        if jobs.contains_key(id) {
            return Err("此请求仍在进行中".into());
        }
        if jobs.len() >= 8 {
            return Err("正在进行的测试过多，请等待一个请求完成".into());
        }
        let (tx, rx) = watch::channel(false);
        jobs.insert(id.to_string(), tx);
        Ok((Self(id.to_string()), rx))
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        if let Ok(mut jobs) = JOBS.get_or_init(Mutex::default).lock() {
            jobs.remove(&self.0);
        }
    }
}

#[tauri::command]
pub fn api_test_cancel(request_id: String) -> bool {
    JOBS.get_or_init(Mutex::default)
        .lock()
        .ok()
        .and_then(|jobs| jobs.get(&request_id).map(|tx| tx.send(true).is_ok()))
        .unwrap_or(false)
}

fn client() -> Result<reqwest::Client, String> {
    crate::transport_security::ensure_rustls_crypto_provider();
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "无法准备 API 请求，请稍后重试".into())
}

fn http_error(code: u16) -> String {
    match code {
        300..=399 => "服务返回跳转，请核对基础地址；为保护密钥，本次没有跟随跳转".into(),
        401 => "API Key 未被接受，请检查密钥".into(),
        403 => "服务拒绝访问，请检查账号权限或模型权限".into(),
        404 => "服务未找到此接口或模型，请核对地址、接口格式和模型".into(),
        408 | 504 => "服务响应超时，请稍后重试".into(),
        429 => "服务当前限流或额度不足，请检查账号后重试".into(),
        500..=599 => "模型服务暂时不可用，请稍后重试".into(),
        _ => format!("服务未接受请求（HTTP {code}），请核对配置"),
    }
}

fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "连接或响应超时，请检查网络和服务地址".into()
    } else {
        "无法连接模型服务，请检查网络、证书和基础地址".into()
    }
}

async fn response_json(mut response: reqwest::Response) -> Result<Value, String> {
    if !response.status().is_success() {
        return Err(http_error(response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|size| size > BODY_LIMIT as u64)
    {
        return Err("服务返回的内容过大，本次检查已停止".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if body.len().saturating_add(chunk.len()) > BODY_LIMIT {
            return Err("服务返回的内容过大，本次检查已停止".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "服务没有返回可识别的结果，请检查接口格式".into())
}

fn request(
    client: &reqwest::Client,
    config: &ApiConfiguration,
    model: Option<&str>,
) -> Result<reqwest::RequestBuilder, String> {
    let path = match model {
        None => "models",
        Some(_) => match config.api_type.as_str() {
            "chat-completions" => "chat/completions",
            "responses" => "responses",
            "messages" => "messages",
            _ => return Err("请选择接口格式".into()),
        },
    };
    let base = crate::api_endpoint::base_url(&config.endpoint, &config.api_type)?;
    let url = format!("{base}/{path}");
    let mut request = if model.is_some() {
        client.post(url)
    } else {
        client.get(url)
    };
    request = if config.api_type == "messages" {
        request
            .header("x-api-key", &config.secret)
            .header("anthropic-version", "2023-06-01")
    } else {
        request.bearer_auth(&config.secret)
    };
    if let Some(model) = model {
        if !credentials::valid_model(model) {
            return Err("请选择有效的模型".into());
        }
        let body = match config.api_type.as_str() {
            "responses" => {
                json!({"model":model,"input":"Reply exactly OK.","max_output_tokens":64,"stream":false,"store":false})
            }
            _ => {
                json!({"model":model,"messages":[{"role":"user","content":"Reply exactly OK."}],"max_tokens":64,"stream":false})
            }
        };
        request = request.json(&body);
    }
    Ok(request)
}

fn parse_models(value: &Value) -> Result<Vec<String>, String> {
    let rows = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or("此服务未提供可读取的模型列表，请手动添加模型 ID")?;
    let mut seen = HashSet::new();
    let models: Vec<String> = rows
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str))
        .filter(|id| credentials::valid_model(id) && seen.insert((*id).to_string()))
        .take(500)
        .map(str::to_string)
        .collect();
    if models.is_empty() {
        return Err("服务没有返回可用模型，请手动添加模型 ID".into());
    }
    Ok(models)
}

fn parse_text(value: &Value, api: &str, secret: &str) -> Result<String, String> {
    let limited = match api {
        "chat-completions" => {
            value
                .pointer("/choices/0/finish_reason")
                .and_then(Value::as_str)
                == Some("length")
        }
        "responses" => {
            value
                .pointer("/incomplete_details/reason")
                .and_then(Value::as_str)
                == Some("max_output_tokens")
        }
        "messages" => value.get("stop_reason").and_then(Value::as_str) == Some("max_tokens"),
        _ => false,
    };
    if limited {
        return Err("模型服务已响应，但本次简短测试达到输出上限，未验证完整回复。可以保存配置；完整回复与 Agent 兼容性仍需验证".into());
    }
    let text = match api {
        "chat-completions" => value
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .map(str::to_string),
        "responses" => value.get("output").and_then(Value::as_array).map(|items| {
            items
                .iter()
                .filter_map(|v| v.get("content").and_then(Value::as_array))
                .flatten()
                .filter(|v| v.get("type").and_then(Value::as_str) == Some("output_text"))
                .filter_map(|v| v.get("text").and_then(Value::as_str))
                .collect::<String>()
        }),
        "messages" => value.get("content").and_then(Value::as_array).map(|items| {
            items
                .iter()
                .filter(|v| v.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|v| v.get("text").and_then(Value::as_str))
                .collect::<String>()
        }),
        _ => None,
    }
    .filter(|text| !text.trim().is_empty())
    .ok_or("已收到响应，但未取得文字结果，请检查模型和接口格式")?;
    Ok(text
        .replace(secret, "[已隐藏密钥]")
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(256)
        .collect())
}

async fn perform(
    config: ApiConfiguration,
    model: Option<String>,
) -> Result<(Vec<String>, Option<String>), String> {
    let client = client()?;
    let response = request(&client, &config, model.as_deref())?
        .send()
        .await
        .map_err(network_error)?;
    let value = response_json(response).await?;
    match model {
        None => {
            let models: Vec<_> = parse_models(&value)?
                .into_iter()
                .filter(|model| !model.contains(&config.secret))
                .collect();
            if models.is_empty() {
                return Err("服务没有返回可用模型，请手动添加模型 ID".into());
            }
            Ok((models, None))
        }
        Some(_) => Ok((
            vec![],
            Some(parse_text(&value, &config.api_type, &config.secret)?),
        )),
    }
}

async fn execute(store: MetaStore, input: ApiInput, test: bool) -> Result<ApiResult, String> {
    let model = if test {
        Some(
            input
                .model
                .filter(|m| credentials::valid_model(m))
                .ok_or("请选择需要测试的模型")?,
        )
    } else {
        None
    };
    let operation = move |job: Arc<Job>| async move {
        let config = store
            .run(move |store| {
                // Keychain is synchronous. A cancelled caller must not release
                // the request slot while this worker still owns the operation.
                let _job = job;
                match input.source {
                    ApiSource::Saved { id } => {
                        credentials::api_configuration(store, Some(&id), None)
                    }
                    ApiSource::Draft { input } => {
                        credentials::api_configuration(store, None, Some(&input))
                    }
                }
            })
            .await?;
        perform(config, model).await
    };
    run_operation(input.request_id, test, operation).await
}

async fn run_operation<F>(
    request_id: String,
    test: bool,
    operation: impl FnOnce(Arc<Job>) -> F,
) -> Result<ApiResult, String>
where
    F: std::future::Future<Output = Result<(Vec<String>, Option<String>), String>>,
{
    let (job, mut cancellation) = Job::start(&request_id)?;
    let job = Arc::new(job);
    let operation = operation(job.clone());
    let started = Instant::now();
    let outcome = tokio::select! {
        biased;
        _ = cancellation.wait_for(|cancelled| *cancelled) => None,
        result = operation => Some(result),
    };
    let mut result = ApiResult {
        request_id,
        status: "cancelled",
        message: "已取消本次检查".into(),
        models: vec![],
        response_text: None,
        latency_ms: None,
    };
    match outcome {
        Some(Ok((models, text))) => {
            result.status = "success";
            result.message = if test {
                "已收到此模型的响应；Agent 的兼容性需分别确认"
            } else {
                "已读取模型列表"
            }
            .into();
            result.models = models;
            result.response_text = text;
            result.latency_ms = Some(started.elapsed().as_millis().min(u64::MAX as u128) as u64);
        }
        Some(Err(error)) => {
            result.status = "failed";
            result.message = error;
        }
        None => {}
    }
    Ok(result)
}

#[tauri::command]
pub async fn api_models(app: AppHandle, input: ApiInput) -> Result<ApiResult, String> {
    execute(app.state::<MetaStore>().inner().clone(), input, false).await
}

#[tauri::command]
pub async fn api_test(app: AppHandle, input: ApiInput) -> Result<ApiResult, String> {
    execute(app.state::<MetaStore>().inner().clone(), input, true).await
}

#[cfg(test)]
mod tests;
