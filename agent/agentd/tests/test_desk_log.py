"""character.desk_log: its rows across a restart, the running spans' heartbeat, retention and reset, and the edge parking
Spatial reports."""
from pathlib import Path
import tempfile
import unittest

import support  # noqa: F401
from character.desk_log import TICK, DeskLog
from infra.data_lifecycle import DataLifecycle
from infra.store import open_store
from observation.spatial import EDGE, Spatial
from sessions.registry import Registry


class DeskLogTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1])
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / 'agentd.sqlite'
        self.at = 1_000_000.0
        self.keep = None
        self.desk = self.open()

    def open(self):
        db = open_store(self.path)
        self.addCleanup(db.close)
        return DeskLog(db, clock=lambda: self.at, retention=lambda: self.keep)

    def rows(self):
        return self.desk.db.execute('SELECT kind,at,until FROM desk_log ORDER BY id').fetchall()

    def test_a_running_span_keeps_its_end_fresh_and_an_earlier_process_span_ends_there(self):
        self.desk.span('visible', True)
        self.desk.count('pat')
        self.at += 1
        self.desk.tick()
        self.at += TICK - 1
        self.desk.tick()
        self.assertEqual(self.rows(), [('visible', 1_000_000.0, 1_000_001.0), ('pat', 1_000_000.0, None)])
        self.at += 1
        self.desk.tick()
        self.assertEqual(self.rows()[0], ('visible', 1_000_000.0, 1_000_000.0 + TICK + 1))
        self.at += 30
        self.desk = self.open()
        self.assertEqual(self.desk.running(), set())
        self.desk.span('visible', False)
        self.desk.span('visible', True)
        self.assertEqual(self.rows(), [('visible', 1_000_000.0, 1_000_000.0 + TICK + 1), ('pat', 1_000_000.0, None),
                                       ('visible', self.at, self.at)])

    def test_retention_and_reset_delete_the_rows(self):
        self.desk.count('wheel')
        self.at += 8 * 86400
        self.desk.count('pinch')
        self.assertEqual(len(self.rows()), 2)
        self.keep = 7 * 86400
        self.at += 3600
        self.desk.count('drag')
        self.assertEqual([row[0] for row in self.rows()], ['pinch', 'drag'])
        self.desk.span('edge', True)
        DataLifecycle([self.desk.db]).clear()
        self.assertEqual(self.rows(), [])
        self.at += TICK
        self.desk.tick()
        self.assertEqual(self.rows(), [('edge', self.at, self.at)])


class EdgeParkingTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1])
        self.addCleanup(tmp.cleanup)
        db = open_store(Path(tmp.name) / 'agentd.sqlite')
        self.addCleanup(db.close)
        self.now, self.stage = 1_760_900_000.0, 'quiet'
        self.desk = DeskLog(db, clock=lambda: self.now)
        self.registry = Registry(epoch=7)
        situation = {'fullscreen': False, 'user_speaking': False, 'speaking': False, 'voicing': False, 'line_id': None,
                     'typing': False, 'session': None, 'state': 'idle', 'related': [], 'window_id': 101}
        self.spatial = Spatial(lambda: dict(situation), self.registry.publish_event, lambda: 3, 7, clock=lambda: self.now,
                               stage=lambda: self.stage)
        self.spatial.parked = lambda on: self.desk.span('edge', on)
        self.spatial._next_tick = self.now + 10_000

    def behaviors(self):
        return [m for m in self.registry.intents_since(0) if m.get('event') == 'behavior']

    def receipt(self, behavior, phase):
        self.spatial.receipt({'behavior_id': behavior['behavior_id'], 'phase': phase, 'reason': None,
                              'at_ms': int(self.now * 1000), 'turn_generation': behavior['turn_generation']})

    def test_parking_at_the_edge_is_one_span_until_quiet_ends(self):
        self.spatial.stage_event('stage.quiet')
        self.now += 2
        self.spatial.poll()
        [walk] = self.behaviors()
        self.assertEqual(walk['target'], EDGE)
        self.receipt(walk, 'running')
        self.now += 5
        self.receipt(walk, 'completed')
        parked = self.now
        self.now += 1200
        self.stage = 'normal'
        self.spatial.stage_event('stage.normal')
        self.assertEqual(self.desk.db.execute('SELECT kind,at,until FROM desk_log').fetchall(),
                         [('edge', parked, parked + 1200)])

    def test_kept_in_place_she_is_parked_at_once(self):
        self.spatial.switches['stay_in_place'] = True
        self.spatial.stage_event('stage.quiet')
        self.now += 2
        self.spatial.poll()
        self.assertEqual(self.behaviors(), [])
        self.assertEqual(self.desk.running(), {1})


if __name__ == '__main__':
    unittest.main()
