import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from character.repeat_finder import find  # noqa: E402


class FakeSemantic:
    """SemanticService.run as the finder sees it: the reply parsed as the service parses it, checked by validate_output."""

    def __init__(self):
        self.calls = []
        self.answer = dict(found=True, what='整理日报', kind='schedule', cadence='daily', evidence=['a', 'b', 'c'])
        self.error = None
        self.language = 'zh-Hans'

    def reply(self):
        return self.language

    def run(self, purpose, instructions, evidence, *, validate_output=None, **_):
        self.calls.append({'purpose': purpose, 'instructions': instructions, 'evidence': evidence})
        if self.error:
            raise self.error
        try:
            value = json.loads(self.answer) if isinstance(self.answer, str) else json.loads(json.dumps(self.answer))
        except ValueError:
            raise ValueError('invalid_semantic_json') from None
        if validate_output is not None:
            validate_output(value)
        return {'run_id': 'semantic-1', 'value': value, 'backend': 'codex', 'model': 'fake-model'}


class RepeatFinderTest(unittest.TestCase):
    def setUp(self):
        self.client = FakeSemantic()
        self.summaries = [dict(id=ident, day=f'2026-11-0{day}', title='日报', body={'outcome': '整理好了'})
                          for ident, day in (('a', 1), ('b', 2), ('c', 3))]

    def test_three_days_accepted_in_one_repeat_semantic_run(self):
        self.assertEqual(find(self.summaries, self.client), self.client.answer)
        [call] = self.client.calls
        self.assertEqual(call['purpose'], 'repeat')
        content = call['evidence']['material']
        for row in self.summaries:
            self.assertIn(row['id'], content)
            self.assertIn(row['day'], content)

    def test_two_days_or_duplicate_evidence_are_rejected(self):
        self.summaries[2]['day'] = self.summaries[1]['day']
        self.assertIsNone(find(self.summaries, self.client))
        self.client.answer['evidence'] = ['a', 'a', 'b']
        self.assertIsNone(find(self.summaries, self.client))

    def test_invalid_json_schema_and_unknown_evidence_are_rejected(self):
        for changes in ({'evidence': ['a', 'b', 'missing']}, {'evidence': 'abc'}, {'what': '长' * 31},
                        {'what': ''}, {'kind': 'other'}, {'cadence': 'weekly'}, {'found': 1}, {'found': False}):
            with self.subTest(changes=changes):
                self.client.answer = dict(found=True, what='整理日报', kind='skill', cadence=None,
                                          evidence=['a', 'b', 'c'])
                self.client.answer.update(changes)
                self.assertIsNone(find(self.summaries, self.client))
        self.client.answer = 'not JSON'
        self.assertIsNone(find(self.summaries, self.client))

    def test_an_english_what_gets_two_and_a_half_times_the_characters(self):
        for reply, most in ((None, 30), ('zh-Hans', 30), ('ja', 30), ('en', 75)):
            with self.subTest(reply=reply):
                self.client.answer['what'] = 'x' * most
                self.assertEqual(find(self.summaries, self.client, reply=reply)['what'], 'x' * most)
                self.assertIn(f'over {most} characters is dropped', self.client.calls[-1]['instructions'])
                self.client.answer['what'] = 'x' * (most + 1)
                self.assertIsNone(find(self.summaries, self.client, reply=reply))

    def test_failed_runs_are_not_suggestions(self):
        self.client.error = ValueError('semantic_busy')
        self.assertIsNone(find(self.summaries, self.client))
