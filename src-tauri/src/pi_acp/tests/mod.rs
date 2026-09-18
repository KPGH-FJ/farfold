mod admission;
mod auth;
mod fixed_binary;
mod lifecycle;
mod turns;

use super::admission::*;
use super::configure::*;
use super::interactions::*;
use super::sessions::*;
use super::turns::*;
use super::workspace::*;
use super::*;
use crate::host_store::session_open::SessionOpenBlocker;

struct Fixture {
    temp: tempfile::TempDir,
    cwd: PathBuf,
    store: HostStore,
    selection: ManagedProviderSelection,
    prepared: PreparedPiProfile,
    binding: RuntimeBinding,
}

impl Fixture {
    fn stable(endpoint: &str) -> Self {
        let mut fixture = Self::new(endpoint);
        let profile = new_owned_profile(fixture.selection.clone()).unwrap();
        let root = fixture.temp.path().canonicalize().unwrap();
        fixture.prepared = crate::acp_provider_profile::prepare_owned(
            &root,
            &root.join("pi-acp"),
            &fixture.store,
            &profile,
            true,
        )
        .unwrap();
        fixture
            .store
            .register_runtime_owned_profile(&runtime_registration(&profile.binding, 1), &profile)
            .unwrap();
        fixture.binding = profile.binding;
        fixture
    }

    fn new(endpoint: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let cwd = root.join("project");
        fs::create_dir(&cwd).unwrap();
        let store = HostStore::open(root.join("host.sqlite3"));
        let selection = crate::acp_provider_profile::tests::save_fixture(
            &root,
            &store,
            endpoint,
            "openai-chat-completions",
            "fixture-not-a-credential",
        );
        let binding = managed_binding(&selection).unwrap();
        let prepared = crate::acp_provider_profile::prepare(
            &root,
            &root.join("pi-acp"),
            "fixture",
            &binding,
            &store,
            &selection,
            true,
        )
        .unwrap()
        .into_optional_bootstrap();
        Self {
            temp,
            cwd,
            store,
            selection,
            prepared,
            binding,
        }
    }

    fn native(&self) -> PiNativeSession {
        PiNativeSession {
            version: 1,
            session_id: "native-fixture".into(),
            cwd: self.cwd.clone(),
            session_file: self
                .prepared
                .profile_root
                .join("sessions/native-fixture.jsonl"),
        }
    }

    fn response(&self) -> Value {
        json!({"sessionId":"native-fixture", "configOptions":[{"id":"model","type":"select",
                "currentValue":self.prepared.binding.clone().unwrap().runtime_model_id,
                "options":[{"value":self.prepared.binding.clone().unwrap().runtime_model_id,"name":"Fixture"}]},
                {"id":"thought_level","type":"select","currentValue":"off","options":[{"value":"off"},{"value":"high"}]}],
                "_meta":{"farfoldPi":{"nativeSession":self.native()}}})
    }

