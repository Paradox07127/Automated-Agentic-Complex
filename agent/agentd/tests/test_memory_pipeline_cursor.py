"""Persistent memory ingestion cursors and reset-aware admission backoff."""
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import json
import threading

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from character_agent.services.memory_pipeline import MemoryPipeline, unsupported_recurrence
import test_character_agent_semantic as semantic_fixture
from test_character_agent_runtime import FakeSession


class MemoryCursorTests(unittest.TestCase):
    setUp=semantic_fixture.SemanticTests.setUp
    tearDown=semantic_fixture.SemanticTests.tearDown
    factory=semantic_fixture.SemanticTests.factory
    source=semantic_fixture.SemanticTests.source

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

    def test_a_turn_that_says_not_to_remember_or_to_forget_is_no_source(self):
        now=time.time()
        for i,text in enumerate(('不要记住我对花粉过敏','别记录这件事','忘记我住在哪','请删除关于咖啡的记忆',
                                 "Don't remember my address",'forget my birthday','周五要交报告')):
            self.server.history.record(turn_id='t'+str(i),source='text',character_id='aster',persona_revision='v1',
                user_text=text,reply='好',state='completed',started_at=now-8*3600+i)
        self.assertEqual([row['user'] for row in self.pipeline.sources()],['周五要交报告'])

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

    def test_hypotheses_are_not_memory_sources_or_readable_extraction_tools(self):
        from test_character_agent_runtime import FakeSession
        self.server.share_page_text=True
        self.c.observations=SimpleNamespace(task_understanding_context=lambda *_:{'available':True,'segments':[],
            'hypotheses':[{'id':'hyp-test','task':'EPHEMERAL_HYPOTHESIS_SECRET','created_at':time.time(),
                           'source_refs':['attention:1']}]},events=lambda *a,**k:[],close=lambda:None)
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
