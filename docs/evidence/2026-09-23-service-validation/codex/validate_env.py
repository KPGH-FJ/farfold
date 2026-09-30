"""Registered real Codex ACP -> bounded local Responses fixture; no real service key.

Reuses the repository's existing ACP process probe. Raw requests/headers are never
persisted. Each test creates dedicated Agent-owned history, never edits old history.
"""
import asyncio
import datetime
import importlib.util
import json
import os
from pathlib import Path
import secrets
import sqlite3
import sys

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('base_probe', ROOT.parents[1] / '2026-09-21-acceptance-fixes/probe.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.ROOT = ROOT
CAPS = {'auth': {'terminal': True}, '_meta': {'terminal-auth': True}}


class Fixture:
    def __init__(self, lane, token, mode='env'):
        self.lane, self.token, self.records = lane, token, []
        self.mode = mode
        self.server = None
        self.marker = 'FARFOLD-CODEX-LOCAL-' + lane.upper()

    async def start(self):
        self.server = await asyncio.start_server(self.handle, '127.0.0.1', 0, limit=2**21)
        self.port = self.server.sockets[0].getsockname()[1]

    async def handle(self, reader, writer):
        try:
            head = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 10)
            lines = head.decode('latin1').split('\r\n')
            method, path, _ = lines[0].split(' ', 2)
            headers = dict(line.split(':', 1) for line in lines[1:] if ':' in line)
            headers = {k.lower(): v.strip() for k, v in headers.items()}
            n = int(headers.get('content-length', '0'))
            if n > 2**20:
                raise ValueError('request_size_limit')
            raw = await asyncio.wait_for(reader.readexactly(n), 10) if n else b'{}'
            data = json.loads(raw)
            self.records.append({'method': method, 'path': path,
                                 'model': data.get('model'), 'stream': data.get('stream'),
                                 'reasoning': data.get('reasoning'),
                                 'expected_key_received': headers.get('authorization') == 'Bearer ' + self.token,
                                 'tool_definition_count': len(data.get('tools', [])),
                                 'tool_names': [{'name': t.get('name'), 'type': t.get('type')} for t in data.get('tools', [])],
                                 'controlled_tool_output_seen': any('FARFOLD-CODEX-TOOL-OK' in str(i.get('output', '')) for i in data.get('input', []) if isinstance(i, dict) and i.get('type') == 'function_call_output')})
            if self.mode.startswith('fault') and self.lane == 'a':
                payload = json.dumps({'error': {'type': 'invalid_request_error', 'code': 'invalid_api_key', 'message': 'Controlled fixture rejects this key'}}).encode()
                writer.write(b'HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ' + str(len(payload)).encode() + b'\r\n\r\n' + payload)
            elif method != 'POST' or not path.startswith('/v1/responses'):
                payload = json.dumps({'error': {'message': 'fixture accepts responses only'}}).encode()
                writer.write(b'HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ' + str(len(payload)).encode() + b'\r\n\r\n' + payload)
            else:
                message = {'id': 'msg_' + self.lane, 'type': 'message', 'role': 'assistant',
                           'status': 'completed', 'content': [{'type': 'output_text', 'text': self.marker, 'annotations': []}]}
                response = {'id': 'resp_' + self.lane, 'object': 'response', 'created_at': 1750000000,
                            'status': 'completed', 'model': data.get('model'), 'output': [message],
                            'usage': {'input_tokens': 10, 'output_tokens': 5, 'total_tokens': 15}}
                events = [
                    {'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}},
                    {'type': 'response.output_item.added', 'output_index': 0, 'item': {**message, 'status': 'in_progress', 'content': []}},
                    {'type': 'response.content_part.added', 'item_id': message['id'], 'output_index': 0, 'content_index': 0, 'part': {'type': 'output_text', 'text': '', 'annotations': []}},
                    {'type': 'response.output_text.delta', 'item_id': message['id'], 'output_index': 0, 'content_index': 0, 'delta': self.marker},
                    {'type': 'response.output_text.done', 'item_id': message['id'], 'output_index': 0, 'content_index': 0, 'text': self.marker},
                    {'type': 'response.content_part.done', 'item_id': message['id'], 'output_index': 0, 'content_index': 0, 'part': message['content'][0]},
                    {'type': 'response.output_item.done', 'output_index': 0, 'item': message},
                    {'type': 'response.completed', 'response': response},
                ]
                if self.mode == 'tool' and len(self.records) == 1:
                    tool = next((t for t in data.get('tools', []) if t.get('name') == 'exec_command'), None)
                    if tool is not None:
                        call = {'type': 'function_call', 'id': 'fc_' + self.lane, 'call_id': 'call_' + self.lane,
                                'name': 'exec_command', 'arguments': json.dumps({'cmd': 'printf FARFOLD-CODEX-TOOL-OK', 'max_output_tokens': 50}), 'status': 'completed'}
                        response['output'] = [call]
                        events = [
                            {'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}},
                            {'type': 'response.output_item.added', 'output_index': 0, 'item': {**call, 'arguments': '', 'status': 'in_progress'}},
                            {'type': 'response.function_call_arguments.delta', 'item_id': call['id'], 'output_index': 0, 'delta': call['arguments']},
                            {'type': 'response.function_call_arguments.done', 'item_id': call['id'], 'output_index': 0, 'arguments': call['arguments']},
                            {'type': 'response.output_item.done', 'output_index': 0, 'item': call},
                            {'type': 'response.completed', 'response': response},
                        ]
                payload = ''.join('event: ' + e['type'] + '\ndata: ' + json.dumps({**e, 'sequence_number': i}) + '\n\n' for i, e in enumerate(events)).encode()
                writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: ' + str(len(payload)).encode() + b'\r\n\r\n' + payload)
            await writer.drain()
        except Exception as e:
            self.records.append({'fixture_exception': type(e).__name__})
        finally:
            writer.close()
            await writer.wait_closed()

    async def close(self):
        self.server.close()
        await self.server.wait_closed()


def options(result):
    return [{k: o.get(k) for k in ('id', 'category', 'currentValue', 'options')} for o in result.get('configOptions', [])]


async def rpc(p, method, params, rid, seconds=40):
    await p.acp(method, params, rid)
    value = await p.response(rid, seconds)
    if value is None:
        raise TimeoutError(method)
    if 'error' in value:
        # Strip possibly sensitive upstream messages; stable code and allowlisted
        # local model/provider identifiers are sufficient for this probe.
        p.note(failed_method=method, code=value['error'].get('code'))
        raise RuntimeError('rpc_error_' + method)
    return value['result']


async def lane_run(lane, argv, original_env, fixture):
    env = {**os.environ, **original_env}
    provider = 'farfold_local_' + lane
    env_name = 'FARFOLD_LOCAL_FIXTURE_KEY'
    env[env_name] = fixture.token
    config = {'model': 'farfold-fixture-' + lane, 'model_reasoning_effort': 'high',
              'model_provider': provider,
              'model_providers': {provider: {'name': 'Farfold local controlled fixture ' + lane,
                 'base_url': f'http://127.0.0.1:{fixture.port}/v1', 'wire_api': 'responses',
                 'env_key': env_name, 'requires_openai_auth': False,
                 'request_max_retries': 0, 'stream_max_retries': 0}}}
    env['CODEX_CONFIG'] = json.dumps(config)
    env['MODEL_PROVIDER'] = provider
    # This configuration contains only a variable name, never its value.
    assert fixture.token not in env['CODEX_CONFIG']
    (ROOT / (fixture.mode + '-configuration-' + lane + '.json')).write_text(json.dumps(config, indent=2) + '\n')
    sid = None
    result_summary = {'lane': lane, 'configuration': config, 'phases': []}
    for phase in (('new', 'load') if fixture.mode == 'env' else ('new',)):
        if phase == 'load' and not sid:
            break
        p = base.Probe(fixture.mode + '-' + lane + '-' + phase)
        phase_summary = {'phase': phase}
        try:
            await p.start(argv, env)
            caps = json.loads(json.dumps(CAPS))
            if fixture.mode == 'fault-typed':
                caps['_meta']['jetbrains'] = {'air': {'version': 1, 'capabilities': ['sessionFailure']}}
            initialized = await rpc(p, 'initialize', {'protocolVersion': 1,
                'clientInfo': {'name': 'farfold-local-service-validation', 'version': '1'},
                'clientCapabilities': caps}, 1)
            phase_summary['agentInfo'] = initialized.get('agentInfo')
            phase_summary['providers'] = await rpc(p, 'providers/list', {}, 2)
            cwd = ROOT / 'shared-project'
            cwd.mkdir(exist_ok=True)
            params = {'cwd': str(cwd), 'mcpServers': []}
            if phase == 'load':
                params['sessionId'] = sid
            opened = await rpc(p, 'session/' + phase, params, 3, 50)
            sid = opened.get('sessionId', sid)
            phase_summary['session_id'] = sid
            phase_summary['options'] = options(opened)
            phase_summary['model_state'] = opened.get('models')
            p.note(options=[{k: o.get(k) for k in ('id', 'category', 'currentValue')} for o in opened.get('configOptions', [])])
            if fixture.mode == 'menu':
                await p.acp('session/set_config_option', {'sessionId': sid, 'configId': 'model', 'value': 'farfold-fixture-a-other'}, 5)
                change = await p.response(5, 10)
                phase_summary['select_unlisted_custom_model'] = {'reply_received': change is not None, 'error_code': (change or {}).get('error', {}).get('code'), 'result_keys': list((change or {}).get('result', {}))}
                continue
            prompt = 'This is a local transport fixture. Reply once, do not use tools, read or change files, inspect credentials, or change settings.'
            if fixture.mode == 'tool':
                prompt = 'This is a controlled tool transport check. Run exactly printf FARFOLD-CODEX-TOOL-OK once, then reply. Do not run any other command, read or change files, inspect credentials, or change settings.'
            prompted = await rpc(p, 'session/prompt', {'sessionId': sid, 'prompt': [{'type': 'text', 'text': prompt}]}, 4, 45)
            phase_summary['stop_reason'] = prompted.get('stopReason')
            failure = prompted.get('_meta', {}).get('jetbrains', {}).get('air', {}).get('sessionFailure')
            phase_summary['structured_failure'] = {k: failure.get(k) for k in ('category', 'severity', 'recoverable')} if failure else None
            phase_summary['text_mentions_controlled_failure'] = any(t in p.text for t in ('401', 'Unauthorized', 'Controlled fixture rejects', 'invalid_api_key'))
            phase_summary['fixture_marker_received'] = fixture.marker in p.text
            phase_summary['fixture_requests_so_far'] = len(fixture.records)
        except Exception as e:
            phase_summary['exception'] = type(e).__name__
            phase_summary['exception_stage'] = str(e) if str(e).startswith('rpc_error_') else None
        finally:
            if hasattr(p, 'proc'):
                await p.close()
            result_summary['phases'].append(phase_summary)
    return result_summary


async def main():
    with sqlite3.connect('file:' + str(base.DB) + '?mode=ro', uri=True) as db:
        row = db.execute("SELECT command,args,env FROM agents WHERE id='codex'").fetchone()
    argv, inherited = [row[0], *json.loads(row[1])], json.loads(row[2])
    assert not any(str(v).startswith('__keychain__') for v in inherited.values())
    mode = sys.argv[1] if len(sys.argv) > 1 else 'env'
    assert mode in ('env', 'tool', 'fault', 'fault-typed', 'menu')
    fixtures = [Fixture(lane, secrets.token_urlsafe(24), mode) for lane in (('a',) if mode == 'menu' else ('a', 'b'))]
    for fixture in fixtures:
        await fixture.start()
    try:
        lanes = await asyncio.gather(*(lane_run(f.lane, argv, inherited, f) for f in fixtures))
    finally:
        for fixture in fixtures:
            await fixture.close()
    result = {'at': datetime.datetime.now().astimezone().isoformat(),
              'evidence_level': 'real registered Codex ACP and CLI with synthetic localhost Responses service; no real model call',
              'argv': argv, 'lanes': lanes, 'http_observations': {f.lane: f.records for f in fixtures}}
    destination = ROOT / ('result.json' if mode == 'env' else mode + '-result.json')
    destination.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'result': str(destination), 'phases': [{ 'lane': l['lane'], 'results': [{k:v for k,v in p.items() if k not in ('model_state', 'options', 'providers')} for p in l['phases']]} for l in lanes], 'http': result['http_observations']}, indent=2))


if __name__ == '__main__':
    asyncio.run(main())
