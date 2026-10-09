"""Bounded protocol probe against the configured installed Claude Agent.

The only model service provided by this probe is its own loopback HTTP peer.
No account switch, private HOME, Agent config write, or automatic retry.
This proves request routing, not a real model response or all Agent standards.
"""
import datetime
import http.server
import json
import os
from pathlib import Path
import queue
import signal
import sqlite3
import subprocess
import sys
import threading
import time

ROOT = Path('/Users/tw/Desktop/farfold')
OUT = ROOT / 'output/2026-10-09-continuous-development/claude-routing'
MODEL = 'farfold-controlled-route-model'
TOKEN = 'farfold-controlled-route-not-a-secret'
MARKER = 'FARFOLD_CONTROLLED_ROUTE_OK'
requests = []


class Peer(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        size = int(self.headers.get('Content-Length', '0'))
        if size > 2_000_000:
            self.send_error(413)
            return
        body = json.loads(self.rfile.read(size))
        requests.append({
            'path': self.path,
            'model': body.get('model'),
            'keyMatches': self.headers.get('x-api-key') == TOKEN,
            'authorizationPresent': bool(self.headers.get('authorization')),
            'authorizationIsProxyOrAbsent': self.headers.get('authorization') in (None, 'Bearer acp-proxy'),
            'stream': body.get('stream'),
        })
        if self.path.split('?')[0] == '/v1/messages/count_tokens':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"input_tokens":10}')
            return
        if self.path.split('?')[0] != '/v1/messages':
            self.send_error(404)
            return
        message = {'id': 'msg_controlled', 'type': 'message', 'role': 'assistant',
                   'model': MODEL, 'content': [], 'stop_reason': None,
                   'stop_sequence': None, 'usage': {'input_tokens': 10, 'output_tokens': 0}}
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream' if body.get('stream') else 'application/json')
        self.end_headers()
        if not body.get('stream'):
            message.update(content=[{'type': 'text', 'text': MARKER}], stop_reason='end_turn')
            message['usage']['output_tokens'] = 1
            self.wfile.write(json.dumps(message).encode())
            return
        events = [
            ('message_start', {'type': 'message_start', 'message': message}),
            ('content_block_start', {'type': 'content_block_start', 'index': 0,
                                     'content_block': {'type': 'text', 'text': ''}}),
            ('content_block_delta', {'type': 'content_block_delta', 'index': 0,
                                     'delta': {'type': 'text_delta', 'text': MARKER}}),
            ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
            ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn',
                                                                'stop_sequence': None},
                               'usage': {'output_tokens': 1}}),
            ('message_stop', {'type': 'message_stop'}),
        ]
        for name, event in events:
            self.wfile.write(('event: ' + name + '\ndata: ' + json.dumps(event) + '\n\n').encode())
            self.wfile.flush()


