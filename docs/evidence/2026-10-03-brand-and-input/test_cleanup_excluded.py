"""Controlled cleanup verification; all data and directories are synthetic."""
import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import cleanup_excluded as cleanup

A = 'registry:cortex-code'
B = 'codex'
S = A + ':/fixture:session-one'
T = B + ':/fixture:session-two'


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.data = self.base / 'data'
        self.out = self.base / 'evidence'
        self.data.mkdir(); self.out.mkdir()
        self.root = self.data / 'agents' / A / 'install-fixture'
        self.root.mkdir(parents=True)
        (self.root / 'fixture.txt').write_text('fixture only')
        self.dbpath = self.data / 'farfold.sqlite3'
        self.db = sqlite3.connect(self.dbpath)
        self.db.create_function('record_hash', 1, cleanup.digest)
        self.db.executescript('''
          CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,source TEXT,command TEXT,args TEXT,version TEXT,created_at INTEGER,updated_at INTEGER);
          CREATE TABLE sessions(id TEXT PRIMARY KEY,agent_id TEXT,cwd TEXT,native_session_id TEXT,title TEXT,pinned INTEGER,archived INTEGER,created_at INTEGER,updated_at INTEGER);
          CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
          CREATE TABLE dismissed_sessions(id TEXT PRIMARY KEY,created_at INTEGER);
        ''')
        self.db.executemany('INSERT INTO agents VALUES (?,?,?,?,?,?,?,?)',[(A,'excluded','managed','fixture','[]','1',1,1),(B,'kept','external','other','[]','2',1,1)])
        self.db.executemany('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)',[(S,A,'/fixture','one','remove',0,0,1,1),(T,B,'/fixture','two','keep',0,0,1,1)])
        self.db.executemany('INSERT INTO dismissed_sessions VALUES (?,?)',[(S,1),(T,1)])
        self.values = {
          'installations.v1':[{'id':'install-a','agentId':A,'path':str(self.root),'managedRoot':str(self.root),'programOnly':False,'command':'do-not-execute','args':[]},{'id':'install-b','agentId':B,'path':'/external/keep','managedRoot':None,'programOnly':False,'command':'retain','args':['opaque']}],
          'credentials.v1':[{'id':'service','secretRef':'opaque-reference','label':'keep','grants':[{'agentId':A,'envName':'KEY'},{'agentId':B,'envName':'KEY'}]}],
          'agentSetup.v1':{'version':1,'completed':[A,B],'pending':{A:'a',B:'b'},'selections':{A:{'config':{}},B:{'config':{'model':'keep'}}},'progress':{json.dumps([A,'/fixture']):{'step':1},json.dumps([B,'/fixture']):{'step':2}}},
          'unsentWork.v1':{'version':1,'composers':{'new':{'text':'preserve my new draft','attachments':[]},'session:'+S:{'text':'','attachments':[]},'session:'+T:{'text':'keep','attachments':[]}},'choice':{'agentId':A,'cwd':'/fixture','service':None,'config':{'model':'old'}},'feedback':{T:{'note':'keep'}},'queues':{T:['keep']},'activity':{S:{'ended':True},T:{'ended':True}}},
          'conversationGroups.v1':{'groups':[{'id':'group','name':'keep'}],'assignments':{S:'group',T:'group'}},
          'conversationReadState.v1':{'version':1,'unread':[S,T]},
          'agentWorkPolicy.v1':{'version':1,'defaults':{A:False,B:True},'projects':{'/fixture':{A:True,B:False}},'locations':{'/fixture':True}},
          'installPrevious.'+A:{'opaque':'remove'},'installPrevious.'+B:{'opaque':'keep'},'themeMode':'dark',
        }
        for key,value in self.values.items(): self.set(key,value)
        self.db.commit()

    def tearDown(self):
        self.db.close();self.temp.cleanup()

    def set(self,key,value):
        self.db.execute('INSERT OR REPLACE INTO settings VALUES (?,?)',(key,json.dumps(value)))

    def test_precise_metadata_and_shared_members_are_preserved(self):
        plan,before,patches=cleanup.prepare(self.db,self.data)
        self.assertEqual((plan['sessionCount'],plan['dismissedCount'],plan['grantsRevoked']),(1,1,1))
        cleanup.mutate(self.db,plan,patches)
        cleanup.verify_others(before,cleanup.metadata(self.db),plan)
        remaining,_,_=cleanup.prepare(self.db,self.data)
        self.assertEqual(remaining['presentAgentIds'],[])
        for field in ['sessionCount','dismissedCount','grantsRevoked','installationReceiptsRemoved']:
            self.assertEqual(remaining[field],0)
        draft=json.loads(self.db.execute("SELECT value FROM settings WHERE key='unsentWork.v1'").fetchone()[0])
        self.assertEqual(draft['composers']['new'],self.values['unsentWork.v1']['composers']['new'])
        self.assertIsNone(draft['choice']['agentId'])
        self.assertEqual(draft['composers']['session:'+T]['text'],'keep')
        self.assertTrue(self.root.exists())

    def test_pending_or_unsent_target_drafts_block(self):
        for update in [{'sendPending':True},{'text':'not sent'},{'attachments':[{'name':'unsent'}]}]:
            value=copy.deepcopy(self.values['unsentWork.v1'])
            value['composers']['session:'+S].update(update)
            with self.assertRaises(ValueError): cleanup.transform('unsentWork.v1',value)

    def test_unknown_version_does_not_change_data(self):
        value=copy.deepcopy(self.values['agentSetup.v1']);value['version']=2
        with self.assertRaises(ValueError): cleanup.transform('agentSetup.v1',value)

    def test_shared_root_blocks_deletion(self):
        value=copy.deepcopy(self.values['installations.v1']);value[1]['path']=str(self.root/'shared')
        self.set('installations.v1',value)
        with self.assertRaises(ValueError): cleanup.prepare(self.db,self.data)

    def test_symlink_root_blocks_deletion(self):
        self.root.rename(self.root.with_name('actual'))
        self.root.symlink_to(self.root.with_name('actual'),target_is_directory=True)
        with self.assertRaises(ValueError): cleanup.prepare(self.db,self.data)

    def test_stale_metadata_changes_plan_fingerprint(self):
        first,_,_=cleanup.prepare(self.db,self.data)
        self.set('themeMode','light')
        second,_,_=cleanup.prepare(self.db,self.data)
        self.assertNotEqual(first['fingerprint'],second['fingerprint'])

    def test_exact_id_matching_does_not_match_similar_names(self):
        self.assertFalse(cleanup.target_conversation(A+'-other:/fixture:one'))
        self.assertFalse(cleanup.exact_setting('installPrevious.'+A+'-other'))
        self.assertTrue(cleanup.exact_setting('auth.manual.v1.'+json.dumps([A,'method'])))

    def test_apply_rolls_back_files_and_database_when_transaction_fails(self):
        plan,_,_=cleanup.prepare(self.db,self.data)
        expected=self.out/'expected.json';expected.write_text(json.dumps(plan))
        self.db.close()
        with patch.multiple(cleanup,DATA=self.data,OUT=self.out),patch.object(cleanup,'require_recovery_scope'),patch.object(cleanup,'require_closed'),patch.object(cleanup,'mutate',side_effect=RuntimeError('synthetic failure')),patch('sys.argv',['cleanup','apply','--expected',str(expected)]):
            with self.assertRaises(RuntimeError): cleanup.main()
        self.assertEqual((self.root/'fixture.txt').read_text(),'fixture only')
        self.db=sqlite3.connect(self.dbpath)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM agents').fetchone()[0],2)
        self.assertFalse(any(p.name.startswith('.farfold-cleanup-') for p in self.data.iterdir()))

    def test_apply_removes_only_recorded_roots_and_target_data(self):
        plan,_,_=cleanup.prepare(self.db,self.data)
        expected=self.out/'expected.json';expected.write_text(json.dumps(plan))
        self.db.close()
        with patch.multiple(cleanup,DATA=self.data,OUT=self.out),patch.object(cleanup,'require_recovery_scope'),patch.object(cleanup,'require_closed'),patch('sys.argv',['cleanup','apply','--expected',str(expected)]),patch('builtins.print'):
            cleanup.main()
        self.assertFalse(self.root.exists())
        self.db=sqlite3.connect(self.dbpath)
        self.assertEqual(self.db.execute('SELECT id FROM agents').fetchall(),[(B,)])
        result=json.loads((self.out/'cleanup-result.json').read_text())
        self.assertTrue(result['otherMetadataUnchanged'])
        self.assertTrue(result['temporaryStageRemoved'])

    def test_real_entrypoint_blocks_cleanup_before_opening_database(self):
        with patch.object(cleanup,'require_closed'),patch.object(cleanup,'connection') as connect,patch('sys.argv',['cleanup','apply','--expected','fixture.json']):
            with self.assertRaisesRegex(ValueError,'history access'):
                cleanup.main()
        connect.assert_not_called()

if __name__=='__main__': unittest.main()
