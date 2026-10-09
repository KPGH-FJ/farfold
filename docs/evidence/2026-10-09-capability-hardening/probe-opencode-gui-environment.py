"""Bounded initialize-only reconstruction. Never persists environment or stderr.

Captures only the installed main process's launch environment in memory and
re-runs Farfold's login-shell resolution from its observed cwd. This is not a
claim to read the already cached LOGIN_ENV. No session/prompt/config/auth calls.
"""
from pathlib import Path
import ctypes
import datetime
import json
import os
import queue
import signal
import sqlite3
import struct
import subprocess
import threading
import time

ROOT = Path('/Users/tw/Desktop/farfold')
MAIN_PID = 54178
DESTINATION = Path(__file__).with_name('opencode-gui-environment.json')
if DESTINATION.exists():
    raise SystemExit('Receipt already exists; no automatic retry')
rows = subprocess.check_output(['/bin/ps', '-p', str(MAIN_PID), '-o', 'comm='], text=True)
if rows.strip() != '/Applications/Farfold.app/Contents/MacOS/farfold':
    raise SystemExit('Main process identity changed')
libc = ctypes.CDLL(None, use_errno=True)
mib = (ctypes.c_int * 3)(1, 49, MAIN_PID)
size = ctypes.c_size_t(1024 * 1024)
buf = ctypes.create_string_buffer(size.value)
if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0):
    raise SystemExit('Main launch environment unavailable')
data = buf.raw[:size.value]
argc = struct.unpack_from('i', data)[0]
offset = data.index(b'\0', 4) + 1
while offset < len(data) and not data[offset]:
    offset += 1
for _ in range(argc):
    offset = data.index(b'\0', offset) + 1
app_environment = {}
for entry in data[offset:].split(b'\0'):
    if b'=' in entry:
        name, value = entry.split(b'=', 1)
        app_environment[name.decode()] = value.decode()
probe = subprocess.Popen([app_environment.get('SHELL', 'zsh'), '-ilc', 'env'],
    cwd='/', env=app_environment, stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, preexec_fn=os.setpgrp)
try:
    shell_output, _ = probe.communicate(timeout=5)
except subprocess.TimeoutExpired:
    os.killpg(probe.pid, signal.SIGKILL)
    probe.communicate()
    raise SystemExit('Login-shell reconstruction timed out; Agent not started')
if probe.returncode != 0:
    raise SystemExit('Login-shell reconstruction failed; Agent not started')
login_environment = dict(line.split('=', 1) for line in shell_output.decode().splitlines()
    if '=' in line and line.split('=', 1)[0])
if not login_environment:
    raise SystemExit('Login-shell reconstruction empty; Agent not started')
environment = {**app_environment, **login_environment}
database = Path.home() / 'Library/Application Support/ai.farfold.desktop/farfold.sqlite3'
with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as db:
    command, args, registered = db.execute("SELECT command,args,env FROM agents WHERE id='opencode'").fetchone()
    rows = db.execute("SELECT value FROM settings WHERE key='credentials.v1'").fetchall()
    pool = json.loads(rows[0][0]) if rows else []
    grants = sum(g.get('agent_id', g.get('agentId')) == 'opencode' for c in pool for g in c.get('grants', []))
if json.loads(registered) or grants:
    raise SystemExit('Launch configuration requires credentials; no reconstruction attempted')
request = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
    'protocolVersion': 1, 'clientInfo': {'name': 'farfold', 'version': '0.1.7'},
    'clientCapabilities': {'fs': {'readTextFile': False, 'writeTextFile': False}, 'terminal': False,
        'session': {'configOptions': {'boolean': {}}}, 'elicitation': {'form': {}},
        'auth': {'terminal': True}, '_meta': {'terminal-auth': True,
            'jetbrains': {'air': {'version': 1, 'capabilities': ['sessionFailure']}}}}}}
encoded = json.dumps(request, separators=(',', ':')) + '\n'
record = {'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'method': 'initialize', 'mainAppUntouched': True, 'promptSent': False,
    'configWritten': False, 'keychainRead': False, 'registeredEnvironmentEntries': 0,
    'legacyCredentialGrants': grants, 'cwd': '/Users/tw/Desktop/TR', 'timeoutSeconds': 60,
    'launch': {'environment': 'Main launch environment + freshly reconstructed -ilc env; values not recorded',
        'cachedEnvironmentEquality': 'unverified', 'loginShellCwd': '/',
        'processGroup': 'setpgrp, equivalent new group without setsid', 'childPipes': 'blocking',
        'initializeBytesWithoutNewline': len(encoded) - 1},
    'safeComparisons': {name: {'present': name in environment,
        'equalsShellProbeEnvironment': environment.get(name) == os.environ.get(name)}
        for name in ['HOME', 'SHELL', 'PATH', 'TMPDIR', 'PWD', 'TERM']}}
process = subprocess.Popen([command, *json.loads(args)], cwd=record['cwd'], env=environment,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    preexec_fn=os.setpgrp)
inbox = queue.Queue()
counts = {'stderrBytes': 0, 'stdoutBytes': 0}
def read_stdout():
    for line in process.stdout:
        counts['stdoutBytes'] += len(line)
        try:
            inbox.put(json.loads(line))
        except ValueError:
            inbox.put({'invalidJson': True})
    inbox.put({'closed': True})
def drain_stderr():
    while True:
        chunk = process.stderr.read(4096)
        if not chunk:
            return
        counts['stderrBytes'] += len(chunk)
def group_exists():
    try:
        os.killpg(process.pid, 0)
        return True
    except ProcessLookupError:
        return False
threading.Thread(target=read_stdout, daemon=True).start()
threading.Thread(target=drain_stderr, daemon=True).start()
started = time.monotonic()
try:
    process.stdin.write(encoded.encode())
    process.stdin.flush()
    record['writeFlushed'] = True
    while True:
        message = inbox.get(timeout=max(0.01, 60 - (time.monotonic() - started)))
        if message.get('id') == 1 and 'method' not in message:
            result = message.get('result', {})
            info = result.get('agentInfo', {})
            record.update(result='initialized' if 'result' in message else 'protocolError',
                protocolVersion=result.get('protocolVersion'),
                knownOpenCodeIdentity=info.get('name') == 'OpenCode',
                knownInstalledVersion=info.get('version') == '1.18.31',
                errorCode=message.get('error', {}).get('code'))
            break
        if message.get('closed') or message.get('invalidJson'):
            record['result'] = 'closed' if message.get('closed') else 'invalidJson'
            break
        if 'method' in message and 'id' in message:
            process.stdin.write((json.dumps({'jsonrpc': '2.0', 'id': message['id'],
                'error': {'code': -32601, 'message': 'Initialization-only probe'}}) + '\n').encode())
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
    record.update(counts)
    record['ownProcessExited'] = process.poll() is not None
    record['ownProcessGroupGone'] = not group_exists()
    with DESTINATION.open('x') as handle:
        handle.write(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(record, ensure_ascii=False))
