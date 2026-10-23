//! One isolated, actual Wry/WebView2 test. Not an installed App or real Agent.
//! The only child executable uses the production MCP helper entry before run().
use super::*;
use crate::browser_workspace::{self, Bounds, windows_native_test};
use agent_client_protocol::schema::v1::McpServer;
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_lite::io::{AsyncReadExt, AsyncWriteExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{borrow::Cow, io::Read, process::Stdio, time::Duration};
use tauri::{Assets, WebviewUrl, WebviewWindowBuilder, Wry};

const WAIT: Duration = Duration::from_secs(15);
const SECRET: &str = "OWNED_P27_SECRET";

struct ParentAssets;
impl Assets<Wry> for ParentAssets {
    fn get(&self, _: &tauri::utils::assets::AssetKey) -> Option<Cow<'_, [u8]>> {
        Some(Cow::Borrowed(
            b"<!doctype html><title>Owned native parent</title>",
        ))
    }
    fn iter(&self) -> Box<tauri::utils::assets::AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(
        &self,
        _: &tauri::utils::assets::AssetKey,
    ) -> Box<dyn Iterator<Item = tauri::utils::assets::CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

fn require(ok: bool, phase: &str) -> Result<(), String> {
    ok.then_some(()).ok_or_else(|| phase.to_owned())
}
fn runtime_condition() -> Result<(), String> {
    let mut version = windows::core::PWSTR::null();
    let outcome = unsafe {
        webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString(
            windows::core::PCWSTR::null(),
            &mut version,
        )
    };
    let code = outcome
        .as_ref()
        .err()
        .map(|error| error.code().0)
        .unwrap_or(0);
    let version = if outcome.is_ok() {
        webview2_com::CoTaskMemPWSTR::from(version).to_string()
    } else {
        String::new()
    };
    eprintln!(
        "FARFOLD_P27_NATIVE_PHASE {}",
        json!({"phase":"official-runtime-discovery","hresult":code,"version":version})
    );
    require(
        outcome.is_ok(),
        "official WebView2 Runtime condition unavailable",
    )
}
fn main_view(app: &AppHandle) -> Result<Webview, String> {
    let window = app.get_webview_window("main").ok_or("main missing")?;
    let view: &Webview = window.as_ref();
    Ok(view.clone())
}
fn digest_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|_| "helper file open")?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let size = file.read(&mut buffer).map_err(|_| "helper file read")?;
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
async fn wait_until(mut ready: impl FnMut() -> bool) -> Result<(), String> {
    tokio::time::timeout(WAIT, async {
        while !ready() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .map_err(|_| "bounded state wait expired".to_owned())
}
async fn native_facts(app: &AppHandle) -> Result<Value, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = send.send(windows_native_test::facts());
    })
    .map_err(|_| "facts dispatch")?;
    tokio::time::timeout(WAIT, receive)
        .await
        .map_err(|_| "facts wait")?
        .map_err(|_| "facts retired".to_owned())
}

