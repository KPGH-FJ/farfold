"""Three bounded real prompts with root-supplied Key read without echo.

Uses registered executable, existing ACP probe, and env-only service configuration.
No raw prompt response, Key, Authorization header or private config is written.
"""
import asyncio
import datetime
import getpass
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('validation', ROOT / 'validate_env.py')
validation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validation)
base = validation.base
MODEL = 'Atria-Dawn-Preview'
PROVIDER = 'farfold_atria_validation'
ENV_NAME = 'FARFOLD_SERVICE_VALIDATION_KEY'
CONFIG = {'model': MODEL, 'model_reasoning_effort': 'high',
          'model_provider': PROVIDER,
          'model_providers': {PROVIDER: {'name': 'Atria controlled Farfold validation',
             'base_url': 'https://api.atria-asi.ai/v1', 'wire_api': 'responses',
             'env_key': ENV_NAME, 'requires_openai_auth': False,
             'request_max_retries': 0, 'stream_max_retries': 0}}}
CAPS = {'auth': {'terminal': True}, '_meta': {'terminal-auth': True,
        'jetbrains': {'air': {'version': 1, 'capabilities': ['sessionFailure']}}}}


class AuditedReader:
    def __init__(self, stream, probe):
        self.stream, self.probe = stream, probe

    def __aiter__(self):
        return self

    async def __anext__(self):
        line = await self.stream.readline()
        if not line:
            raise StopAsyncIteration
        try:
            msg = json.loads(line)
            update = msg.get('params', {}).get('update', {})
            kind = update.get('sessionUpdate')
            if kind in ('tool_call', 'tool_call_update'):
                encoded = json.dumps(update)
                self.probe.tool_observations.append({
                    'kind': kind, 'status': update.get('status'),
                    'contains_requested_printf': 'printf FARFOLD-ATRIA-TOOL-OK' in encoded,
                    'contains_tool_marker': 'FARFOLD-ATRIA-TOOL-OK' in encoded,
                    'has_output': bool(update.get('rawOutput') or update.get('content'))})
            for carrier in (update, msg.get('result', {})):
                failure = carrier.get('_meta', {}).get('jetbrains', {}).get('air', {}).get('sessionFailure')
                if failure:
                    self.probe.error_details.append(self.probe.safe_failure(failure))
            if isinstance(msg.get('error'), dict):
                error = msg['error']
                self.probe.error_details.append({'rpc_code': error.get('code'),
                    'rpc_message': self.probe.redact(error.get('message', ''))})
        except (ValueError, UnicodeDecodeError):
            pass
        return line


class AuditedProbe(base.Probe):
    def __init__(self, name, secret):
        super().__init__(name)
        self.tool_observations = []
        self.error_details = []
        self.secret = secret

    def redact(self, value):
        if not isinstance(value, str):
            return None
        text = value.replace(self.secret, '[REDACTED]')
        text = re.sub(r'(?i)(bearer|authorization|x-api-key)(\s*[:=]?\s*)[^\s,;]+', r'\1\2[REDACTED]', text)
        text = re.sub(r'https?://[^\s?]+\?[^\s]+', '[URL_WITH_QUERY_REDACTED]', text)
        return text[:1000]

    def safe_failure(self, failure):
        value = {k: failure.get(k) for k in ('category', 'severity', 'revision')}
        for field in ('code', 'title', 'message'):
            raw = failure.get(field)
            if isinstance(raw, str):
                value[field] = self.redact(raw)
            elif isinstance(raw, int):
                value[field] = raw
        return value

    async def read(self):
        self.proc.stdout = AuditedReader(self.proc.stdout, self)
        await super().read()


