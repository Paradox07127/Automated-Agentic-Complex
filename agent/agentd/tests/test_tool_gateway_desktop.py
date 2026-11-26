"""Desktop leases are owned by the gateway and bound to one run; release comes before the next acquire."""
import ast
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from brain.egress import EgressPolicy  # noqa: E402
from brain.provider import Mouth  # noqa: E402
from character_agent.integration import CharacterAgentController  # noqa: E402
from tool_gateway.computer_use import ComputerUseError  # noqa: E402
from personal.history import History  # noqa: E402
from personal.memory import Memory  # noqa: E402
from infra.store import open_store  # noqa: E402
from sessions.tasks import TaskLedger  # noqa: E402
import test_server  # noqa: E402
from test_character_agent_runtime import FakeSession, chat  # noqa: E402
from tool_gateway import desktop  # noqa: E402
from tool_gateway.gateway import SessionKey  # noqa: E402

AGENTD = Path(__file__).resolve().parents[1]


def fake_bridge(test, *, block=None, refuse=()):
    """Patch the only client constructor; returns the (session_id, method) of every finished native call.
    block: an Event a release/cancel waits on before it is recorded. refuse: {method: error code}."""
    calls = []
    def make(config, session_id, **kwargs):
        client = SimpleNamespace(config=config, session_id=session_id, kwargs=kwargs)
        def call(name, args):
            if block is not None and name in ('desktop_release', 'desktop_cancel'):
                block.wait(5)
            calls.append((session_id, name))
            if name in dict(refuse):
                raise ComputerUseError(dict(refuse)[name], 'synthetic')
            return {'ready': True}
        client.call = call
        return client
    patcher = patch('tool_gateway.desktop.ComputerControlClient', side_effect=make)
    patcher.start(); test.addCleanup(patcher.stop)
    return calls


