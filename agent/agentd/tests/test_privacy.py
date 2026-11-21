"""Consent regression tests across saved config, cached context and the line dispatch boundary."""
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace as NS
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from observation.attention import AttentionStore
from observation.blacklist import Blacklist
from support import add_episode, deny_blacklist
from observation.capture import CaptureManager
from observation.privacy import ConsentPolicy, saved_consent, saved_switch
from daemon.agentd_server import AgentdServer
from support import serve_in_thread
from test_server import KernelLines, Script, ScriptedMouth


class PrivacyRevocationTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.config=self.root/'config.json'
        self.settings={"share_window_text":True,"share_page_text":True,"share_screenshots":True}
        self.save()
        black=Blacklist(deny_blacklist(self.root/'blacklist.json'))
        self.attention=AttentionStore(self.root/'attention.sqlite',black)
        self.addCleanup(self.attention.close)
        self.front={"window_id":42,"pid":1234,"app":"Fixture","title":"Synthetic"}
        self.attention.ingest({"ts":time.time(),"idle_s":0,"front":self.front})
        self.server=AgentdServer(('127.0.0.1',0),'hook','ui',attention=self.attention,
                                share_page_text=True,tick_interval=1000)
        self.server.character_agent=KernelLines(self.server)
        self.addCleanup(self.server.server_close)
        self.server.privacy_config=str(self.config)
        self.server.capture=CaptureManager(self.server.feed,black,lambda:self.front,self.root/'capture.log',share_text=True)
        self.server.sync_privacy()
        self.server.capture.text({**self.front,"text":"SYNTHETIC_WINDOW_SECRET "*15,"source":"ax","secure_input":False})

    def save(self,**changes):
        self.settings.update(changes);self.config.write_text(json.dumps(self.settings), encoding='utf-8')

    def test_a_turn_whose_observation_context_holds_the_window_text_leaves_it_out(self):
        self.assertIn('SYNTHETIC_WINDOW_SECRET',self.server.context('hello'))  # control
        self.assertNotIn('SYNTHETIC_WINDOW_SECRET',self.server.context('hello',window=False))

    def test_revoked_window_text_is_removed_before_next_context_without_restart(self):
        self.assertIn('SYNTHETIC_WINDOW_SECRET',self.server.context('hello'))
        self.save(share_window_text=False)
        self.assertNotIn('SYNTHETIC_WINDOW_SECRET',self.server.context('hello'))
        self.assertIsNone(self.server.capture.window_text())
        self.save(share_window_text=True)
        self.assertNotIn('SYNTHETIC_WINDOW_SECRET',self.server.context('hello'),'re-enabling cannot resurrect a cache')

    def test_reducing_context_level_or_unreadable_config_fails_closed(self):
        for value in ({"screen_context_level":"status"},None):
            with self.subTest(value=value):
                if value is None: self.config.write_text('{', encoding='utf-8')
                else: self.save(**value)
                self.assertNotIn('SYNTHETIC_WINDOW_SECRET',self.server.context('hello'))

    def test_narrowing_full_window_to_focused_discards_the_wider_cache(self):
        self.save(screen_context_level='window');self.server.sync_privacy()
        self.server.capture.text({**self.front,"text":"WIDER_WINDOW_SECRET "*20,"source":"ax","secure_input":False})
        self.assertIn('WIDER_WINDOW_SECRET',self.server.context('hello'))
        self.save(screen_context_level='focused')
        self.assertNotIn('WIDER_WINDOW_SECRET',self.server.context('hello'))

    def test_live_dispatch_is_cancelled_and_late_reply_not_retained(self):
        entered,released,closed=threading.Event(),threading.Event(),threading.Event()
        class HeldMouth(ScriptedMouth):
            def stream(self,text,context):
                entered.set();released.wait(3);yield from super().stream(text,context)
            def cancel_active(self): closed.set();released.set()
        mouth=HeldMouth(Script(['late secret reply']),lore_path=False)
        self.server.mouth=mouth
        cancel=self.server._line_cancel=threading.Event()
        errors=[]
        def run():
            try: self.server._run_line('privacy-line','hello',cancel,self.server.turn_generation,prepared=mouth)
            except Exception as error: errors.append(error)
        thread=threading.Thread(target=run);thread.start()
        try:
            self.assertTrue(entered.wait(2))
            self.save(share_window_text=False);self.server.sync_privacy()
            self.assertTrue(closed.wait(1));self.assertTrue(cancel.is_set())
        finally: released.set();thread.join(3)
        self.assertFalse(thread.is_alive());self.assertEqual(errors,[]);self.assertEqual(mouth.history,[])

    def test_late_vision_result_is_dropped_after_screenshot_revocation(self):
        entered,released,finished=threading.Event(),threading.Event(),threading.Event()
        def describe(_,user):
            entered.set();released.wait(3);finished.set();return 'SYNTHETIC_IMAGE_SECRET'
        capture=self.server.capture;capture.vision=NS(describe=describe)
        self.server.sync_privacy();status,request=self.server.look();self.assertEqual(status,202)
        capture.image(request['request_id'],42,b'synthetic-image')
        try:
            self.assertTrue(entered.wait(2));self.save(share_screenshots=False);self.server.sync_privacy()
        finally: released.set()
        self.assertTrue(finished.wait(2))
        self.assertIsNone(capture.view())
        self.assertNotEqual(capture.observation(request['request_id'])['status'],'ready')

    def test_revocation_discards_cached_browser_text(self):
        self.attention.ingest_browser({"type":"page","ts":time.time(),"url_host":"example.com","text":"page secret"})
        self.assertGreater(self.attention.db.execute('SELECT COUNT(*) FROM context').fetchone()[0],0)
        self.save(share_page_text=False);self.server.sync_privacy()
        self.assertEqual(self.attention.db.execute('SELECT COUNT(*) FROM context').fetchone()[0],0)

    def test_page_permission_is_rechecked_without_waiting_for_the_tick(self):
        self.server.sync_privacy()
        self.save(share_page_text=False)
        self.assertFalse(self.server.page_text_allowed())

    def test_revoked_page_messages_are_not_persisted(self):
        thread=serve_in_thread(self.server)
        try:
            self.save(share_page_text=False)
            conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=2)
            body={"type":"page","ts":time.time(),"url_host":"example.com","title":"Fixture","text":"REVOKED_PAGE_SECRET"}
            conn.request('POST','/context/browser',json.dumps(body),{'Authorization':'Bearer hook','Content-Type':'application/json'})
            reply=conn.getresponse();reply.read();conn.close()
            self.assertEqual(reply.status,200)
            self.assertEqual(self.attention.db.execute('SELECT COUNT(*) FROM context').fetchone()[0],0)
        finally:self.server.shutdown();thread.join(2)

    def test_native_revocation_tombstone_survives_a_quick_off_on(self):
        self.assertIn('SYNTHETIC_WINDOW_SECRET',self.server.context('hello'))
        self.save(share_window_text=False)
        self.save(share_window_text=True)  # the next file poll only sees the final grant
        self.server.sync_privacy(['window_text'])
        self.assertNotIn('SYNTHETIC_WINDOW_SECRET',self.server.context('hello'))

    def test_native_sync_endpoint_authenticates_and_applies_only_saved_policy(self):
        thread=serve_in_thread(self.server)
        try:
            self.save(share_window_text=False)
            for token,expected in (('hook',401),('ui',200)):
                conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=2)
                conn.request('POST','/context/privacy/sync','{}',{'Authorization':'Bearer '+token,'Content-Type':'application/json'})
                reply=conn.getresponse();body=json.loads(reply.read());conn.close()
                self.assertEqual(reply.status,expected)
                if expected==200:self.assertFalse(body['permissions']['window_text'])
        finally:self.server.shutdown();thread.join(2)

    def typed(self):
        self.server.share_typed_text=True;self.save(share_typed_text=True);self.server.sync_privacy()
        now=time.time()
        self.attention.ingest_events([{"ts":now,"kind":"value","app":"Fixture","value":"SYNTHETIC_TYPED"},
                                      {"ts":now,"kind":"prompt","app":"claude","value":"SYNTHETIC_PROMPT"}])
        return lambda:[(e['kind'],e['value']) for e in self.attention.recent_events(0)]

    def test_revoked_typed_text_drops_kept_values(self):
        kept=self.typed()
        self.save(share_typed_text=False);self.server.sync_privacy()
        self.assertEqual(kept(),[('value',None),('prompt',None)])

    def test_native_sync_revokes_typed_text(self):
        kept=self.typed()
        thread=serve_in_thread(self.server)
        try:
            conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=2)
            conn.request('POST','/context/privacy/sync',json.dumps({'revoke':['typed_text']}),
                         {'Authorization':'Bearer ui','Content-Type':'application/json'})
            reply=conn.getresponse();reply.read();conn.close()
            self.assertEqual(reply.status,200)
        finally:self.server.shutdown();thread.join(2)
        self.assertEqual(kept(),[('value',None),('prompt',None)])

    def test_p0_8_dry_run_counts_equal_the_rows_the_real_sync_then_deletes(self):
        from personal.episodes import Episodes
        from personal.memory import Memory
        from infra.store import open_store
        self.typed()
        self.attention.ingest_browser({"type":"page","ts":time.time(),"url_host":"example.com","text":"page secret"})
        db=open_store(self.root/'domain.sqlite');self.addCleanup(db.close)
        s=self.server;s.episodes=Episodes(db);s.memory=Memory(db)
        typed=add_episode(s.episodes,1,2,"t","d",[{"subject":"x"}],requires=["page_text","typed_text"])
        linked,kept=(add_episode(s.episodes,3,4,"t","d",[{"subject":"x"}],requires=["window_text"]) for _ in range(2))
        s.memory.add("observed one","observed_context",evidence=[f"episode:{typed}@d",f"episode:{linked}@d"])
        s.memory.add("told via linked","asserted_by_user",evidence=[f"episode:{linked}@d"])
        s.memory.add("observed kept","observed_context",evidence=[f"episode:{kept}@d"])
        queries={"browser_text":(self.attention.db,"SELECT COUNT(*) FROM context"),
                 "typed_values":(self.attention.db,"SELECT COUNT(*) FROM events_raw WHERE value IS NOT NULL"),
                 "episodes":(db,"SELECT COUNT(*) FROM episodes"),
                 "facts":(db,"SELECT COUNT(DISTINCT fact_id) FROM facts WHERE state IN ('active','candidate')")}
        rows=lambda:{k:conn.execute(sql).fetchone()[0] for k,(conn,sql) in queries.items()}
        thread=serve_in_thread(self.server)
        def sync(body):
            conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=2)
            conn.request('POST','/context/privacy/sync',json.dumps(body),{'Authorization':'Bearer ui','Content-Type':'application/json'})
            reply=conn.getresponse();value=json.loads(reply.read());conn.close()
            return reply.status,value
        try:
            before=rows()
            self.assertEqual(sync({'revoke':['typed_text','page_text'],'dry_run':1})[0],400)
            status,dry=sync({'revoke':['typed_text','page_text'],'dry_run':True})
            self.assertEqual(status,200,dry)
            self.assertEqual(rows(),before)
            self.assertEqual(sync({'revoke':['typed_text','page_text']})[0],200)
        finally:self.server.shutdown();thread.join(2)
        after=rows()
        self.assertEqual({k:dry['counts'][k] for k in queries},{k:before[k]-after[k] for k in queries})
        self.assertEqual({k:dry['counts'][k] for k in queries},
                         {"browser_text":1,"typed_values":2,"episodes":2,"facts":2})
        self.assertEqual({k:v for k,v in dry['counts'].items() if k not in queries},
                         {"task_understanding":0})