struct Peer {
    child: async_process::Child,
    input: Option<async_process::ChildStdin>,
    output: async_process::ChildStdout,
    error: Option<async_process::ChildStderr>,
    buffered: Vec<u8>,
    binary_sha256: String,
    pid: u32,
}
impl Peer {
    fn start(server: agent_client_protocol::schema::v1::McpServerStdio) -> Result<Self, String> {
        let current = std::env::current_exe().map_err(|_| "current test executable")?;
        let helper = current
            .parent()
            .and_then(Path::parent)
            .ok_or("test executable parent")?
            .join("farfold.exe");
        require(
            helper.is_file(),
            "same-job production helper binary missing",
        )?;
        let binary_sha256 = digest_file(&helper)?;
        // libtest's current_exe is NOT a browser-helper main. Only this test
        // program location is replaced. Exact original args and short-lived
        // capability env are retained in memory, never printed or persisted.
        let mut command = async_process::Command::new(helper);
        command
            .args(server.args)
            .envs(server.env.into_iter().map(|pair| (pair.name, pair.value)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|_| "helper-only child spawn")?;
        let pid = child.id();
        Ok(Self {
            input: child.stdin.take(),
            output: child.stdout.take().ok_or("helper stdout missing")?,
            error: child.stderr.take(),
            child,
            buffered: Vec::new(),
            binary_sha256,
            pid,
        })
    }
    async fn send(&mut self, value: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&value).map_err(|_| "owned request encode")?;
        require(bytes.len() <= 65_536, "owned request bound")?;
        bytes.push(b'\n');
        let input = self.input.as_mut().ok_or("peer input closed")?;
        tokio::time::timeout(WAIT, input.write_all(&bytes))
            .await
            .map_err(|_| "helper input wait")?
            .map_err(|_| "helper input write".to_owned())
    }
    async fn response(&mut self, id: u64) -> Result<Value, String> {
        tokio::time::timeout(WAIT, async {
            loop {
                if let Some(end) = self.buffered.iter().position(|b| *b == b'\n') {
                    let line: Vec<_> = self.buffered.drain(..=end).collect();
                    let value: Value = serde_json::from_slice(&line).map_err(|_| "helper JSON")?;
                    require(
                        value["id"] == id && value["jsonrpc"] == "2.0",
                        "original MCP reply id",
                    )?;
                    return Ok(value);
                }
                let mut bytes = [0u8; 8192];
                let size = self
                    .output
                    .read(&mut bytes)
                    .await
                    .map_err(|_| "helper stdout read")?;
                require(size != 0, "helper stdout ended before reply")?;
                require(
                    self.buffered.len() + size <= 600_000,
                    "helper response bound",
                )?;
                self.buffered.extend_from_slice(&bytes[..size]);
            }
        })
        .await
        .map_err(|_| "MCP reply wait expired")?
    }
    async fn call(&mut self, id: u64, name: &str, args: Value) -> Result<(), String> {
        self.send(json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":args}})).await
    }
    async fn finish(mut self) -> Result<Value, String> {
        self.input.take();
        let status = match tokio::time::timeout(WAIT, self.child.status()).await {
            Ok(status) => status.map_err(|_| "helper status")?,
            Err(_) => {
                let _ = self.child.kill();
                let _ = tokio::time::timeout(WAIT, self.child.status()).await;
                return Err(
                    "helper original process did not settle; owned termination attempted".into(),
                );
            }
        };
        let mut stderr = Vec::new();
        if let Some(error) = self.error.take() {
            tokio::time::timeout(WAIT, error.take(8193).read_to_end(&mut stderr))
                .await
                .map_err(|_| "helper stderr wait")?
                .map_err(|_| "helper stderr read")?;
        }
        // Keep the original child's terminal observation even when the earlier
        // protocol step failed. Never print MCP bodies or launch credentials.
        eprintln!(
            "FARFOLD_P27_NATIVE_PHASE {}",
            json!({"phase":"original-helper-ended","pid":self.pid,"naturalExit":status.code(),"stderrBytes":stderr.len()})
        );
        require(
            status.success() && stderr.is_empty(),
            "helper natural exit zero/empty stderr",
        )?;
        Ok(
            json!({"pid":self.pid,"binarySha256":self.binary_sha256,"naturalExit":status.code(),"stderrBytes":stderr.len()}),
        )
    }
}

async fn respond(
    app: &AppHandle,
    target: &ShareTarget,
    task: &str,
    owner: &ToolSession,
    allow: bool,
    screenshot: bool,
) -> Result<(), String> {
    wait_until(|| owner.info(task, "").pending_request.is_some()).await?;
    let pending = owner
        .info(task, "")
        .pending_request
        .ok_or("permission missing")?;
    let visible = serde_json::to_value(&pending).map_err(|_| "permission encode")?;
    if screenshot {
        require(
            visible["control"]["kind"] == "screenshot",
            "distinct screenshot decision",
        )?;
    }
    browser_share_respond(
        main_view(app)?,
        app.clone(),
        app.state(),
        task.into(),
        pending.label,
        target.clone(),
        pending.request_id,
        allow,
    )
    .await?;
    Ok(())
}

async fn open_case(app: &AppHandle, task: &str, route: &str) -> Result<BrowserInfo, String> {
    let bounds = Bounds {
        x: 8.0,
        y: 8.0,
        width: 640.0,
        height: 420.0,
    };
    let info = browser_workspace::browser_workspace_open(
        main_view(app)?,
        app.clone(),
        app.state(),
        task.into(),
        format!("{}{route}", windows_native_test::ORIGIN),
        bounds,
    )
    .await?;
    let tabs = browser_workspace::tab_commands::browser_workspace_tabs(
        main_view(app)?,
        app.state(),
        task.into(),
    )?;
    browser_workspace::tab_commands::browser_workspace_select(
        main_view(app)?,
        app.clone(),
        app.state(),
        task.into(),
        Some(info.label.clone()),
        tabs.selection,
    )
    .await?;
    browser_workspace::browser_workspace_set_visible(
        main_view(app)?,
        app.clone(),
        app.state(),
        task.into(),
        info.label.clone(),
        true,
        Some(bounds),
    )
    .await?;
    wait_until(|| {
        app.state::<BrowserWorkspace>()
            .permission_page(task)
            .is_ok()
    })
    .await?;
    app.state::<BrowserWorkspace>().permission_page(task)
}

fn image(response: &Value) -> Result<Vec<u8>, String> {
    let items = response["result"]["content"]
        .as_array()
        .ok_or("MCP content")?;
    let images: Vec<_> = items.iter().filter(|v| v["type"] == "image").collect();
    require(images.len() == 1, "exactly one actual image")?;
    require(images[0]["mimeType"] == "image/png", "actual image MIME")?;
    let data = images[0]["data"].as_str().ok_or("actual image payload")?;
    require(
        !items
            .iter()
            .filter(|v| v["type"] == "text")
            .any(|v| v["text"].as_str().unwrap_or("").contains(data)),
        "image not repeated in text",
    )?;
    STANDARD
        .decode(data)
        .map_err(|_| "actual PNG base64".into())
}
fn no_image(response: &Value) -> Result<(), String> {
    require(
        !response.to_string().contains(SECRET),
        "protected value must never escape",
    )?;
    require(
        response["result"]["isError"] == true,
        "refusal must be an actual tool error",
    )?;
    require(
        response["result"]["structuredContent"].is_null(),
        "no unrequested text or nodes fallback",
    )?;
    let images = response["result"]["content"]
        .as_array()
        .map(|a| a.iter().filter(|v| v["type"] == "image").count())
        .unwrap_or(0);
    require(images == 0, "refused/retired request emitted pixels")
}

// Pixel oracle only: original native capture and production PNG checks already
// ran. Decode bounded Chromium RGB/RGBA8 scanlines without another browser.
fn center_pixel(bytes: &[u8]) -> Result<[u8; 3], String> {
    require(bytes.starts_with(b"\x89PNG\r\n\x1a\n"), "PNG signature")?;
    let (mut width, mut height, mut channels) = (0usize, 0usize, 0usize);
    let mut compressed = Vec::new();
    let mut offset = 8usize;
    while offset + 12 <= bytes.len() {
        let size = u32::from_be_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .map_err(|_| "PNG length")?,
        ) as usize;
        let end = offset.checked_add(size + 12).ok_or("PNG chunk overflow")?;
        require(end <= bytes.len(), "PNG chunk bound")?;
        let body = &bytes[offset + 8..offset + 8 + size];
        match &bytes[offset + 4..offset + 8] {
            b"IHDR" => {
                require(
                    body.len() == 13 && body[8] == 8 && body[12] == 0,
                    "PNG RGB geometry",
                )?;
                width = u32::from_be_bytes(body[..4].try_into().map_err(|_| "PNG width")?) as usize;
                height =
                    u32::from_be_bytes(body[4..8].try_into().map_err(|_| "PNG height")?) as usize;
                channels = match body[9] {
                    2 => 3,
                    6 => 4,
                    _ => return Err("unexpected native PNG color type".into()),
                };
            }
            b"IDAT" => compressed.extend_from_slice(body),
            b"IEND" => break,
            _ => {}
        }
        offset = end;
    }
    require(
        width > 0 && height > 0 && width <= 1024 && height <= 1024,
        "PNG dimensions bounded",
    )?;
    let stride = width * channels;
    let expected = (stride + 1) * height;
    let mut rows = Vec::new();
    flate2::read::ZlibDecoder::new(compressed.as_slice())
        .take((expected + 1) as u64)
        .read_to_end(&mut rows)
        .map_err(|_| "PNG inflate")?;
    require(rows.len() == expected, "PNG exact expanded length")?;
    let mut previous = vec![0u8; stride];
    for y in 0..=height / 2 {
        let filter = rows[y * (stride + 1)];
        let mut row = rows[y * (stride + 1) + 1..(y + 1) * (stride + 1)].to_vec();
        for x in 0..stride {
            let left = if x >= channels { row[x - channels] } else { 0 };
            let above = previous[x];
            let upper_left = if x >= channels {
                previous[x - channels]
            } else {
                0
            };
            let predict = match filter {
                0 => 0,
                1 => left,
                2 => above,
                3 => ((left as u16 + above as u16) / 2) as u8,
                4 => {
                    let p = left as i32 + above as i32 - upper_left as i32;
                    let a = (p - left as i32).abs();
                    let b = (p - above as i32).abs();
                    let c = (p - upper_left as i32).abs();
                    if a <= b && a <= c {
                        left
                    } else if b <= c {
                        above
                    } else {
                        upper_left
                    }
                }
                _ => return Err("PNG filter".into()),
            };
            row[x] = row[x].wrapping_add(predict);
        }
        previous = row;
    }
    let x = (width / 2) * channels;
    Ok([previous[x], previous[x + 1], previous[x + 2]])
}

