mod context;
mod outbound;
use std::{ffi::{c_char,c_void,CStr},fs::File,io::{BufRead,BufReader,Read,Write},os::{fd::{FromRawFd,RawFd},unix::{fs::{MetadataExt,PermissionsExt},net::{UnixListener,UnixStream}}},path::PathBuf,sync::{Arc,Mutex,mpsc},time::{Duration,Instant,SystemTime,UNIX_EPOCH}};
use serde_json::{Value,json};
use tauri::{Manager,State,Webview,WebviewWindowBuilder,WebviewUrl};

unsafe extern "C" {
 fn arc4random_buf(buffer:*mut c_void,count:usize);
 fn getuid()->u32;
 fn rr_create(parent:*mut c_void,context:*mut c_void,event:extern "C" fn(*mut c_void,i32,*const c_char))->bool;
 fn rr_mutate()->bool;
 fn rr_read(context:*mut c_void,callback:extern "C" fn(*mut c_void,*const c_char,*const c_char))->bool;
 fn rr_close()->bool;
 fn rr_create_count()->u64;
 fn rr_read_count()->u64;
 fn rr_same_instance()->bool;
 fn rr_is_ephemeral()->bool;
}
const TASK:&str="running-page-task";
const LABEL:&str="running-page";
const GENERATION:u64=1;
static STDOUT:Mutex<()>=Mutex::new(());
fn emit(value:Value){let _guard=STDOUT.lock().unwrap();let mut out=std::io::stdout().lock();let _=writeln!(out,"{value}");let _=out.flush();}
fn now()->u64{SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64}
fn instance_id()->String{let mut bytes=[0u8;16];unsafe{arc4random_buf(bytes.as_mut_ptr().cast(),bytes.len());}bytes.iter().map(|v|format!("{v:02x}")).collect()}
fn fail(id:&str,error:&str)->Value{json!({"ok":false,"requestId":id,"error":error})}
#[derive(Clone)]
struct Host { capability:Arc<Vec<u8>>, page:Arc<Mutex<Page>>, outbound:Arc<outbound::OutboundGate> }
struct Page {instance:String,ready:bool,closed:bool,authorized:bool,epoch:u64,revision:u64,read_sequence:u64,hold_next:bool,held:Option<Held>}
#[derive(Clone)]
struct Ticket {request_id:String,epoch:u64,revision:u64,read_sequence:u64,hold:bool}
struct Held {ticket:Ticket,result:Value,sender:mpsc::Sender<Value>}
struct NativeContext{host:Host}
struct ReadContext{host:Host,ticket:Ticket,sender:mpsc::Sender<Value>}
fn gate(page:&Page,ticket:&Ticket)->Result<(),&'static str>{
 if page.closed{return Err("CLOSED")}if !page.authorized||page.epoch!=ticket.epoch{return Err("REVOKED")}
 if !page.ready{return Err("NOT_READY")}if page.revision!=ticket.revision{return Err("STALE_PAGE")}Ok(())
}
fn constant_equal(a:&[u8],b:&[u8])->bool{if a.len()!=b.len(){return false}a.iter().zip(b).fold(0u8,|v,(a,b)|v|(a^b))==0}
fn identity_valid(text:&str)->bool{!text.is_empty()&&text.len()<=128&&text.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_')}
extern "C" fn native_event(context:*mut c_void,event:i32,_json:*const c_char){
 let host=&unsafe{&*(context.cast::<NativeContext>())}.host;
 host.outbound.run(||(),|_|match event {
  1=>{let mut page=host.page.lock().unwrap();page.ready=true;page.revision=1;emit(json!({"event":"ready","instanceId":page.instance,"taskKey":TASK,"label":LABEL,"generation":GENERATION,"revision":page.revision,"nativeCreateCount":unsafe{rr_create_count()},"sameNativeInstance":unsafe{rr_same_instance()},"ephemeral":unsafe{rr_is_ephemeral()}}));}
  2=>{let mut page=host.page.lock().unwrap();page.revision+=1;emit(json!({"event":"mutated","instanceId":page.instance,"revision":page.revision,"sameNativeInstance":unsafe{rr_same_instance()},"nativeCreateCount":unsafe{rr_create_count()}}));}
  3=>{let mut page=host.page.lock().unwrap();page.closed=true;page.ready=false;page.authorized=false;page.epoch+=1;if let Some(held)=page.held.take(){let _=held.sender.send(fail(&held.ticket.request_id,"CLOSED"));}emit(json!({"event":"closed","instanceId":page.instance,"nativeCreateCount":unsafe{rr_create_count()},"nativeReadCount":unsafe{rr_read_count()}}));}
  _=>emit(json!({"event":"error","error":"NATIVE_EVENT_FAILED"})),
 });
}
extern "C" fn read_result(context:*mut c_void,raw:*const c_char,error:*const c_char){
 let context=unsafe{Box::from_raw(context.cast::<ReadContext>())};
 let mut page=context.host.page.lock().unwrap();
 if let Err(code)=gate(&page,&context.ticket){let _=context.sender.send(fail(&context.ticket.request_id,code));return}
 if !error.is_null()||raw.is_null(){let _=context.sender.send(fail(&context.ticket.request_id,"NATIVE_READ_FAILED"));return}
 let raw=unsafe{CStr::from_ptr(raw)}.to_bytes();
 if raw.len()>300_000{let _=context.sender.send(fail(&context.ticket.request_id,"READ_TOO_LARGE"));return}
 let Ok(snapshot)=serde_json::from_slice::<Value>(raw)else{let _=context.sender.send(fail(&context.ticket.request_id,"INVALID_NATIVE_RESULT"));return};
 if snapshot["blocked"]!=false{let _=context.sender.send(fail(&context.ticket.request_id,"PAGE_BLOCKED"));return}
 let same=unsafe{rr_same_instance()};
 if !same{let _=context.sender.send(fail(&context.ticket.request_id,"INSTANCE_CHANGED"));return}
 let result=json!({"ok":true,"requestId":context.ticket.request_id,"instanceId":page.instance,"taskKey":TASK,"label":LABEL,"generation":GENERATION,"revision":page.revision,"readId":format!("read-{}",context.ticket.read_sequence),"url":snapshot["url"],"title":snapshot["title"],"text":snapshot["text"],"observedAtMs":now(),"nativeReadCount":unsafe{rr_read_count()},"nativeCreateCount":unsafe{rr_create_count()},"sameNativeInstance":same});
 if context.ticket.hold {
  if page.held.is_some(){let _=context.sender.send(fail(&context.ticket.request_id,"HOLD_BUSY"));return}
  emit(json!({"event":"held","requestId":context.ticket.request_id,"instanceId":page.instance,"nativeReadCount":unsafe{rr_read_count()}}));
  page.held=Some(Held{ticket:context.ticket,result,sender:context.sender});
 }else{let _=context.sender.send(result);}
}
fn snapshot(app:&tauri::AppHandle,host:&Host,request:&Value)->(Value,Option<Ticket>){
 let id=request["requestId"].as_str().filter(|x|identity_valid(x)).unwrap_or("invalid-request");
 let keys=["op","requestId","taskKey","label","generation","capability"];
 if !request.as_object().is_some_and(|x|x.len()==keys.len()&&x.keys().all(|k|keys.contains(&k.as_str())))||id=="invalid-request"{return(fail(id,"INVALID_REQUEST"),None)}
 if request["op"]!="snapshot"{return(fail(id,"INVALID_OPERATION"),None)}
 if !constant_equal(request["capability"].as_str().unwrap_or("").as_bytes(),&host.capability){return(fail(id,"UNAUTHORIZED"),None)}
 if request["taskKey"]!=TASK||request["label"]!=LABEL||request["generation"]!=GENERATION{return(fail(id,"SCOPE_MISMATCH"),None)}
 let ticket={let mut page=host.page.lock().unwrap();
  let probe=Ticket{request_id:id.into(),epoch:page.epoch,revision:page.revision,read_sequence:0,hold:false};
  if let Err(code)=gate(&page,&probe){return(fail(id,code),None)}
  page.read_sequence+=1;let hold=page.hold_next;page.hold_next=false;
  Ticket{request_id:id.into(),epoch:page.epoch,revision:page.revision,read_sequence:page.read_sequence,hold}
 };
 let (sender,receiver)=mpsc::channel();let read_host=host.clone();let read_ticket=ticket.clone();
 if app.run_on_main_thread(move||{
  {let page=read_host.page.lock().unwrap();if let Err(code)=gate(&page,&read_ticket){let _=sender.send(fail(&read_ticket.request_id,code));return}}
  let context=Box::new(ReadContext{host:read_host,ticket:read_ticket,sender});let pointer=Box::into_raw(context);
  if !unsafe{rr_read(pointer.cast(),read_result)}{let context=unsafe{Box::from_raw(pointer)};let _=context.sender.send(fail(&context.ticket.request_id,"NATIVE_READ_UNAVAILABLE"));}
 }).is_err(){return(fail(id,"DISPATCH_FAILED"),None)}
 match receiver.recv_timeout(Duration::from_secs(12)){Ok(value)=>(value,Some(ticket)),Err(_)=>(fail(id,"READ_TIMEOUT"),None)}
}
fn serve_connection(mut stream:UnixStream,app:tauri::AppHandle,host:Host){
 let _=stream.set_read_timeout(Some(Duration::from_secs(2)));let _=stream.set_write_timeout(Some(Duration::from_secs(1)));
 let mut line=String::new();let read=BufReader::new(&stream).take(4097).read_line(&mut line);
 let (mut response,ticket)=if read.is_err()||line.len()>4096{(fail("invalid-request","INVALID_REQUEST"),None)}else{match serde_json::from_str::<Value>(line.trim()){Ok(request)=>snapshot(&app,&host,&request),Err(_)=>(fail("invalid-request","INVALID_REQUEST"),None)}};
 // Dedicated outbound gate, never held while waiting for native observation.
 // Revoke/close ACK cannot pass between this final check and bounded write.
 host.outbound.run(||{
  if response["ok"]==true{if let Some(ticket)=ticket{let page=host.page.lock().unwrap();if let Err(code)=gate(&page,&ticket){response=fail(&ticket.request_id,code);}}}
  response
 },|response|{let _=write_bounded(&mut stream,&response);});
}
fn write_bounded(stream:&mut UnixStream,response:&Value)->std::io::Result<()>{
 let bytes=format!("{response}\n").into_bytes();
 if bytes.len()>16_384{return Err(std::io::Error::other("probe response limit"))}
 let deadline=Instant::now()+Duration::from_secs(1);let mut offset=0;
 while offset<bytes.len(){let remaining=deadline.checked_duration_since(Instant::now()).ok_or_else(||std::io::Error::new(std::io::ErrorKind::TimedOut,"probe outbound deadline"))?;stream.set_write_timeout(Some(remaining))?;let count=stream.write(&bytes[offset..])?;if count==0{return Err(std::io::Error::new(std::io::ErrorKind::WriteZero,"probe peer closed"))}offset+=count;}
 Ok(())
}
fn controls(file:File,app:tauri::AppHandle,host:Host){
 for line in BufReader::new(file).lines(){let Ok(line)=line else{break};match line.as_str(){
  "mutate"=>{let state=host.clone();let _=app.run_on_main_thread(move||{let allowed={let page=state.page.lock().unwrap();page.ready&&!page.closed&&page.authorized&&page.revision==1};if !allowed||!unsafe{rr_mutate()}{emit(json!({"event":"control_error","error":"MUTATE_REJECTED"}));}});}
  "hold-next-read"=>{let mut page=host.page.lock().unwrap();if page.ready&&!page.closed&&page.authorized&&!page.hold_next&&page.held.is_none(){page.hold_next=true;emit(json!({"event":"hold-armed"}));}else{emit(json!({"event":"control_error","error":"HOLD_REJECTED"}));}}
  "release-held"=>{let mut page=host.page.lock().unwrap();if let Some(held)=page.held.take(){let value=gate(&page,&held.ticket).map(|_|held.result).unwrap_or_else(|e|fail(&held.ticket.request_id,e));let _=held.sender.send(value);}emit(json!({"event":"held-released"}));}
  "revoke"=>host.outbound.run(||(),|_|{let mut page=host.page.lock().unwrap();page.authorized=false;page.epoch+=1;page.hold_next=false;if let Some(held)=page.held.take(){let _=held.sender.send(fail(&held.ticket.request_id,"REVOKED"));}emit(json!({"event":"revoked","instanceId":page.instance}));}),
  "close"=>{let _=app.run_on_main_thread(move||{if !unsafe{rr_close()}{emit(json!({"event":"control_error","error":"CLOSE_REJECTED"}));}});}
  "quit"=>{let quit=app.clone();let _=app.run_on_main_thread(move||{unsafe{rr_close();}emit(json!({"event":"finished","nativeCreateCount":unsafe{rr_create_count()},"nativeReadCount":unsafe{rr_read_count()}}));quit.exit(0);});break;}
  _=>emit(json!({"event":"control_error","error":"INVALID_CONTROL"})),
 }}
}
#[tauri::command]
fn probe_ready(webview:Webview,host:State<Host>)->Result<(),String>{
 if webview.label()!="main"||!webview.url().is_ok_and(|u|u.scheme()=="tauri"&&u.host_str()==Some("localhost")){return Err("CALLER_REJECTED".into())}
 let parent=webview.app_handle().get_webview_window("main").ok_or("MAIN_MISSING")?;
 let host=host.inner().clone();parent.with_webview(move|platform|{
  let context=Box::into_raw(Box::new(NativeContext{host}));
  if !unsafe{rr_create(platform.inner(),context.cast(),native_event)}{unsafe{drop(Box::from_raw(context));}emit(json!({"event":"error","error":"NATIVE_CREATE_FAILED"}));}
 }).map_err(|_|"DISPATCH_FAILED".into())
}
fn main(){
 let args:Vec<String>=std::env::args().collect();if args.len()!=3{eprintln!("usage: running-page-probe SOCKET_PATH CONTROL_FD");std::process::exit(64)}
 let socket=PathBuf::from(&args[1]);let parent=socket.parent().and_then(|p|p.canonicalize().ok()).expect("private socket parent required");
 let meta=std::fs::metadata(&parent).expect("private socket parent required");
 assert!(socket.is_absolute()&&parent.starts_with("/Users/tw/Documents/Codex/2026-10-03/task-3")&&!socket.exists()&&meta.mode()&0o077==0&&meta.uid()==unsafe{getuid()},"socket must be new and in a private task-3 directory");
 let fd:RawFd=args[2].parse().expect("control descriptor required");assert!(fd>=3,"private control descriptor required");let control=unsafe{File::from_raw_fd(fd)};
 let mut secret=String::new();std::io::stdin().lock().read_line(&mut secret).expect("private authorization pipe required");let secret=secret.trim_end();assert!(secret.len()==64&&secret.bytes().all(|b|b.is_ascii_hexdigit()),"invalid private authorization");
 let host=Host{capability:Arc::new(secret.as_bytes().to_vec()),page:Arc::new(Mutex::new(Page{instance:instance_id(),ready:false,closed:false,authorized:true,epoch:1,revision:0,read_sequence:0,hold_next:false,held:None})),outbound:Arc::new(outbound::OutboundGate::default())};
 let listener=UnixListener::bind(&socket).expect("private socket bind");std::fs::set_permissions(&socket,std::fs::Permissions::from_mode(0o600)).expect("private socket permissions");
 let setup_host=host.clone();let app=tauri::Builder::default().manage(host).invoke_handler(tauri::generate_handler![probe_ready]).setup(move|app|{
  WebviewWindowBuilder::new(app,"main",WebviewUrl::App("index.html".into())).title("Controlled running page probe — synthetic content").inner_size(680.0,440.0).incognito(true).visible(true).on_navigation(|u|u.scheme()=="tauri"&&u.host_str()==Some("localhost")).on_page_load(|view,payload|{if matches!(payload.event(),tauri::webview::PageLoadEvent::Finished){let _=view.eval("if(!window.__runningProbeStarted){window.__runningProbeStarted=true;window.__TAURI_INTERNALS__.invoke('probe_ready')}");}}).build()?;
  let socket_app=app.handle().clone();let socket_host=setup_host.clone();std::thread::spawn(move||{for stream in listener.incoming(){if let Ok(stream)=stream{let app=socket_app.clone();let host=socket_host.clone();std::thread::spawn(move||serve_connection(stream,app,host));}}});
  let control_app=app.handle().clone();std::thread::spawn(move||controls(control,control_app,setup_host));
  let deadline=app.handle().clone();std::thread::spawn(move||{std::thread::sleep(Duration::from_secs(90));emit(json!({"event":"error","error":"HOST_DEADLINE"}));deadline.exit(2);});Ok(())
 }).build(context::context()).expect("isolated runtime build");app.run(|_,_|{});let _=std::fs::remove_file(socket);
}