async def main(key):
    with sqlite3.connect('file:' + str(base.DB) + '?mode=ro', uri=True) as db:
        row = db.execute("SELECT command,args,env FROM agents WHERE id='codex'").fetchone()
    argv, inherited = [row[0], *json.loads(row[1])], json.loads(row[2])
    assert not any(str(v).startswith('__keychain__') for v in inherited.values())
    env = {**os.environ, **inherited, ENV_NAME: key,
           'CODEX_CONFIG': json.dumps(CONFIG), 'MODEL_PROVIDER': PROVIDER}
    assert key not in env['CODEX_CONFIG']
    cwd = ROOT / 'atria-project'
    cwd.mkdir(exist_ok=True)
    (ROOT / 'atria-configuration.json').write_text(json.dumps(CONFIG, indent=2) + '\n')
    result = {'at': datetime.datetime.now().astimezone().isoformat(), 'evidence_level': 'real external Atria service through registered Codex ACP/CLI',
              'agent_argv': argv, 'configuration': CONFIG, 'phases': [], 'max_prompt_admissions': 3,
              'application_retries': 0, 'note': 'Codex may independently retry network failures; provider retry limits requested as zero.'}
    sid, expected_config, proceed = None, None, True
    for phase in ('new', 'load'):
        if not proceed or (phase == 'load' and sid is None):
            break
        p = AuditedProbe('atria-' + phase, key)
        record = {'phase': phase, 'prompts': []}
        try:
            await p.start(argv, env)
            init = await validation.rpc(p, 'initialize', {'protocolVersion': 1,
                'clientInfo': {'name': 'farfold-atria-validation', 'version': '1'},
                'clientCapabilities': CAPS}, 1, 20)
            record['agent_info'] = init.get('agentInfo')
            record['providers'] = await validation.rpc(p, 'providers/list', {}, 2, 10)
            params = {'cwd': str(cwd), 'mcpServers': []}
            if phase == 'load':
                params['sessionId'] = sid
            opened = await validation.rpc(p, 'session/' + phase, params, 3, 45)
            sid = opened.get('sessionId', sid)
            record['session_id'] = sid
            record['options'] = validation.options(opened)
            record['model_state'] = opened.get('models')
            current = (opened.get('models') or {}).get('currentModelId')
            record['model_id_with_effort'] = current
            if phase == 'new':
                expected_config = current
            elif current != expected_config:
                record['model_or_effort_drift'] = True
                proceed = False
                continue
            selected = next((o.get('currentValue') for o in opened.get('configOptions', []) if o.get('category') == 'model'), None)
            if selected != MODEL or current != MODEL + '[high]':
                record['unexpected_model_or_effort'] = True
                proceed = False
                continue
            prompts = [('text', 'FARFOLD-ATRIA-TEXT-OK', 'Reply only FARFOLD-ATRIA-TEXT-OK. Do not use tools, read or change files, inspect credentials, or change settings.'),
                       ('tool', 'FARFOLD-ATRIA-TOOL-OK', 'Run exactly the shell command printf FARFOLD-ATRIA-TOOL-OK once, then reply FARFOLD-ATRIA-TOOL-OK. Do not run any other command, read or change files, inspect credentials, change settings, or use any other tool.')] if phase == 'new' else [
                       ('resume', 'FARFOLD-ATRIA-RESUME-OK', 'Reply only FARFOLD-ATRIA-RESUME-OK. Do not use tools, read or change files, inspect credentials, or change settings.')]
            for i, (label, marker, prompt) in enumerate(prompts, 4):
                p.text = ''
                p.tool_observations = []
                p.error_details = []
                response = await validation.rpc(p, 'session/prompt', {'sessionId': sid, 'prompt': [{'type': 'text', 'text': prompt}]}, i, 90)
                failure = response.get('_meta', {}).get('jetbrains', {}).get('air', {}).get('sessionFailure')
                check = {'label': label, 'stop_reason': response.get('stopReason'), 'expected_marker': marker in p.text,
                         'structured_failure': {k: failure.get(k) for k in ('category', 'severity', 'recoverable')} if failure else None,
                         'error_details': p.error_details,
                         'tool_observations': p.tool_observations}
                record['prompts'].append(check)
                print(json.dumps({'phase': phase, **check}), flush=True)
                if not check['expected_marker'] or (failure and failure.get('severity') == 'error'):
                    proceed = False
                    break
                if label == 'tool' and not any(t['status'] == 'completed' and t['contains_tool_marker'] and t['has_output'] for t in p.tool_observations):
                    check['tool_execution_unconfirmed'] = True
                    proceed = False
                    break
        except Exception as e:
            record['exception'] = type(e).__name__
            record['exception_stage'] = str(e) if str(e).startswith('rpc_error_') else None
            record['error_details'] = p.error_details
            proceed = False
        finally:
            if hasattr(p, 'proc'):
                await p.close()
            result['phases'].append(record)
            (ROOT / 'atria-result.json').write_text(json.dumps(result, indent=2) + '\n')
    # The key exists only in this process and its child environment during the probe.
    env.pop(ENV_NAME, None)
    print(json.dumps({'result': str(ROOT / 'atria-result.json'), 'completed_all_checks': proceed}), flush=True)


if __name__ == '__main__':
    api_key = getpass.getpass('Atria API Key (not saved or echoed): ') if sys.stdin.isatty() else sys.stdin.readline().rstrip('\r\n')
    if not api_key or any(c in api_key for c in '\r\n'):
        raise SystemExit('Key required; no requests made')
    asyncio.run(main(api_key))
