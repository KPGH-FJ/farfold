"""Deterministic ACP test peer for installed UI load testing, not a real Agent.
No provider, credentials, user files or model calls. Own state stores only profile names.
"""
import asyncio
import json
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATE = ROOT / 'fixture-state.json'
EVENTS = ROOT / 'fixture-events.jsonl'
profiles = json.loads(STATE.read_text()) if STATE.exists() else {}
running = {}
pending = {}
options = [{'id': 'model', 'name': 'Test load', 'category': 'model', 'type': 'select',
            'currentValue': 'synthetic', 'options': [{'value': 'synthetic', 'name': 'Synthetic load'}]}]


def send(value):
    print(json.dumps({'jsonrpc': '2.0', **value}), flush=True)


def result(message, value):
    send({'id': message['id'], 'result': value})


def note(kind, **data):
    with EVENTS.open('a') as f:
        f.write(json.dumps({'time': time.time(), 'kind': kind, **data}) + '\n')


def update(sid, text, role='agent_message_chunk'):
    send({'method': 'session/update', 'params': {'sessionId': sid, 'update': {
        'sessionUpdate': role, 'content': {'type': 'text', 'text': text}}}})


async def replay(sid, profile, delay=False):
    if profile == 'HISTORY1000':
        for i in range(500):
            update(sid, f'Synthetic user row {i:04d}', 'user_message_chunk')
            update(sid, f'Synthetic reply row {i:04d}: ' + 'content ' * 12)
            if i % 20 == 0:
                await asyncio.sleep(.01)
        note('history_emitted', session=sid, rows=1000)
    else:
        size = 131072 if profile == 'PERF128' else 65536
        chunk = ('Synthetic load line, no real model or files. ' * 6)[:255] + '\n'
        assert len(chunk) == 256
        for i in range(size // len(chunk)):
            update(sid, chunk)
            if delay:
                await asyncio.sleep(.075 if size == 131072 else .15)
        note('text_emitted', session=sid, bytes=size)


async def prompt(message):
    sid = message['params']['sessionId']
    text = ' '.join(p.get('text', '') for p in message['params'].get('prompt', []))
    requests = set()

    def ask(method, params, request=None):
        request = request or str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        pending[request] = future
        requests.add(request)
        send({'id': request, 'method': method, 'params': {'sessionId': sid, **params}})
        return request, future

    async def form_reply(request, future):
        reply = await future
        action = reply.get('action') if isinstance(reply, dict) else None
        note('form_response', requestId=request,
             action=action if action in ('accept', 'decline', 'cancel') else 'error')

    try:
        if text.startswith(('PERF128', 'PERF64', 'HISTORY1000')):
            profile = text.split()[0]
            profiles[sid] = profile
            STATE.write_text(json.dumps(profiles))
            await replay(sid, profile, True)
            update(sid, '\n\nLOAD-COMPLETE')
        elif text.startswith('PERMISSIONS'):
            waits = []
            for i in range(2):
                request = str(uuid.uuid4())
                _, future = ask('session/request_permission', {
                    'toolCall': {'toolCallId': request, 'title': f'Synthetic approval {i}', 'kind': 'read'},
                    'options': [{'optionId': 'yes', 'name': 'Allow once', 'kind': 'allow_once'},
                                {'optionId': 'no', 'name': 'Reject', 'kind': 'reject_once'}]}, request)
                waits.append(future)
            await asyncio.gather(*waits)
            update(sid, 'SYNTHETIC-APPROVALS-RESPONDED')
        elif text.startswith('FORMS'):
            waits = []
            for label, field in [('A', 'alpha_value'), ('B', 'beta_value')]:
                request, future = ask('elicitation/create', {
                    'mode': 'form',
                    'message': f'Synthetic form {label}: simulated request; no real service or model. Enter any test value.',
                    'requestedSchema': {
                        'type': 'object',
                        'properties': {field: {'type': 'string', 'title': f'Synthetic {label} value'}},
                        'required': [field],
                    },
                })
                waits.append(form_reply(request, future))
            await asyncio.gather(*waits)
            update(sid, 'SYNTHETIC-FORMS-RESPONDED')
        else:
            update(sid, 'SYNTHETIC-REPLY')
        result(message, {'stopReason': 'end_turn'})
        note('complete', session=sid)
    except asyncio.CancelledError:
        result(message, {'stopReason': 'cancelled'})
        note('cancelled', session=sid)
    finally:
        for request in requests:
            future = pending.pop(request, None)
            if future is not None and not future.done():
                future.cancel()
        if running.get(sid) is asyncio.current_task():
            running.pop(sid, None)


async def main():
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin)
    while line := await reader.readline():
        m = json.loads(line)
        method = m.get('method')
        p = m.get('params', {})
        if method == 'initialize':
            result(m, {'protocolVersion': 1, 'agentInfo': {'name': 'Synthetic acceptance peer', 'version': '1'},
                       'agentCapabilities': {'loadSession': True}, 'authMethods': []})
        elif method in ('session/new', 'session/load'):
            sid = p.get('sessionId') or str(uuid.uuid4())
            if sid in profiles:
                await replay(sid, profiles[sid])
            result(m, {'configOptions': options, **({'sessionId': sid} if method == 'session/new' else {})})
        elif method == 'session/prompt':
            running[p['sessionId']] = asyncio.create_task(prompt(m))
            # Start the owner before a buffered cancel can cancel an unstarted task.
            await asyncio.sleep(0)
        elif method == 'session/cancel':
            if p['sessionId'] in running:
                running[p['sessionId']].cancel()
        elif method == 'session/close':
            if p['sessionId'] in running:
                running[p['sessionId']].cancel()
            result(m, {})
        elif method is None:
            future = pending.pop(m.get('id'), None)
            if future is not None and not future.done():
                future.set_result(m.get('result'))
        elif 'id' in m:
            send({'id': m['id'], 'error': {'code': -32601, 'message': 'Not supported in test peer'}})


asyncio.run(main())
