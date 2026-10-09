"""Read current declared options; no prompt or set-config request."""
import sqlite3
import json
import os
import subprocess
import threading
import queue
import signal
import time
from pathlib import Path

ROOT = Path('/Users/tw/Desktop/farfold')
out = ROOT / 'output/2026-10-09-continuous-development/codex-config'
out.mkdir(exist_ok=False)
database = Path.home() / 'Library/Application Support/ai.farfold.desktop/farfold.sqlite3'
with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as db:
    command, args, env = db.execute("SELECT command,args,env FROM agents WHERE id='codex'").fetchone()
descriptor = os.open(out / 'stderr.txt', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
p = subprocess.Popen([command, *json.loads(args)], cwd='/Users/tw/Desktop/TR',
    env=dict(os.environ, **json.loads(env)), stdin=subprocess.PIPE,
    stdout=subprocess.PIPE, stderr=descriptor, text=True, start_new_session=True)
os.close(descriptor)
inbox = queue.Queue()

def read():
    for line in p.stdout:
        try:
            inbox.put(json.loads(line))
        except ValueError:
            inbox.put({'invalid': True})
    inbox.put({'closed': True})

threading.Thread(target=read, daemon=True).start()

def rpc(ident, method, params):
    p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': ident, 'method': method, 'params': params}) + '\n')
    p.stdin.flush()
    deadline = time.monotonic() + 30
    while True:
        value = inbox.get(timeout=max(0.01, deadline - time.monotonic()))
        if value.get('closed') or value.get('invalid'):
            raise RuntimeError('Transport closed or invalid')
        if value.get('id') == ident and 'method' not in value:
            if 'error' in value:
                raise RuntimeError('Protocol error ' + str(value['error'].get('code')))
            return value['result']
        if 'method' in value and 'id' in value:
            p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': value['id'],
                'error': {'code': -32601, 'message': 'Read options only'}}) + '\n')
            p.stdin.flush()

def alive():
    try:
        os.killpg(p.pid, 0)
        return True
    except ProcessLookupError:
        return False

result = {'promptSent': False, 'configSet': False, 'environment': 'inherited shell',
          'cwd': '/Users/tw/Desktop/TR', 'initialAttempt': 'A prior shell snippet failed Python syntax parsing before any execution; this is the first launched probe.'}
capabilities = {
    'session': {'configOptions': {'boolean': {}}},
    'auth': {'terminal': True}, 'elicitation': {'form': {}},
    '_meta': {'terminal-auth': True, 'jetbrains': {'air': {
        'version': 1, 'capabilities': ['sessionFailure']}}},
}
try:
    handshake = rpc(1, 'initialize', {'protocolVersion': 1,
        'clientInfo': {'name': 'farfold', 'version': '0.1.7'},
        'clientCapabilities': capabilities})
    session = rpc(2, 'session/new', {'cwd': '/Users/tw/Desktop/TR', 'mcpServers': []})
    result.update(agentInfo=handshake.get('agentInfo'), status='read',
        options=[{k: v for k, v in option.items()
            if k in ('id', 'type', 'name', 'category', 'currentValue')}
            for option in session.get('configOptions', [])],
        modes=session.get('modes'))
except Exception as error:
    result.update(status='error', errorType=type(error).__name__)
finally:
    if alive():
        os.killpg(p.pid, signal.SIGTERM)
    try:
        p.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass
    deadline = time.monotonic() + 3
    while alive() and time.monotonic() < deadline:
        time.sleep(0.05)
    if alive():
        os.killpg(p.pid, signal.SIGKILL)
    p.wait(timeout=3)
    result.update(processExited=p.poll() is not None, groupGone=not alive())
    with (Path(__file__).parent / 'codex-config-probe.json').open('x') as handle:
        handle.write(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False))