def main():
    OUT.mkdir(parents=True, exist_ok=False)
    workspace = OUT / 'workspace'
    workspace.mkdir()
    database = Path('/Users/tw/Library/Application Support/ai.farfold.desktop/farfold.sqlite3')
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
        row = connection.execute("SELECT command,args,env FROM agents WHERE id='registry:claude-acp' AND source='registry'").fetchone()
    if row is None:
        raise RuntimeError('configured registered Agent missing')
    command, arguments, settings = row[0], json.loads(row[1]), json.loads(row[2])
    package = Path(arguments[0]).parent.parent / 'package.json'
    metadata = json.loads(package.read_text())
    environment = dict(os.environ)
    environment.update(settings)
    environment.update(ANTHROPIC_MODEL=MODEL, ANTHROPIC_CUSTOM_MODEL_OPTION=MODEL)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Peer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    route = 'http://127.0.0.1:' + str(server.server_port)
    stderr_fd = os.open(OUT / 'stderr.txt', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    process = subprocess.Popen([command, *arguments], cwd=workspace, env=environment,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr_fd,
                               text=True, start_new_session=True)
    os.close(stderr_fd)
    inbox = queue.Queue()
    def read():
        for line in process.stdout:
            try:
                inbox.put(json.loads(line))
            except ValueError:
                inbox.put({'invalidJson': True})
        inbox.put({'closed': True})
    threading.Thread(target=read, daemon=True).start()
    sequence = 0
    observed = {'updates': 0, 'permissionsCancelled': 0, 'markerSeen': False}
    calls = []
    def send(message):
        process.stdin.write(json.dumps(dict(jsonrpc='2.0', **message)) + '\n')
        process.stdin.flush()
    def rpc(method, params, timeout=45):
        nonlocal sequence
        sequence += 1
        ident = sequence
        calls.append(method)
        send({'id': ident, 'method': method, 'params': params})
        deadline = time.monotonic() + timeout
        while True:
            message = inbox.get(timeout=max(0.01, deadline - time.monotonic()))
            if message.get('closed') or message.get('invalidJson'):
                raise RuntimeError('transport ended or malformed output')
            if message.get('id') == ident and 'method' not in message:
                if 'error' in message:
                    raise RuntimeError(method + ' returned error code ' + str(message['error'].get('code')))
                return message.get('result')
            if message.get('method') == 'session/update':
                observed['updates'] += 1
                text = message.get('params', {}).get('update', {}).get('content', {}).get('text', '')
                observed['markerSeen'] |= MARKER in text
            if 'id' in message and 'method' in message:
                if message['method'] == 'session/request_permission':
                    observed['permissionsCancelled'] += 1
                    send({'id': message['id'], 'result': {'outcome': {'outcome': 'cancelled'}}})
                else:
                    send({'id': message['id'], 'error': {'code': -32601, 'message': 'Probe does not provide this callback'}})
            if time.monotonic() >= deadline:
                raise TimeoutError(method + ' timed out')
    receipt = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'kind': 'installed-official-agent-with-controlled-http-peer',
               'version': metadata['version'], 'source': metadata['name'],
               'calls': calls, 'requests': requests, 'observed': observed,
               'realModelAnswer': False, 'outcome': 'failed'}
    try:
        initialized = rpc('initialize', {'protocolVersion': 1, 'clientCapabilities': {},
                                        'clientInfo': {'name': 'Farfold routing probe', 'version': '1'}})
        if not isinstance(initialized.get('agentCapabilities', {}).get('providers'), dict):
            raise RuntimeError('official provider interface not declared')
        providers = rpc('providers/list', {})['providers']
        eligible = [p for p in providers if 'anthropic' in p.get('supported', [])]
        if len(eligible) != 1:
            raise RuntimeError('ambiguous provider slot')
        provider_id = eligible[0]['providerId']
        rpc('providers/set', {'providerId': provider_id, 'apiType': 'anthropic',
                              'baseUrl': route, 'headers': {'x-api-key': TOKEN}})
        confirmed = rpc('providers/list', {})['providers']
        if not any(p.get('providerId') == provider_id and p.get('current', {}).get('apiType') == 'anthropic'
                   and p.get('current', {}).get('baseUrl') == route for p in confirmed):
            raise RuntimeError('route not confirmed')
        result = rpc('session/new', {'cwd': str(workspace), 'mcpServers': []})
        receipt['modelConfirmed'] = any(o.get('category') == 'model' and o.get('currentValue') == MODEL
                                        for o in result.get('configOptions', []))
        if not receipt['modelConfirmed']:
            raise RuntimeError('selected model not confirmed')
        completed = rpc('session/prompt', {'sessionId': result['sessionId'],
                                           'prompt': [{'type': 'text', 'text': 'Only reply ' + MARKER + '. Do not use tools or read or modify files.'}]}, 60)
        receipt['stopReason'] = completed.get('stopReason')
        messages = [r for r in requests if r['path'].split('?')[0] == '/v1/messages']
        receipt['routeVerified'] = bool(messages) and all(r['keyMatches'] and r['authorizationIsProxyOrAbsent'] and r['model'] == MODEL for r in messages)
        if receipt['routeVerified'] and observed['markerSeen'] and completed.get('stopReason') == 'end_turn':
            receipt['outcome'] = 'passed'
    except (Exception, KeyboardInterrupt) as error:
        # Do not publish raw remote error data, headers or runtime stderr.
        receipt['failureClass'] = type(error).__name__
        receipt['failureStage'] = calls[-1] if calls else 'launch'
    finally:
        # The leader can exit while its SDK child still belongs to our group.
        # This PGID was created only by this invocation, never looked up by name.
        def group_exists():
            process.poll()  # Reap our leader before checking the group.
            try:
                os.killpg(process.pid, 0)
                return True
            except ProcessLookupError:
                return False
        def signal_group(sig):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                pass
        for sig in (signal.SIGTERM, signal.SIGKILL):
            if not group_exists():
                break
            signal_group(sig)
            deadline = time.monotonic() + 5
            while group_exists() and time.monotonic() < deadline:
                time.sleep(0.05)
        receipt['ownedLeaderExited'] = process.poll() is not None
        receipt['ownedProcessGroupGone'] = not group_exists()
        if not receipt['ownedProcessGroupGone']:
            receipt['outcome'] = 'cleanup-unconfirmed'
        server.shutdown()
        server.server_close()
        (OUT / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps(receipt))
    return 0 if receipt['outcome'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
