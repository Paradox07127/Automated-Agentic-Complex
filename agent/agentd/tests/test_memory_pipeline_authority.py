"""Memory authority, hedge filtering and model-directed semantic reinforcement."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services.memory_pipeline import INSTRUCTIONS
import test_character_agent_semantic as semantic_fixture


class MemoryAuthorityTests(unittest.TestCase):
    setUp = semantic_fixture.SemanticTests.setUp
    tearDown = semantic_fixture.SemanticTests.tearDown
    factory = semantic_fixture.SemanticTests.factory
    source = semantic_fixture.SemanticTests.source
    findings = semantic_fixture.SemanticTests.findings

    def test_hedge_item_is_dropped_without_losing_clean_sibling(self):
        hedge = '这不是用户偏好的证据，用户提到了 X'
        self.source(reply=hedge)
        value = self.findings()
        value['memories'].append({'scope':'shared', 'kind':'fact', 'text':hedge,
            'evidence':[{'source_id':self.pipeline.sources()[0]['source_id'], 'quote':hedge}]})
        result = self.pipeline.validate(value, self.pipeline.sources())
        self.assertEqual([item['text'] for item in result['accepted']], [value['memories'][0]['text']])
        self.assertEqual(result['rejected'][0]['reason'], 'hedge_memory_text')

    def test_memory_prompt_uses_authority_without_hedge_sentences(self):
        self.assertNotIn("assistant's suggestion is not a user preference", INSTRUCTIONS)
        self.assertNotIn("quote in the material is not the user's own preference", INSTRUCTIONS)
        self.assertIn('authority', INSTRUCTIONS)
        for authority in ('asserted_by_user', 'observed_context', 'inferred_hypothesis'):
            self.assertIn(authority, INSTRUCTIONS)
        self.assertIn('An observed habit can become a memory', INSTRUCTIONS)
        self.assertNotIn('only when the user explicitly asks to remember', INSTRUCTIONS)
        self.assertIn('recent outweighs old', INSTRUCTIONS)

    def test_authority_is_derived_from_evidence_not_model_assertion(self):
        self.source()
        value = self.findings()
        observed = {'source_id':'observation:one', 'kind':'authorized_observation',
                    'content':{'summary':'报告项目正在核对来源'}}
        value['projects'][0]['evidence'] = [observed['source_id']]
        value['memories'] = [{'scope':'shared', 'kind':'fact', 'text':'报告项目正在核对来源',
            'authority':'asserted_by_user', 'evidence':[{'source_id':observed['source_id'], 'quote':'报告项目正在核对来源'}]}]
        result = self.pipeline.validate(value, [observed])
        self.assertEqual(result['rejected'], [])
        self.assertEqual(result['accepted'][0]['source'], 'observed_context')
        self.assertEqual(result['accepted'][0]['state'], 'candidate')
        self.assertEqual(result['projects'][0]['evidence'], [observed['source_id']])
        value = self.findings()
        value['memories'][0]['authority'] = 'inferred_hypothesis'
        result = self.pipeline.validate(value, self.pipeline.sources())
        self.assertEqual(result['accepted'][0]['source'], 'asserted_by_user')
        value['memories'][0].update(text='用户偏好更短的报告', authority='asserted_by_user')
        result = self.pipeline.validate(value, self.pipeline.sources())
        self.assertEqual(result['accepted'][0]['source'], 'inferred_hypothesis')

    def test_observed_preference_is_added_only_as_a_candidate(self):
        memory = self.server.memory
        self.assertIsInstance(memory.add('晚上 11 点后还在写代码', 'observed_context', kind='preference', state='candidate'), str)
        with self.assertRaises(ValueError):
            memory.add('晚上 11 点后还在写代码', 'observed_context', kind='preference')

    def test_observed_habit_is_accepted_as_an_observed_candidate(self):
        self.source()
        value = self.findings()
        observed = {'source_id':'observation:habit', 'kind':'authorized_observation',
                    'content':{'summary':'晚上 11 点后还在写代码'}}
        value['projects'][0]['evidence'] = [observed['source_id']]
        value['memories'] = [{'scope':'shared', 'kind':'preference', 'text':'晚上 11 点后还在写代码', 'authority':'observed_context',
            'evidence':[{'source_id':observed['source_id'], 'quote':'晚上 11 点后还在写代码'}]}]
        result = self.pipeline.validate(value, [observed])
        self.assertEqual(result['rejected'], [])
        self.assertEqual((result['accepted'][0]['source'], result['accepted'][0]['state']), ('observed_context', 'candidate'))

    def test_same_as_reinforces_and_promotes_only_after_three_distinct_days(self):
        memory = self.server.memory
        ident = memory.add('用户偏好简短回答', 'inferred_hypothesis', kind='preference', state='candidate')
        base = 1793448000
        for index, offset in enumerate((0, 0, 86400, 172800)):
            text = '用户喜欢简短的回答'
            self.server.history.record(turn_id='sighting-'+str(index), source='text', character_id='aster',
                persona_revision='v1', user_text='整理报告工作', reply=text, state='completed', started_at=base+offset)
            self.reply = self.findings(text)
            self.reply['memories'][0].update(same_as=ident, confidence=.9)
            result = self.pipeline.run_once()
            self.assertEqual(result['memories'][0]['fact_id'], ident)
            self.assertEqual(result['memories'][0]['state'], 'active' if index == 3 else 'candidate')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM facts').fetchone()[0], 1)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM fact_sightings WHERE fact_id=?', (ident,)).fetchone()[0], 4)
        self.assertEqual(memory.active()[0]['text'], '用户偏好简短回答')
        other = memory.add('报告工作需要核对来源', 'asserted_by_user', kind='fact')
        retired = memory.add('退役的简短回答约定', 'inferred_hypothesis', kind='preference', state='candidate')
        memory.reject(retired, expected_version=1)
        for index, same_as in enumerate(('unknown-id', other, retired, ['invalid-id'])):
            text = '新的报告约定'+str(index)
            self.source(reply=text, ident='fallback-'+str(index))
            self.reply = self.findings(text)
            self.reply['memories'][0]['same_as'] = same_as
            result = self.pipeline.run_once()
            self.assertNotIn(result['memories'][0]['fact_id'], (ident, other, retired))
            self.assertEqual(result['memories'][0]['state'], 'candidate')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM facts').fetchone()[0], 7)

    def test_locked_fact_is_left_alone_by_consolidation(self):
        memory = self.server.memory
        ident = memory.add('用户偏好简短回答', 'inferred_hypothesis', kind='preference', state='candidate')
        memory.set_mark(ident, 'locked', True)
        before = self.db.execute('SELECT evidence, reinforcement FROM facts WHERE fact_id=?', (ident,)).fetchone()
        self.source(reply='用户喜欢简短的回答')
        self.reply = self.findings('用户喜欢简短的回答')
        self.reply['memories'][0].update(same_as=ident, confidence=.9)
        result = self.pipeline.run_once()
        self.assertEqual(result['memories'], [])
        self.assertEqual([r['reason'] for r in result['rejected']], ['memory_locked'])
        self.assertEqual(self.db.execute('SELECT evidence, reinforcement FROM facts WHERE fact_id=?', (ident,)).fetchone(), before)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM fact_sightings WHERE fact_id=?', (ident,)).fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM facts').fetchone()[0], 1)

    def test_consolidation_writes_its_versions_as_pipeline(self):
        self.source(reply='用户喜欢简短的回答')
        self.reply = self.findings('用户喜欢简短的回答')
        [written] = self.pipeline.run_once()['memories']
        self.assertEqual([v['by'] for v in self.server.memory.versions(written['fact_id'])], ['pipeline'])

    def test_similar_ranks_only_live_facts_of_same_kind_and_limits_results(self):
        memory = self.server.memory
        far = memory.add('报告需要保留来源', 'inferred_hypothesis', kind='preference', state='candidate')
        close = memory.add('用户喜欢简短的回答', 'asserted_by_user', kind='preference')
        closest = memory.add('用户偏好简短回答', 'inferred_hypothesis', kind='preference', state='candidate')
        memory.add('用户偏好简短回答', 'asserted_by_user', kind='fact')
        retired = memory.add('用户偏好简短回答', 'inferred_hypothesis', kind='preference', state='candidate')
        memory.reject(retired, expected_version=1)
        rows = memory.similar('用户偏好简短回答', 'preference')
        self.assertEqual([row['fact_id'] for row in rows], [closest, close, far])
        self.assertEqual(rows[0]['text'], '用户偏好简短回答')
        self.assertEqual(memory.similar('用户偏好简短回答', 'preference', k=1), rows[:1])

    def test_extraction_prompt_includes_top_five_existing_facts_per_kind(self):
        memory = self.server.memory
        expected = set()
        for kind in ('fact', 'preference', 'experience', 'agreement'):
            for index in range(6):
                ident = memory.add('报告交付的来源'+str(index), 'inferred_hypothesis', kind=kind, state='candidate')
                if index: expected.add(ident)
        self.source()
        self.pipeline.run_once()
        evidence = json.loads(self.sessions[0].calls[0]['prompt'])['evidence']
        self.assertEqual({item['fact_id'] for item in evidence['existing']}, expected)
        self.assertTrue(all(set(item) == {'fact_id','text'} for item in evidence['existing']))


if __name__ == '__main__': unittest.main()