async fn run_cases(app: &AppHandle) -> Result<Value, String> {
    wait_until(|| main_view(app).is_ok_and(|view| browser_workspace::caller_allowed(&view)))
        .await?;
    let cwd = tempfile::tempdir().map_err(|_| "owned conversation fixture directory")?;
    let target = ShareTarget {
        agent_id: "controlled-p27".into(),
        cwd: cwd.path().to_string_lossy().into_owned(),
        native_session_id: "owned-native".into(),
    };
    let task = format!(
        "{}:{}:{}",
        target.agent_id, target.cwd, target.native_session_id
    );
    let sharing = app.state::<BrowserSharing>();
    let mut offer = sharing.prepare(app, &target.agent_id, cwd.path())?;
    let server = match offer.servers().pop().ok_or("MCP offer")? {
        McpServer::Stdio(server) => server,
        _ => return Err("unexpected MCP offer type".into()),
    };
    let lease = offer.bind_route(&target.native_session_id)?;
    let requests = lease.requests();
    requests.set_prompt_active(true);
    offer.finish_opening();
    let owner = sharing
        .entry(&target, &task)?
        .ok_or("original tool owner missing")?;
    let mut peer = Peer::start(server)?;
    let mut opened = Vec::new();
    let result=async {
        eprintln!("FARFOLD_P27_NATIVE_PHASE {{\"phase\":\"helper-initialize-request\"}}");
        peer.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"owned-native-p27","version":"1"}}})).await?;
        require(peer.response(1).await?["result"]["serverInfo"]["name"]=="farfold-public-page", "actual helper initialize")?;
        eprintln!("FARFOLD_P27_NATIVE_PHASE {{\"phase\":\"helper-initialize-replied\"}}");
        peer.send(json!({"jsonrpc":"2.0","method":"notifications/initialized"})).await?;
        peer.send(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})).await?;
        require(peer.response(2).await?["result"]["tools"].is_array(), "actual helper tool list")?;
        eprintln!("FARFOLD_P27_NATIVE_PHASE {{\"phase\":\"helper-tools-listed\"}}");
        wait_until(|| owner.state.lock().unwrap_or_else(|e|e.into_inner()).ready).await?;
        let page=open_case(app,&task,"plain").await?;opened.push(page.label.clone());
        browser_share_allow(main_view(app)?,app.clone(),app.state(),task.clone(),page.label.clone(),target.clone(),page.revision).await?;
        let before=native_facts(app).await?;
        peer.call(3,"observe_page",json!({"screenshot":true})).await?;
        wait_until(||owner.info(&task,"").pending_request.is_some()).await?;
        require(native_facts(app).await?["captureCallbacks"]==before["captureCallbacks"], "no capture before screenshot decision despite text grant")?;
        respond(app,&target,&task,&owner,true,true).await?;
        let response=peer.response(3).await?;
        let png=image(&response)?;
        let pixel=center_pixel(&png)?;
        require(pixel==[12,132,44], "actual expected renderer center pixel")?;
        let png_sha256: String=Sha256::digest(&png).iter().map(|byte|format!("{byte:02x}")).collect();
        peer.call(4,"observe_page",json!({"screenshot":true})).await?;
        respond(app,&target,&task,&owner,false,true).await?;
        no_image(&peer.response(4).await?)?;
        peer.call(5,"read_page_snapshot",json!({})).await?;
        require(peer.response(5).await?.to_string().contains("OWNED_P27_PUBLIC_TEXT"), "denial preserves original text grant")?;
        browser_workspace::browser_workspace_close(main_view(app)?,app.clone(),app.state(),task.clone(),page.label).await?;
        opened.pop();
        let mut checks=vec!["actual-permitted-PNG-center","text-grant-does-not-authorize-screenshot","denial-preserves-text"];
        for (index,route) in ["closed","design","frame"].into_iter().enumerate() {
            let page=open_case(app,&task,route).await?;opened.push(page.label.clone());
            let id=10+index as u64;
            peer.call(id,"observe_page",json!({"screenshot":true})).await?;
            respond(app,&target,&task,&owner,true,true).await?;
            no_image(&peer.response(id).await?)?;
            let facts=native_facts(app).await?;
            if route=="closed" {require(facts["closedPageScriptConfirmed"]==true,"actual page-world closed semantics")?;}
            if route=="design" {require(facts["designModeScriptConfirmed"]==true,"actual designMode on")?;}
            browser_workspace::browser_workspace_close(main_view(app)?,app.clone(),app.state(),task.clone(),page.label).await?;
            opened.pop();
            checks.push(route);
        }
        let page=open_case(app,&task,"late").await?;opened.push(page.label.clone());
        let (send,receive)=tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {windows_native_test::arm_capture_revocation();let _=send.send(());}).map_err(|_|"arm actual callback")?;
        tokio::time::timeout(WAIT,receive).await.map_err(|_|"arm callback wait")?.map_err(|_|"arm callback retired")?;
        peer.call(20,"observe_page",json!({"screenshot":true})).await?;
        respond(app,&target,&task,&owner,true,true).await?;
        no_image(&peer.response(20).await?)?;
        let facts=native_facts(app).await?;
        require(facts["actualCallbackRevocations"]==1, "actual native callback revoke stage reached")?;
        require(facts["revokedCallbackHadPng"]==true,"late control reached original real PNG")?;
        checks.push("same-scope-revoked-at-actual-capture-callback");
        Ok::<_,String>(json!({"checks":checks,"positivePngBytes":png.len(),"positivePngSha256":png_sha256,"positiveCenterRgb":pixel,"native":facts}))
    }.await;
    requests.set_prompt_active(false);
    let mut cleanup_ok = true;
    for label in opened.into_iter().rev() {
        cleanup_ok &= browser_workspace::browser_workspace_close(
            main_view(app)?,
            app.clone(),
            app.state(),
            task.clone(),
            label,
        )
        .await
        .is_ok();
    }
    drop(lease);
    let helper = peer.finish().await;
    let mut result = result?;
    require(cleanup_ok, "exact page cleanup not acknowledged")?;
    result["helper"] = helper?;
    result["cleanupAcknowledged"] = json!(true);
    Ok(result)
}