class ConsentPolicyTest(unittest.TestCase):
    def test_saved_config_cannot_expand_startup_capabilities(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'config.json';path.write_text(json.dumps(dict.fromkeys(
                ('share_window_text','share_page_text','share_screenshots'),True)), encoding='utf-8')
            policy=ConsentPolicy(lambda:path,lambda:dict.fromkeys(('window_text','page_text','screenshots','typed_text'),False))
            self.assertFalse(any(policy.snapshot()[0].values()))

    def test_typed_text_needs_the_startup_capability_and_a_true_saved_switch(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'config.json'
            for saved,capability,expected in (({'share_typed_text':True},True,True),({},True,False),
                                              ({'share_typed_text':'yes'},True,False),
                                              ({'share_typed_text':True},False,False)):
                with self.subTest(saved=saved,capability=capability):
                    path.write_text(json.dumps(saved), encoding='utf-8')
                    capabilities={'window_text':False,'page_text':False,'screenshots':False,'typed_text':capability}
                    self.assertIs(saved_consent(path,capabilities)[0]['typed_text'],expected)

    def test_a_saved_switch_is_on_only_when_its_key_is_true(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'config.json'
            self.assertIs(saved_switch(path,'cloud_summary'),False)
            for text,expected in ((json.dumps({'cloud_summary':True}),True),(json.dumps({'cloud_summary':False}),False),
                                  (json.dumps({}),False),(json.dumps({'cloud_summary':'yes'}),False),('{',False)):
                with self.subTest(text=text):
                    path.write_text(text, encoding='utf-8')
                    self.assertIs(saved_switch(path,'cloud_summary'),expected)

    def test_an_unchanged_config_is_not_read_again(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'config.json';path.write_text(json.dumps({'share_typed_text':True,'cloud_summary':True}), encoding='utf-8')
            capabilities={'window_text':False,'page_text':False,'screenshots':False,'typed_text':True}
            with patch('observation.privacy.json.load',wraps=json.load) as load:
                for _ in range(5):
                    self.assertIs(saved_consent(path,capabilities)[0]['typed_text'],True)
                    self.assertIs(saved_switch(path,'cloud_summary'),True)
                self.assertEqual(load.call_count,1)
                path.write_text(json.dumps({'share_typed_text':False,'cloud_summary':True}), encoding='utf-8')
                self.assertIs(saved_consent(path,capabilities)[0]['typed_text'],False)
                self.assertEqual(load.call_count,2)
                path.unlink()
                self.assertIs(saved_switch(path,'cloud_summary'),False)