    fn start(
        &self,
        runtime: &PiAcpRuntime,
        router: &RuntimeEventRouter,
        response: Value,
    ) -> Arc<Mutex<PiAcpConnection>> {
        let mut command = Command::new("/usr/bin/python3");
        command.args(["-u", "-c", r#"
import json,sys,time
response=json.loads(sys.argv[1])
pending=None
cancel_waiting=False
form_cancelled=False
turn_count=0
prompt_calls=0
held_read=None
state_reads=0
held_intervention=None
interventions=[]
held_config=None
config_count=0
refresh_count=0
auth=None
auth_calls=0
manual_form_count=0
expected_answer={'action':'cancel'}
form_answer=None
for line in sys.stdin:
    request=json.loads(line)
    if request.get('method')=='fixture/auth_calls':
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':auth_calls}),flush=True)
        continue
    if request.get('method')=='_pi/auth':
        auth_calls+=1
        params=request['params']
        if params['action']=='start':
            auth={'version':1,'sessionId':params['sessionId'],'flowId':'flow-fixture','providerId':params['providerId'],'authType':params['authType'],'state':'running','credentialState':'unknown','refreshState':'not_attempted','prompt':{'id':'prompt-fixture','value':{'type':'secret','message':'Synthetic key'}},'notice':None}
            auth['operation']=params['operation']
        elif params['action']=='reply':
            assert params['value']=='synthetic-auth-secret'
            auth.update({'prompt':None,'state':'unknown' if response.get('authMode')=='unknown' else 'succeeded','credentialState':'committed','refreshState':'unknown' if response.get('authMode')=='unknown' else 'confirmed'})
        elif params['action']=='cancel':
            auth.update({'prompt':None,'state':'unknown','credentialState':'unknown'})
        result=json.loads(json.dumps(auth))
        if response.get('authMode')=='wrong': result['sessionId']='wrong-native'
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
        continue
    if request.get('method')=='fixture/prompt_calls':
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':prompt_calls}),flush=True)
        continue
    if request.get('method')=='fixture/idle_crash':
        sys.exit(1)
    if request.get('method')=='fixture/show_form':
        manual_form_count+=1
        form=json.loads(json.dumps(response['form']))
        form['id']=100+manual_form_count
        form['params']['_meta']['farfoldPi']['event']['id']=f'manual-dialog-{manual_form_count}'
        expected_answer=request['params'].get('expectedAnswer',{'action':'cancel'})
        print(json.dumps(form),flush=True)
    if request.get('method')=='fixture/withdraw_form':
        print(json.dumps({'jsonrpc':'2.0','method':'_pi/ui_withdrawn','params':{'version':1,'sessionId':response['sessionId'],'nativeRequestId':f'manual-dialog-{manual_form_count}','reason':'timeout'}}),flush=True)
    if request.get('method')=='fixture/last_form_answer':
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':form_answer}),flush=True)
        continue
    if request.get('method')=='fixture/read_pending':
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'pending':held_read is not None}}),flush=True)
        continue
    if request.get('method')=='fixture/intervention_status':
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'held':held_intervention is not None,'interventions':interventions,'prompts':turn_count}}),flush=True)
        continue
    if request.get('method')=='fixture/config_status':
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'held':held_config is not None,'configs':config_count,'prompts':turn_count,'refreshes':refresh_count}}),flush=True)
        continue
    if request.get('method')=='_pi/refresh_profile':
        refresh_count+=1
        native=json.loads(json.dumps(response['_meta']['farfoldPi']['nativeSession']))
        if response.get('refreshMode')=='wrong': native['sessionId']='wrong-session'
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'version':1,'nativeSession':native}}),flush=True)
        continue
    if request.get('method')=='session/set_config_option':
        config_count+=1
        options=json.loads(json.dumps(response['configOptions']))
        for option in options:
            if option['id']==request['params']['configId']:
                option['currentValue']='malformed' if response.get('configMode')=='malformed' else request['params']['value']
        result={'configOptions':options}
        if response.get('nativeFirstUse'):
            provider,_,model=options[0]['currentValue'].partition('/')
            result['_meta']={'farfoldPi':{'nativeFirstUse':{'version':1,'phase':'ready','provider':provider,'modelId':model}}}
        held_config={'id':request['id'],'result':result}
        if response.get('configMode')=='reject':
            held_config={'id':request['id'],'error':{'code':-32602,'message':'native rejected'}}
        else: response['configOptions']=options
        if response.get('emitConfigUpdate'):
            print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':response['sessionId'],'update':{'sessionUpdate':'config_option_update','configOptions':options}}}),flush=True)
        if response.get('autoConfig'):
            print(json.dumps({'jsonrpc':'2.0',**held_config}),flush=True)
            held_config=None
        continue
    if request.get('method')=='fixture/release_config':
        assert held_config is not None
        print(json.dumps({'jsonrpc':'2.0',**held_config}),flush=True)
        held_config=None
    if request.get('method') in ('_pi/steer','_pi/follow_up'):
        assert pending is not None
        interventions.append(request['method'])
        result={'accepted':True,'sessionId':response['sessionId'],'delivery':request['method'][4:]}
        if response.get('holdIntervention'):
            held_intervention={'id':request['id'],'result':result}
            continue
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
        continue
    if request.get('method')=='fixture/release_intervention':
        assert held_intervention is not None
        if request['params'].get('malformed'): held_intervention['result']['sessionId']='wrong'
        print(json.dumps({'jsonrpc':'2.0',**held_intervention}),flush=True)
        held_intervention=None
    if request.get('method')=='fixture/finish_prompt':
        assert pending is not None
        print(json.dumps({'jsonrpc':'2.0','id':pending['id'],'result':{'stopReason':'end_turn'}}),flush=True)
        pending=None
    if request.get('method')=='fixture/release_read':
        assert held_read is not None
        print(json.dumps({'jsonrpc':'2.0','id':held_read['id'],'result':held_read['result']}),flush=True)
        held_read=None
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'ok':True}}),flush=True)
        continue
    if isinstance(request.get('id'),int) and 'method' not in request:
        assert request['result']==expected_answer
        form_answer=request['result']
        form_cancelled=True
        if cancel_waiting and pending:
            print(json.dumps({'jsonrpc':'2.0','id':pending['id'],'result':{'stopReason':'cancelled'}}),flush=True)
            pending=None
            cancel_waiting=False
        continue
    if request.get('method')=='session/prompt':
        prompt_calls+=1
        receipt=None
        if response.get('promptMode') in ('preflight_not_sent','preflight_unknown'):
            provider,model=response['configOptions'][0]['currentValue'].split('/',1)
            assert request['params']['_meta']['farfoldPi']['expectedModel']=={'version':1,'sessionId':response['sessionId'],'sessionFile':response['_meta']['farfoldPi']['nativeSession']['sessionFile'],'provider':provider,'modelId':model}
            code=-32600 if response['promptMode']=='preflight_not_sent' else -32603
            print(json.dumps({'jsonrpc':'2.0','id':request['id'],'error':{'code':code,'message':'fixture preflight','data':{'farfoldPiPromptNotSent':True}}}),flush=True)
            continue
        if response.get('emitReceipt'):
            provider,model=response['configOptions'][0]['currentValue'].split('/',1)
            now=int(time.time()*1000)
            receipt={'version':1,'hostTurnId':request['params']['_meta']['farfoldPi']['hostTurnId'],'sessionId':response['sessionId'],'runtimeProviderId':provider,'runtimeModelId':f'{provider}/{model}','nativeModelId':model,'nativeTimestamp':now,'completedAt':now,'nativeStopReason':'error' if response.get('promptMode')=='error' else 'stop'}
        if response.get('promptMode')=='exit': sys.exit(7)
        if response.get('promptMode')=='wait':
            pending=request
            turn_count+=1
            if 'form' in response:
                form_cancelled=False
                form=json.loads(json.dumps(response['form']))
                form['id']=6+turn_count
                form['params']['_meta']['farfoldPi']['event']['id']=f'native-dialog-{turn_count}'
                print(json.dumps(form),flush=True)
            continue
        if response.get('promptMode')=='error':
            data={'farfoldOutcomeUnknown':False,'nativeStopReason':'error'}
            if receipt: data['farfoldPiProviderRequest']=receipt
            print(json.dumps({'jsonrpc':'2.0','id':request['id'],'error':{'code':-32603,'message':'fixture error','data':data}}),flush=True)
            continue
    if request.get('method')=='_pi/cancel':
        outcome='unsupported' if response.get('cancelUnsupported') else 'accepted'
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'version':1,'sessionId':response['sessionId'],'outcome':outcome}}),flush=True)
        if outcome=='accepted' and pending:
            if 'form' in response:
                cancel_waiting=True
                print(json.dumps({'jsonrpc':'2.0','method':'_pi/ui_withdrawn','params':{'version':1,'sessionId':response['sessionId'],'nativeRequestId':form['params']['_meta']['farfoldPi']['event']['id'],'reason':'cancelled'}}),flush=True)
            else:
                print(json.dumps({'jsonrpc':'2.0','id':pending['id'],'result':{'stopReason':'cancelled'}}),flush=True)
                pending=None
        continue
    if request.get('method')=='fixture/malformed':
        print(json.dumps({'jsonrpc':'2.0','method':'_pi/ui_withdrawn','params':{}}),flush=True)
    if request.get('method')=='initialize':
        result={'protocolVersion':1,'agentInfo':{'version':'0.0.33-farfold.1'},'agentCapabilities':{'loadSession':True,'_meta':{'farfoldPi':{'ui':True,'promptModel':True}}}}
    elif request.get('method')=='_pi/workspace':
        data={'entries':[{'type':'future','id':'entry'}]}
        if request['params']['section']=='configuration': data=response['configOptions']
        if request['params']['section']=='state':
            state_reads+=1
            provider,_,model=response['configOptions'][0]['currentValue'].partition('/')
            data={'sessionId':response['sessionId'],'sessionFile':response['_meta']['farfoldPi']['nativeSession']['sessionFile'],'model':{'provider':provider,'id':model},'isStreaming':False,'isCompacting':False,'pendingMessageCount':0}
            data.update(response.get('stateOverride',{}))
        result={'version':1,'nativeSession':response['_meta']['farfoldPi']['nativeSession'],'section':request['params']['section'],'data':data}
        if response.get('holdEntries') and request['params']['section']=='entries':
            held_read={'id':request['id'],'result':result}
            continue
        if response.get('holdFirstState') and request['params']['section']=='state' and state_reads==1:
            held_read={'id':request['id'],'result':result}
            continue
    elif request.get('method')=='session/prompt':
        result=response.get('promptResult',{'stopReason':'end_turn'})
        if receipt: result['_meta']={'farfoldPiProviderRequest':receipt}
    else: result=response
    if 'id' in request: print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
"#]).arg(response.to_string());
        start_connection(
            runtime,
            router,
            self.binding.clone(),
            &self.cwd,
            &self.prepared,
            &mut command,
        )
        .unwrap()
    }
}
