"""Copy only validated content-free event and startup fields for this candidate."""
import datetime
import json
from pathlib import Path

base = Path(__file__).resolve().parent
start = int(datetime.datetime.fromisoformat(json.loads(
    (base / 'candidate-install.json').read_text())['at']).timestamp() * 1000)
end = int(datetime.datetime.now().astimezone().timestamp() * 1000)
events = {'initialize', 'authenticate', 'session/new', 'session/load', 'session/prompt',
          'session/update', 'session/cancel', 'session/request_permission',
          'session/set_config_option', 'session/list', 'response', 'other'}
phases = {'spawn', 'registration', 'initialize', 'cleanup'}
outcomes = {'unknown', 'success', 'cancelled', 'failed', 'timeout', 'ended', 'start_failed'}
booleans = ['initializeAccepted', 'childStarted', 'childReaped', 'waitFailed',
            'termRequested', 'killRequested', 'exitObservedBeforeTerm',
            'groupEnded', 'connectionRemoved']


def safe(value):
    if (not isinstance(value, dict) or type(value.get('version')) is not int
            or type(value.get('ts')) is not int or value['ts'] < 0):
        return None
    if (value.get('version') == 1 and value.get('event') in events
            and value.get('dir') in ['in', 'out', 'err']
            and value.get('error') in ['none', 'stderr', 'protocol']
            and type(value.get('bytes')) is int and value['bytes'] >= 0):
        record = {key: value[key] for key in ['version', 'ts', 'dir', 'event', 'bytes', 'error']}
        common_classes = ['parse_error', 'invalid_request', 'method_not_found',
                          'invalid_params', 'internal_error', 'other']
        allowed_classes = {
            'out': common_classes,
            'in': common_classes + ['auth_required', 'request_cancelled', 'resource_not_found'],
        }
        if (value['event'] == 'response' and value['error'] == 'protocol'
                and value.get('protocolErrorClass') in allowed_classes.get(value['dir'], [])
                and type(value.get('responseIdNull')) is bool
                and type(value.get('beforeInitializeAccepted')) is bool):
            record.update({key: value[key] for key in ['protocolErrorClass', 'responseIdNull', 'beforeInitializeAccepted']})
        return record
    if value.get('version') != 2 or value.get('event') != 'startup':
        return None
    if (value.get('phase') not in phases or value.get('failurePhase') not in phases | {None}
            or value.get('startupOutcome') not in outcomes
            or value.get('initializeResponse') not in ['not_observed', 'matched_result', 'matched_error']
            or value.get('candidateCleanup') not in ['not_applicable', 'pending', 'deleted', 'retained', 'unconfirmed']
            or not all(type(value.get(key)) is bool for key in booleans)):
        return None
    for key, minimum, maximum in [('exitCode', 0, 255), ('exitSignal', 1, 127)]:
        if value.get(key) is not None and (type(value[key]) is not int or not minimum <= value[key] <= maximum):
            return None
    if (value.get('exitCode') is not None and value.get('exitSignal') is not None
            or not value['childReaped'] and any(value.get(k) is not None for k in ['exitCode', 'exitSignal'])
            or value['childReaped'] and not value['childStarted']):
        return None
    keys = ['version', 'ts', 'event', 'phase', 'failurePhase', 'startupOutcome',
            'initializeResponse', 'candidateCleanup', 'exitCode', 'exitSignal', *booleans]
    return {key: value.get(key) for key in keys}


files = []
for path in sorted((Path.home() / 'Library/Logs/Farfold').glob('protocol-v1-*.jsonl')):
    try:
        stamp = int(path.name.split('-')[2])
    except ValueError:
        continue
    if stamp < start:
        continue
    records = []
    rejected = 0
    with path.open() as source:
        for line in source:
            if not line.endswith('\n'):
                rejected += 1
                continue
            try:
                record = safe(json.loads(line))
            except (ValueError, TypeError):
                record = None
            if record is not None:
                if start <= record['ts'] <= end:
                    records.append(record)
            else:
                rejected += 1
    files.append({'file': path.name, 'events': records, 'rejectedRecords': rejected})
result = {'at': datetime.datetime.now().astimezone().isoformat(),
          'windowStart': start, 'windowEnd': end, 'files': files}
(base / 'protocol-metadata-final.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'files': len(files), 'sentPrompts': sum(e.get('dir') == 'out' and
    e['event'] == 'session/prompt' for f in files for e in f['events']),
    'startupRecords': sum(e['version'] == 2 for f in files for e in f['events'])}))
