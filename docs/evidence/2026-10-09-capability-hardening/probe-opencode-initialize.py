"""One bounded initialization-only comparison using the registered command.

Inherits HOME/environment and uses the same observed folder as the app. No
prompt, authentication change, configuration write, or automatic retry.
"""
from pathlib import Path
import datetime
import json
import os
import queue
import signal
import sqlite3
import subprocess
import threading
import time

ROOT = Path('/Users/tw/Desktop/farfold')
OUT = ROOT / 'output/2026-10-09-continuous-development/opencode-initialize'
OUT.mkdir(exist_ok=False)
database = Path.home() / 'Library/Application Support/ai.farfold.desktop/farfold.sqlite3'
with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as db:
    command, args, env = db.execute("SELECT command,args,env FROM agents WHERE id='opencode'").fetchone()
environment = dict(os.environ)
environment.update(json.loads(env))
request = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
    'protocolVersion': 1, 'clientInfo': {'name': 'farfold', 'version': '0.1.7'},
    'clientCapabilities': {'session': {'configOptions': {'boolean': {}}},
        'elicitation': {'form': {}}, 'auth': {'terminal': True},
        '_meta': {'terminal-auth': True, 'jetbrains': {'air': {
            'version': 1, 'capabilities': ['sessionFailure']}}}}}}
record = {'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'installedAppCommit': 'af4870168ce29ded9d2a55cdb646771e57991012',
          'method': 'initialize', 'appObservation': 'AGENT_INITIALIZE_TIMEOUT',
          'cwd': '/Users/tw/Desktop/TR', 'timeoutSeconds': 65,
          'privateHome': False, 'agentConfigWritten': False, 'promptSent': False,
          'environment': 'Inherited shell plus registered env; not claimed identical to GUI launch environment.'}
stderr = os.open(OUT / 'stderr.txt', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
process = subprocess.Popen([command, *json.loads(args)], cwd=record['cwd'], env=environment,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True, start_new_session=True)
os.close(stderr)
inbox = queue.Queue()

def read():
    for line in process.stdout:
        try:
            inbox.put(json.loads(line))
        except ValueError:
            inbox.put({'invalidJson': True})
    inbox.put({'closed': True})

def group_exists():
    try:
        os.killpg(process.pid, 0)
        return True
    except ProcessLookupError:
        return False

threading.Thread(target=read, daemon=True).start()
started = time.monotonic()
try:
    process.stdin.write(json.dumps(request) + '\n')
    process.stdin.flush()
    while True:
        message = inbox.get(timeout=max(0.01, 65 - (time.monotonic() - started)))
        if message.get('id') == 1 and 'method' not in message:
            result = message.get('result', {})
            record.update(result='initialized' if 'result' in message else 'protocolError',
                          protocolVersion=result.get('protocolVersion'), agentInfo=result.get('agentInfo'),
                          errorCode=message.get('error', {}).get('code'))
            break
        if message.get('closed') or message.get('invalidJson'):
            record['result'] = 'closed' if message.get('closed') else 'invalidJson'
            break
        if 'method' in message and 'id' in message:
            process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': message['id'],
                'error': {'code': -32601, 'message': 'Initialization-only probe'}}) + '\n')
            process.stdin.flush()
except queue.Empty:
    record['result'] = 'timeout'
except Exception as error:
    record.update(result='probeError', errorType=type(error).__name__)
finally:
    record['responseSeconds'] = round(time.monotonic() - started, 3)
    if group_exists():
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass
    deadline = time.monotonic() + 3
    while group_exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    if group_exists():
        os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=3)
    record['ownProcessExited'] = process.poll() is not None
    record['ownProcessGroupGone'] = not group_exists()
    destination = Path(__file__).parent / 'opencode-initialize.json'
    with destination.open('x') as handle:
        handle.write(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(record, ensure_ascii=False))
