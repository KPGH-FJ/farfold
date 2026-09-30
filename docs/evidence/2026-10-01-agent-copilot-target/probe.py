"""One initialize-only observation of the currently registered official program.

Raw protocol, environment, command, argument and error values stay in memory.
Only fixed enums, booleans and counts are persisted. No login or session request.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import sqlite3
import subprocess
import time

base = Path(__file__).resolve().parent
out = base / 'observation.json'
if out.exists():
    raise SystemExit('Observation already exists; do not repeat automatically')
data = Path.home() / 'Library/Application Support/ai.farfold.desktop'
database = data / 'farfold.sqlite3'


def snapshot():
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as connection:
        return {table: hashlib.sha256(json.dumps(connection.execute(
            f'SELECT * FROM {table} ORDER BY 1').fetchall(), sort_keys=True,
            default=str).encode()).hexdigest() for table in ('sessions', 'agents', 'settings')}


before = snapshot()
with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as connection:
    row = connection.execute('SELECT id,source,command,args,env,version FROM agents WHERE id=?',
                             ('registry:github-copilot-cli',)).fetchone()
    inventory = json.loads(connection.execute('SELECT value FROM settings WHERE key=?',
                                              ('installations.v1',)).fetchone()[0])
assert row and row[1] == 'registry' and row[5] == '1.0.89'
args = json.loads(row[3])
env = json.loads(row[4])
assert isinstance(env, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in env.items())
receipts = [item for item in inventory if item['agentId'] == row[0]
            and item['command'] == row[2] and item['args'] == args
            and item['source'] == 'managed' and item['version'] == row[5] and item.get('managedRoot')]
assert len(receipts) == 1
root = Path(receipts[0]['managedRoot']).resolve(strict=True)
loader = root / 'node_modules/@github/copilot/npm-loader.js'
package_path = root / 'node_modules/@github/copilot/package.json'
platform_path = root / 'node_modules/@github/copilot-darwin-arm64/package.json'
package = json.loads(package_path.read_text())
platform = json.loads(platform_path.read_text())
target = platform_path.parent / 'copilot'
assert args == [str(loader), '--acp']
assert all(path.resolve(strict=True).is_relative_to(root) for path in (loader, package_path, platform_path, target))
assert package['name'] == '@github/copilot' and platform['name'] == '@github/copilot-darwin-arm64'
assert package['version'] == platform['version'] == row[5]
assert package['bin']['copilot'] == 'npm-loader.js'
assert package['optionalDependencies']['@github/copilot-darwin-arm64'] == row[5]
assert platform['exports']['.'] == './copilot'
assert not any(line.strip() == '/Applications/Farfold.app/Contents/MacOS/farfold'
               for line in subprocess.check_output(['ps', '-axo', 'comm='], text=True).splitlines())

result = {'at': datetime.datetime.now().astimezone().isoformat(), 'kind': 'initialize-only-probe',
          'registeredOfficialSource': True, 'selectedReceiptMatches': True,
          'sameRootPackageAndPlatformVersion': True, 'sentInitialize': 0,
          'sentAuthenticate': 0, 'sentSessionRequests': 0, 'outcome': 'pending',
          'stdoutBytes': 0, 'stderrBytes': 0}
process = None
selector = selectors.DefaultSelector()
buffer = b''
try:
    process = subprocess.Popen([row[2], *args], cwd=data / 'conversations',
                               env={**os.environ, **env}, start_new_session=True,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    request = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
        'protocolVersion': 1, 'clientInfo': {'name': 'farfold', 'version': '0.1.7'},
        'clientCapabilities': {'elicitation': {'form': {}}, 'auth': {'terminal': True},
                               '_meta': {'terminal-auth': True, 'jetbrains': {'air': {
                                   'version': 1, 'capabilities': ['sessionFailure']}}}}}}
    process.stdin.write((json.dumps(request) + '\n').encode())
    process.stdin.flush()
    result['sentInitialize'] = 1
    selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
    selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and result['outcome'] == 'pending' and selector.get_map():
        for key, _ in selector.select(timeout=min(1, max(0, deadline-time.monotonic()))):
            chunk = os.read(key.fileobj.fileno(), 16384)
            if not chunk:
                selector.unregister(key.fileobj)
                continue
            result[key.data+'Bytes'] += len(chunk)
            if result[key.data+'Bytes'] > 1048576:
                result['outcome'] = 'byte-limit'
                break
            if key.data == 'stderr':
                continue
            buffer += chunk
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                try:
                    value = json.loads(line)
                except (ValueError, UnicodeError):
                    continue
                if not isinstance(value, dict) or value.get('id') != 1:
                    continue
                if 'error' in value:
                    result['outcome'] = 'rpc-error'
                    break
                response = value.get('result')
                if not isinstance(response, dict):
                    result['outcome'] = 'invalid-result'
                    break
                methods = response.get('authMethods', [])
                methods = methods if isinstance(methods, list) else []
                matching = [m for m in methods if isinstance(m, dict) and m.get('id') == 'copilot-login']
                result['methodCount'] = len(methods)
                result['matchingMethodCount'] = len(matching)
                result['outcome'] = 'initialize-result'
                if len(matching) != 1:
                    break
                method = matching[0]
                meta = method.get('_meta', {})
                terminal = meta.get('terminal-auth') if isinstance(meta, dict) else None
                declaration = terminal if isinstance(terminal, dict) else {}
                command = declaration.get('command')
                declared_args = declaration.get('args', [])
                resolved = None
                if isinstance(command, str) and Path(command).is_absolute():
                    try:
                        resolved = Path(command).resolve(strict=True)
                    except (OSError, ValueError):
                        pass
                result['declaration'] = {
                    'typeAbsent': 'type' not in method,
                    'legacyTerminalObject': isinstance(terminal, dict),
                    'targetAbsolute': isinstance(command, str) and Path(command).is_absolute(),
                    'targetResolves': resolved is not None,
                    'targetIsSelectedNode': resolved == Path(row[2]).resolve(strict=True),
                    'targetIsSelectedLoader': resolved == loader.resolve(strict=True),
                    'targetIsSamePackagePlatformExport': resolved == target.resolve(strict=True),
                    'targetInsideSelectedRoot': resolved is not None and resolved.is_relative_to(root),
                    'argumentsExactlyLogin': declared_args == ['login'],
                    'argumentsEmpty': declared_args == [],
                    'argumentsExactlyAuthLogin': declared_args == ['auth', 'login'],
                    'argumentCount': len(declared_args) if isinstance(declared_args, list) else None,
                    'methodEnvironmentAbsentOrEmpty': method.get('env') in (None, {}),
                    'terminalEnvironmentAbsentOrEmpty': declaration.get('env') in (None, {}),
                }
    if result['outcome'] == 'pending':
        result['outcome'] = 'timeout' if time.monotonic() >= deadline else 'eof-before-result'
except Exception:
    result['outcome'] = 'probe-error'
finally:
    selector.close()
    if process is not None:
        result['terminationRequested'] = process.poll() is None
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            result['killRequested'] = True
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=3)
        result['childReaped'] = process.returncode is not None
        result['childExitCode'] = process.returncode
        # Only a process group created above can be targeted or checked.
        try:
            os.killpg(process.pid, 0)
            result['processGroupAbsent'] = False
        except ProcessLookupError:
            result['processGroupAbsent'] = True
    result['databaseTablesUnchanged'] = {key: value == snapshot()[key] for key, value in before.items()}
    result['finishedAt'] = datetime.datetime.now().astimezone().isoformat()
    out.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
