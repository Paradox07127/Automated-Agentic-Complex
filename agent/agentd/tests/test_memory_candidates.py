"""Candidate decisions, independent sightings and actual prompt-use receipts."""
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api.memory import MemoryMixin
from character_agent.services.memory_pipeline import MemoryPipeline
from infra.store import open_store
from personal.memory import Memory
from route_registry import REGISTRY
import test_character_agent_runtime as runtime_fixture


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = open_store(Path(self.tmp.name) / 'memory.sqlite')
        self.addCleanup(self.db.close)
        self.now = 1793700000
        self.memory = Memory(self.db, clock=lambda: self.now)
        self.server = SimpleNamespace(memory=self.memory, feed=Mock())
        self.pipeline = MemoryPipeline(SimpleNamespace(server=self.server), clock=lambda: self.now)

    def extract(self, ident, confidence=.9, text='喜欢简洁的报告'):
        sources = [{'source_id':ident, 'version':'v1', 'kind':'conversation', 'at':self.now,
                    'user':'可以把报告写简洁一些吗？', 'assistant':'', 'requires':[]}]
        value = {'no_new_knowledge':False, 'title':'报告格式', 'summary':'讨论报告长度',
                 'projects':[{'subject':'报告', 'goal':'调整长度', 'evidence':[ident]}],
                 'memories':[{'scope':'shared', 'kind':'preference', 'text':text, 'confidence':confidence,
                              'evidence':[{'source_id':ident, 'quote':sources[0]['user']}]}]}
        findings = self.pipeline.validate(value, sources)
        run = {'run_id':ident, 'value':value, 'journal':SimpleNamespace(commit_extraction=lambda *_:'committed')}
        return self.pipeline.commit(run, sources, findings, lambda:True)

    def test_reject_route_blocks_normalized_reproposal(self):
        [fact] = self.extract('first', text='喜欢 Markdown 简洁报告')['memories']
        path = '/memory/facts/' + fact['fact_id'] + '/reject'
        route = next((r for r in REGISTRY if r.method == 'POST' and not isinstance(r.path, str)
                      and r.path.fullmatch(path)), None)
        self.assertIsNotNone(route, 'candidate rejection needs a registered write route')
        handler = MemoryMixin()
        handler.server = self.server
        handler.path = path
        handler._json = Mock()
        handler._memory_post(route.path.fullmatch(path), {'expected_version':0})
        self.assertEqual(handler._json.call_args.args, (409, {'error':'version_conflict', 'current_version':1}))
        self.assertEqual(len(self.memory.candidates()), 1)
        handler._memory_post(route.path.fullmatch(path), {'expected_version':1})
        self.assertEqual(handler._json.call_args.args, (200, {'rejected':True}))
        self.assertFalse(self.memory.candidates())
        with self.assertRaises(KeyError): self.memory.confirm(fact['fact_id'])
        self.assertFalse(self.extract('again', text='  喜欢 ＭＡＲＫＤＯＷＮ   简洁报告  ')['memories'])
        self.assertEqual(self.db.execute("SELECT state FROM facts WHERE fact_id=?", (fact['fact_id'],)).fetchone()[0], 'rejected')

    def test_three_high_confidence_days_auto_activate_without_user_provenance(self):
        self.extract('day-one')
        self.assertFalse(self.memory.active())
        self.now += 86400
        self.extract('day-two')
        self.assertFalse(self.memory.active())
        self.now += 86400
        self.extract('day-three')
        [fact] = self.memory.active()
        self.assertEqual(fact['source'], 'inferred_hypothesis')
        self.assertFalse(self.memory.candidates())
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM fact_sightings').fetchone()[0], 3)
        self.assertEqual(len(self.memory.select('简洁的报告', derived=True)['low_trust']), 1)

    def test_deleting_a_batch_fact_keeps_a_confirmed_fact_the_batch_only_reinforced(self):
        confirmed = self.memory.add('喜欢简洁的报告', 'confirmed_by_user', kind='preference', manual=True)
        sources = [{'source_id':'batch', 'version':'v1', 'kind':'conversation', 'at':self.now,
                    'user':'可以把报告写简洁一些吗？周五前交初稿', 'assistant':'', 'requires':[]}]
        value = {'no_new_knowledge':False, 'title':'报告格式', 'summary':'讨论报告长度',
                 'projects':[{'subject':'报告', 'goal':'调整长度', 'evidence':['batch']}],
                 'memories':[{'scope':'shared', 'kind':'preference', 'text':'喜欢简洁的报告', 'confidence':.9,
                              'evidence':[{'source_id':'batch', 'quote':'可以把报告写简洁一些吗？'}]},
                             {'scope':'shared', 'kind':'agreement', 'text':'周五前交初稿', 'confidence':.9,
                              'evidence':[{'source_id':'batch', 'quote':'周五前交初稿'}]}]}
        run = {'run_id':'batch', 'value':value, 'journal':SimpleNamespace(commit_extraction=lambda *_:'committed')}
        commits = self.pipeline.commit(run, sources, self.pipeline.validate(value, sources), lambda:True)['memories']
        other = next(m['fact_id'] for m in commits if m['fact_id'] != confirmed)
        self.memory.delete(other)
        self.assertEqual(self.db.execute("SELECT state,text FROM facts WHERE fact_id=? ORDER BY version DESC",
                                         (confirmed,)).fetchone(), ('active', '喜欢简洁的报告'))

    def test_same_day_and_low_confidence_do_not_count_as_three_days(self):
        self.extract('one')
        self.extract('two')
        self.extract('three')
        self.now += 86400
        self.extract('low', confidence=.79)
        self.now += 86400
        self.extract('missing', confidence=None)
        self.assertFalse(self.memory.active())
        self.now += 86400
        self.extract('second-day', confidence=.8)
        self.assertFalse(self.memory.active())
        self.now += 86400
        self.extract('third-day', confidence=.8)
        self.assertEqual(len(self.memory.active()), 1)


