"""Desktop contract through the authenticated API and both hook providers."""
import datetime
import json
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_server
from sessions.approvals import ApprovalBroker
from sessions.events import normalize_claude, normalize_codex
from character_agent.services.interactions import InteractionService
from character_agent.services.jobs import JobStore
from character_agent.services.store import RunStore
from character.focus import Focus
from personal.commitments import Commitments
from personal.memory import Memory
from personal.rituals import Rituals
from sessions.own import OwnSession
from infra.store import open_store
from sessions.tasks import TaskLedger
from observation.desktop_presence import LABELS, PresenceFeed, snapshot
from brain.language import ReplyLanguage


def agent(setting='zh-Hans', **attrs):
    """A character agent double whose reply language setting is setting."""
    return SimpleNamespace(reply_language=ReplyLanguage(),
                           settings=SimpleNamespace(snapshot=lambda: {'reply_language': setting}), **attrs)


class DesktopPresenceTests(unittest.TestCase):
    setUp = test_server.ServerTest.setUp
    tearDown = test_server.ServerTest.tearDown
    request = test_server.ServerTest.request
    hook = test_server.ServerTest.hook
    def test_private_endpoint_and_both_hook_providers(self):
        for token in (None, test_server.HOOK, test_server.EVENTS):
            self.assertEqual(self.request('GET', '/desktop/presence', token=token)[0], 401)
        self.hook('claude', 'UserPromptSubmit', session='a', prompt='private prompt')
        self.hook('codex', 'UserPromptSubmit', session='b', prompt='private prompt')
        self.hook('codex', 'PreToolUse', session='b', tool_name='Bash', tool_input={'command': 'make SECRET_COMMAND'})
        status, value = self.request('GET', '/desktop/presence')
        self.assertEqual(status, 200)
        sessions = {s['id']: s for s in value['sessions']}
        self.assertEqual(sessions['claude:a']['state'], 'thinking')
        self.assertEqual(sessions['codex:b']['activity'], '在跑')
        self.assertEqual((sessions['codex:b']['tool'], sessions['codex:b']['target']), ('Bash', 'make'))
        encoded = json.dumps(value)
        for private in ('private prompt', 'SECRET_COMMAND', 'tool_input', 'last_line'):
            self.assertNotIn(private, encoded)

    def test_stale_idle_and_parallel_session_limit(self):
        for i in range(10): self.hook('claude', 'UserPromptSubmit', session=str(i), prompt='test')
        value = snapshot(self.server)
        self.assertEqual(len(value['sessions']), 8)
        self.assertEqual(value['additional_sessions'], 2)
        # Expired work must never remain displayed as currently running.
        start = value['sampled_at']
        self.server.registry.tick(now=start + 1000)
        value = snapshot(self.server, now=start + 1010)
        self.assertEqual({s['status'] for s in value['sessions']}, {'stale'})
        self.server.registry.tick(now=start + 1900)
        self.assertEqual(snapshot(self.server, now=start + 1900)['sessions'], [])

    def test_default_settings_show_chinese_words(self):
        from character_agent.services.settings import DEFAULTS
        with tempfile.TemporaryDirectory() as directory:
            store = RunStore(Path(directory) / 'runs.sqlite')
            try:
                self.server.character_agent = agent(DEFAULTS['reply_language'], store=store)
                self.hook('claude', 'PreToolUse', session='a', tool_name='Bash', tool_input={'command': 'make'})
                self.hook('claude', 'PermissionRequest', session='a', tool_name='Bash', tool_input={'command': 'make'})
                value = snapshot(self.server)
                self.assertEqual(value['sessions'][0]['activity'], '待批准')
                self.assertEqual(value['role']['activity'], '空闲')
                self.assertTrue(self.server._headlines()['due'].startswith('提醒你'))
            finally:
                self.server.character_agent = None
                store.close()

    def test_role_backend_progress_comes_from_run_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            store = RunStore(Path(directory) / 'runs.sqlite')
            try:
                self.server.character_agent = agent(store=store)
                for backend in ('codex', 'pi'):
                    with self.subTest(backend=backend):
                        store.begin(backend, 'conversation', self.server.character, 1)
                        store.event(backend, 'running', {'backend': backend})
                        store.event(backend, 'tool_started', {'tool': 'artifact_verify', 'tool_call_id': 'opaque'})
                        value = snapshot(self.server)
                        self.assertEqual(value['role']['backend'], backend)
                        self.assertEqual(value['role']['intention'], '我在检查结果是否符合要求。')
                        self.assertEqual(value['role']['state'], 'running_tool')
                        self.assertNotIn('opaque', json.dumps(value))
                        store.finish(backend, 'cancelled')
                        self.assertEqual(snapshot(self.server)['role']['state'], 'idle')
            finally:
                self.server.character_agent = None
                store.close()

    def test_role_words_follow_the_reply_language(self):
        with tempfile.TemporaryDirectory() as directory:
            store = RunStore(Path(directory) / 'runs.sqlite')
            try:
                for setting, words in (('en', ("I'm checking whether the result meets the requirements.", 'Running')),
                                       ('zh-Hans', ('我在检查结果是否符合要求。', '在跑')),
                                       ('harness', ('我在检查结果是否符合要求。', '在跑'))):
                    with self.subTest(setting=setting):
                        self.server.character_agent = agent(setting, store=store)
                        store.begin(setting, 'conversation', self.server.character, 1)
                        store.event(setting, 'running', {'backend': 'codex'})
                        store.event(setting, 'tool_started', {'tool': 'artifact_verify', 'tool_call_id': 'opaque'})
                        role = snapshot(self.server)['role']
                        self.assertEqual((role['intention'], role['activity']), words)
                        store.finish(setting, 'cancelled')
            finally:
                self.server.character_agent = None
                store.close()

    def test_role_since_is_run_start_only_while_a_run_is_shown(self):
        with tempfile.TemporaryDirectory() as directory:
            store = RunStore(Path(directory) / 'runs.sqlite')
            try:
                self.server.character_agent = agent(store=store)
                self.assertNotIn('since', snapshot(self.server)['role'])
                store.begin('run', 'conversation', self.server.character, 1)
                store.event('run', 'running', {'backend': 'codex'})
                self.assertEqual(snapshot(self.server)['role']['since'], store.get('run')['started_at'])
            finally:
                self.server.character_agent = None
                store.close()

    def test_hook_session_title_is_its_first_prompt_kept_only_with_typed_text(self):
        self.server.share_typed_text = True
        self.hook('claude', 'UserPromptSubmit', session='a', prompt='  修一下\n  构建 ' + 'x' * 100)
        self.hook('claude', 'UserPromptSubmit', session='a', prompt='second prompt')
        self.hook('codex', 'PreToolUse', session='b', cwd='/work/orbit', tool_name='Bash')
        titles = lambda: {s['id']: s['title'] for s in snapshot(self.server)['sessions']}  # noqa: E731
        self.assertEqual(titles(), {'claude:a': ('修一下 构建 ' + 'x' * 100)[:60], 'codex:b': 'orbit'})
        self.server.share_typed_text = False  # revoked: the kept title is no longer shown
        self.assertEqual(titles(), {'claude:a': 'w', 'codex:b': 'orbit'})
        self.hook('claude', 'UserPromptSubmit', session='c', prompt='not kept')
        self.server.share_typed_text = True
        self.assertEqual(titles()['claude:c'], 'w')

    def test_untitled_worktree_session_is_its_repository_subtask(self):
        self.hook('claude', 'UserPromptSubmit', session='a', cwd='/Users/me/Endfield/.claude/worktrees/agent-a4d525f1')
        self.hook('claude', 'UserPromptSubmit', session='b', cwd='/Users/me/Endfield/.claude/worktrees/g2/web')
        self.hook('claude', 'UserPromptSubmit', session='c', cwd='/Users/me/Endfield')
        self.assertEqual({s['id']: s['title'] for s in snapshot(self.server)['sessions']},
                         {'claude:a': 'Endfield · 子任务', 'claude:b': 'Endfield · 子任务', 'claude:c': 'Endfield'})

    def test_hook_session_title_is_not_kept_during_a_pause(self):
        self.server.share_typed_text = True
        self.server.paused_until = time.time() + 60
        self.hook('claude', 'UserPromptSubmit', session='a', prompt='paused prompt')
        self.server.paused_until = None
        self.assertEqual(snapshot(self.server)['sessions'][0]['title'], 'w')

    def test_reset_and_shutdown_do_not_publish_old_presence(self):
        for field in ('resetting', 'closing'):
            setattr(self.server, field, True)
            try: self.assertEqual(self.request('GET', '/desktop/presence')[0], 503)
            finally: setattr(self.server, field, False)

    def test_managed_claude_is_not_duplicated_and_native_approval_wins(self):
        own = OwnSession('claude', '/w', '检查构建结果')
        own.native_id = 'native-one'
        own.state = 'thinking'
        manager = SimpleNamespace(sessions={own.session_id: own}, native_ids=lambda: {'native-one': own})
        self.hook('claude', 'UserPromptSubmit', session='native-one', prompt='not shown')
        self.hook('claude', 'PermissionRequest', session='native-one', tool_name='Bash', tool_input={'command': 'pwd'})
        self.server.sessions = manager
        try:
            value = snapshot(self.server)
            self.assertEqual(len(value['sessions']), 1)
            self.assertEqual(value['sessions'][0]['id'], own.session_id)
            self.assertEqual(value['sessions'][0]['title'], '检查构建结果')
            self.assertEqual(value['sessions'][0]['state'], 'awaiting_approval')
            self.assertIs(value['sessions'][0]['own_app'], False)
        finally: self.server.sessions = None

    def test_observed_sessions_waiting_in_their_own_app_are_listed_and_counted_without_an_approval(self):
        now = time.time()
        for normalize, session in ((normalize_claude, 'a'), (normalize_codex, 'b')):
            self.server.registry.ingest(normalize({'hook_event_name': 'PermissionRequest', 'session_id': session,
                                                   'cwd': '/w', 'tool_name': 'Bash'}, now=now))
        held = normalize_claude({'hook_event_name': 'PermissionRequest', 'session_id': 'c', 'cwd': '/w',
                                 'tool_name': 'Bash'}, now=now)
        held.request_id = 'r1'  # a card Endfield holds the hook for
        self.server.registry.ingest(held)
        value = snapshot(self.server, now=now)
        self.assertEqual(value['pending']['observed_waiting'], 2)
        self.assertEqual(value['pending']['approvals'], [])
        self.assertEqual(sorted((s['id'], s['state'], s['status'], s['own_app'], s['approvals'])
                                for s in value['sessions']),
                         [('claude:a', 'awaiting_approval', 'needs_you', True, []),
                          ('claude:c', 'awaiting_approval', 'needs_you', False, []),
                          ('codex:b', 'awaiting_approval', 'needs_you', True, [])])

    def test_ritual_is_the_pending_kind_a_tap_would_say_since_the_pending_set_changed(self):
        night = datetime.datetime(2027, 1, 4, 3, 0).timestamp()  # before the morning greeting, after no report
        self.server.clock = lambda: night
        self.assertIsNone(snapshot(self.server)['ritual'])
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = open_store(Path(tmp.name) / 'rituals.sqlite')
        self.addCleanup(db.close)
        self.server.rituals = Rituals(db, clock=lambda: night)
        self.assertIsNone(snapshot(self.server)['ritual'])
        self.server.rituals.set_pending('water', {'minutes': 50})  # no on_change: the feed has not heard yet
        self.assertEqual(snapshot(self.server)['ritual'], {'kind': 'water', 'since': night})
        self.assertEqual([i['data']['kinds'] for i in self.server.feed.since(0) if i['event'] == 'pending'], [['water']])
        self.server.clock = lambda: night + 60
        self.assertEqual(self.request('GET', '/desktop/presence')[1]['ritual'], {'kind': 'water', 'since': night})
        self.server.rituals.set_pending('break', {'minutes': 90})
        self.assertEqual(snapshot(self.server)['ritual'], {'kind': 'break', 'since': night + 60})
        for kind in ('break', 'water'): self.server.rituals.clear_pending(kind)
        self.assertIsNone(snapshot(self.server)['ritual'])


