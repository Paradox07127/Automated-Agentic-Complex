"""Local-only hypotheses: provenance, privacy and corrections, with a fake semantic kernel."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from brain.egress import EgressPolicy
from character_agent.services.knowledge import KnowledgeService
from character_agent.services.task_understanding import SCHEMA, TaskUnderstanding
from personal.memory import Memory
from infra.store import open_store
from observation.attention import AttentionStore, RAW_RETENTION
from observation.blacklist import Blacklist
from support import deny_blacklist
from test_c6_fixtures import FIXTURES, mismatches


class TaskUnderstandingTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.db=open_store(Path(self.tmp.name)/'memory.sqlite'); self.addCleanup(self.db.close)
        for sql in SCHEMA:self.db.execute(sql)
        self.db.commit();self.now=time.time();self.epoch=1;self.allowed=True;self.calls=[];self.during=lambda:None
        self.memory=Memory(self.db,clock=lambda:self.now)
        self.server=SimpleNamespace(memory=self.memory,character='aster',resetting=False,closing=False,
            consent=SimpleNamespace(snapshot=lambda:({},self.epoch)))
        self.controller=SimpleNamespace(server=self.server,_permitted=lambda source:self.allowed,
            knowledge=lambda:KnowledgeService(egress=EgressPolicy()),semantic=SimpleNamespace(run=self.semantic))
        self.subject=TaskUnderstanding(self.controller,clock=lambda:self.now)
        self.addCleanup(self.subject.close)

    def semantic(self,purpose,instructions,evidence,**kwargs):
        self.calls.append((purpose,evidence));self.during()
        if not kwargs['valid']():raise ValueError('semantic_cancelled')
        value={'hypotheses':[{'task':'可能在编辑预算报告','goal':'核对预算','status':'working','next_step':'核对数据',
            'confidence':.6,'evidence':[evidence['segments'][0]['id']],'expires_in_seconds':1800}]}
        kwargs['validate_output'](value)
        return {'run_id':'semantic-fixture','value':value}

    def events(self,start=1,doc='Budget.md',count=15,offset=0):
        return [{'id':start+i,'ts':self.now-500+offset+i*15,'kind':'value','bundle_id':'editor',
                 'app':'Editor','doc':doc,'window':'SECRET WINDOW BODY alice@example.com',
                 'value':'PRIVATE BUFFER ghp_abcdefghijklmnopqrstuvwxyz Error','edits':1,'input_near':1} for i in range(count)]

    def ingest(self,events=None,**kwargs):
        return self.subject.ingest(events or self.events(),authorized=True,consent_epoch=self.epoch,**kwargs)

    def test_merge_is_local_deduplicated_and_no_raw_buffer_or_window_leaves(self):
        self.assertEqual(self.ingest()['accepted'],15)
        self.assertEqual(self.ingest()['accepted'],0)
        self.subject.run_once()
        self.assertEqual(len(self.calls),1)
        raw=json.dumps(self.calls[0][1])
        for forbidden in ('PRIVATE BUFFER','SECRET WINDOW BODY','alice@example.com','ghp_abcdefghijklmnopqrstuvwxyz'):
            self.assertNotIn(forbidden,raw)
        row=self.subject.context()['hypotheses'][0]
        self.assertEqual(row['authority'],'inferred_hypothesis');self.assertEqual(row['consent_epoch'],1)
        self.assertTrue(row['source_refs']);self.assertEqual(row['producer'],'character_semantic')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM facts').fetchone()[0],0)
        self.subject.run_once();self.assertEqual(len(self.calls),1)

    def test_dwell_without_actions_never_calls_model(self):
        rows=self.events()
        for row in rows:row.update(kind='focus',edits=0,value='',input_near=0)
        self.ingest(rows);self.assertIsNone(self.subject.run_once());self.assertEqual(self.calls,[])

    def test_context_shape_with_and_without_observation_frames(self):
        self.ingest();self.subject.run_once()
        legacy=self.subject.context()
        task={'id':'hyp-observed','revision':2,'title':'检查构建','objective':'恢复构建','state':'blocked',
              'confidence':.7,'last_interpreted_at':self.now-10,'evidence':[]}
        current={'available':True,'character_id':'aster','interpreted_at':self.now,'tasks':[task]}
        self.controller.observations=SimpleNamespace(active=lambda:True,allowed=lambda:True,context=lambda:current)
        observed=self.subject.context()
        fixture=json.loads((FIXTURES/'task-understanding.json').read_text(encoding='utf-8'))
        loose=json.loads((FIXTURES/'loose-fields.json').read_text(encoding='utf-8'))
        for context in (legacy,observed):
            with self.subTest(observed=context is observed):
                self.assertEqual(mismatches(fixture,context,loose['nullable']['task-understanding.json'],
                                            loose['free_keys']['task-understanding.json']),[])
                row=context['hypotheses'][0]
                self.assertEqual(row['state'],'active')
                self.assertLessEqual(row['created_at'],self.now)
                self.assertGreater(row['expires_at'],self.now)
                self.assertEqual(context['segments'],legacy['segments'])
                self.assertEqual(context['consent_epoch'],self.epoch)
                self.assertTrue(context['version'])
        task['authority']='user_correction_of_hypothesis'
        self.assertEqual(self.subject.context()['hypotheses'][0]['state'],'corrected')
        self.now += 8*3600
        self.assertEqual(self.subject.context()['hypotheses'],[])

    def test_task_expires_by_observed_time_not_interpreted_time(self):
        self.ingest();self.subject.run_once()
        task={'id':'hyp-backlog','revision':1,'title':'旧任务','objective':'旧目标','state':'active','confidence':.98,
              'last_interpreted_at':self.now-10,'last_observed_at':self.now-9*3600,'evidence':[]}
        current={'available':True,'character_id':'aster','interpreted_at':self.now,'tasks':[task]}
        self.controller.observations=SimpleNamespace(active=lambda:True,allowed=lambda:True,context=lambda:current)
        self.assertEqual(self.subject.context()['hypotheses'],[])
        task['last_observed_at']=self.now-60
        row=self.subject.context()['hypotheses'][0]
        self.assertEqual(row['created_at'],self.now-60);self.assertEqual(row['expires_at'],self.now-60+8*3600)

    def test_full_replay_batch_reads_segments_once_and_preserves_all_actions(self):
        events=self.events(count=200)
        for i,event in enumerate(events):event['ts']=self.now-200+i
        queries=[];self.db.set_trace_callback(queries.append)
        try:
            self.assertEqual(self.ingest(events)['accepted'],200)
            self.assertEqual(self.ingest(events)['accepted'],0)
        finally:self.db.set_trace_callback(None)
        reads=[q for q in queries if q.startswith('SELECT ') and 'FROM task_segments' in q and 'LIMIT 64' in q]
        self.assertLessEqual(len(reads),2)
        body=json.loads(self.db.execute('SELECT body FROM task_segments').fetchone()[0])
        self.assertEqual(len(body['source_refs']),200)
        self.assertEqual(body['edits'],200);self.assertEqual(body['active_seconds'],199)

    def test_temporary_denied_and_stale_epoch_never_store(self):
        self.assertEqual(self.ingest(temporary=True)['accepted'],0)
        self.assertEqual(self.subject.ingest(self.events(),authorized=True,consent_epoch=0)['accepted'],0)
        self.allowed=False;self.assertEqual(self.ingest()['accepted'],0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM task_segments').fetchone()[0],0)

    def test_revoke_during_model_prevents_output_and_hides_context(self):
        self.ingest();self.during=lambda:setattr(self,'epoch',2)
        with self.assertRaisesRegex(ValueError,'semantic_cancelled'):self.subject.run_once()
        self.assertEqual(self.subject.context()['hypotheses'],[])
        self.assertEqual(self.subject.context()['segments'],[])

    def test_correction_rejection_expiry_and_deletion_invalidate_read_dependencies(self):
        self.ingest();self.subject.run_once();row=self.subject.context()['hypotheses'][0]
        service=KnowledgeService(task_understanding=self.subject,permitted=lambda *_:True)
        self.assertTrue(service.call('task_context',{})['available']);self.assertTrue(service.valid())
        corrected=self.subject.correct(row['id'],1,action='correct',text='是在准备会议材料')
        self.assertEqual(corrected['authority'],'user_correction_of_hypothesis');self.assertFalse(service.valid())
        with self.assertRaisesRegex(ValueError,'task_hypothesis_changed'):self.subject.correct(row['id'],1,action='reject')
        self.subject.correct(row['id'],2,action='reject');self.assertEqual(self.subject.context()['hypotheses'],[])
        self.subject.delete_sources([row['source_refs'][0]])
        self.assertIsNone(self.subject.get(row['id']));self.assertEqual(self.subject.context()['segments'],[])
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM facts').fetchone()[0],0)

    def test_a_phone_like_run_in_a_segment_id_keeps_the_hypothesis_evidence(self):
        ident='13800138000'+'a'*21
        with patch('uuid.uuid4',lambda:SimpleNamespace(hex=ident)):self.ingest()
        self.subject.run_once();row=self.subject.context()['hypotheses'][0]
        self.assertEqual(row['evidence'],['seg-'+ident]);self.assertEqual(len(row['source_refs']),15)

    def test_unknown_evidence_and_asserted_authority_cannot_escape_validator(self):
        value={'hypotheses':[{'task':'任务','goal':'','status':'completed','next_step':'','confidence':1,
                             'evidence':['invented'],'expires_in_seconds':99999,'authority':'confirmed_by_user'}]}
        with self.assertRaises(ValueError):self.subject.validate(value,[{'id':'real'}])

    def test_short_app_detour_merges_without_counting_detour_as_editing(self):
        self.ingest(self.events(count=4))
        self.ingest(self.events(start=100,doc='Other.md',count=1,offset=50))
        self.ingest(self.events(start=200,count=1,offset=55))
        rows=self.subject._segments('aster',self.now)
        self.assertEqual(len(rows),2)
        budget=next(r for r in rows if r['subject']=='Budget md')
        self.assertEqual(len(budget['source_refs']),5);self.assertEqual(budget['active_seconds'],45)

    def test_raw_retention_empty_table_id_reuse_is_a_new_source(self):
        attention=AttentionStore(Path(self.tmp.name)/'attention.sqlite',
            Blacklist(deny_blacklist(Path(self.tmp.name)/'blacklist.json')),clock=lambda:self.now)
        self.addCleanup(attention.close)
        event=self.events(count=1)[0];event.pop('id')
        attention.ingest_events([event])
        first=attention.recent_events(0)[0]
        self.assertEqual(self.ingest([first])['accepted'],1)
        old_ref=self.subject.context()['segments'][0]['source_refs'][0]
        self.now += RAW_RETENTION+1
        event=self.events(count=1)[0];event.pop('id')
        attention.ingest_events([event])  # Production pruning empties events_raw before INSERT.
        [second]=attention.recent_events(0)
        self.assertEqual(first['id'],second['id'],'The fixture exercises actual SQLite row-ID reuse')
        self.assertEqual(self.ingest([second])['accepted'],1)
        new_ref=self.subject.context()['segments'][0]['source_refs'][0]
        self.assertNotEqual(old_ref,new_ref)
        self.assertEqual(len(self.subject.context()['segments']),2)

    def test_identical_event_retry_has_a_canonical_timestamp_reference(self):
        event=self.events(count=1)[0];event['ts']=int(event['ts'])
        self.assertEqual(self.ingest([event])['accepted'],1)
        event['ts']=float(event['ts'])
        self.assertEqual(self.ingest([event])['accepted'],0)
        ref=self.subject.context()['segments'][0]['source_refs'][0]
        self.assertEqual(ref,'attention:1@'+format(event['ts'],'.6f'))


if __name__=='__main__':unittest.main()
