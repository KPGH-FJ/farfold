use super::*;
use serde_json::json;
const WORLD: &str = "FarfoldFixedObservation";
const BINDING: &str = "__farfoldManualActivity";
const PROGRAM: &str = include_str!("../../../native/browser_observation.js");
const MONITOR: &str = include_str!("../../../native/browser_manual_activity.js");
const OPERATION: &str = include_str!("../../../native/browser_operation.js");
fn cdp(
    view: &Rc<View>,
    method: &'static str,
    params: Value,
    done: impl FnOnce(Result<Value, String>) + 'static,
) -> Result<(), String> {
    let callback =
        CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, raw| {
            let result = result
                .map_err(|_| "网页操作结果未确认".to_owned())
                .and_then(|_| {
                    if raw.len() > 550_000 {
                        return Err("网页返回内容过大".into());
                    }
                    serde_json::from_str(&raw).map_err(|_| "网页返回内容无效".into())
                });
            done(result);
            Ok(())
        }));
    unsafe {
        view.core.CallDevToolsProtocolMethod(
            &HSTRING::from(method),
            &HSTRING::from(params.to_string()),
            &callback,
        )
    }
    .map_err(|_| "网页操作未能开始".into())
}
pub(super) fn install_manual_event(view: &Rc<View>) -> windows::core::Result<()> {
    unsafe {
        let receiver = view
            .core
            .GetDevToolsProtocolEventReceiver(windows::core::w!("Runtime.bindingCalled"))?;
        let weak = Rc::downgrade(view);
        let mut token = 0;
        receiver.add_DevToolsProtocolEventReceived(
            &DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                let (Some(view), Some(args)) = (weak.upgrade(), args) else {
                    return Ok(());
                };
                let mut raw = PWSTR::null();
                args.ParameterObjectAsJson(&mut raw)?;
                let raw = CoTaskMemPWSTR::from(raw).to_string();
                if raw.len() > 512 {
                    return Ok(());
                }
                if let Ok(message) = serde_json::from_str::<Value>(&raw)
                    && message["name"] == BINDING
                    && message["executionContextId"].as_i64() == view.context.get()
                    && let Some(revision) = message["payload"]
                        .as_str()
                        .filter(|s| s.len() <= 16)
                        .and_then(|s| s.parse::<u64>().ok())
                        .filter(|n| *n > view.manual_revision.get())
                {
                    view.manual_revision.set(revision);
                    view.manual_activity();
                }
                Ok(())
            })),
            &mut token,
        )?;
        Ok(())
    }
}
fn preparation_failed(view: &Rc<View>, navigation: u64) {
    if view.live() && view.navigation.get() == navigation {
        view.loading.set(false);
        view.invalidate("网页观察保护未能准备，请重新打开");
        view.emit(2, navigation, "");
    }
}
// Only mark ready after an isolated realm and the constant activity monitor exist.
pub(super) fn prepare(view: Rc<View>, navigation: u64) {
    let next = view.clone();
    if cdp(&view,"Page.getFrameTree",json!({}),move|result|{
        let Some(frame)=result.ok().and_then(|v|v["frameTree"]["frame"]["id"].as_str().map(str::to_owned))else{preparation_failed(&next,navigation);return;};
        if !next.live()||next.navigation.get()!=navigation{return;}
        let stage=next.clone();
        if cdp(&next,"Page.createIsolatedWorld",json!({"frameId":frame,"worldName":WORLD,"grantUniveralAccess":false}),move|result|{
            let Some(context)=result.ok().and_then(|v|v["executionContextId"].as_i64())else{preparation_failed(&stage,navigation);return;};
            if !stage.live()||stage.navigation.get()!=navigation{return;}
            stage.context.set(Some(context));let monitor=stage.clone();
            if cdp(&stage,"Runtime.addBinding",json!({"name":BINDING,"executionContextId":context}),move|result|{
                if result.is_err()||!monitor.live()||monitor.navigation.get()!=navigation{preparation_failed(&monitor,navigation);return;}
                let ready=monitor.clone();
                if cdp(&monitor,"Runtime.callFunctionOn",json!({"functionDeclaration":MONITOR.trim().trim_end_matches(';'),"executionContextId":context,"returnByValue":true}),move|result|{
                    if !ready.live()||ready.navigation.get()!=navigation{return;}
                    if result.as_ref().ok().is_none_or(|r|r.get("exceptionDetails").is_some()||r["result"]["value"].as_u64().is_none()){preparation_failed(&ready,navigation);return;}
                    ready.manual_revision.set(result.as_ref().ok().and_then(|r|r["result"]["value"].as_u64()).unwrap_or(0));
                    let Ok(url)=ready.source()else{preparation_failed(&ready,navigation);return;};ready.loading.set(false);ready.emit(1,navigation,&url);
                }).is_err(){preparation_failed(&monitor,navigation);}
            }).is_err(){preparation_failed(&stage,navigation);}
        }).is_err(){preparation_failed(&next,navigation);}
    }).is_err(){preparation_failed(&view,navigation);}
}
fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "无法准备网页观察")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn finish(view: &Rc<View>, operation: &str, result: Result<String, String>) {
    if let Some(pending) = PendingOperation::take_matching(&view.pending, operation) {
        view.action_navigation.set(None);
        let _ = pending.reply.send(result);
    }
}
pub(super) fn unknown(observation: &str) -> String {
    json!({"applied":null,"outcome":"unknown","reason":"网页操作结果未确认，请查看页面后重新观察；不要自动重复操作","pageChanged":true,"navigationChanged":true,"observationId":observation}).to_string()
}
pub(super) async fn run(
    app: &AppHandle,
    scope: FixedPageReadScope,
    action: Option<(String, String, NativeAction)>,
) -> Result<String, String> {
    let (mode, observation, node, kind, input) = match action {
        None => ("observe", String::new(), String::new(), "", String::new()),
        Some((observation, node, action)) => {
            if observation.is_empty()
                || observation.len() > 128
                || node.is_empty()
                || node.len() > 64
            {
                return Err("网页操作目标无效，请重新观察".into());
            }
            let (kind, input) = match action {
                NativeAction::Click => ("click", String::new()),
                NativeAction::Input { text } => ("input", text),
            };
            if input.len() > 8192
                || input
                    .chars()
                    .any(|c| c.is_control() && c != '\n' && c != '\t')
            {
                return Err("输入内容过长或含不支持的字符".into());
            }
            ("act", observation, node, kind, input)
        }
    };
    let (sender, receiver) = oneshot::channel();
    main(app,move||{
        scope.observe(|id,expected|{
            if sender.is_closed(){return Err("网页操作已取消".into());}
            let view=lookup(id)?;let navigation=scope.navigation();
            // A manual UI read has a validated ticket but no external grant URL.
            // Pin its current source now; external requests still supply an exact URL.
            let source=view.source()?;let expected=expected.unwrap_or(&source).to_owned();
            if view.loading.get()||view.pending.borrow().is_some(){return Err("网页正在变化或操作中，请稍后再试".into());}
            if view.navigation.get()!=navigation||source!=expected{return Err("网页已变化，请重新确认要分享的页面".into());}
            let context=view.context.get().ok_or("网页观察保护尚未准备，请重新打开")?;
            if mode=="act" && view.observation.borrow().as_deref()!=Some(observation.as_str()){return Err("网页操作目标已失效，请重新观察".into());}
            view.observation.borrow_mut().take();let seed=random_id()?;let epoch=random_id()?;
            let operation=seed.clone();let started_operation=operation.clone();
            let deadline=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|"系统时间无效")?.as_millis()+5000;
            let function=OPERATION.trim().trim_end_matches(';').replace("/* FARFOLD_OBSERVATION_PROGRAM */", PROGRAM);
            let args=[json!(mode),json!(epoch),json!(seed),json!(navigation.to_string()),json!(observation),json!(node),json!(kind),json!(input),json!(deadline as u64),json!(view.manual_revision.get())].into_iter().map(|value|json!({"value":value})).collect::<Vec<_>>();
            *view.pending.borrow_mut()=Some(PendingOperation{id:operation.clone(),reply:sender,action:(mode=="act").then(||observation.clone())});
            if mode=="act"{view.action_navigation.set(Some(Instant::now()+Duration::from_secs(5)));}
            let done=view.clone();
            let result=cdp(&view,"Runtime.callFunctionOn",json!({"functionDeclaration":function,"executionContextId":context,"arguments":args,"returnByValue":true,"awaitPromise":true}),move|result|{
                if done.pending.borrow().as_ref().is_none_or(|pending|pending.id!=operation){return;}
                if !done.live()||done.navigation.get()!=navigation||done.source().ok().as_deref()!=Some(&expected){finish(&done,&operation,if mode=="act"{Ok(unknown(&observation))}else{Err("网页已变化，请重新确认分享范围".into())});return;}
                let value=result.and_then(|result|{if result.get("exceptionDetails").is_some(){return Err("网页操作结果未确认".into());}result.get("result").and_then(|r|r.get("value")).cloned().filter(Value::is_object).ok_or("网页返回内容无效".into())});
                let result=value.map(|mut value|{if mode=="observe"{if value["blocked"]==false{*done.observation.borrow_mut()=value["observationId"].as_str().map(str::to_owned);}value["screenshotReason"]=json!("当前页面受保护输入无法可靠核实，暂不提供截图");}value.to_string()});
                finish(&done,&operation,result);
            });if result.is_err(){finish(&view,&started_operation,Err("网页操作未能开始".into()));}result
        })
    }).await?;
    receiver
        .await
        .map_err(|_| "网页操作结果未确认，请查看页面")?
}