class PresenceFeedTests(unittest.TestCase):
    setUp = test_server.ServerTest.setUp
    tearDown = test_server.ServerTest.tearDown
    request = test_server.ServerTest.request
    hook = test_server.ServerTest.hook

    def presence_items(self, after=0):
        return [i for i in self.server.feed.since(after) if i['event'] == 'presence']

    def test_a_changed_snapshot_publishes_one_presence_and_an_unchanged_one_none(self):
        feed = PresenceFeed(self.server)
        start = time.time()
        self.assertIsNotNone(feed.check(now=start))
        self.assertIsNone(feed.check(now=start + 1), 'only sampled_at moved')
        self.assertEqual(len(self.presence_items()), 1)
        self.hook('claude', 'UserPromptSubmit', session='a', prompt='test')
        item = feed.check()
        self.assertEqual(item['event'], 'presence')
        self.assertIsNone(feed.check())
        self.assertEqual(len(self.presence_items()), 2)

    def test_no_presence_while_resetting_or_closing(self):
        feed = PresenceFeed(self.server)
        for field in ('resetting', 'closing'):
            setattr(self.server, field, True)
            try: self.assertIsNone(feed.check())
            finally: setattr(self.server, field, False)
        self.assertEqual(self.presence_items(), [])

    def test_a_hook_wakes_the_loop_without_waiting_for_the_interval(self):
        presence = self.server.presence_feed
        presence.interval = 60
        stopped = threading.Event()
        thread = threading.Thread(target=presence.run, args=(stopped,), daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(presence.poke)
        self.addCleanup(stopped.set)
        deadline = time.time() + 5
        while not self.presence_items() and time.time() < deadline: time.sleep(0.02)
        self.assertEqual(len(self.presence_items()), 1, 'the first check publishes')
        seq = self.server.feed.seq
        self.server.feed.publish('memory', {'action': 'added', 'fact_id': 'f'})
        time.sleep(0.5)
        self.assertEqual(self.presence_items(seq), [], 'a feed item that leaves the snapshot as it was')
        self.hook('codex', 'UserPromptSubmit', session='b', prompt='test')
        deadline = time.time() + 5
        while not self.presence_items(seq) and time.time() < deadline: time.sleep(0.02)
        self.assertEqual(len(self.presence_items(seq)), 1)


class PendingPresenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.tmp.cleanup)
        self.now = 1800000000.
        self.store = RunStore(Path(self.tmp.name) / 'runs.sqlite')
        self.addCleanup(self.store.close)
        self.db = open_store(Path(self.tmp.name) / 'domain.sqlite')
        self.addCleanup(self.db.close)
        self.interactions = InteractionService(self.store, clock=lambda: self.now)
        self.jobs = JobStore(Memory(self.db), clock=lambda: self.now)
        self.broker = ApprovalBroker(clock=lambda: self.now - 1700000000)
        self.server = SimpleNamespace(
            registry=SimpleNamespace(snapshot=lambda: {'sessions': []}, activity='relax'),
            sessions=None, character='aster', character_state=lambda: {'character_id': 'aster'},
            character_agent=SimpleNamespace(store=self.store, interactions=self.interactions,
                                            jobs=SimpleNamespace(store=self.jobs)), reply_language_code=lambda: 'zh-Hans',
            broker=self.broker, tasks=TaskLedger(self.db),
            commitments=Commitments(self.db, clock=lambda: self.now), _mouth_lock=threading.Lock(), rituals=None,
            focus=Focus(clock=lambda: self.now), consent=SimpleNamespace(snapshot=lambda: ({'typed_text': True}, 1)))
        self.server.registry.titles = dict

    def test_done_session_survives_registry_idle_until_seen_or_thirty_minutes(self):
        from sessions.registry import Registry
        self.server.registry = Registry()
        now = time.time()
        self.server.registry.clock = lambda: now
        for source, normalize in (('claude', normalize_claude), ('codex', normalize_codex)):
            self.server.registry.ingest(normalize({'hook_event_name': 'Stop', 'session_id': 'done', 'cwd': '/w'}, now=now))
        now += 4
        self.assertEqual({s['id'] for s in snapshot(self.server, now=now)['sessions']}, {'claude:done', 'codex:done'})
        self.server.registry.ingest(normalize_claude({'hook_event_name': 'Notification', 'session_id': 'done', 'cwd': '/w'}, now=now + 1))
        self.server.registry.ingest(normalize_codex({'hook_event_name': 'SessionEnd', 'session_id': 'done', 'cwd': '/w'}, now=now + 1))
        now += 1795
        self.assertEqual(len(snapshot(self.server, now=now)['sessions']), 2)
        from observation.desktop_presence import acknowledge
        self.assertTrue(acknowledge(self.server, 'claude:done', now - 1799))
        self.assertEqual([s['id'] for s in snapshot(self.server, now=now)['sessions']], ['codex:done'])
        now += 1
        self.assertEqual(snapshot(self.server, now=now)['sessions'], [])

    def test_error_session_survives_registry_idle_until_seen_or_new_work(self):
        from sessions.registry import Registry
        from observation.desktop_presence import acknowledge
        self.server.registry = Registry()
        now = time.time()
        self.server.registry.clock = lambda: now
        hook = lambda name, ts, session='broke': self.server.registry.ingest(
            normalize_claude({'hook_event_name': name, 'session_id': session, 'cwd': '/w'}, now=ts))
        hook('StopFailure', now)
        hook('StopFailure', now, session='ended')
        hook('SessionEnd', now + 1, session='ended')
        self.server.registry.tick(now=now + 1000)
        rows = snapshot(self.server, now=now + 1000)['sessions']
        self.assertEqual(sorted((s['id'], s['state'], s['status'], s['updated_at']) for s in rows),
                         [('claude:broke', 'error', 'error', now), ('claude:ended', 'error', 'error', now)])
        self.assertFalse(acknowledge(self.server, 'claude:broke', now - 1))
        self.assertTrue(acknowledge(self.server, 'claude:broke', now))
        self.assertEqual([s['id'] for s in snapshot(self.server, now=now + 1000)['sessions']], ['claude:ended'])
        hook('UserPromptSubmit', now + 1001)
        self.assertEqual([(s['id'], s['state']) for s in snapshot(self.server, now=now + 1001)['sessions']],
                         [('claude:ended', 'error'), ('claude:broke', 'thinking')])
        hook('StopFailure', now + 1002)
        self.assertEqual([(s['id'], s['state']) for s in snapshot(self.server, now=now + 1010)['sessions']],
                         [('claude:broke', 'error'), ('claude:ended', 'error')])

    def test_unseen_error_session_leaves_after_thirty_minutes(self):
        self.rows(('kept', 'error', self.now - 1799, {}), ('gone', 'error', self.now - 1800, {}))
        self.assertEqual([s['id'] for s in snapshot(self.server, now=self.now)['sessions']], ['claude:kept'])

    def test_stale_session_stays_while_the_registry_keeps_it(self):
        self.rows(('lost', 'stale', self.now - 8, {'observed_at': self.now - 600}),
                  ('old', 'stale', self.now - 1000, {'observed_at': self.now - 1799}))
        self.assertEqual([(s['id'], s['status'], s['updated_at']) for s in snapshot(self.server, now=self.now)['sessions']],
                         [('claude:lost', 'stale', self.now - 600), ('claude:old', 'stale', self.now - 1799)])

    def test_stale_session_says_how_long_it_has_been_quiet(self):
        self.rows(('lost', 'stale', self.now - 20, {'observed_at': self.now - 200, 'tool_name': 'Bash',
                                                   'tool_target': 'swift'}))
        row = snapshot(self.server, now=self.now)['sessions'][0]
        self.assertEqual((row['status'], row['activity'], row['doing']), ('stale', '没有新动静', '3 分钟没动静'))

    def test_session_words_follow_the_reply_language(self):
        self.rows(('lost', 'stale', self.now - 20, {'observed_at': self.now - 200}),
                  ('edit', 'running_tool', self.now - 1, {'tool_name': 'Edit', 'tool_target': 'app.py'}))
        for code, expected in (('en', {'claude:lost': ('No recent activity', 'Quiet for 3 min'),
                                       'claude:edit': ('Running', 'Edit app.py')}),
                               ('zh-Hans', {'claude:lost': ('没有新动静', '3 分钟没动静'),
                                            'claude:edit': ('在跑', '改 app.py')})):
            with self.subTest(code=code):
                self.server.reply_language_code = lambda: code
                rows = snapshot(self.server, now=self.now)['sessions']
                self.assertEqual({row['id']: (row['activity'], row['doing']) for row in rows}, expected)

    def test_seen_stale_session_is_hidden_until_a_new_event(self):
        from sessions.registry import Registry
        from observation.desktop_presence import acknowledge
        self.server.registry = Registry()
        now = time.time()
        clock = [now]
        self.server.registry.clock = lambda: clock[0]
        hook = lambda name, ts: self.server.registry.ingest(
            normalize_claude({'hook_event_name': name, 'session_id': 'quiet', 'cwd': '/w'}, now=ts))
        hook('UserPromptSubmit', now)
        clock[0] = now + 700
        rows = snapshot(self.server, now=now + 700)['sessions']
        self.assertEqual([(s['id'], s['state'], s['status'], s['updated_at'], s['doing']) for s in rows],
                         [('claude:quiet', 'stale', 'stale', now, '11 分钟没动静')])
        self.assertFalse(acknowledge(self.server, 'claude:quiet', now + 600))
        self.assertTrue(acknowledge(self.server, 'claude:quiet', now))
        self.assertEqual(snapshot(self.server, now=now + 700)['sessions'], [])
        hook('UserPromptSubmit', now + 800)
        clock[0] = now + 1500
        self.assertEqual([(s['id'], s['status'], s['updated_at']) for s in snapshot(self.server, now=now + 1500)['sessions']],
                         [('claude:quiet', 'stale', now + 800)])

    def test_voice_and_observation_pause(self):
        value = snapshot(self.server, now=self.now)
        self.assertEqual((value['voice'], value['observation']), ({'state': 'off', 'muted': False}, {'paused': False}))
        from voice.voice_provider import VoiceProvider
        self.server.voice = VoiceProvider(clock=lambda: 0.0)
        self.server.voice.on_speech('speech.failed', {'reason': 'bad_stream'})
        self.server.muted = True
        self.server.observation_paused = lambda: True
        value = snapshot(self.server, now=self.now)
        self.assertEqual((value['voice'], value['observation']), ({'state': 'unreachable', 'muted': True}, {'paused': True}))

    def test_seen_is_completion_specific_and_new_work_is_not_hidden(self):
        from sessions.registry import Registry
        self.server.registry = Registry()
        now = time.time()
        self.server.registry.clock = lambda: now
        own = OwnSession('codex', '/w', '构建')
        own.state, own.updated_at = 'done', now
        self.server.sessions = SimpleNamespace(sessions={own.session_id: own}, native_ids=dict)
        try:
            self.assertEqual(len(snapshot(self.server, now=now + 4)['sessions']), 1)
            from observation.desktop_presence import acknowledge
            self.assertTrue(acknowledge(self.server, own.session_id, now))
            self.assertEqual(snapshot(self.server, now=now + 4)['sessions'], [])
            own.state, own.updated_at = 'thinking', now + 5
            self.assertEqual(snapshot(self.server, now=now + 5)['sessions'][0]['status'], 'running')
            own.state, own.updated_at = 'done', now + 6
            self.assertEqual(snapshot(self.server, now=now + 7)['sessions'][0]['status'], 'done')
            self.assertEqual(snapshot(self.server, now=now + 1806)['sessions'], [])
        finally:
            self.server.sessions = None

    def rows(self, *rows):
        """Registry rows (Session.to_dict) from (name, state, since, extra) tuples."""
        self.server.registry.snapshot = lambda: {'sessions': [
            {'source': 'claude', 'session_id': name, 'display_session': 'claude:' + name, 'cwd': '/w',
             'effective_state': state, 'since': since, 'pending_approvals': [], 'tool_name': None,
             'tool_category': None, 'tool_target': None, 'last_tool_name': None, 'last_tool_target': None,
             'outcomes': [], 'observed_at': since, **extra} for name, state, since, extra in rows]}

    def test_presence_state_words(self):
        self.assertEqual(LABELS['zh-Hans'], {
            'thinking': '在想', 'running_tool': '在跑', 'awaiting_approval': '待批准',
            'awaiting_input': '待回答', 'compacting': '在整理上下文', 'subagent': '在派子任务',
            'done': '完成', 'background': '在后台做', 'error': '出错了', 'stale': '没有新动静', 'idle': '空闲'})
        for table in LABELS.values():
            self.assertEqual(set(table), set(LABELS['zh-Hans']))
        for state, label in LABELS['zh-Hans'].items():
            if state == 'idle':
                continue
            with self.subTest(state=state):
                self.rows(('one', state, self.now, {'pending_approvals': ['held']}))
                row = snapshot(self.server, now=self.now)['sessions'][0]
                self.assertEqual(row['activity'], label)
                self.assertIsInstance(row['updated_at'], float)

    def test_session_doing_describes_current_state_and_tool(self):
        cases = [
            ('running_tool', 'Edit', 'SessionCard.tsx', '改 SessionCard.tsx'),
            ('running_tool', 'MultiEdit', 'app.py', '改 app.py'),
            ('running_tool', 'NotebookEdit', 'demo.ipynb', '改 demo.ipynb'),
            ('running_tool', 'apply_patch', 'app.py', '改 app.py'),
            ('running_tool', 'Read', 'README.md', '读取 README.md'),
            ('running_tool', 'Write', 'notes.md', '写入 notes.md'),
            ('running_tool', 'Bash', 'swift', '运行 swift'),
            ('running_tool', 'exec_command', 'swift test', '运行 swift test'),
            ('running_tool', 'Bash', '跑一遍 host 单元测试', '跑一遍 host 单元测试'),
            ('running_tool', 'Task', '检查构建结果', '检查构建结果'),
            ('running_tool', 'Agent', '核对 API 契约', '核对 API 契约'),
            ('running_tool', 'WebFetch', 'example.com', '访问 example.com'),
            ('running_tool', 'WebSearch', None, '搜索'),
            ('running_tool', 'Glob', None, '查找'),
            ('running_tool', 'Grep', None, '搜索'),
            ('running_tool', None, None, '在跑'),
            ('running_tool', 'custom_tool', None, '用 custom_tool'),
            ('running_tool', 'mcp__search__lookup', 'search · lookup', '用 search 的 lookup'),
            ('running_tool', 'mcp__agentic_complex__private', None, '在跑'),
            ('running_tool', 'Bash', '  跑一遍\n 测试  ', '跑一遍 测试'),
            ('awaiting_approval', 'Bash', 'rm -rf build/', '待批准 rm -rf build/'),
            ('awaiting_approval', None, None, '待批准'),
            ('awaiting_input', 'Read', 'README.md', '待回答'),
            ('thinking', 'Edit', 'app.py', '在想'),
            ('compacting', 'Read', 'README.md', '在整理上下文'),
            ('subagent', None, None, '在派子任务'),
            ('done', 'Edit', 'app.py', '完成'),
            ('error', 'Bash', 'swift', '出错了'),
            ('stale', 'Bash', 'swift', '1 分钟没动静'),
        ]
        for state, tool, target, expected in cases:
            with self.subTest(state=state, tool=tool, target=target):
                self.rows(('one', state, self.now, {'tool_name': tool, 'tool_target': target,
                                                   'pending_approvals': ['held']}))
                self.assertEqual(snapshot(self.server, now=self.now)['sessions'][0]['doing'], expected)

    def test_session_started_at_uses_available_source_time_only(self):
        self.rows(('known', 'running_tool', self.now, {'started_at': self.now - 120}),
                  ('unknown', 'thinking', self.now - 1, {}))
        own = OwnSession('codex', '/w', '构建')
        own.state, own.started_at, own.updated_at = 'thinking', self.now - 90, self.now - 2
        self.server.sessions = SimpleNamespace(sessions={own.session_id: own}, native_ids=dict)
        value = snapshot(self.server, now=self.now)
        self.assertEqual({s['id']: s['started_at'] for s in value['sessions']},
                         {'claude:known': self.now - 120, 'claude:unknown': None, own.session_id: self.now - 90})
        self.assertTrue(all(isinstance(s['doing'], str) and s['doing'] for s in value['sessions']))

    def test_role_doing_uses_tool_name_without_arguments(self):
        self.store.begin('role', 'conversation', 'aster', 1)
        self.store.event('role', 'running', {'backend': 'codex'})
        self.assertEqual(snapshot(self.server, now=self.now)['role']['doing'], '在想')
        for tool, expected in (
                ('Bash', '在跑命令'), ('exec_command', '在跑命令'),
                ('Read', '在读文件'), ('knowledge_read', '在读文件'), ('Edit', '在改文件'),
                ('Write', '在改文件'), ('apply_patch', '在改文件'), ('knowledge_search', '在查资料'),
                ('WebSearch', '在查资料'), ('unknown_tool', '在跑')):
            with self.subTest(tool=tool):
                self.store.event('role', 'tool_started', {'tool': tool, 'tool_call_id': 'opaque-' + tool})
                value = snapshot(self.server, now=self.now)
                self.assertEqual(value['role']['doing'], expected)
                self.assertEqual(value['role']['activity'], '在跑')
                self.assertNotIn('opaque-', json.dumps(value))
                self.store.event('role', 'tool_finished', {'tool_call_id': 'opaque-' + tool})

    def test_role_doing_idle_activity_and_mouth_work(self):
        for activity, expected in (('read', '阅读中'), ('relax', '空闲'), (None, '空闲')):
            with self.subTest(activity=activity):
                self.server.registry.activity = activity
                self.assertEqual(snapshot(self.server, now=self.now)['role']['doing'], expected)
        with self.server._mouth_lock:
            role = snapshot(self.server, now=self.now)['role']
            self.assertEqual((role['state'], role['activity'], role['doing']), ('thinking', '在想', '在想'))

    def test_role_counts_background_runs_and_names_the_background_state(self):
        self.assertEqual(snapshot(self.server, now=self.now)['role']['background_runs'], 0)
        self.store.begin('bg', 'conversation', 'aster', 1)
        self.store.event('bg', 'running', {'backend': 'codex', 'work_kind': 'background'})
        role = snapshot(self.server, now=self.now)['role']
        self.assertEqual((role['state'], role['activity'], role['doing'], role['background_runs']),
                         ('background', '在后台做', '在后台做', 1))

    def test_role_lists_each_background_run_with_its_job_title(self):
        self.assertEqual(snapshot(self.server, now=self.now)['role']['background'], [])
        job = self.jobs.submit('  整理\n 周报 ', {'user_request': 'PRIVATE_TRANSCRIPT'})
        self.jobs.claim()
        self.store.begin(job['run_id'], 'conversation', 'aster', job['generation'])
        self.store.begin('bg-other', 'conversation', 'aster', 3)
        for run_id in (job['run_id'], 'bg-other'):
            self.store.event(run_id, 'running', {'backend': 'codex', 'work_kind': 'background'})
        role = snapshot(self.server, now=self.now)['role']
        self.assertEqual(role['background_runs'], 2)
        self.assertEqual(sorted(role['background'], key=lambda r: r['run_id']),
                         sorted([{'run_id': job['run_id'], 'generation': job['generation'], 'title': '整理 周报'},
                                 {'run_id': 'bg-other', 'generation': 3, 'title': '后台任务'}], key=lambda r: r['run_id']))
        self.assertNotIn('PRIVATE_', json.dumps(role))

    def test_role_doing_follows_state_and_unknown_state_is_readable(self):
        self.store.begin('role', 'conversation', 'aster', 1)
        for state, expected in (('awaiting_approval', '待批准'), ('awaiting_input', '待回答'),
                                ('done', '完成'), ('error', '出错了'), ('unknown', '状态不明')):
            with self.subTest(state=state):
                run = {'state': state, 'backend': 'codex', 'phase': 'tool_started', 'tool_name': 'Read',
                       'run_id': 'role', 'conversation_id': 'conversation', 'run_generation': 1,
                       'outcome': None, 'additional_runs': 0, 'background_runs': 0, 'background': [], 'since': self.now}
                with patch('character_agent.services.embodiment.project', return_value=run):
                    role = snapshot(self.server, now=self.now)['role']
                self.assertEqual((role['state'], role['activity'], role['doing']), (state, expected, expected))

    def test_session_status_maps_states_to_five_kinds_and_sorts_by_them(self):
        now = self.now
        self.rows(('run', 'running_tool', now - 1, {}), ('think', 'thinking', now - 5, {}),
                  ('done', 'done', now - 6, {}), ('lost', 'stale', now - 2, {}), ('broke', 'error', now - 7, {}),
                  ('input', 'awaiting_input', now - 9, {}), ('ask', 'awaiting_approval', now - 3, {'pending_approvals': ['x']}),
                  ('sub', 'subagent', now - 4, {}), ('old', 'done', now - 1800, {}))
        value = snapshot(self.server, now=now)
        self.assertEqual([(s['id'], s['status']) for s in value['sessions']],
                         [('claude:ask', 'needs_you'), ('claude:input', 'needs_you'), ('claude:broke', 'error'),
                          ('claude:done', 'done'), ('claude:run', 'running'), ('claude:sub', 'running'),
                          ('claude:think', 'running'), ('claude:lost', 'stale')])

    def test_session_with_a_pending_approval_needs_you_and_lists_only_its_own(self):
        self.rows(('a', 'running_tool', self.now - 1, {}), ('b', 'thinking', self.now - 2, {}))
        mine = [self.broker.open('claude', 'a', 'Bash', window=90), self.broker.open('claude', 'a', 'Edit', window=90)]
        other = self.broker.open('codex', 'a', 'Bash', window=90)
        value = snapshot(self.server, now=self.now)
        sessions = {s['id']: s for s in value['sessions']}
        self.assertEqual(sorted(sessions['claude:a']['approvals']), sorted(c.request_id for c in mine))
        self.assertEqual(sessions['claude:a']['status'], 'needs_you')
        self.assertEqual((sessions['claude:b']['approvals'], sessions['claude:b']['status']), ([], 'running'))
        self.assertIn(other.request_id, [r['id'] for r in value['pending']['approvals']])

    def test_session_cap_is_eight_with_the_rest_counted(self):
        self.rows(*[(str(i), 'thinking', self.now - i, {}) for i in range(11)])
        value = snapshot(self.server, now=self.now)
        self.assertEqual([s['id'] for s in value['sessions']], ['claude:' + str(i) for i in range(8)])
        self.assertEqual(value['additional_sessions'], 3)

    def test_session_action_is_the_current_tool_else_the_last_one(self):
        last = {'last_tool_name': 'Edit', 'last_tool_target': 'HostLink.swift'}
        self.rows(('tool', 'running_tool', self.now - 1, {'tool_name': 'Bash', 'tool_category': 'command',
                                                          'tool_target': 'swift', **last}),
                  ('grep', 'running_tool', self.now - 2, {'tool_name': 'Grep', 'tool_category': 'search', **last}),
                  ('between', 'thinking', self.now - 3, last),
                  ('quiet', 'thinking', self.now - 4, {'outcomes': [{'kind': 'done'}]}))
        value = snapshot(self.server, now=self.now)
        sessions = {s['id']: (s['tool'], s['target']) for s in value['sessions']}
        self.assertEqual(sessions, {'claude:tool': ('Bash', 'swift'), 'claude:grep': ('Grep', None),
                                    'claude:between': ('Edit', 'HostLink.swift'), 'claude:quiet': (None, None)})
        self.assertNotIn('last', value['sessions'][0])

    def test_own_session_action_comes_from_its_native_hook(self):
        own = OwnSession('claude', '/w', '检查构建结果')
        own.native_id, own.state, own.last_line = 'native', 'running_tool', '  正在\n 跑测试 ' + 'x' * 100
        self.server.sessions = SimpleNamespace(sessions={own.session_id: own}, native_ids=lambda: {'native': own})
        self.rows(('native', 'running_tool', self.now, {'tool_name': 'Bash', 'tool_category': 'command',
                                                        'tool_target': 'swift'}))
        value = snapshot(self.server, now=own.updated_at)
        self.assertEqual([(s['id'], s['tool'], s['target'], s['status']) for s in value['sessions']],
                         [(own.session_id, 'Bash', 'swift', 'running')])

    def test_hook_session_title_is_the_stored_one_while_typed_text_is_allowed(self):
        self.rows(('a', 'thinking', self.now, {}), ('b', 'thinking', self.now - 1, {}))
        self.server.registry.titles = lambda: {'claude:a': '修构建'}
        self.assertEqual([s['title'] for s in snapshot(self.server, now=self.now)['sessions']], ['修构建', 'w'])
        self.server.consent = SimpleNamespace(snapshot=lambda: ({'typed_text': False}, 2))
        self.assertEqual([s['title'] for s in snapshot(self.server, now=self.now)['sessions']], ['w', 'w'])

    def test_thought_is_the_latest_one_when_the_server_has_thoughts(self):
        self.assertIsNone(snapshot(self.server, now=self.now)['thought'])
        self.server.thoughts = None
        self.assertIsNone(snapshot(self.server, now=self.now)['thought'])
        thought = {'id': 't1', 'text': '她好像卡在测试上了', 'offer': None, 'reason': 'error', 'at': self.now,
                   'session_id': None}
        self.server.thoughts = SimpleNamespace(latest=lambda: thought)
        self.assertEqual(snapshot(self.server, now=self.now)['thought'], thought)
        self.server.thoughts = SimpleNamespace(latest=lambda: None)
        self.assertIsNone(snapshot(self.server, now=self.now)['thought'])

    def test_presence_names_the_focus_session_only_while_it_runs(self):
        self.assertIsNone(snapshot(self.server, now=self.now)['focus'])
        self.server.focus.start(25)
        self.assertEqual(snapshot(self.server, now=self.now)['focus'], {'until': self.now + 1500, 'minutes': 25})
        self.server.focus.stop()
        self.assertIsNone(snapshot(self.server, now=self.now)['focus'])

    def test_pending_questions_are_versioned_open_and_bounded(self):
        for i in range(6):
            data = {'questions': [{'id': 'answer', 'question': '  Which\n  option? ' + 'x' * 100}],
                    'user_text': 'PRIVATE_TRANSCRIPT', 'preview': 'PRIVATE_PREVIEW'}
            self.store.db.execute(
                "INSERT INTO character_interactions(request_id,run_id,kind,state,revision,generation,data,created_at,expires_at) "
                "VALUES(?,?,?,'pending',1,?,?,?,?)",
                (str(i), 'run', 'question' if i < 5 else 'approval', 10 + i,
                 json.dumps(data), self.now + i, self.now + 100))
        self.store.db.commit()
        value = snapshot(self.server, now=self.now + 10)['pending']
        self.assertEqual([(r['id'], r['generation'], r['since']) for r in value['questions']],
                         [('4', 14, self.now + 4), ('3', 13, self.now + 3), ('2', 12, self.now + 2)])
        self.assertEqual(value['questions_more'], 2)
        self.assertEqual(value['questions'][0]['title'], ('Which option? ' + 'x' * 100)[:80])
        self.assertNotIn('PRIVATE_', json.dumps(value))
        for i in range(5): self.interactions.respond(str(i), 1, {'answer': ['yes']})
        value = snapshot(self.server, now=self.now + 10)['pending']
        self.assertEqual((value['questions'], value['questions_more']), ([], 0))

    def test_pending_approvals_are_versioned_open_and_bounded(self):
        cards = []
        for i in range(5):
            self.now += 1
            cards.append(self.broker.open('claude', str(i), 'Bash', tool_summary='  git\n status  ', window=90))
        value = snapshot(self.server, now=self.now)['pending']
        self.assertEqual([(r['id'], r['generation']) for r in value['approvals']],
                         [(r.request_id, r.generation) for r in reversed(cards[2:])])
        self.assertEqual(value['approvals_more'], 2)
        self.assertEqual(value['approvals'][0]['title'], 'Bash: git status')
        self.assertEqual(value['approvals'][0]['since'], self.now)
        self.assertEqual(value['approvals'][1]['since'], self.now - 1)
        for card in cards:
            self.assertEqual(self.broker.decide(card.request_id, card.generation, 'deny'), (True, None))
        value = snapshot(self.server, now=self.now)['pending']
        self.assertEqual((value['approvals'], value['approvals_more']), ([], 0))

    def test_pending_approval_exposes_only_tool_and_clipped_card_summary(self):
        card = self.broker.open('claude', 'one', 'Edit', tool_summary='  safe\n ' + 's' * 100,
                                content_preview='PRIVATE_FILE_CONTENTS',
                                dispatch={'prompt': 'PRIVATE_TOOL_INPUT'}, cwd='/PRIVATE_PATH')
        value = snapshot(self.server, now=self.now)['pending']
        self.assertEqual(value['approvals'], [{'id': card.request_id, 'generation': card.generation,
                         'title': ('Edit: safe ' + 's' * 100)[:80], 'since': self.now}])
        self.assertNotIn('PRIVATE_', json.dumps(value))

    def test_pending_dispatch_approval_without_tool_name(self):
        card = self.broker.open('agentd', 'one', kind='dispatch',
                                dispatch={'prompt': 'PRIVATE_TRANSCRIPT'})
        value = snapshot(self.server, now=self.now)['pending']
        self.assertEqual(value['approvals'], [{'id': card.request_id, 'generation': card.generation,
                         'title': 'dispatch:', 'since': self.now}])

    def test_pending_tasks_are_versioned_open_and_bounded(self):
        jobs = []
        for i in range(5):
            self.now += 1
            job = self.jobs.submit('  Task\n ' + str(i) + ' ' + 'x' * 100,
                                   {'user_request': 'PRIVATE_TRANSCRIPT'})
            self.jobs.settle(job['job_id'], 'failed', from_states=('queued',))
            jobs.append(self.jobs.resume(job['job_id']))
        self.jobs.claim()
        value = snapshot(self.server, now=self.now)['pending']
        self.assertEqual([(r['id'], r['generation'], r['since']) for r in value['tasks']],
                         [(j['job_id'], j['generation'], j['created_at']) for j in reversed(jobs[2:])])
        self.assertEqual(value['tasks_more'], 2)
        self.assertEqual(value['tasks'][0]['title'], ('Task 4 ' + 'x' * 100)[:80])
        self.assertEqual(value['tasks'][0]['state'], 'queued')
        self.assertNotIn('PRIVATE_', json.dumps(value))
        for job in jobs[1:]: self.jobs.settle(job['job_id'], 'succeeded', from_states=('queued',))
        value = snapshot(self.server, now=self.now)['pending']
        self.assertEqual(value['tasks'][0]['state'], 'running')
        self.jobs.settle(jobs[0]['job_id'], 'succeeded')
        value = snapshot(self.server, now=self.now)['pending']
        self.assertEqual((value['tasks'], value['tasks_more']), ([], 0))

    def test_pending_tasks_include_jobs_that_wait_for_the_user(self):
        states = {}
        for state in ('needs_review', 'interrupted', 'cancelled', 'failed'):
            self.now += 1
            job = self.jobs.submit('Task ' + state, {'user_request': 'PRIVATE_TRANSCRIPT'})
            self.jobs.settle(job['job_id'], state, from_states=('queued',))
            states[job['job_id']] = state
        value = snapshot(self.server, now=self.now)['pending']
        self.assertEqual(sorted((states[r['id']], r['state']) for r in value['tasks']),
                         [('interrupted', 'interrupted'), ('needs_review', 'needs_review')])

    def test_pending_results_are_empty_without_a_viewed_delivery_store(self):
        job = self.jobs.submit('Finished result', {'user_request': 'PRIVATE_TRANSCRIPT'})
        self.jobs.settle(job['job_id'], 'succeeded', {'reply': 'PRIVATE_RESULT'}, from_states=('queued',))
        value = snapshot(self.server, now=self.now)['pending']
        self.assertEqual((value['results'], value['results_more']), ([], 0))
        self.assertNotIn('PRIVATE_', json.dumps(value))

    def test_pending_results_count_viewed_but_undecided_deliveries(self):
        from character_agent.services.deliveries import DeliveryService
        deliveries = DeliveryService(Memory(self.db), self.store, self.server.tasks, self.jobs, clock=lambda: self.now)
        self.server.character_agent.deliveries = deliveries
        produced = {}
        for ident in ('kept', 'decided'):
            self.server.tasks.create(ident, 'character', self.tmp.name, 'Result ' + ident, 'workspace_write')
            for state in ('approved', 'running', 'returned', 'verifying', 'needs_review'):
                self.server.tasks.transition(ident, state)
            self.store.begin('run-' + ident, 'conversation', 'aster', 1, delivery_eligible=True)
            self.store.finish('run-' + ident, 'completed', task_id=ident, result={'artifacts': []})
            value = deliveries.produce('run-' + ident)
            produced[ident] = deliveries.receipt(value['delivery_id'], 'viewed', expected_revision=value['revision'],
                                                 generation=value['generation'])
        decided = produced['decided']
        deliveries.decide(decided['canonical_task_id'], decided['delivery_id'], 'accept',
                          expected_revision=decided['revision'], generation=decided['generation'])
        value = snapshot(self.server, now=self.now)['pending']
        self.assertEqual([(r['id'], r['state']) for r in value['results']],
                         [(produced['kept']['delivery_id'], 'viewed')])

    def at(self, days, hour, minute=0):
        """Epoch seconds at hour:minute local time, days after self.now's local day."""
        t = time.localtime(self.now)
        return time.mktime((t.tm_year, t.tm_mon, t.tm_mday + days, hour, minute, 0, 0, 0, -1))

    def test_pending_reminders_are_the_ones_due_today_and_the_overdue_triggered_ones_by_due_time(self):
        commitments = self.server.commitments
        self.now = self.at(0, 12)
        overdue = commitments.add('昨晚的提醒', self.at(-1, 20))
        rang = commitments.add('11 点的提醒', self.at(0, 11))
        delivered = commitments.add('10 点已送达', self.at(0, 10))
        cancelled = commitments.add('取消了', self.at(0, 9))
        self.assertEqual(len(commitments.due()), 4)
        commitments.fulfill(delivered['id'], None)
        commitments.cancel(cancelled['id'])
        later = commitments.add('下午组会', self.at(0, 15, 30))
        commitments.add('明早的提醒', self.at(1, 9))
        commitments.add('等 codex 做完', None, trigger={'kind': 'session_done', 'agent': 'codex'})
        value = snapshot(self.server, now=self.now)['pending']
        self.assertEqual(value['reminders'], [
            {'id': overdue['id'], 'text': '昨晚的提醒', 'due_at': self.at(-1, 20), 'state': 'triggered'},
            {'id': rang['id'], 'text': '11 点的提醒', 'due_at': self.at(0, 11), 'state': 'triggered'},
            {'id': later['id'], 'text': '下午组会', 'due_at': self.at(0, 15, 30), 'state': 'armed'}])
        self.assertEqual(value['reminders_more'], 0)

    def test_pending_reminders_are_at_most_five_with_the_rest_counted_and_read_without_firing(self):
        self.now = self.at(0, 12)
        for i in range(7): self.server.commitments.add('提醒 ' + str(i), self.now - 60 * (7 - i))
        value = snapshot(self.server, now=self.now)['pending']
        self.assertEqual([r['text'] for r in value['reminders']], ['提醒 ' + str(i) for i in range(5)])
        self.assertEqual(value['reminders_more'], 2)
        self.assertEqual([r['state'] for r in self.server.commitments.list()], ['armed'] * 7)

    def test_pending_tasks_omit_unversioned_task_ledger_rows(self):
        ledger = self.server.tasks
        ledger.create('one', 'codex', '/private', 'PRIVATE_TASK', 'read_only')
        ledger.transition('one', 'approved'); ledger.transition('one', 'running')
        value = snapshot(self.server, now=self.now)['pending']
        self.assertEqual((value['tasks'], value['tasks_more']), ([], 0))

    def test_presence_reports_agent_state_priority(self):
        rows = []
        self.server.registry.snapshot = lambda: {'sessions': list(rows)}
        def row(name, state, since):
            return {'source': 'claude', 'session_id': name, 'display_session': 'claude:' + name, 'cwd': '/w',
                    'effective_state': state, 'since': since, 'pending_approvals': [], 'tool_name': None,
                    'tool_category': None, 'tool_target': None, 'last_tool_name': None, 'last_tool_target': None,
                    'outcomes': []}
        agent = lambda: snapshot(self.server, now=self.now)['agent']
        self.assertEqual(agent(), {'state': 'idle', 'since': None, 'count': 0})
        rows.append(row('busy', 'running_tool', self.now - 5))
        self.assertEqual(agent(), {'state': 'working', 'since': self.now - 5, 'count': 1})
        card = self.broker.open('claude', 'one', 'Bash', window=90)
        self.assertEqual(agent(), {'state': 'waiting_you', 'since': self.now, 'count': 1})
        self.broker.decide(card.request_id, card.generation, 'deny')
        rows.append(row('broke', 'error', self.now - 100))
        self.assertEqual(agent(), {'state': 'failed', 'since': self.now - 100, 'count': 1})
        rows[:] = [row('finished', 'done', self.now - 30), row('broke', 'error', self.now - 130)]
        self.assertEqual(agent(), {'state': 'done', 'since': self.now - 30, 'count': 1})
        self.now += 31
        self.assertEqual(agent(), {'state': 'idle', 'since': None, 'count': 0})

    def test_role_run_longer_than_the_freshness_window_is_fresh_from_its_finish(self):
        for state, outcome, agent_state in (('completed', 'answered', 'done'), ('failed', None, 'failed')):
            with self.subTest(outcome=outcome):
                self.store.forget()
                self.store.begin('long', 'conversation', 'aster', 1)
                self.store.event('long', 'running', {'backend': 'codex'})
                self.store.finish('long', state)
                self.store.event('long', state, {'outcome': outcome} if outcome else {})
                with self.store.lock:
                    self.store.db.execute("UPDATE character_runs SET started_at=?, ended_at=? WHERE run_id='long'",
                                          (self.now - 300, self.now - 1))
                self.assertEqual(snapshot(self.server, now=self.now)['agent'],
                                 {'state': agent_state, 'since': self.now - 1, 'count': 1})

    def test_pending_missing_character_agent_and_commitments_are_empty(self):
        self.server.character_agent = None
        self.server.commitments = None
        value = snapshot(self.server, now=self.now)
        self.assertEqual(value['role']['state'], 'idle')
        for kind in ('questions', 'approvals', 'tasks', 'results', 'reminders'):
            self.assertEqual((value['pending'][kind], value['pending'][kind + '_more']), ([], 0))


if __name__ == '__main__': unittest.main()
