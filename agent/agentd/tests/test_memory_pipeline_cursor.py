"""Persistent memory ingestion cursors and reset-aware admission backoff."""
import hashlib
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import json
import threading

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from brain.outbound import OutboundGuard
from character_agent.services.memory_pipeline import MemoryPipeline, unsupported_recurrence
import test_character_agent_semantic as semantic_fixture
from test_character_agent_runtime import FakeSession


class MemoryCursorTests(unittest.TestCase):
    setUp=semantic_fixture.SemanticTests.setUp
    tearDown=semantic_fixture.SemanticTests.tearDown
    factory=semantic_fixture.SemanticTests.factory
    source=semantic_fixture.SemanticTests.source

    def test_task_semantic_validity_never_reenters_nonrecursive_memory_lock(self):
        class GuardedLock:
            def __init__(self): self.lock=threading.Lock();self.owner=None
            def __enter__(self):
                if self.owner==threading.get_ident(): raise RuntimeError('reentrant_memory_lock')
                self.lock.acquire();self.owner=threading.get_ident();return self
            def __exit__(self,*args): self.owner=None;self.lock.release()
        guarded=GuardedLock()
        self.server.memory.lock=guarded
        understanding=self.c.task_understanding
        understanding.lock=guarded
        self.server.share_page_text=True
        epoch=self.server.consent.snapshot()[1];now=time.time()
        events=[{'id':i+1,'ts':now-400+i*15,'kind':'value','doc':'预算报告.md','edits':1,'input_near':1}
                for i in range(15)]
        self.assertEqual(understanding.ingest(events,authorized=True,consent_epoch=epoch)['accepted'],15)
        ident=understanding.context()['segments'][0]['id']
        self.reply={'hypotheses':[{'task':'可能在写预算报告','goal':'核对数据','status':'working',
            'next_step':'复核来源','confidence':.6,'evidence':[ident],'expires_in_seconds':1800}]}
        self.assertEqual(understanding.run_once()['state'],'completed')
        self.assertEqual(len(understanding.context()['hypotheses']),1)

    def test_old_history_is_paged_oldest_first_and_cursor_survives_restart(self):
        now=time.time()
        for i in range(230):
            self.server.history.record(turn_id='t'+str(i),source='text' if i<20 else 'proactive',
                character_id='aster',persona_revision='v1',user_text='记录具体安排'+str(i),reply='收到',
                state='completed',started_at=now-10*3600+i)
        self.assertEqual(self.pipeline.sources()[0]['source_id'],'history:t0')
        self.pipeline.run_once()
        restarted=MemoryPipeline(self.c)
        self.assertEqual(restarted.sources()[0]['source_id'],'history:t12')
        restarted.run_once();self.assertFalse(restarted.sources())
        self.assertEqual(int(self.server.memory.setting('agent_memory_history_cursor')),230)

    def test_cancelled_turn_keeps_user_words_but_never_cancelled_answer(self):
        self.server.history.record(turn_id='cancelled',source='text',character_id='aster',persona_revision='v1',
            user_text='请记住周五需要交付报告',reply='已经替你发送了',state='cancelled',started_at=time.time()-8*3600)
        [row]=self.pipeline.sources();self.assertEqual(row['user'],'请记住周五需要交付报告');self.assertEqual(row['assistant'],'')

    def test_usage_cap_defers_same_batch_until_reset_even_after_restart(self):
        self.source()
        with patch.object(self.c.semantic,'run',side_effect=ValueError('usage_cap')) as run:
            with self.assertRaisesRegex(ValueError,'usage_cap'):self.pipeline.run_once()
            self.assertIsNone(self.pipeline.run_once())
            restarted=MemoryPipeline(self.c);self.assertIsNone(restarted.run_once());self.assertEqual(run.call_count,1)
        self.assertGreater(self.pipeline.retry_until,time.time())
        self.assertIsNone(self.server.memory.setting('agent_memory_history_cursor'))

    def test_rejected_batch_is_quarantined_without_creating_a_fact(self):
        self.source();self.reply={'no_new_knowledge':False,'projects':[],'memories':[]}
        for _ in range(3):self.assertEqual(self.pipeline.run_once()['state'],'rejected')
        self.assertFalse(self.pipeline.sources())
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM facts').fetchone()[0],0)
        self.assertTrue(self.db.execute('SELECT version FROM agent_memory_processed').fetchone()[0].startswith('quarantined:'))

    def test_guarded_history_line_is_settled_alone_and_the_rest_is_extracted(self):
        line='甲乙丙丁戊己庚';path=self.root/'windows.json'
        path.write_text(json.dumps({'n':7,'hashes':[hashlib.sha256(line.encode()).hexdigest()[:16]]}),encoding='utf-8')
        self.server.egress=semantic_fixture.EgressPolicy(guard=OutboundGuard(path))
        self.source(text='她说'+line,ident='canon');self.source(ident='plain')
        prompts=[]
        def factory(definitions):
            def script(session,prompt,options):
                prompts.append(prompt)
                yield {'type':'result','success':True,'final_text':json.dumps(self.reply),'model':'fixture-model'}
            return FakeSession(script)
        self.c.session_factory_override=factory
        self.assertEqual(self.pipeline.run_once()['state'],'no_new_knowledge')
        [prompt]=prompts;self.assertIn('history:plain',prompt);self.assertNotIn('history:canon',prompt);self.assertNotIn(line,prompt)
        self.assertTrue(self.db.execute("SELECT version FROM agent_memory_processed WHERE source_id='history:canon'").fetchone()[0].startswith('quarantined:'))
        self.assertFalse(self.pipeline.sources());self.assertIsNone(self.pipeline.run_once())
        self.assertEqual(int(self.server.memory.setting('agent_memory_history_cursor')),2)

    def test_hypotheses_are_not_memory_sources_or_readable_extraction_tools(self):
        from test_character_agent_runtime import FakeSession
        self.server.share_page_text=True
        self.c.task_understanding=SimpleNamespace(context=lambda *_:{'available':True,'segments':[],
            'hypotheses':[{'id':'hyp-test','task':'EPHEMERAL_HYPOTHESIS_SECRET','created_at':time.time(),
                           'source_refs':['attention:1']}]},close=lambda:None)
        self.assertFalse(self.pipeline.sources());self.assertIsNone(self.pipeline.run_once())
        self.source();responses=[]
        def factory(definitions):
            self.assertNotIn('task_context',{d['name'] for d in definitions})
            def script(session,prompt,options):
                self.assertNotIn('EPHEMERAL_HYPOTHESIS_SECRET',prompt)
                for name,args in [('knowledge_search',{'sources':['task_context']}),
                                  ('knowledge_read',{'source':'task_context','id':'current'})]:
                    yield from session.use(options,name,args)
                    responses.append(session.responses[-1][2])
                yield {'type':'result','success':True,'final_text':json.dumps({'no_new_knowledge':True,'projects':[],'memories':[]})}
            return FakeSession(script)
        self.c.session_factory_override=factory
        self.pipeline.run_once()
        self.assertNotIn('EPHEMERAL_HYPOTHESIS_SECRET',json.dumps(responses))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM facts').fetchone()[0],0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM episodes').fetchone()[0],0)

    def test_single_friday_cannot_be_committed_as_weekly_even_as_candidate(self):
        original='我们约定周五检查周报的来源。'
        self.source(text=original)
        self.reply=semantic_fixture.SemanticTests.findings(self,quote=original)
        self.reply['memories'][0]['text']='用户与助手约定每周五检查周报的来源。'
        result=self.pipeline.run_once()
        self.assertEqual(result['memories'],[])
        self.assertEqual(result['rejected'][0]['reason'],'unsupported_memory_recurrence')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM facts').fetchone()[0],0)

    def test_explicit_recurrence_is_preserved_without_inventing_a_stronger_cadence(self):
        cases=[('每周五检查来源。','每个星期五检查来源。',False),
               ('Check sources weekly.','Check sources every week.',False),
               ('每天检查一次。','定期检查。',False),
               ('周五检查来源。','定期检查来源。',True),
               ('Check on Friday.','Check daily.',True),
               ('周五检查来源。','这是一次性的周五，不是每周五的固定习惯。',False),
               ('每周检查一次。','每天检查一次。',True),
               ('每周检查一次。','不是每周检查。',True),
               ('不是每周检查。','每周检查。',True),
               ('不是每周检查。','不是每周检查。',False)]
        for quote,claim,rejected in cases:
            with self.subTest(claim=claim,quote=quote):
                self.assertEqual(unsupported_recurrence(claim,[quote]),rejected)
        original='我们约定每周五检查周报的来源。'
        self.source(text=original)
        self.reply=semantic_fixture.SemanticTests.findings(self,quote=original)
        result=self.pipeline.run_once()
        self.assertEqual(len(result['memories']),1)
        self.assertEqual(result['memories'][0]['text'],original)


if __name__=='__main__':unittest.main()