#[test]
#[ignore = "actual Windows Wry/WebView2 and same-job helper binary; dedicated bounded CI entry"]
fn real_windows_public_screenshot_keeps_permission_pixels_and_retirement() {
    let directory = tempfile::tempdir().expect("test-owned main profile");
    let profile = directory.path().join("main");
    let mut context = tauri::generate_context!();
    context.config_mut().build.dev_url = None;
    for window in &mut context.config_mut().app.windows {
        window.create = false;
    }
    context.set_assets(Box::new(ParentAssets));
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let app=tauri::Builder::<Wry>::default().any_thread()
        .manage(BrowserWorkspace::default()).manage(BrowserSharing::default())
        .setup(move |app| {
            runtime_condition()?;
            let window=WebviewWindowBuilder::new(app,"main",WebviewUrl::App("index.html".into()))
                .inner_size(800.0,600.0).data_directory(profile).visible(true).build()?;
            require(window.hwnd().is_ok(),"actual HWND")?;
            let mut apartment=windows::Win32::System::Com::APTTYPE::default();
            let mut qualifier=windows::Win32::System::Com::APTTYPEQUALIFIER::default();
            unsafe {windows::Win32::System::Com::CoGetApartmentType(&mut apartment,&mut qualifier)}?;
            require(apartment==windows::Win32::System::Com::APTTYPE_STA || apartment==windows::Win32::System::Com::APTTYPE_MAINSTA,"actual UI STA")?;
            eprintln!("FARFOLD_P27_NATIVE_PHASE {}",json!({"phase":"actual-main-created","pid":std::process::id(),"apartment":apartment.0}));
            let handle=app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let task_handle=handle.clone();
                let result=tauri::async_runtime::spawn(async move {
                    tokio::time::timeout(Duration::from_secs(180),run_cases(&task_handle)).await.map_err(|_|"native test deadline".to_owned())?
                }).await.map_err(|_|"native driver panic".to_owned()).and_then(|v|v);
                let code=if result.is_ok(){0}else{1};
                let _=send.send(result);
                handle.exit(code);
            });
            Ok(())
        }).build(context).expect("real Tauri/Wry condition, not a mock runtime");
    let code = app.run_return(|app, event| browser_workspace::handle_run_event(app, &event));
    let result = receive
        .recv_timeout(Duration::from_secs(2))
        .expect("native final receipt");
    match result {
        Ok(value) => {
            eprintln!("FARFOLD_P27_NATIVE_COMPLETED {value}");
            assert_eq!(code, 0);
        }
        Err(phase) => {
            eprintln!(
                "FARFOLD_P27_NATIVE_FAILED {}",
                json!({"phase":phase,"code":code})
            );
            panic!("actual native P27 failed; see fixed phase");
        }
    }
}
