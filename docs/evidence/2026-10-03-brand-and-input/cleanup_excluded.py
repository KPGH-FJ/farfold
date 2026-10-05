"""Exact one-time cleanup of the user's excluded Farfold records.

Never opens Agent configs, environment values, credential stores, transcripts,
terminal output, or executables. Native histories and external installs remain.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import uuid
from datetime import datetime, timezone

TARGETS = frozenset('registry:' + value for value in (
    'agoragentic-acp', 'cortex-code', 'crow-cli', 'deepagents',
    'glm-acp-agent', 'harn', 'minion-code', 'vtcode',
))
DATA = Path('/Users/tw/Library/Application Support/ai.farfold.desktop')
OUT = Path(__file__).resolve().parent
KNOWN = {'agentSetup.v1', 'agentWorkPolicy.v1', 'unsentWork.v1',
         'conversationGroups.v1', 'conversationReadState.v1'}
PLACEHOLDERS = ','.join('?' for _ in TARGETS)


def digest(value):
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(value.encode()).hexdigest()


def object_at(value, key):
    result = value.get(key)
    if not isinstance(result, dict):
        raise ValueError('Unexpected owned setting structure: ' + key)
    return result


def target_conversation(key):
    for prefix in ('session:', 'queue-edit:'):
        if key.startswith(prefix):
            key = key[len(prefix):]
    return any(key.startswith(agent + ':') for agent in TARGETS)


def target_scope(key):
    if key in TARGETS:
        return True
    try:
        scope = json.loads(key)
        return isinstance(scope, list) and scope and scope[0] in TARGETS
    except (ValueError, TypeError):
        return False


def exact_setting(key):
    if key in {'installPrevious.' + a for a in TARGETS} | {'agent.' + a + '.work' for a in TARGETS}:
        return True
    prefix = 'auth.manual.v1.'
    return key.startswith(prefix) and target_scope(key[len(prefix):])


def transform(key, original):
    value = copy.deepcopy(original)
    if not isinstance(value, dict):
        raise ValueError('Unexpected setting object: ' + key)
    if key != 'conversationGroups.v1' and value.get('version') != 1:
        raise ValueError('Unexpected setting version: ' + key)
    if key == 'agentSetup.v1':
        if not isinstance(value.get('completed'), list):
            raise ValueError('Unexpected setup completed records')
        value['completed'] = [x for x in value['completed'] if x not in TARGETS]
        for field in ('pending', 'progress', 'selections'):
            value[field] = {k: v for k, v in object_at(value, field).items() if not target_scope(k)}
    elif key == 'agentWorkPolicy.v1':
        value['defaults'] = {k: v for k, v in object_at(value, 'defaults').items() if k not in TARGETS}
        value['projects'] = {folder: {k: v for k, v in policies.items() if k not in TARGETS}
                             for folder, policies in object_at(value, 'projects').items()}
    elif key == 'conversationGroups.v1':
        value['assignments'] = {k: v for k, v in object_at(value, 'assignments').items() if not target_conversation(k)}
    elif key == 'conversationReadState.v1':
        if not isinstance(value.get('unread'), list):
            raise ValueError('Unexpected unread records')
        value['unread'] = [k for k in value['unread'] if not target_conversation(k)]
    elif key == 'unsentWork.v1':
        composers = object_at(value, 'composers')
        for name, draft in list(composers.items()):
            pending = draft.get('pendingConversation') or {}
            related = target_conversation(name) or pending.get('agentId') in TARGETS
            if related and draft.get('sendPending'):
                raise ValueError('STOP excluded conversation has pending send: ' + digest(name))
            if target_conversation(name):
                if draft.get('text') or draft.get('attachments') or draft.get('queueEdit'):
                    raise ValueError('STOP excluded conversation has unsent content: ' + digest(name))
                del composers[name]
            elif pending.get('agentId') in TARGETS:
                draft.pop('pendingConversation', None)
        choice = object_at(value, 'choice')
        if choice.get('agentId') in TARGETS:
            choice.update(agentId=None, service=None, config={})
        for field in ('feedback', 'queues', 'activity'):
            items = object_at(value, field)
            for name, item in list(items.items()):
                if target_conversation(name):
                    if field in ('feedback', 'queues') and item:
                        raise ValueError('STOP excluded conversation has unsent ' + field + ': ' + digest(name))
                    del items[name]
    return value


def connection(path, writable=False):
    db = sqlite3.connect(path.as_uri() + ('?mode=rw' if writable else '?mode=ro'), uri=True)
    db.create_function('record_hash', 1, digest, deterministic=True)
    if not writable:
        db.execute('PRAGMA query_only=ON')
    return db


def metadata(db):
    return {'otherInstallations': list(db.execute(f"SELECT record_hash(json(j.value)) FROM settings s,json_each(s.value) j WHERE s.key='installations.v1' AND json_extract(j.value,'$.agentId') NOT IN ({PLACEHOLDERS}) ORDER BY json_extract(j.value,'$.id')", tuple(sorted(TARGETS)))),
            'credentialRecordsAfterRevoke': list(db.execute(f"SELECT record_hash(json_set(c.value,'$.grants',json((SELECT json_group_array(json(g.value)) FROM json_each(c.value,'$.grants') g WHERE json_extract(g.value,'$.agentId') NOT IN ({PLACEHOLDERS}))))) FROM settings s,json_each(s.value) c WHERE s.key='credentials.v1' ORDER BY json_extract(c.value,'$.id')", tuple(sorted(TARGETS)))),
            'agents': list(db.execute('SELECT id,name,source,version,created_at,updated_at FROM agents ORDER BY id')),
            'sessions': list(db.execute('SELECT id,agent_id,cwd,native_session_id,title,pinned,archived,created_at,updated_at FROM sessions ORDER BY id')),
            'dismissed': list(db.execute('SELECT id,created_at FROM dismissed_sessions ORDER BY id')),
            'settings': dict(db.execute('SELECT key,record_hash(value) FROM settings ORDER BY key'))}


def installation_metadata(db):
    return [{'id': r[0], 'agentId': r[1], 'path': r[2], 'managedRoot': r[3], 'programOnly': bool(r[4])}
            for r in db.execute("SELECT json_extract(j.value,'$.id'),json_extract(j.value,'$.agentId'),json_extract(j.value,'$.path'),json_extract(j.value,'$.managedRoot'),json_extract(j.value,'$.programOnly') FROM settings s,json_each(s.value) j WHERE s.key='installations.v1'")]


def validate_root(item, records, db, data):
    root = Path(item['managedRoot'])
    encoded = 'agent-' + ''.join(chr(b) if chr(b).isascii() and (chr(b).isalnum() or chr(b) in '-_') else f'%{b:02X}' for b in item['agentId'].encode())
    parents = [data / 'agents' / item['agentId'], data / ('companion-programs' if item['programOnly'] else 'agent-installations') / encoded]
    if root.parent not in parents or root.resolve(strict=False) != root:
        raise ValueError('STOP invalid recorded managed root')
    for part in [root, root.parent, root.parent.parent, data]:
        if part.is_symlink():
            raise ValueError('STOP managed root ancestry is a link')
    if root.exists() and not root.is_dir():
        raise ValueError('STOP managed root is not a directory')
    for other in records:
        if other['agentId'] not in TARGETS:
            for path in (other['path'], other['managedRoot']):
                if path and (Path(path) == root or root in Path(path).parents):
                    raise ValueError('STOP managed root is shared by another Agent')
    shared = db.execute(f'SELECT COUNT(*) FROM agents WHERE id NOT IN ({PLACEHOLDERS}) AND (instr(command,?)>0 OR instr(args,?)>0)', (*sorted(TARGETS), str(root), str(root))).fetchone()[0]
    if shared:
        raise ValueError('STOP another Agent references recorded root')
    return {'path': str(root), 'agentId': item['agentId'], 'exists': root.exists(),
            'inode': root.stat().st_ino if root.exists() else None}


def prepare(db, data=None):
    if data is None:
        data = DATA
    before = metadata(db)
    patches = {}
    delete_keys = [key for key in before['settings'] if exact_setting(key)]
    for key in KNOWN & before['settings'].keys():
        raw = db.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()[0]
        old = json.loads(raw)
        new = transform(key, old)
        if new != old:
            patches[key] = json.dumps(new, ensure_ascii=False, separators=(',', ':'))
    records = installation_metadata(db)
    owned = [x for x in records if x['agentId'] in TARGETS]
    roots = {}
    for item in owned:
        if item['managedRoot']:
            info = validate_root(item, records, db, data)
            roots[info['path']] = info
    grants = db.execute(f"SELECT COUNT(*) FROM settings s,json_each(s.value) c,json_each(c.value,'$.grants') g WHERE s.key='credentials.v1' AND json_extract(g.value,'$.agentId') IN ({PLACEHOLDERS})", tuple(sorted(TARGETS))).fetchone()[0]
    target_agents = [r[0] for r in before['agents'] if r[0] in TARGETS]
    target_sessions = [r[0] for r in before['sessions'] if r[1] in TARGETS]
    target_dismissed = [r[0] for r in before['dismissed'] if target_conversation(r[0])]
    plan = {'targets': sorted(TARGETS), 'presentAgentIds':target_agents,
            'sessionCount':len(target_sessions),'dismissedCount':len(target_dismissed),
            'settingKeysRemoved':delete_keys,'settingKeysUpdated':sorted(patches),
            'installationReceiptsRemoved':len(owned),'grantsRevoked':grants,
            'managedRoots':list(roots.values()),'metadataFingerprint':digest(before),
            'patchHashes':{k:digest(v) for k,v in patches.items()},
            'externalInstallationsDeleted':False,'nativeDataAccessed':False}
    plan['fingerprint'] = digest(plan)
    return plan, before, patches


def mutate(db, plan, patches):
    args = tuple(sorted(TARGETS))
    db.execute(f'DELETE FROM sessions WHERE agent_id IN ({PLACEHOLDERS})', args)
    db.execute(f'DELETE FROM agents WHERE id IN ({PLACEHOLDERS})', args)
    for key, in db.execute('SELECT id FROM dismissed_sessions').fetchall():
        if target_conversation(key):
            db.execute('DELETE FROM dismissed_sessions WHERE id=?', (key,))
    for key in plan['settingKeysRemoved']:
        db.execute('DELETE FROM settings WHERE key=?', (key,))
    for key, value in patches.items():
        db.execute('UPDATE settings SET value=? WHERE key=?', (value, key))
    if plan['installationReceiptsRemoved']:
        db.execute(f"UPDATE settings SET value=(SELECT json_group_array(json(j.value)) FROM json_each(settings.value) j WHERE json_extract(j.value,'$.agentId') NOT IN ({PLACEHOLDERS})) WHERE key='installations.v1'", args)
    if plan['grantsRevoked']:
        db.execute(f"UPDATE settings SET value=(SELECT json_group_array(json_set(c.value,'$.grants',json((SELECT json_group_array(json(g.value)) FROM json_each(c.value,'$.grants') g WHERE json_extract(g.value,'$.agentId') NOT IN ({PLACEHOLDERS}))))) FROM json_each(settings.value) c) WHERE key='credentials.v1'", args)


def verify_others(before, after, plan):
    for key, predicate in [('agents',lambda r:r[0] not in TARGETS),('sessions',lambda r:r[1] not in TARGETS),('dismissed',lambda r:not target_conversation(r[0]))]:
        if after[key] != [row for row in before[key] if predicate(row)]:
            raise ValueError('STOP unrelated table records changed: ' + key)
    for key in ('otherInstallations', 'credentialRecordsAfterRevoke'):
        if before[key] != after[key]:
            raise ValueError('STOP unrelated managed metadata changed: ' + key)
    changed = set(plan['settingKeysRemoved']) | set(plan['settingKeysUpdated'])
    if plan['installationReceiptsRemoved']:
        changed.add('installations.v1')
    if plan['grantsRevoked']:
        changed.add('credentials.v1')
    if {k:v for k,v in before['settings'].items() if k not in changed} != {k:v for k,v in after['settings'].items() if k not in changed}:
        raise ValueError('STOP unrelated settings changed')


def require_closed():
    if subprocess.run(['/usr/bin/pgrep','-x','farfold'],capture_output=True).returncode != 1:
        raise ValueError('STOP Farfold must be normally closed before cleanup')


def require_recovery_scope():
    raise ValueError('STOP cleanup execution is paused: history access, recovery materials, and managed-directory user content must be resolved separately from normal app exit')


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('mode',choices=['dry-run','apply'])
    parser.add_argument('--expected', type=Path)
    args=parser.parse_args()
    if args.mode == 'apply':
        require_recovery_scope()
        require_closed()
        if not args.expected:
            raise ValueError('Expected reviewed plan is required')
    db=connection(DATA/'farfold.sqlite3',args.mode=='apply')
    db.execute('BEGIN IMMEDIATE' if args.mode=='apply' else 'BEGIN')
    plan,before,patches=prepare(db)
    if args.mode=='dry-run':
        db.rollback();db.close()
        (OUT/'cleanup-plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps(plan,ensure_ascii=False))
        return
    expected=json.loads(args.expected.read_text())
    if plan['fingerprint'] != expected['fingerprint']:
        raise ValueError('STOP cleanup plan changed; run a new read-only preview')
    stage=DATA/('.farfold-cleanup-'+uuid.uuid4().hex)
    moved=[]
    committed=False
    try:
        require_closed()
        stage.mkdir()
        for index,item in enumerate(plan['managedRoots']):
            root=Path(item['path'])
            if item['exists']:
                if root.is_symlink() or root.stat().st_ino != item['inode']:
                    raise ValueError('STOP managed directory changed')
                temporary=stage/str(index)
                root.rename(temporary)
                moved.append((root,temporary))
        mutate(db,plan,patches)
        after=metadata(db)
        verify_others(before,after,plan)
        remaining,_,_=prepare(db)
        if remaining['presentAgentIds'] or remaining['sessionCount'] or remaining['dismissedCount'] or remaining['settingKeysRemoved'] or remaining['settingKeysUpdated'] or remaining['installationReceiptsRemoved'] or remaining['grantsRevoked']:
            raise ValueError('STOP targeted metadata still remains')
        require_closed()
        db.commit();committed=True
        shutil.rmtree(stage)
        empty_parents=[]
        for item in plan['managedRoots']:
            parent=Path(item['path']).parent
            if parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir();empty_parents.append(str(parent))
        result={'atUtc':datetime.now(timezone.utc).isoformat(),'plan':plan,
                'removedAgentRecords':len(plan['presentAgentIds']),'removedSessionIndexes':plan['sessionCount'],
                'otherMetadataUnchanged':True,'targetedMetadataRemaining':0,
                'managedRootsRemoved':len(moved),'temporaryStageRemoved':not stage.exists(),
                'emptyParentsRemoved':empty_parents,
                'afterCounts':{k:len(v) for k,v in after.items()},'appStarted':False}
        (OUT/'cleanup-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps(result,ensure_ascii=False))
    except BaseException:
        if not committed:
            db.rollback()
            for root,temporary in reversed(moved):
                temporary.rename(root)
            if stage.is_dir():
                stage.rmdir()
        raise
    finally:
        db.close()

if __name__=='__main__':
    main()
