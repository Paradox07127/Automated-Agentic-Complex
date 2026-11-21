"""Deterministic read/ticker barriers: resource cleanup must follow their owners."""
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from observation.attention import AttentionStore
from daemon.agentd_server import AgentdServer


class AttentionCloseTests(unittest.TestCase):
    def test_close_waits_for_inflight_read_under_the_store_lock(self):
        entered,release,close_started,closed=map(lambda _:threading.Event(),range(4))
        order=[]
        class DB:
            def execute(self,*args):
                order.append('read_started');entered.set()
                release.wait(2)
                order.append('read_finished')
                return SimpleNamespace(fetchone=lambda:None)
            def close(self):order.append('closed');closed.set()
        store=AttentionStore.__new__(AttentionStore)
        store.lock=threading.Lock();store.db=DB()
        reader=threading.Thread(target=store.focus,daemon=True)
        def close():close_started.set();store.close()
        closer=threading.Thread(target=close,daemon=True)
        reader.start()
        try:
            self.assertTrue(entered.wait(1));closer.start();self.assertTrue(close_started.wait(1))
            self.assertFalse(closed.wait(.05),'Database closed while its owner was reading')
        finally:
            release.set();reader.join(1)
            if closer.ident is not None:closer.join(1)
        self.assertEqual(order,['read_started','read_finished','closed'])


class ServerCloseTests(unittest.TestCase):
    def test_stop_precedes_join_and_owner_close_waits_for_active_tick(self):
        entered,release,closed=threading.Event(),threading.Event(),threading.Event()
        def tick(server,interval):entered.set();release.wait(2)
        with patch.object(AgentdServer,'_tick_loop',tick):
            server=AgentdServer(('127.0.0.1',0),'hook','ui')
        observations=[]
        server.character_agent=SimpleNamespace(close=lambda:observations.append(
            (server._stopped.is_set(),server._ticker.is_alive())))
        def close():
            try:server.server_close()
            finally:closed.set()
        closer=threading.Thread(target=close,daemon=True)
        try:
            self.assertTrue(entered.wait(1));closer.start()
            self.assertTrue(server._stopped.wait(1))
            self.assertFalse(closed.wait(.05),'server_close returned while ticker still used its resources')
            self.assertEqual(observations,[])
        finally:
            release.set();closer.join(2);server._ticker.join(1)
            if server.socket.fileno()!=-1:server.socket.close()
        self.assertFalse(closer.is_alive());self.assertEqual(observations,[(True,False)])

    def test_close_from_ticker_defers_cleanup_without_self_join(self):
        ready,finished,closed=threading.Event(),threading.Event(),threading.Event()
        errors=[]
        def tick(server,interval):
            ready.wait(2)
            try:server.server_close()
            except Exception as error:errors.append(error)
            finally:finished.set()
        with patch.object(AgentdServer,'_tick_loop',tick):
            server=AgentdServer(('127.0.0.1',0),'hook','ui')
        observations=[]
        def owner_close():observations.append(server._ticker.is_alive());closed.set()
        server.character_agent=SimpleNamespace(close=owner_close)
        ready.set()
        try:
            self.assertTrue(finished.wait(1));self.assertTrue(closed.wait(1));server._ticker.join(1)
            self.assertEqual(errors,[]);self.assertEqual(observations,[False])
        finally:
            server._stopped.set()
            if server.socket.fileno()!=-1:server.socket.close()

    def test_bounded_join_timeout_never_silently_releases_live_owner(self):
        server=AgentdServer(('127.0.0.1',0),'hook','ui',tick_interval=60)
        server._stopped.set();server._ticker.join(1)
        original=server._ticker
        fake=SimpleNamespace(join=Mock(),is_alive=lambda:True)
        owner=Mock();server.character_agent=SimpleNamespace(close=owner)
        server._ticker=fake
        try:
            with self.assertRaisesRegex(RuntimeError,'ticker_not_stopped'):server.server_close()
            fake.join.assert_called_once_with(timeout=2.0);owner.assert_not_called()
            self.assertEqual(server.socket.fileno(),-1)
        finally:
            server._ticker=original
            if server.socket.fileno()!=-1:server.socket.close()


if __name__=='__main__':unittest.main()
