import copy
from pathlib import Path
import sys
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from observation.facing_decisions import FacingDecisions, validate
from observation.spatial import Spatial
from observation.user_now import UserNow
import c1


class RuleFacingTests(unittest.TestCase):
    def test_saved_manual_facing_mode_skips_production_policy(self):
        import json
        import tempfile
        from daemon.agentd_server import AgentdServer
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as directory:
            path=Path(directory)/'config.json'
            execute=Mock()
            service=FacingDecisions(Semantic(),execute)
            server=SimpleNamespace(activity=lambda:dict(activity='reading',related_session_ids=[]),attention=None,
                registry=SimpleNamespace(snapshot=lambda:dict(focus=dict(display_session=None,state='idle'))),
                _turn_trace=None,gate=SimpleNamespace(fullscreen=False,user_speaking=True,meeting=False),
                busy=lambda:False,_live_lines=[],speech=None,facing_decisions=service,thoughts=None,
                character_agent=SimpleNamespace(_permitted=lambda _:True),character='test',turn_generation=0,
                consent=SimpleNamespace(snapshot=lambda:({},0)),closing=False,resetting=False,quiet_until=None,
                privacy_config=path,character_state=lambda:{},user_now=UserNow(),
                spatial=SimpleNamespace(switches={'fullscreen_give_way':True},running=lambda:[],
                    facing_status=lambda:{},facing_available=lambda:True))
            for mode in ('front','side','back'):
                path.write_text(json.dumps({'render_facing_mode':mode}), encoding='utf-8')
                service.last=-float('inf')
                AgentdServer.spatial_situation(server)
                execute.assert_not_called()
            path.write_text(json.dumps({'render_facing_mode':'auto'}), encoding='utf-8')
            AgentdServer.spatial_situation(server)
            self.assertEqual(execute.call_args[0][0],0)

    def test_speech_and_attend_face_user_idle_keeps_and_unsafe_scenes_skip(self):
        for extra, yaw in (({'user_speaking':True},0), ({'speaking':True},0), ({'voicing':True},0),
                           ({'state':'awaiting_approval','session':'s'},0), ({'state':'listen'},0),
                           ({},None), ({'presence':'away','speaking':True},None),
                           ({'presence':'locked','speaking':True},None), ({'presence':'asleep','speaking':True},None),
                           ({'doing':'meeting','speaking':True},None), ({'doing':'sharing','speaking':True},None),
                           ({'presence':'present','doing':'idle','speaking':True},0),
                           ({'giving_way':True,'speaking':True},None)):
            with self.subTest(extra=extra):
                semantic=Semantic();sent=[]
                service=FacingDecisions(semantic,lambda *args:sent.append(args))
                service.apply({'activity':'reading','state':'idle',**extra},allowed=True)
                FacingDecisionTests.settle(self,service)
                self.assertEqual([a[0] for a in sent],[] if yaw is None else [yaw])
                self.assertEqual(semantic.calls,[])

    def test_foreground_defer_wins_then_rules_resume(self):
        semantic=Semantic();sent=[];now=[0]
        service=FacingDecisions(semantic,lambda *args:sent.append(args),clock=lambda:now[0])
        service.defer(60)
        service.apply({'user_speaking':True},allowed=True)
        self.assertEqual(sent,[])
        now[0]=60
        service.apply({'user_speaking':True},allowed=True)
        FacingDecisionTests.settle(self,service)
        self.assertEqual([a[0] for a in sent],[0])
        self.assertEqual(semantic.calls,[])

    def test_hour_of_production_scene_updates_never_calls_models(self):
        import ast
        import tempfile
        import daemon.agentd_server as agentd_server
        import daemon.main as module
        from observation.attention import AttentionStore
        from observation.blacklist import Blacklist
        from support import deny_blacklist
        from observation.activity_decisions import ActivityDecisions
        from character.behavior import Behavior
        from character.interactions import preset

        now=[1792300000.]
        semantic=Mock()
        semantic.run.side_effect=ValueError('unexpected_scene_model')
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as directory:
            attention=AttentionStore(Path(directory)/'attention.sqlite',Blacklist(deny_blacklist(Path(directory)/'blacklist.json')),clock=lambda:now[0])
            self.addCleanup(attention.close)
            with patch.object(agentd_server.ThreadingHTTPServer,'__init__'), patch.object(module.threading.Thread,'start'):
                server=agentd_server.AgentdServer(('127.0.0.1',48810),'hook','ui',attention=attention)
            server.character_agent=SimpleNamespace(semantic=semantic,_permitted=lambda _:True,busy=lambda:False)
            server.activity_decisions=ActivityDecisions(semantic,clock=lambda:now[0])
            server.facing_decisions=FacingDecisions(semantic,Mock(),clock=lambda:now[0])
            server.spatial.capabilities={'face':None}
            server.state_view=None
            server.capture=module.build_capture(server.feed,attention,semantic,directory,True,False)
            server.capture.clock=lambda:now[0]
            server.capture.spawn=None
            decisions=[]
            server.capture.judge.on_decision=lambda _,attrs,key:decisions.append(attrs['backend'])
            tree=ast.parse(Path(module.__file__).read_text(encoding='utf-8'))
            assignment=next(n for n in ast.walk(tree) if isinstance(n,ast.Assign)
                            and any(isinstance(t,ast.Attribute) and isinstance(t.value,ast.Name)
                                    and t.value.id=='server' and t.attr=='behavior' for t in n.targets))
            scope={**vars(module),'server':server,'Behavior':Behavior,
                   'card':{'name':'Test'},'client':object(),'interaction':preset()}
            exec(compile(ast.Module(body=[assignment],type_ignores=[]),module.__file__,'exec'),scope)
            server.behavior.clock=lambda:now[0]
            class Immediate:
                def __init__(self,target,args=(),**kw):self.target,self.args=target,args
                def start(self):self.target(*self.args)
            with patch.object(module.threading,'Thread',Immediate):
                for second in range(0,3600,5):
                    now[0]=1792300000.+second
                    window={'window_id':1+second//60%2,'app':'Synthetic','bundle_id':'test.unknown','title':str(second//120)}
                    attention.ingest({'ts':now[0],'front':window,'mouse':None,'idle_s':1.,'locked':False,'asleep':False})
                    server.capture.text({**window,'text':('unclear '+str(second))*30,'source':'ax'})
                    server.capture.tick()
                    server.activity()
                    server.spatial_situation()
                    server.behavior.poll()
                self.assertEqual(semantic.run.call_args_list,[])
            self.assertTrue(decisions)
            self.assertEqual(set(decisions),{'rules'})


class Semantic:
    def __init__(self,value=None,error=False):
        self.value=value or dict(yaw_degrees=-67,hold_seconds=40,reason='侧身一起核对资料')
        self.calls=[];self.error=error;self.entered=threading.Event();self.release=threading.Event();self.release.set()
    def run(self,purpose,instructions,evidence,**kwargs):
        self.calls.append((purpose,copy.deepcopy(evidence)));self.entered.set();self.release.wait(2)
        if self.error:raise ValueError('semantic_busy')
        kwargs['validate_output'](self.value)
        return dict(value=self.value,run_id='semantic-facing')


class FacingDecisionTests(unittest.TestCase):
    def settle(self,service):
        until=time.monotonic()+3
        while service.running and time.monotonic()<until:time.sleep(.001)
        self.assertFalse(service.running)

    def test_invalid_model_values_are_rejected(self):
        for yaw in (True,181,float('nan'),'180'):
            with self.assertRaises(ValueError):validate(dict(yaw_degrees=yaw,reason='bad',hold_seconds=60))

    def test_tool_descriptions_state_the_30_degree_limit(self):
        from observation.facing_decisions import FACING_STATUS_TOOL, FACING_TOOL
        text=FACING_TOOL['description']
        self.assertNotIn('faces away',text);self.assertNotIn('face away',text)
        self.assertIn('30',text)
        self.assertIn('30',FACING_STATUS_TOOL['description'])


class FacingExecutionRequestTests(unittest.TestCase):
    def setUp(self):
        self.events=[]
        self.context=dict(fullscreen=False,user_speaking=False,speaking=False,voicing=False,line_id=None,
            typing=False,session=None,state='idle',related=[],window_id=7)
        def publish(kind,value):self.events.append(dict(event=kind,seq=len(self.events)+1,**value));return len(self.events)
        self.spatial=Spatial(lambda:self.context,publish,lambda:3,1)
        self.spatial.capabilities={'face':None}
    def test_request_goes_through_c1_without_claiming_execution_and_stale_cannot_emit(self):
        result=self.spatial.request_facing(73,'一起查看文档',42)
        self.assertEqual(result['phase'],'requested');self.assertTrue(result['accepted'])
        behavior=self.events[-1]
        self.assertEqual(behavior['type'],'face');self.assertEqual(behavior['facing_yaw'],73)
        self.assertEqual(c1.check_message(behavior),[])
        self.assertEqual(self.spatial.request_facing(-25,'旧决定',valid=lambda:False)['reason'],'decision_stale')
        self.assertEqual(len(self.events),1)
        self.assertEqual(self.spatial.facing_status()['phase'],'requested')
        for phase in ('prepared','running','completed'):
            self.spatial.receipt({'behavior_id':result['behavior_id'],'phase':phase,'reason':None,
                'turn_generation':3,'at_ms':int(time.time()*1000)})
            self.assertEqual(self.spatial.facing_status()['phase'],phase)
        self.assertEqual(self.spatial.facing_status()['requested_yaw'],73)
        self.spatial.capability_character='another-role'
        self.assertFalse(self.spatial.facing_status()['available'])
    def test_bust_framing_refuses_a_facing_decision(self):
        self.spatial.set_switches({'stay_in_place':True,'sit_window_top':True,'hold_window_edge':True,
                                   'fullscreen_give_way':True,'bust_framing':True})
        self.assertEqual(self.spatial.request_facing(30,'侧身')['reason'],'facing_unavailable')
        self.assertEqual(self.events,[])
    def test_missing_capability_or_occupied_body_refuses_instead_of_cancelling(self):
        self.spatial.capabilities={}
        self.assertFalse(self.spatial.request_facing(180,'陪看')['accepted'])
        self.spatial.capabilities={'face':None}
        self.spatial.active['seat']={'behavior':{'type':'sit','channels':['full_body','contact']}}
        self.assertEqual(self.spatial.request_facing(30,'侧身')['reason'],'body_busy')
        self.assertEqual(self.events,[])