def until(test, predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline: test.fail('condition not reached')
        time.sleep(.01)


class StructureTests(unittest.TestCase):
    def test_only_desktop_module_constructs_clients(self):
        found = []
        for path in AGENTD.rglob('*.py'):
            relative = path.relative_to(AGENTD)
            if relative.parts[0] in ('tests', '.venv') or relative == Path('tool_gateway/desktop.py'):
                continue
            for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'), str(path))):
                if isinstance(node, ast.Call):
                    func = node.func
                    name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
                    if name == 'ComputerControlClient':
                        found.append(f'{relative}:{node.lineno}')
        self.assertEqual(found, [])

    def test_controller_holds_no_desktop_dict(self):
        source = (AGENTD / 'character_agent' / 'integration.py').read_text(encoding='utf-8')
        for gone in ('self._desktop', '_cancel_desktop', 'cancel_native', 'ComputerControlClient'):
            self.assertNotIn(gone, source)


class LeaseTests(unittest.TestCase):
    def setUp(self):
        self.reports = []
        self.config = object()
        self.leases = desktop.DesktopLeases(lambda: self.config, lambda: None,
                                            lambda kind, attrs, key: self.reports.append((kind, attrs, key)))

    def test_busy_desktop_never_cancels_other_session(self):
        calls = fake_bridge(self, refuse={'desktop_status': 'desktop_busy'})
        a, b = SessionKey('character', 'run-a', None), SessionKey('character', 'run-b', None)
        self.assertEqual(self.leases.call(a, 'desktop_observe', {'target': {'pid': 1}}), {'ready': True})
        self.assertEqual(self.leases.call(b, 'desktop_status', {})['error']['code'], 'desktop_busy')
        self.assertEqual(calls, [('character:run-a', 'desktop_observe'), ('character:run-b', 'desktop_status')])
        self.assertEqual(set(self.leases.held()), {'run-a', 'run-b'})
        self.leases.release('run-b', 'user_cancelled_task')
        until(self, lambda: len(calls) == 3)
        self.assertEqual(calls[2], ('character:run-b', 'desktop_cancel'))
        desktop.release_session(self.config, 'own-1', 'own_interrupt')
        until(self, lambda: len(calls) == 4)
        self.assertEqual(calls[3], ('own-1', 'desktop_cancel'))
        self.assertEqual(set(self.leases.held()), {'run-a'})

    def test_lease_reports_open_and_release(self):
        fake_bridge(self)
        key = SessionKey('character', 'run-a', None)
        self.assertEqual(key.native_session, 'character:run-a')
        self.leases.call(key, 'desktop_status', {})
        self.leases.call(key, 'desktop_status', {})
        self.assertTrue(self.leases.release('run-a', 'run_end'))
        self.assertFalse(self.leases.release('run-a', 'run_end'))
        self.assertEqual([(kind, attrs.get('reason')) for kind, attrs, _ in self.reports],
                         [('desktop.lease_opened', None), ('desktop.lease_released', 'run_end')])

    def test_image_and_unconfigured_bridge_are_refused_without_a_lease(self):
        calls = fake_bridge(self)
        key = SessionKey('character', 'run-a', None)
        self.assertEqual(self.leases.call(key, 'desktop_observe', {'target': {'pid': 1}, 'include_image': True}),
                         {'error': {'code': 'image_bridge_unavailable'}})
        self.config = None
        self.assertEqual(self.leases.call(key, 'desktop_status', {}), {'error': {'code': 'desktop_unavailable'}})
        self.assertEqual((calls, self.leases.held()), ([], {}))


class FakeTimers:
    """Stands in for threading.Timer; fire() runs every timer not cancelled."""

    def __init__(self):
        self.made = []

    def __call__(self, interval, function):
        timer = SimpleNamespace(interval=interval, function=function, cancelled=False, start=lambda: None)
        timer.cancel = lambda: setattr(timer, 'cancelled', True)
        self.made.append(timer)
        return timer

    def fire(self):
        for timer in self.made:
            if not timer.cancelled:
                timer.function()


class ConversationLeaseTests(unittest.TestCase):
    def setUp(self):
        self.reports, self.timers = [], FakeTimers()
        self.leases = desktop.DesktopLeases(lambda: object(), lambda: None,
                                            lambda kind, attrs, key: self.reports.append((kind, attrs, key)),
                                            timer=self.timers)

    def run_once(self, run_id, conversation_id, reason='run_end'):
        self.leases.enter(SessionKey('character', run_id, conversation_id))
        result = self.leases.call(SessionKey('character', run_id, None), 'desktop_status', {})
        self.leases.release(run_id, reason)
        return result

    def released(self):
        return [(attrs['run_id'], attrs['session_id'], attrs['reason'])
                for kind, attrs, _ in self.reports if kind == 'desktop.lease_released']

    def test_runs_in_one_conversation_share_one_lease(self):
        calls = fake_bridge(self)
        self.run_once('run-a', 'conv-1')
        self.run_once('run-b', 'conv-1')
        self.assertEqual(calls, [('character:conv-1', 'desktop_status')] * 2)
        self.assertEqual([kind for kind, _, _ in self.reports], ['desktop.lease_opened'])
        self.assertEqual(self.leases.held(), {'conv-1': 'character:conv-1'})
        self.assertEqual([t.cancelled for t in self.timers.made], [True, False])

    def test_idle_conversation_lease_is_released_after_the_grant_window(self):
        calls = fake_bridge(self)
        self.run_once('run-a', 'conv-1')
        self.assertEqual(self.timers.made[0].interval, 120.0)
        self.timers.fire()
        until(self, lambda: len(calls) == 2)
        self.assertEqual(calls[1], ('character:conv-1', 'desktop_release'))
        self.assertEqual(self.released(), [('run-a', 'character:conv-1', 'conversation_idle')])
        self.assertEqual(self.leases.held(), {})

    def test_run_in_another_conversation_releases_the_old_lease_first(self):
        gate = threading.Event(); self.addCleanup(gate.set)
        calls = fake_bridge(self, block=gate)
        self.run_once('run-a', 'conv-1')
        threading.Timer(.2, gate.set).start()
        self.run_once('run-b', 'conv-2')
        self.assertEqual(calls[:3], [('character:conv-1', 'desktop_status'), ('character:conv-1', 'desktop_release'),
                                     ('character:conv-2', 'desktop_status')])
        self.assertEqual(self.released(), [('run-b', 'character:conv-1', 'conversation_switch')])
        self.assertEqual(self.leases.held(), {'conv-2': 'character:conv-2'})
        self.assertTrue(self.timers.made[0].cancelled)

    def test_cancel_still_cancels_the_conversation_lease_at_once(self):
        calls = fake_bridge(self)
        self.leases.enter(SessionKey('character', 'run-a', 'conv-1'))
        self.leases.call(SessionKey('character', 'run-a', None), 'desktop_status', {})
        self.assertTrue(self.leases.release('run-a', 'turn_cancelled'))
        until(self, lambda: len(calls) == 2)
        self.assertEqual(calls[1], ('character:conv-1', 'desktop_cancel'))
        self.assertFalse(self.leases.release('run-a', 'run_end'))
        self.assertEqual((self.leases.held(), self.timers.made), ({}, []))

    def test_run_without_a_conversation_releases_at_run_end(self):
        calls = fake_bridge(self)
        self.run_once('run-a', None)
        until(self, lambda: len(calls) == 2)
        self.assertEqual(calls, [('character:run-a', 'desktop_status'), ('character:run-a', 'desktop_release')])
        self.assertEqual(self.released(), [('run-a', 'character:run-a', 'run_end')])
        self.assertEqual((self.leases.held(), self.timers.made), ({}, []))

    def test_run_without_conversation_releases_idle_conversation_first(self):
        gate = threading.Event(); self.addCleanup(gate.set)
        calls = fake_bridge(self, block=gate)
        self.run_once('run-a', 'conv-1')
        threading.Timer(.1, gate.set).start()
        self.leases.enter(SessionKey('character', 'run-b', None))
        self.leases.call(SessionKey('character', 'run-b', None), 'desktop_status', {})
        self.assertEqual(calls, [('character:conv-1', 'desktop_status'),
                                 ('character:conv-1', 'desktop_release'), ('character:run-b', 'desktop_status')])
        self.assertEqual(self.leases.held(), {'run-b':'character:run-b'})
        self.assertTrue(self.timers.made[0].cancelled)
        self.leases.release('run-b', 'run_end')

    def test_run_without_conversation_preserves_busy_conversation(self):
        calls = fake_bridge(self, refuse={'desktop_status':'desktop_busy'})
        a = SessionKey('character', 'run-a', 'conv-1')
        self.leases.enter(a)
        self.leases.call(a, 'desktop_observe', {})
        b = SessionKey('character', 'run-b', None)
        self.leases.enter(b)
        self.assertEqual(self.leases.call(b, 'desktop_status', {})['error']['code'], 'desktop_busy')
        self.assertEqual(calls, [('character:conv-1', 'desktop_observe'), ('character:run-b', 'desktop_status')])
        self.leases.release_all('shutdown')


class CharacterDesktopTests(test_server.FeedServerCase):
    request = test_server.SayTest.request
    lines_until_final = test_server.SayTest.lines_until_final

    def setUp(self):
        super().setUp()
        self.root = Path(self.tmp.name) / 'personal'; self.root.mkdir()
        self.db = open_store(self.root / 'domain.sqlite')
        s = self.server
        domain_lock = threading.RLock()
        s.history, s.memory, s.tasks = History(self.db, lock=domain_lock, character_id=s.character), Memory(self.db, lock=domain_lock), TaskLedger(self.db, lock=domain_lock)
        s.egress = EgressPolicy()
        s.mouth = Mouth()
        self.script = chat; self.sessions = []
        self.controller = s.character_agent = CharacterAgentController(s, self.root, session_factory=self.factory)
        self.controller.discovery = SimpleNamespace(scan=lambda refresh=False: {'runtimes': [], 'scanned_at': 0})
        self.controller.configure({'backend': 'pi', 'runtime_source': 'bundled'})
        self.server.computer_control = object()
        self.server.sessions = Mock(sessions={}, store=None)
        # desktop_task's readiness probe uses its own session, not a run's lease.
        patcher = patch('tool_gateway.computer_toolset.available', return_value=False)
        patcher.start(); self.addCleanup(patcher.stop)

    def tearDown(self):
        super().tearDown()
        if self.controller.jobs: self.controller.jobs.close()
        self.controller.store.close(); self.controller.workspace.close(); self.db.close()

    def factory(self, definitions):
        result = FakeSession(self.script); self.sessions.append(result); return result

    def line(self, text):
        conn, response = self.open_feed()
        status, body = self.request('POST', '/say', {'text': text})
        self.assertEqual(status, 202, body)
        events = self.lines_until_final(response); conn.close()
        self.assertFalse(events[-1].get('error'), events)
        return body

    def desktop_script(self, session, prompt, options):
        yield from session.use(options, 'desktop_status', {})
        yield from chat(session, prompt, options)

    def conversation(self):
        return 'character:' + self.server.history.conversations.active

    def test_run_in_a_new_conversation_waits_for_the_old_release(self):
        gate = threading.Event(); self.addCleanup(gate.set)
        calls = fake_bridge(self, block=gate)
        self.script = self.desktop_script
        self.line('查一下这个窗口')
        a = self.conversation()
        until(self, lambda: not self.server._live_lines and not self.controller.busy())
        self.assertEqual(self.request('POST', '/conversations', {})[0], 201)
        b = self.conversation()
        self.assertNotEqual(a, b)
        threading.Timer(.3, gate.set).start()
        self.line('再查一下窗口')
        released = next(i for i, (session, name) in enumerate(calls)
                        if session == a and name in ('desktop_release', 'desktop_cancel'))
        self.assertLess(released, calls.index((b, 'desktop_status')))

    def test_idle_conversation_uses_release_not_cancel(self):
        patcher = patch('tool_gateway.desktop.IDLE_RELEASE', .05)
        patcher.start(); self.addCleanup(patcher.stop)
        calls = fake_bridge(self)
        self.script = self.desktop_script
        self.line('查一下这个窗口')
        a = self.conversation()
        until(self, lambda: len(calls) == 2)
        self.assertEqual(calls, [(a, 'desktop_status'), (a, 'desktop_release')])
        self.assertEqual(self.controller.tools.desktop.held(), {})

    def test_user_cancel_still_cancels(self):
        calls = fake_bridge(self)
        hold = threading.Event(); self.addCleanup(hold.set)
        def script(session, prompt, options):
            yield from session.use(options, 'desktop_status', {})
            while not hold.wait(.01) and not options['cancelled'](): pass
            yield from chat(session, prompt, options)
        self.script = script
        status, body = self.request('POST', '/say', {'text': '查一下这个窗口'})
        self.assertEqual(status, 202, body)
        session = self.conversation()
        until(self, lambda: (session, 'desktop_status') in calls)
        self.controller.cancel('turn_cancelled')
        until(self, lambda: (session, 'desktop_cancel') in calls)
        hold.set()
        until(self, lambda: not self.server._live_lines)
        self.assertNotIn((session, 'desktop_release'), calls)
        self.assertEqual(self.controller.tools.desktop.held(), {})

    def test_side_and_background_runs_hold_no_lease(self):
        calls = fake_bridge(self)
        hold = threading.Event(); self.addCleanup(hold.set)
        results = []
        def script(session, prompt, options):
            if 'background_assignment' in prompt or '顺便' in prompt:
                results.append((yield from session.use(options, 'desktop_status', {})))
            else:
                yield from session.use(options, 'background_start', {'title': '核查', 'instruction': '只读核查'})
                while not hold.wait(.01) and not options['cancelled'](): pass
            yield from chat(session, prompt, options)
        self.script = script
        status, body = self.request('POST', '/say', {'text': '在后台查一下资料'})
        self.assertEqual(status, 202, body)
        until(self, lambda: self.controller.busy() and len(results) == 1)
        self.assertEqual(self.request('POST', '/say', {'text': '顺便看看窗口'})[0], 202)
        until(self, lambda: len(results) == 2)
        hold.set()
        until(self, lambda: not self.server._live_lines)
        self.assertEqual([r['error']['code'] for r in results], ['tool_not_available'] * 2)
        self.assertEqual(calls, [])
        self.assertEqual(self.controller.tools.desktop.held(), {})



class ReleaseReasonsTests(unittest.TestCase):
    def test_every_release_reason_revokes_a_native_panel_grant(self):
        from tool_gateway.desktop import RELEASE_REASONS
        from tool_gateway.policy import REVOKE_ON
        self.assertLessEqual(RELEASE_REASONS, REVOKE_ON["native_panel"])


if __name__ == '__main__':
    unittest.main()
