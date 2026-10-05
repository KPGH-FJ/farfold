"""Read only process names and Farfold-owned state hashes/counts."""
import hashlib
import json
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('/Users/tw/Desktop/farfold')
OUT = Path(__file__).resolve().parent / 'installed'
DATA = Path('/Users/tw/Library/Application Support/ai.farfold.desktop')
OUT.mkdir(exist_ok=True)


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def snapshot():
    connection = sqlite3.connect((DATA / 'farfold.sqlite3').as_uri() + '?mode=ro', uri=True)
    connection.execute('PRAGMA query_only=ON')
    result = {'scope': 'Farfold-owned hashes only; excludes Agent command/args/env, config_options, credentials, terminal and account files', 'tables': {}}
    for table, columns in [
        ('sessions', 'id,agent_id,cwd,native_session_id,title,pinned,archived,created_at,updated_at'),
        ('agents', 'id,name,source,version,created_at,updated_at'),
        ('settings', 'key,value'), ('dismissed_sessions', 'id,created_at'),
    ]:
        cursor = connection.execute(f'SELECT {columns} FROM {table}')
        names = [column[0] for column in cursor.description]
        rows = cursor.fetchall()
        result['tables'][table] = {'count': len(rows), 'rows': {digest(row[0]): {name: digest(value) for name, value in zip(names, row)} for row in rows}}
    connection.close()
    result['databaseFiles'] = {name: hashlib.sha256((DATA / name).read_bytes()).hexdigest() for name in ['farfold.sqlite3', 'farfold.sqlite3-wal', 'farfold.sqlite3-shm'] if (DATA / name).exists()}
    return result


def processes():
    rows = {}
    for line in subprocess.check_output(['/bin/ps', '-axo', 'pid=,ppid=,comm='], text=True).splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3:
            rows[int(parts[0])] = {'pid': int(parts[0]), 'ppid': int(parts[1]), 'program': Path(parts[2]).name}
    roots = {pid for pid, row in rows.items() if row['program'] == 'farfold'}
    seen = set(roots)
    while True:
        children = {pid for pid, row in rows.items() if row['ppid'] in seen}
        if children <= seen:
            break
        seen |= children
    return {'scope': 'PID, parent PID and executable basename only; no args/env/terminal', 'appPids': sorted(roots), 'descendants': [rows[pid] for pid in sorted(seen) if pid in rows]}


if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'preflight':
        state = processes()
        connection = sqlite3.connect((DATA / 'farfold.sqlite3').as_uri() + '?mode=ro', uri=True)
        connection.execute('PRAGMA query_only=ON')
        row = connection.execute('SELECT value FROM settings WHERE key=?', ('unsentWork.v1',)).fetchone()
        connection.close()
        draft = json.loads(row[0]) if row else None
        known = draft is None or (isinstance(draft, dict) and draft.get('version') == 1 and isinstance(draft.get('composers'), dict) and all(isinstance(value, dict) for value in draft['composers'].values()))
        composers = draft.get('composers', {}) if known and draft else {}
        pending = sum(value.get('sendPending') is True for value in composers.values())
        result = {
            'atUtc': datetime.now(timezone.utc).isoformat(), 'processes': state,
            'persistedUnsentStateKnown': known, 'persistedSendPendingCount': pending,
            'persistedUnsentStateSha256': digest(draft),
            'normalExitWaitsForLatestUnsentSave': True,
            'safeToRequestNormalExit': known and pending == 0 and len(state['appPids']) <= 1 and len(state['descendants']) == len(state['appPids']),
        }
        (OUT / 'preflight.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result))
        if not result['safeToRequestNormalExit']:
            raise SystemExit('STOP current work or unknown state blocks normal exit')
    elif mode == 'processes':
        print(json.dumps(processes()))
    elif mode == 'data':
        result = snapshot()
        (OUT / (sys.argv[2] + '-data.json')).write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'counts': {name: value['count'] for name, value in result['tables'].items()}}))
    else:
        raise SystemExit('Unknown mode')
