"""Record only the newly created acceptance session and its own pending work."""
import datetime
import json
import sqlite3
import sys
from pathlib import Path

base = Path(__file__).resolve().parent
target = base / sys.argv[1]
if target.exists():
    raise SystemExit('Preserve existing observation')
session_id = json.loads((base / 'stopped-first-run.json').read_text())['newSessions'][0]
db = Path.home() / 'Library/Application Support/ai.farfold.desktop/farfold.sqlite3'
with sqlite3.connect(f'file:{db}?mode=ro', uri=True) as connection:
    row = connection.execute('SELECT id,agent_id,cwd,native_session_id,config_options FROM sessions WHERE id=?', (session_id,)).fetchone()
    unsent = json.loads(connection.execute('SELECT value FROM settings WHERE key=?', ('unsentWork.v1',)).fetchone()[0])
result = {'at': datetime.datetime.now().astimezone().isoformat(),
          'session': dict(zip(['id', 'agentId', 'cwd', 'nativeId', 'config'], row)),
          'ownQueue': unsent.get('queues', {}).get(session_id),
          'ownActivity': unsent.get('activity', {}).get(session_id)}
target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False))
