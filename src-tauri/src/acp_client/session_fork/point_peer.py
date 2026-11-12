import json, os, pathlib, sys, time

root = pathlib.Path(__file__).parent
mode = (root / 'point-mode').read_text()
options = [dict(id='model', name='Model', category='model', type='select', currentValue='m', options=[dict(value='m', name='m'), dict(value='other', name='other')]), dict(id='effort', name='Effort', category='thought_level', type='select', currentValue='high', options=[dict(value='high', name='High')])]
def body(id, created):
    return dict(id=id, created=created, role='assistant', content=[dict(type='text',text=id)], metadata=dict(agentVisible=True,userVisible=id!='hidden'))
original = [body('a',1),body('hidden',1),body('b',2),body('later',3)]
original[0]['role']='user'
original[1]['role']='user';original[1]['metadata']['turnContext']=True
for index in range(4,21):
    item=body(f'later-{index}',index+1)
    if index in (5,9,13,17):item['metadata']['userVisible']=False
    original.append(item)
if mode=='compacted':
    for item in original[:3]:item['metadata']['agentVisible']=False
    summary=body('summary-after-cutoff',original[-1]['created']+1);summary['metadata']['userVisible']=False
    original.append(summary)
child = None
def send(value): print(json.dumps(dict(jsonrpc='2.0', **value)), flush=True)
def reply(message, result): send(dict(id=message['id'], result=result))
def update(id):
    for item in original if id=='parent' else (child or original[:3]):
        send(dict(method='session/update',params=dict(sessionId=id,update=dict(sessionUpdate='agent_message_chunk',messageId=item['id'],content=dict(type='text',text=item['id']),_meta=dict(goose=dict(created=item['created'],messageId=item['id']))))))
for line in sys.stdin:
    message=json.loads(line);method=message.get('method');p=message.get('params',{})
    with (root/'trace.jsonl').open('a') as trace:trace.write(json.dumps(dict(pid=os.getpid(),method=method,params=p))+'\n')
    if method=='initialize':reply(message,dict(protocolVersion=1,agentCapabilities=dict(loadSession=True,sessionCapabilities=dict(close={},list={})),authMethods=[]))
    elif method=='session/new':reply(message,dict(sessionId='parent',configOptions=options))
    elif method=='session/prompt':update('parent');reply(message,dict(stopReason='end_turn'))
    elif method=='session/load':
        if mode=='load-rewrite' and child is not None:child[1]=body('rewritten-hidden',1)
        update(p['sessionId']);reply(message,dict(configOptions=options))
    elif method=='session/set_config_option':reply(message,dict(configOptions=options))
    elif method=='session/close':reply(message,{})
    elif method=='session/list':reply(message,dict(sessions=[]))
    elif method=='session/fork':
        cutoff=p.get('_meta',{}).get('conversationBefore')
        child=original[:] if mode=='ignore-point' else [v for v in original if cutoff is None or v['created']<cutoff]
        if mode=='parent-change':original[3]=body('changed',3)
        reply(message,dict(sessionId='child',configOptions=options))
    elif method=='_goose/unstable/session/export':
        if mode=='read-error' or (mode=='after-child-read-error' and p['sessionId']=='child'):send(dict(id=message['id'],error=dict(code=-32601,message='fixture export not supported')));continue
        if mode=='hold-read':
            while not (root/'release-read').exists():time.sleep(.01)
        if mode=='config-drift' and p['sessionId']=='parent' and child is None:
            changed=json.loads(json.dumps(options));changed[0]['currentValue']='other'
            send(dict(method='session/update',params=dict(sessionId='parent',update=dict(sessionUpdate='config_option_update',configOptions=changed))))
        messages=original if p['sessionId']=='parent' else child
        data=dict(id=p['sessionId'],working_dir=str(root),message_count=sum(item['metadata']['userVisible'] for item in messages),conversation=messages,extension_data={},provider_name='selected',model_config=dict(model_name='m'),goose_mode='approve',recipe=None,user_recipe_values=None)
        reply(message,dict(data=json.dumps(data)))