class PromptUseTests(unittest.TestCase):
    setUp = runtime_fixture.RuntimeTests.setUp
    tearDown = runtime_fixture.RuntimeTests.tearDown
    knowledge = runtime_fixture.RuntimeTests.knowledge
    factory = runtime_fixture.RuntimeTests.factory
    make_runtime = runtime_fixture.RuntimeTests.make_runtime
    run_agent = runtime_fixture.RuntimeTests.run_agent

    def test_confirm_retrieves_and_prompt_records_each_use_once_even_on_failure(self):
        ident = self.memory.add('报告先列证据', 'inferred_hypothesis', kind='preference', state='candidate')
        self.assertFalse(self.knowledge().call('personal_profile', {})['items'])
        handler = MemoryMixin()
        handler.server = SimpleNamespace(memory=self.memory, feed=Mock())
        handler.path = '/memory/facts/' + ident + '/confirm'
        handler._json = Mock()
        route = next(r for r in REGISTRY if '/memory/facts/:fact_id/confirm' in r.templates)
        handler._memory_post(route.path.fullmatch(handler.path), {'expected_version':1})
        self.assertEqual(handler._json.call_args.args, (200, {'version':2}))
        for run in ('answer', 'failed-answer'):
            knowledge = self.knowledge()
            profile = knowledge.call('personal_profile', {})
            self.assertEqual(profile['items'][0]['id'], ident)
            # Looking at a fact is not yet a model prompt.
            before = self.db.execute('SELECT COUNT(*) FROM fact_uses').fetchone()[0]
            def script(session, prompt, options):
                self.assertIn('报告先列证据', prompt)
                self.assertEqual(self.db.execute('SELECT COUNT(*) FROM fact_uses').fetchone()[0], before+1)
                yield from session.use(options, 'knowledge_read', {'source':'memory', 'id':ident})
                yield {'type':'result', 'success':run == 'answer', 'final_text':'收到'}
            self.script = script
            answer = self.run_agent(run, context=json.dumps(profile, ensure_ascii=False), knowledge_service=knowledge)
            if run == 'answer': self.assertIsNone(answer.error)
            else: self.assertIsNotNone(answer.error)
            self.assertEqual(self.db.execute('SELECT fact_id,version,line_id,mode FROM fact_uses WHERE line_id=?', (run,)).fetchall(),
                             [(ident, 2, run, 'injected')])


if __name__ == '__main__': unittest.main()
