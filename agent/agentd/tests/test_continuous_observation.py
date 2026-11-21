"""Full-content evidence -> native harness -> task continuity -> report/memory, with revocation."""
import copy
import difflib
import hashlib
import json
from pathlib import Path
import sys
import threading
import math
import time
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import test_character_agent_semantic as fixture
from observation.capture import CaptureManager
from observation.attention import AttentionStore
from observation.blacklist import Blacklist
from support import deny_blacklist  # noqa: E402
from sessions.events import normalize_codex
from character_agent.services.observation import CHANGED_PENDING, FIRST_PENDING, FRAME_KEEP_S, FRESH, IMAGE_KEEP_S, ObservationService, TEXT_KEEP_S, dump
from character_agent.services.worklog_digest import _line
from character_agent.services.observation_briefs import window
from test_character_agent_runtime import FakeSession
from brain.outbound import OutboundGuard, OutboundBlocked


class ObservationTests(unittest.TestCase):
    setUp=fixture.SemanticTests.setUp
    tearDown=fixture.SemanticTests.tearDown
    factory=fixture.SemanticTests.factory

    def ready(self):
        self.server.capture=CaptureManager(self.server.feed,Blacklist(deny_blacklist(self.root/'blacklist.json')),lambda:None,None,share_text=True,vision=object())
        self.server.share_typed_text=True;self.server.share_agent_sessions=True;self.server.share_page_text=False
        self.server.sync_privacy()
        self.o=self.c.observations
        return self.o

    def source(self,text='Compile failed: missing RenderTarget declaration',key='editor',**extra):
        return self.o.ingest('native_ax',text,source_key=key,metadata={'app':'Xcode','bundle_id':'fixture.editor','window_id':7,
            'coverage':{'status':'complete','scope':'window'},**extra})

    def finding(self,ident,quote='Compile failed',key='render-fix',state='blocked'):
        ev=[{'observation_id':ident,'quote':quote}]
        return {'observed_facts':[{'text':'编译报告缺少声明','evidence':ev}],
          'work_events':[{'title':'检查编译结果','summary':'编译失败，尚无测试结果','task_key':key,'state':state,'evidence':ev}],
          'task_updates':[{'task_key':key,'title':'修复渲染编译','objective':'恢复构建','current_step':'检查声明',
             'state':state,'confidence':.9,'unresolved':['测试结果未知'],'next_steps':['核对声明'],'evidence':ev}],
          'uncertainties':['尚无测试证据'],'evidence_requests':[]}

    def test_full_text_tree_paging_and_source_specific_permission(self):
        self.ready();text='start\n'+'正文🙂'*30000+'\nLATE_ERROR: RenderTarget missing'
        ident=self.source(text,nodes=[{'id':n,'value':str(n)} for n in range(250)])
        self.assertIsNotNone(ident);self.assertFalse(self.server.share_page_text)
        chunks=[];offset=0
        while True:
            r=self.o.read(ident,offset,64000);chunks.append(r['text']);offset=r['next_offset']
            if offset is None: break
        self.assertEqual(''.join(chunks),text)
        self.assertIn('LATE_ERROR',self.o.read(ident,query='LATE_ERROR')['text'])
        self.assertEqual(len(json.loads(self.o.read(ident,part='tree')['text'])),250)
        self.assertEqual(self.o.search('LATE_ERROR')['items'][0]['id'],ident)
        self.assertIsNone(self.o.ingest('browser','not authorized'))
        self.assertNotIn('nodes',self.o.context()['current_sources'][0]['metadata'])

    def test_native_transport_pages_join_without_loss_or_partial_promotion(self):
        self.ready();body={'app':'Xcode','bundle_id':'fixture.editor','window_id':7,'pid':1,'source':'ax',
            'snapshot_pages':3,'snapshot_id':'full-one','coverage':{'status':'complete','scope':'window'}}
        parts=['a'*64000,'中文🙂'*24000,'END COMPLETE LOG']
        for i in (2,0,1):
            ident=self.o.ingest_text({**body,'snapshot_page':i,'text':parts[i]})
            if i!=1: self.assertEqual(self.o.latest(),[])
        self.assertEqual(self.o.get(ident)['text'],''.join(parts));self.assertEqual(len(self.o.latest()),1)
        with self.assertRaises(ValueError): self.o.ingest_text({**body,'snapshot_page':4,'text':'bad'})

    def test_content_addressing_exact_dedup_restart_and_changes(self):
        self.ready();a=self.source('first line\nold failure\n');b=self.source('first line\nold failure\n')
        self.assertEqual(a,b)
        c=self.source('first line\nnew success\n')
        delta=self.o.changes(c);self.assertIn('-old failure',delta['text']);self.assertIn('+new success',delta['text'])
        self.assertEqual(delta['previous_id'],a)
        self.assertEqual(self.db.execute('SELECT count(*) FROM observation_content').fetchone()[0],2)
        self.reply=self.finding(c,'new success',state='result_observed');self.o.run_once()
        restarted=ObservationService(self.c)
        self.assertEqual(restarted.run_once()['state'],'cached');self.assertEqual(len(self.sessions),1)
        with self.assertRaises(ValueError):self.o.changes(c,offset=-1)

    def test_primary_harness_receives_full_read_tools_and_grounded_result(self):
        self.ready();ident=self.source('header\n'+'x'*80000+'\nCompile failed: missing RenderTarget declaration')
        value=self.finding(ident)
        def factory(definitions):
            self.assertIn('observation_image',{t['name'] for t in definitions})
            def script(session,prompt,options):
                packet=json.loads(prompt)['evidence'];self.assertFalse(packet['observations'][0]['preview_complete'])
                read=yield from session.use(options,'observation_read',{'observation_id':ident,'query':'Compile failed'})
                self.assertIn('missing RenderTarget',read['text'])
                yield {'type':'result','success':True,'final_text':dump(value),'model':'fixture',
                    'usage':{'input_tokens':100,'output_tokens':20,'cache_read_input_tokens':50}}
            return FakeSession(script)
        self.c.session_factory_override=factory
        result=self.o.run_once();self.assertEqual(result['state'],'completed')
        self.assertEqual(self.o.context()['tasks'][0]['state'],'blocked')
        self.assertEqual(len(self.o.events()),1)
        self.assertEqual(self.db.execute('SELECT purpose,outcome FROM semantic_attempts').fetchall(),[('observation_interpret','succeeded')])
        self.assertIn('observation_read',self.c.memory_journal.get(result['run_id'])['detail']['request'])
        self.assertFalse(self.server.memory.active())
        self.assertEqual(self.o.run_once()['state'],'cached')

    def test_carried_task_without_evidence_still_reads(self):
        self.ready();self.reply=self.finding(self.source());self.o.run_once()
        at,body=self.db.execute('SELECT at,body FROM observation_analyses').fetchone();body=json.loads(body)
        body['task_updates']=[{k:v for k,v in t.items() if k not in ('evidence','next_steps')} for t in body['task_updates']]
        self.db.execute('UPDATE observation_analyses SET body=? WHERE at=?',(json.dumps(body),at));self.db.commit()
        self.o.worker=threading.Thread()  # selects production compatibility adapter, no daemon started
        try:
            self.assertEqual(self.o.task_understanding_context()['hypotheses'][0]['evidence'],[])
            self.assertEqual(self.o._task_context()['hypotheses'][0]['source_refs'],[])
        finally: self.o.worker=None

    def test_task_continuity_new_source_during_analysis_and_corrections(self):
        self.ready();one=self.source();self.reply=self.finding(one)
        newer=[]
        self.during=lambda:newer.append(self.source('Build succeeded; tests not run'))
        self.assertEqual(self.o.run_once()['state'],'completed')
        self.assertEqual(self.o.phase,'catching_up')
        self.during=lambda:None;self.reply=self.finding(newer[0],'Build succeeded',state='result_observed')
        self.o.run_once();self.assertEqual(len(self.o.context()['tasks']),1)
        self.o.worker=threading.Thread()  # selects production compatibility adapter, no daemon started
        task=self.o.task_understanding_context()['hypotheses'][0]
        self.o.correct_task(task['id'],task['revision'],action='correct',text='只在检查构建，不是在跑测试')
        self.assertIn('只在检查',self.o.context()['tasks'][0]['title'])
        task=self.o.task_understanding_context()['hypotheses'][0]
        self.o.correct_task(task['id'],task['revision'],action='reject')
        self.assertEqual(self.o.context()['tasks'],[])
        with self.assertRaises(ValueError):self.o.correct_task(task['id'],task['revision'],action='reject')
        self.o.worker=None

    def test_image_must_be_read_and_never_journaled_as_base64(self):
        self.ready();png=b'\x89PNG\r\n\x1a\n'+b'\x00\x00\x00\rIHDR'+(2560).to_bytes(4,'big')+(1440).to_bytes(4,'big')+b'fake-test-pixels'
        ident=self.o.ingest_image(7,'request-one',png,{'app':'Canvas'})
        result=self.finding(ident);ev=[{'observation_id':ident,'image':True}]
        for section in ('observed_facts','work_events','task_updates'):result[section][0]['evidence']=ev
        with self.assertRaisesRegex(ValueError,'observation_image_not_read'):self.o.validate(result)
        def factory(definitions):
            def script(session,prompt,options):
                image=yield from session.use(options,'observation_image',{'observation_id':ident})
                self.assertEqual(image['content'][0]['type'],'image')
                yield {'type':'result','success':True,'final_text':dump(result),'model':'fixture'}
            return FakeSession(script)
        self.c.session_factory_override=factory
        run=self.o.run_once();detail=self.c.memory_journal.get(run['run_id'])['detail']
        self.assertIn('image_read',str(detail));self.assertNotIn('ZmFrZS10ZXN0LXBpeGVscw',str(detail))
        self.assertEqual(self.o.get(ident)['metadata']['pixel_width'],2560)

    def test_fabrication_bad_states_and_revocation_cannot_commit(self):
        self.ready();ident=self.source();value=self.finding(ident)
        bad=copy.deepcopy(value);bad['task_updates'][0]['state']='deployed'
        with self.assertRaises(ValueError):self.o.validate(bad)
        bad=copy.deepcopy(value);bad['observed_facts'][0]['evidence'][0]['quote']='fabricated quote'
        self.assertEqual(self.o.validate(bad),[])
        self.assertEqual([bad[s] for s in ('observed_facts','work_events','task_updates')],[[],[],[]])
        self.reply=value;self.during=lambda:setattr(self.server.capture,'share_text',False)
        with self.assertRaises(ValueError):self.o.run_once()
        self.assertEqual(self.o.events(),[]);self.assertIsNone(self.o.get(ident))
        self.assertEqual(self.db.execute('SELECT count(*) FROM observation_analyses').fetchone()[0],0)

    def test_each_committed_analysis_reaches_the_listeners_and_a_refused_one_does_not(self):
        self.ready();heard=[]
        self.o.listeners.append(lambda character,body:heard.append((character,body)))
        self.o.listeners.append(lambda character,body:1/0)  # a failing listener never fails the committed analysis
        ident=self.source();self.reply=self.finding(ident)
        self.assertEqual(self.o.run_once()['state'],'completed')
        [(character,body)]=heard
        self.assertEqual(character,self.server.character)
        self.assertEqual([(e['title'],e['state']) for e in body['work_events']],[('检查编译结果','blocked')])
        self.assertEqual(body['task_updates'][0]['state'],'blocked')
        self.assertEqual(self.o.phase,'current')
        self.reply=self.finding(self.source('Compile failed again'));self.during=lambda:setattr(self.server.capture,'share_text',False)
        with self.assertRaises(ValueError):self.o.run_once()
        self.assertEqual(len(heard),1)

    def test_raw_expiry_preserves_grounded_work_events_but_clear_erases_both(self):
        self.ready();captured=time.time()-3600
        ident=self.o.ingest('native_ax','Compile failed: missing RenderTarget declaration',source_key='editor',at=captured,
            metadata={'app':'Xcode','coverage':{'status':'complete','scope':'window'}})
        self.reply=self.finding(ident);self.o.run_once()
        future=captured+FRAME_KEEP_S+1;self.o.clock=lambda:future;self.o.prune()
        self.assertIsNone(self.o.get(ident));events=self.o.events();self.assertEqual(len(events),1)
        self.assertIsNotNone(self.o.get(events[0]['id']))
        self.o.clear()
        self.assertEqual(self.o.events(),[])
        for t in ('observation_content','observation_frames','observation_analyses','observation_work_events'):
            self.assertEqual(self.db.execute('SELECT count(*) FROM '+t).fetchone()[0],0)

    def test_continuous_events_feed_memory_and_daily_weekly_briefs(self):
        self.ready();ident=self.source();self.reply=self.finding(ident);self.o.run_once()
        events=self.o.events();self.assertTrue(events)
        self.assertTrue(any(s['kind']=='authorized_observation' for s in self.pipeline.sources()))
        service=self.c.observation_briefs
        service.clock=lambda:time.time()+8*86400
        date=time.strftime('%Y-%m-%d');sources,coverage=service.sources(*window('daily',date,'America/New_York')[1:],'America/New_York')
        item=next(s for s in sources if s['kind']=='work_event')
        self.reply={'observed_details':[{'detail':'编译失败，测试未知','evidence':[{'source_id':item['source_id'],'quote':'编译失败'}]}],
            'recurring_problems':[],'next_steps':[],'unknowns':['测试结果未知']}
        for period in ('daily','weekly'):
            report=service.run_once(period,date);self.assertEqual(report['state'],'completed');self.assertEqual(report['observed_details'][0]['detail'],'编译失败，测试未知')
        knowledge=self.c.knowledge();self.assertTrue(knowledge.call('knowledge_search',{'sources':['briefs'],'query':'编译失败'})['items'])
        self.assertFalse(self.server.memory.active())
        self.reply={'no_new_knowledge':True,'projects':[],'memories':[]}
        self.pipeline.run_once();self.assertEqual(self.pipeline.sources(),[])
        self.server.consent.epoch+=5
        self.c.observations=self.o=ObservationService(self.c)
        self.o.restore_report_consents()
        self.assertEqual(len(service.list()),2)
        self.assertEqual(self.pipeline.sources(),[])

    def test_read_dependencies_immutable_revision_and_source_deletion(self):
        self.ready();ident=self.source();k=self.c.knowledge()
        k.call('observation_read',{'observation_id':ident});self.assertTrue(k.valid())
        self.source('Build passed');self.assertTrue(k.valid())
        self.o.clear();self.assertFalse(k.valid())

    def test_product_nonrecursive_memory_lock_and_search_cursor(self):
        self.ready();self.server.memory.lock=self.o.lock=threading.Lock()
        for i in range(35): self.source('Compile failed '+str(i),key='window-'+str(i))
        rows=[];cursor=None
        while True:
            result=self.o.search('Compile failed',limit=10,cursor=cursor,kind='raw')
            rows.extend(r['id'] for r in result['items']);cursor=result['next_cursor']
            if not cursor: break
        self.assertEqual(len(set(rows)),35)
        with self.assertRaises(ValueError):self.o.search(cursor='not-a-cursor')
        self.reply=self.finding(rows[0]);self.assertEqual(self.o.run_once()['state'],'completed')

    def test_search_crosses_revoked_batches_and_paginates_title_matches_at_equal_times(self):
        self.ready()
        now = time.time()
        title = 'Paper Prototype'
        raw = [
            self.o.ingest('native_ax', 'editor notes', source_key=f'authorized-{i}',
                          metadata={'title': title}, at=now-10)
            for i in range(2)
        ]
        revoked = [
            self.o.ingest('native_ax', 'inaccessible material', source_key=f'revoked-{i}',
                          metadata={'title': title}, at=now-5)
            for i in range(70)
        ]
        self.assertNotIn(None, raw + revoked)
        epoch = self.server.consent.snapshot()[1]
        valid_dep = self.o.dependency(self.o.get(raw[0]))
        invalid_dep = self.o.dependency(self.o.get(revoked[0]))
        with self.db:
            self.db.executemany('UPDATE observation_frames SET consent_epoch=? WHERE id=?',
                                [(epoch-1, ident) for ident in revoked])
            self.db.executemany('INSERT INTO observation_work_events VALUES(?,?,?,?,?,?,?)', [
                ('work-valid', self.server.character, now-10, title, dump({'title': title}),
                 dump([valid_dep]), 'analysis'),
                ('work-revoked', self.server.character, now-1, title, dump({'title': title}),
                 dump([invalid_dep]), 'analysis'),
            ])
        expected = sorted([*raw, 'work-valid'], reverse=True)
        cursor = None
        for index, ident in enumerate(expected):
            page = self.o.search('paper prototype', limit=1, cursor=cursor)
            self.assertEqual([row['id'] for row in page['items']], [ident])
            self.assertEqual(page['items'][0]['metadata']['title'], title)
            cursor = page['next_cursor']
            self.assertEqual(bool(cursor), index < len(expected)-1)
        self.assertEqual([row['id'] for row in self.o.search(title, limit=2, kind='raw')['items']],
                         sorted(raw, reverse=True))

    def test_backlog_drains_newest_first_within_the_freshness_window(self):
        self.ready();now=time.time()
        fresh=[self.o.ingest('native_ax','Compile failed '+str(i),source_key='editor-'+str(i),at=now-3600+i*60) for i in range(25)]
        stale=[self.o.ingest('native_ax','Compile failed old '+str(i),source_key='old-'+str(i),at=now-FRESH-60) for i in range(5)]
        self.assertEqual(self.o.backlog_count(),25)
        batches=[]
        def factory(definitions):
            def script(session,prompt,options):
                rows=json.loads(prompt)['evidence']['observations'];batches.append([r['id'] for r in rows])
                value=self.finding(rows[0]['id'])
                yield {'type':'result','success':True,'final_text':dump(value),'model':'fixture'}
            return FakeSession(script)
        self.c.session_factory_override=factory
        with patch('character_agent.services.observation.BATCH_SOURCES',10):
            for _ in range(4): self.o.run_once()
        self.assertEqual(set(batches[0]),set(fresh[-10:]))
        self.assertEqual({i for b in batches for i in b},set(fresh));self.assertEqual(self.o.backlog_count(),0)
        self.assertFalse(set(stale)&{r[0] for r in self.db.execute('SELECT id FROM observation_processed')})

    def test_newer_frames_are_interpreted_first_and_stale_frames_never(self):
        self.ready();now=time.time()
        stale=[self.o.ingest('native_ax','Compile failed old '+str(i),source_key='old-'+str(i),at=now-3*3600) for i in range(3)]
        fresh=[self.o.ingest('native_ax','Compile failed new '+str(i),source_key='new-'+str(i),at=now-600) for i in range(3)]
        self.assertEqual({r['id'] for r in self.o.pending(3)},set(fresh))
        metrics=self.o.queue_metrics()
        self.assertEqual(self.o.backlog_count(),3);self.assertEqual(metrics['by_origin'],{'native_ax':3})
        self.assertEqual(metrics['all_characters'],{self.o.character:3})
        self.assertLessEqual(metrics['oldest_pending_age_seconds'],600+60)
        self.reply=self.finding(fresh[0],'Compile failed')
        with patch('character_agent.services.observation.BATCH_SOURCES',3):
            self.assertEqual(self.o.run_once()['state'],'completed')
            self.assertEqual(self.o.backlog_count(),0)
            self.o.run_once()
        processed={r[0] for r in self.db.execute('SELECT id FROM observation_processed')}
        self.assertEqual(processed,set(fresh))
        for i in range(70): self.o.ingest('native_ax','Compile failed later '+str(i),source_key='later-'+str(i),at=now-3*3600)
        self.assertGreater(self.o.interval(),60)

    def test_input_value_keeps_complete_body(self):
        self.ready();value='START '+ 'x'*5000+' END'
        self.o.ingest_inputs([{'ts':time.time(),'kind':'value','app':'Editor','bundle_id':'fixture','value':value}])
        self.assertEqual(self.o.latest()[0]['text'],value)

    def test_recent_event_replay_is_idempotent_and_repeat_user_actions_survive(self):
        self.ready();now=time.time()
        events=[{'id':i,'ts':now+i*.001,'kind':'value','app':'Editor','value':'same text','role':'AXTextArea'} for i in range(25)]
        with patch.object(self.o,'ingest',wraps=self.o.ingest) as ingest:
            for _ in range(20): self.o.ingest_inputs(events)
        self.assertEqual(ingest.call_count,25)  # no repeated source sanitization
        self.assertEqual(self.o.backlog_count(),25)
        self.assertEqual(self.db.execute('SELECT count(*) FROM observation_frames').fetchone()[0],25)
        # An upstream identity reused with different actual content is not a hit.
        self.o.ingest_inputs([{**events[0],'value':'real changed content'}])
        self.assertEqual(self.o.backlog_count(),26)
        restarted=ObservationService(self.c);restarted.ingest_inputs(events)
        self.assertEqual(restarted.backlog_count(),26)

    def test_upgrade_aliases_exact_old_replays_without_deleting_evidence(self):
        self.ready();event={'id':4,'ts':time.time(),'kind':'value','app':'Editor','value':'Compile failed'}
        self.o.ingest_inputs([event]);first=self.o.latest()[0]['id']
        # Reproduce old releases' A,B,A replay rows, including a processed copy.
        duplicate='obs-'+'b'*32
        self.db.execute('INSERT INTO observation_frames SELECT ?,character_id,at,origin,source_key,revision,consent_epoch,requires,metadata,content_hash,previous_id FROM observation_frames WHERE id=?',(duplicate,first))
        self.db.execute('INSERT INTO observation_processed VALUES(?,?,?)',(duplicate,'old-analysis',time.time()))
        self.db.execute('DELETE FROM observation_input_identity');self.db.commit()
        restarted=ObservationService(self.c)
        self.assertEqual(restarted.backlog_count(),0)
        self.assertEqual(restarted.get(first)['text'],restarted.get(duplicate)['text'])
        self.assertEqual(self.db.execute('SELECT count(*) FROM observation_frames').fetchone()[0],2)
        self.assertEqual(self.db.execute('SELECT count(*) FROM observation_processed').fetchone()[0],2)
        restarted.clear();self.assertEqual(self.db.execute('SELECT count(*) FROM observation_input_identity').fetchone()[0],0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM observation_aliases').fetchone()[0],0)

    def test_input_batch_uses_budget_and_full_short_events_instead_of_eight_slots(self):
        self.ready();now=time.time()
        for i in range(100): self.o.ingest_inputs([{'id':i,'ts':now,'kind':'agent','app':'Editor','value':f'Compile failed at step {i}'}])
        rows,packet=self.o._evidence()
        self.assertEqual(len(rows),100)
        self.assertLessEqual(packet['batch']['serialized_source_chars'],64000)
        self.assertTrue(all(view['preview_complete'] for view in packet['observations']))
        self.assertEqual({view['text'] for view in packet['observations']},{f'Compile failed at step {i}' for i in range(100)})

    def test_batch_shares_body_but_retains_each_control_change_and_original_tree(self):
        self.ready();text='Compile failed '+ 'x'*10000
        ids=[self.source(text,key='editor-'+str(i),nodes=[{'id':0,'role':'AXStaticText','value':f'Working for {i}s','bounds':[i,1,2,3]}]) for i in range(30)]
        rows,packet=self.o._evidence();views={v['id']:v for v in packet['observations']}
        self.assertEqual(len(rows),30)
        self.assertTrue(any('body_ref' in v for v in views.values()))
        for i,ident in enumerate(ids):
            self.assertIn(f'Working for {i}s',self.o.read(ident,part='tree')['text'])
        self.assertEqual(self.o.read(ids[0],offset=8000)['text'],text[8000:])
        changed=self.source(text+' done',key='editor-0',nodes=[{'id':0,'role':'AXStaticText','value':'Finished','bounds':[0,1,2,3]}])
        self.assertIn('Finished',self.o._view(self.o.get(changed),maximum=16000,seen=set(),bodies={})['node_changes']['text'])

    def test_layout_only_recapture_keeps_one_frame_with_the_latest_layout(self):
        self.ready()
        first=self.source('Body text',nodes=[{'role':'AXStaticText','value':'Working for 1s','bounds':[1,1,2,3]}],
            coverage={'status':'complete','scope':'window','nodes':1})
        second=self.source('Body text',nodes=[{'role':'AXStaticText','value':'Working for 2s','bounds':[2,1,2,3]}],
            coverage={'status':'complete','scope':'window','nodes':2})
        self.assertEqual(second,first)
        self.assertEqual(self.db.execute('SELECT count(*) FROM observation_frames').fetchone()[0],1)
        metadata=self.o.get(first)['metadata']
        self.assertEqual(metadata['nodes'][0]['value'],'Working for 2s');self.assertEqual(metadata['coverage']['nodes'],2)
        third=self.source('Body text changed',nodes=[{'role':'AXStaticText','value':'Working for 2s','bounds':[2,1,2,3]}])
        self.assertNotEqual(third,first)
        self.assertEqual(self.db.execute('SELECT count(*) FROM observation_frames').fetchone()[0],2)

    def test_pending_frames_past_fresh_are_marked_expired_and_counted(self):
        self.ready();now=time.time()
        stale=[self.o.ingest('native_ax','old '+str(i),source_key='old-'+str(i),at=now-FRESH-60) for i in range(3)]
        self.o.ingest('native_ax','new',source_key='new',at=now-60)
        self.o.expire()
        self.assertEqual(dict(self.db.execute('SELECT id,analysis_id FROM observation_processed')),dict.fromkeys(stale,'expired:fresh'))
        self.assertEqual(self.o.queue_metrics()['expired_fresh'],3)
        self.assertEqual(self.o.backlog_count(),1)
        # An unchanged recapture brings the expired frame back into the queue.
        self.assertEqual(self.o.ingest('native_ax','old 0',source_key='old-0'),stale[0])
        self.assertEqual(self.o.backlog_count(),2);self.assertEqual(self.o.queue_metrics()['expired_fresh'],2)

    def test_free_pages_are_reclaimed_once_while_away_on_a_large_mostly_free_file(self):
        from character_agent.services import observation
        from infra.store import compact
        self.ready()
        def free():
            return self.db.execute('PRAGMA freelist_count').fetchone()[0]/self.db.execute('PRAGMA page_count').fetchone()[0]
        def fill(delete=True):
            self.db.execute('CREATE TABLE IF NOT EXISTS filler(b BLOB)')
            self.db.executemany('INSERT INTO filler VALUES(?)',[(b'\1'*4096,) for _ in range(600)]);self.db.commit()
            self.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            if delete: self.db.execute('DELETE FROM filler');self.db.commit()
        away=lambda:{'activity':'away','mode':'away','confidence':1}
        with patch.object(observation,'RECLAIM_BYTES',1<<20),patch.object(observation,'RECLAIMED',threading.Event()), \
                patch('character_agent.services.observation.compact',wraps=compact) as vacuum:
            fill(delete=False);self.server.activity=away
            self.assertLess(free(),.5);self.o.reclaim()
            self.db.execute('DELETE FROM filler');self.db.commit();self.assertGreater(free(),.5)
            self.server.activity=lambda:{'activity':'editing_code','mode':'coding','confidence':.9}
            self.o.reclaim()
            self.server.activity=away
            with patch.object(observation,'RECLAIM_BYTES',1<<40):self.o.reclaim()
            self.assertEqual(vacuum.call_count,0)
            self.o.reclaim()
            self.assertEqual(vacuum.call_count,1);self.assertLess(free(),.5)
            fill();self.assertGreater(free(),.5);self.o.reclaim()
            self.assertEqual(vacuum.call_count,1)

    def test_late_history_does_not_revert_a_newer_task_result(self):
        self.ready();now=time.time()
        old=self.o.ingest('native_ax','Compile failed',source_key='log',at=now-60)
        new=self.o.ingest('native_ax','Build succeeded',source_key='log',at=now)
        self.reply=self.finding(new,'Build succeeded',state='result_observed');self.o.run_once()
        self.source('another event',key='other')
        self.reply=self.finding(old,'Compile failed',state='blocked');self.o.run_once()
        task=self.o.context()['tasks'][0]
        self.assertEqual(task['state'],'result_observed');self.assertEqual(task['last_observed_at'],now)
        self.assertTrue(any(e['state']=='blocked' for e in self.o.events()))

    def test_unselected_large_sources_remain_pending_and_images_fit_tool_budget(self):
        self.ready()
        for i in range(50): self.source(('Compile failed '+str(i)+'\n')*3000,key=str(i))
        rows,packet=self.o._evidence();self.assertGreater(len(rows),1);self.assertLess(len(rows),50)
        self.assertLessEqual(packet['batch']['serialized_source_chars'],64000)
        self.assertEqual(self.o.backlog_count(),50)
        self.o.clear()
        for i in range(20): self.o.ingest('screen_keyframe',image=b'png'+bytes([i]),source_key=str(i))
        rows,packet=self.o._evidence();self.assertLessEqual(sum(r['origin']=='screen_keyframe' for r in rows),8)
        self.assertEqual(self.o.backlog_count(),20)

    def test_received_hook_body_is_full_and_privacy_gated_not_legacy_preview(self):
        self.ready();attention=self.server.attention=AttentionStore(self.root/'attention.sqlite',Blacklist(deny_blacklist(self.root/'blacklist.json')))
        body={'session_id':'live-test','cwd':str(self.root),'tool_name':'exec_command',
            'tool_input':{'command':'echo '+ 'x'*20000+' COMPLETE_COMMAND_END'},
            'tool_response':'original output '+ 'z'*20000+' BUILD SUCCEEDED END_OF_RESULT'}
        try:
            event=normalize_codex({**body,'hook_event_name':'PostToolUse'})
            self.server.record_agent_event(event,body)
            sources=self.o.latest()
            self.assertEqual(len(sources),1)
            original=json.loads(sources[0]['text'])
            self.assertEqual(original['tool_input'],body['tool_input'])
            response=body['tool_response']
            self.assertEqual(original['tool_response'],response[:2048]+f'…[truncated {len(response)-4096} chars]…'+response[-2048:])
            self.o.ingest_inputs(attention.recent_events(time.time()-600))
            self.assertEqual(self.o.backlog_count(),1)  # timeline prefix and full hook are one action
            previews=[r for r in self.o.latest() if r['metadata']['kind']=='agent']
            self.assertEqual(self.o.evidence_unit(previews[0]['id']),sources[0]['id'])
            self.assertTrue(self.o.read(previews[0]['id'])['text'].startswith('echo '))
            self.db.execute('DELETE FROM observation_aliases');self.db.commit()
            restarted=ObservationService(self.c)
            self.assertEqual(restarted.evidence_unit(previews[0]['id']),sources[0]['id'])
            self.assertEqual(restarted.backlog_count(),1)
            attention._secure=True
            self.server.record_agent_event(normalize_codex({**body,'hook_event_name':'PostToolUse','session_id':'secure'}),body)
            self.assertEqual(len(self.o.latest()),2)
            attention._secure=False
            self.server.share_agent_sessions=False;self.server.sync_privacy()
            self.assertIsNone(self.o.ingest_hook(event,body,typed_generation=attention.typed_generation))
        finally: attention.db.close();self.server.attention=None

    def test_agent_sessions_keeps_tools_without_typed_text_but_not_human_prompts(self):
        self.ready();attention=self.server.attention=AttentionStore(self.root/'attention.sqlite',Blacklist(deny_blacklist(self.root/'blacklist.json')))
        self.server.share_agent_sessions=True;self.server.share_typed_text=False;self.server.sync_privacy()
        body={'session_id':'consented-tools','tool_name':'exec_command',
              'tool_input':{'command':'echo Compile failed'},'tool_output':'Compile failed: missing declaration'}
        try:
            event=normalize_codex({**body,'hook_event_name':'PostToolUse'})
            ident=self.o.ingest_hook(event,body,typed_generation=attention.typed_generation)
            self.assertIsNotNone(ident)
            self.assertEqual(json.loads(self.o.get(ident)['text']),
                             {k:body[k] for k in ('tool_input','tool_output')})
            self.assertEqual(self.o.get(ident)['requires'],['agent_sessions'])
            prompt={'session_id':'human-prompt','prompt':'Please fix the compile error'}
            event=normalize_codex({**prompt,'hook_event_name':'UserPromptSubmit'})
            for origin in ('human','unknown'):
                self.assertIsNone(self.o.ingest_hook(event,prompt,origin=origin,typed_generation=attention.typed_generation))
            self.server.share_typed_text=True;self.server.sync_privacy()
            ident=self.o.ingest_hook(event,prompt,origin='human',typed_generation=attention.typed_generation)
            self.assertIsNotNone(ident)
            self.assertEqual(set(self.o.get(ident)['requires']),{'agent_sessions','typed_text'})
        finally: attention.db.close();self.server.attention=None

    def test_agent_sessions_off_keeps_no_live_hook_content_even_with_typed_text(self):
        self.ready();attention=self.server.attention=AttentionStore(self.root/'attention.sqlite',Blacklist(deny_blacklist(self.root/'blacklist.json')))
        self.server.share_agent_sessions=False;self.server.sync_privacy()
        bodies=[('PostToolUse',{'tool_input':{'command':'echo private'},'tool_output':'private output'}),
                ('Stop',{'result':'private result','last_assistant_message':'private answer'}),
                ('UserPromptSubmit',{'prompt':'private prompt'})]
        try:
            for kind,content in bodies:
                body={'session_id':kind,**content}
                event=normalize_codex({**body,'hook_event_name':kind})
                self.assertIsNone(self.o.ingest_hook(event,body,origin='human',typed_generation=attention.typed_generation))
                self.server.record_agent_event(event,body)
            self.o.ingest_inputs(attention.recent_events(time.time()-600))
            self.assertEqual(self.db.execute('SELECT count(*) FROM observation_frames').fetchone()[0],0)
        finally: attention.db.close();self.server.attention=None

    def test_revoking_agent_sessions_deletes_live_frames_and_derived_summaries(self):
        self.ready();attention=self.server.attention=AttentionStore(self.root/'attention.sqlite',Blacklist(deny_blacklist(self.root/'blacklist.json')))
        config=self.root/'privacy.json';self.server.privacy_config=config
        self.server.share_agent_sessions=True
        config.write_text(dump({'share_typed_text':True,'share_agent_sessions':True}), encoding='utf-8')
        self.server.sync_privacy()
        body={'session_id':'revoke-tools','tool_input':{'command':'echo Compile failed'},'tool_output':'Compile failed'}
        try:
            event=normalize_codex({**body,'hook_event_name':'PostToolUse'})
            ident=self.o.ingest_hook(event,body,typed_generation=attention.typed_generation)
            self.assertIsNotNone(ident)
            self.reply=self.finding(ident);self.assertEqual(self.o.run_once()['state'],'completed')
            self.assertEqual(self.db.execute('SELECT count(*) FROM observation_analyses').fetchone()[0],1)
            self.assertTrue(self.o.events())
            config.write_text(dump({'share_typed_text':True,'share_agent_sessions':False}), encoding='utf-8')
            self.server.sync_privacy()
            for table in ('observation_frames','observation_content','observation_analyses','observation_work_events'):
                self.assertEqual(self.db.execute('SELECT count(*) FROM '+table).fetchone()[0],0,table)
            self.assertIsNone(self.o.ingest_hook(event,body,typed_generation=attention.typed_generation))
        finally: attention.db.close();self.server.attention=None

    def test_restart_skips_hook_body_that_is_not_json(self):
        self.ready();attention=self.server.attention=AttentionStore(self.root/'attention.sqlite',Blacklist(deny_blacklist(self.root/'blacklist.json')))
        body={'session_id':'live-test','cwd':str(self.root),'tool_name':'exec_command',
            'tool_input':{'command':'echo done'},'tool_response':'ok'}
        try:
            self.server.record_agent_event(normalize_codex({**body,'hook_event_name':'PostToolUse'}),body)
            self.o.ingest_inputs(attention.recent_events(time.time()-600))
            source=next(r for r in self.o.latest() if r['metadata']['kind']!='agent')
            self.db.execute('DELETE FROM observation_aliases')
            self.db.execute('UPDATE observation_content SET text=? WHERE hash=(SELECT content_hash FROM observation_frames WHERE id=?)',('{"x": "bad \\q escape"}',source['id']))
            self.db.commit()
            restarted=ObservationService(self.c)
            self.assertEqual(self.db.execute('SELECT count(*) FROM observation_aliases').fetchone()[0],0)
            self.assertEqual(restarted.backlog_count(),2)
        finally: attention.db.close();self.server.attention=None

    def test_historical_invalid_hook_json_does_not_block_start_or_remove_evidence(self):
        self.ready();attention=self.server.attention=AttentionStore(self.root/'attention.sqlite',Blacklist(deny_blacklist(self.root/'blacklist.json')))
        body={'session_id':'legacy-invalid','cwd':str(self.root),'tool_name':'exec_command',
              'tool_input':{'command':'echo retained'},'tool_response':'line\nalice@example.com\nEND'}
        try:
            self.server.record_agent_event(normalize_codex({**body,'hook_event_name':'PostToolUse'}),body)
            full=self.o.latest()[0]
            self.assertEqual(json.loads(full['text'])['tool_response'],'line\n[已遮蔽:邮箱]\nEND')
            self.o.ingest_inputs(attention.recent_events(time.time()-600))
            preview=next(r for r in self.o.latest() if r['metadata']['kind']=='agent')
            legacy='{"tool_response":"retained\\[已遮蔽:邮箱] END"}'
            self.db.execute('UPDATE observation_content SET text=? WHERE hash=?',(legacy,full['content_hash']))
            self.db.execute('DELETE FROM observation_aliases');self.db.commit()
            restarted=ObservationService(self.c)
            self.assertEqual(restarted.get(full['id'])['text'],legacy)
            self.assertEqual(restarted.get(preview['id'])['text'],preview['text'])
            self.assertEqual(restarted.backlog_count(),2)
            self.assertEqual(restarted.evidence_unit(preview['id']),preview['id'])
        finally:attention.db.close();self.server.attention=None

    def test_switched_away_queue_finishes_in_its_own_role_without_mutating_selection(self):
        self.ready();old_character=self.server.character;old=self.source()
        self.server.character='birch';active=self.source('new role content',key='active')
        scope=self.o.next_scope(2)
        self.assertEqual(scope.character,old_character)
        self.assertEqual(self.o.next_scope(0),self.o)
        def factory(definitions):
            def script(session,prompt,options):
                read=yield from session.use(options,'observation_read',{'observation_id':old})
                self.assertIn('Compile failed',read['text'])
                hidden=yield from session.use(options,'observation_read',{'observation_id':active})
                self.assertEqual(hidden['error']['code'],'source_unavailable')
                yield {'type':'result','success':True,'final_text':dump(self.finding(old)),'model':'fixture'}
            return FakeSession(script)
        self.c.session_factory_override=factory
        result=scope.run_once();self.assertEqual(result['state'],'completed')
        self.assertEqual(self.server.character,'birch')
        self.assertEqual(scope.backlog_count(),0);self.assertEqual(self.o.backlog_count(),1)
        self.assertEqual(len(scope.context()['tasks']),1);self.assertEqual(self.o.context()['tasks'],[])
        self.assertEqual(self.c.store.get(result['run_id'])['character_id'],old_character)
        self.assertEqual(scope.refresh()['reason'],'inactive_character_capture')
        self.o.clear();self.assertEqual(scope.context()['tasks'],[])

    def test_character_switch_during_packet_build_never_egresses_mixed_roles(self):
        self.ready();self.source();build=self.o._evidence
        def racing_build():
            rows,packet=build();self.server.character='birch';return rows,packet
        with patch.object(self.o,'_evidence',racing_build):
            with self.assertRaisesRegex(ValueError,'observation_source_changed'):self.o.run_once()
        self.assertEqual(self.sessions,[])

    def test_control_only_finding_has_explicit_full_tree_evidence(self):
        self.ready();ident=self.source('Body unchanged',nodes=[{'role':'AXStaticText','value':'Control-only failure: missing RenderTarget'}])
        value=self.finding(ident,'Control-only failure')
        self.o.validate(value)
        self.assertEqual([value[s] for s in ('observed_facts','work_events','task_updates')],[[],[],[]])
        value=self.finding(ident,'Control-only failure')
        for section in ('observed_facts','task_updates','work_events'):
            for item in value[section]:
                for evidence in item['evidence']:evidence['part']='tree'
        self.reply=value;self.assertEqual(self.o.run_once()['state'],'completed')
        self.assertEqual(self.o.context()['tasks'][0]['evidence'][0]['part'],'tree')

    def test_scheduler_batches_cosmetic_changes_and_a_backlog_waits_like_one_change(self):
        self.ready();ident=self.source();self.reply=self.finding(ident);self.o.run_once()
        self.source(nodes=[{'role':'AXStaticText','value':'Working for 2s'}])
        self.assertEqual(self.o.interval(),600)
        self.source(self.BUILT)
        self.assertEqual(self.o.interval(),60)
        self.o.clock=lambda:time.time()+91
        self.assertEqual(self.o.interval(),60)
        self.o.clock=time.time;self.o.clear()
        for i in range(65):self.source('Compile failed '+str(i),key=str(i))
        self.assertEqual(self.o.interval(),60)

    def test_scheduler_ignores_hook_frames_and_waits_while_the_user_is_away(self):
        self.ready();ident=self.source();self.reply=self.finding(ident);self.o.run_once()
        for i in range(70):
            self.o.ingest('input_event',dump({'tool_response':'ok '+str(i)}),source_key='hook'+str(i),
                metadata={'kind':'live_hook','app':'claude','label':'s1'})
        self.assertEqual(self.o.interval(),600)
        self.source(self.BUILT)
        self.assertEqual(self.o.interval(),60)
        self.server.activity=lambda:{'activity':'away','mode':'away','confidence':1}
        self.assertEqual(self.o.interval(),math.inf)
        self.server.activity=lambda:{'activity':'editing_code','mode':'coding','confidence':.9}
        self.assertEqual(self.o.interval(),60)

    def test_a_batch_takes_each_sources_newest_frame_and_marks_its_older_ones_with_it(self):
        self.ready();now=time.time()
        same=[self.o.ingest('native_ax','Compile failed step '+str(i),source_key='editor',at=now-50+i) for i in range(5)]
        other=self.o.ingest('native_ax','Compile failed elsewhere',source_key='terminal',at=now-10)
        batches=[]
        def factory(definitions):
            def script(session,prompt,options):
                batches.append(sorted(v['id'] for v in json.loads(prompt)['evidence']['observations']))
                yield {'type':'result','success':True,'final_text':dump(self.reply),'model':'fixture'}
            return FakeSession(script)
        self.c.session_factory_override=factory
        self.reply={'observed_facts':'not a list'}
        with self.assertRaises(ValueError):self.o.run_once()
        self.assertEqual(batches[-1],sorted([same[-1],other]))
        self.assertEqual(self.o.backlog_count(),6)
        self.assertEqual(self.db.execute('SELECT count(*) FROM observation_processed').fetchone()[0],0)
        self.reply=self.finding(same[-1],'Compile failed step 4')
        result=self.o.run_once();self.assertEqual(result['state'],'completed')
        self.assertEqual(batches[-1],sorted([same[-1],other]))
        self.assertEqual(dict(self.db.execute('SELECT id,analysis_id FROM observation_processed')),dict.fromkeys([*same,other],result['analysis_id']))
        self.assertEqual(self.o.backlog_count(),0)

    def test_batch_changes_are_relative_to_the_sources_last_interpreted_frame(self):
        self.ready();now=time.time();body='Compile log\n'+'line\n'*4000
        seen=self.o.ingest('native_ax',body+'step 0\n',source_key='editor',at=now-30)
        self.reply=self.finding(seen,'Compile log');self.o.run_once()
        self.o.ingest('native_ax',body+'step 1\n',source_key='editor',at=now-20)
        newest=self.o.ingest('native_ax',body+'step 2\n',source_key='editor',at=now-10)
        rows,packet=self.o._evidence()
        self.assertEqual([r['id'] for r in rows],[newest])
        changes=packet['observations'][0]['changes']
        self.assertEqual(changes['previous_id'],seen)
        self.assertIn('-step 0',changes['text']);self.assertIn('+step 2',changes['text']);self.assertNotIn('step 1',changes['text'])

    def test_scheduler_waits_for_captures_to_settle_and_a_minute_between_runs(self):
        self.ready();now=time.time();self.o.clock=lambda:now
        due=lambda:self.o.clock()-self.o.last_attempt>=self.o.interval()
        self.source();self.o.last_attempt=now-600
        self.o.clock=lambda:now+10;self.assertFalse(due())
        self.o.clock=lambda:now+16;self.assertTrue(due())
        self.o.last_attempt=now-30;self.assertFalse(due())
        self.o.clock=lambda:now+30;self.assertTrue(due())
        # A large backlog no longer shortens the wait: the newest frame must still settle.
        self.o.last_attempt=now-600
        for i in range(100):self.source('Compile failed '+str(i),key='window-'+str(i))
        self.assertNotEqual(self.o.interval(),60)
        self.assertFalse(due())
        self.o.clock=lambda:now+46;self.assertTrue(due())
        # Back from away, the first run follows the same rule.
        self.server.activity=lambda:{'activity':'away','mode':'away','confidence':1}
        self.assertEqual(self.o.interval(),math.inf)
        self.server.activity=lambda:{'activity':'editing_code','mode':'coding','confidence':.9}
        self.assertTrue(due())
        self.source('Back at the desk',key='window-0');self.assertFalse(due())

    def test_a_window_that_never_settles_is_read_two_minutes_after_its_text_arrived(self):
        self.ready();now=time.time();self.o.clock=lambda:now;self.o.last_attempt=now-600
        due=lambda:self.o.clock()-self.o.last_attempt>=self.o.interval()
        self.source('Working for 1s',key='terminal')
        for second in range(5,125,5):  # new text every 5 s, never 15 s of quiet
            self.o.clock=lambda second=second:now+second
            self.source('Working for '+str(second)+'s',key='terminal')
            if second<120: self.assertFalse(due(),second)
        self.assertTrue(due())

    def test_a_quote_that_is_not_verbatim_drops_only_its_item(self):
        self.ready();ident=self.source()
        value=self.finding(ident)
        value['observed_facts'].append({'text':'编造的事实','evidence':[{'observation_id':ident,'quote':'not in the source text'}]})
        self.o.validate(value)
        self.assertEqual([f['text'] for f in value['observed_facts']],['编译报告缺少声明'])
        self.assertEqual(len(value['work_events']),1)

    def test_scheduler_change_check_reads_processed_frames_from_indexes_only(self):
        self.ready();now=time.time();metadata=dump({'app':'Xcode','blob':'x'*200000})
        for i in range(20):
            self.db.execute('INSERT INTO observation_frames VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                ('big-'+str(i),self.o.character,now-100+i,'native_ax','editor','r'+str(i),0,'[]',metadata,'h'+str(i%3),None))
            if i<19: self.db.execute('INSERT INTO observation_processed VALUES(?,?,?)',('big-'+str(i),'a',now))
        plan=[row[3] for row in self.db.execute('EXPLAIN QUERY PLAN '+CHANGED_PENDING,(self.o.character,))]
        self.assertTrue(any('SEARCH old USING COVERING INDEX observation_frame_latest_hash' in line for line in plan),plan)
        self.assertEqual([line for line in plan if line.startswith(('SEARCH f ','SCAN f ')) and 'COVERING' not in line and '(id=?)' not in line],[])

    def test_task_read_stays_valid_across_new_frames_but_not_real_corrections(self):
        self.ready();ident=self.source();self.reply=self.finding(ident);self.o.run_once()
        knowledge=self.c.knowledge();self.assertTrue(knowledge.call('task_context',{})['items'])
        self.source('Fresh frame with another log line')
        self.assertTrue(knowledge.valid())
        task=self.o.context()['tasks'][0]
        self.o.correct_task(task['id'],task['revision'],action='correct',text='只在核对错误日志')
        self.assertFalse(knowledge.valid())
        # only the model reads the step, so it is English whatever the reply language
        self.assertEqual(self.o.context()['tasks'][0]['current_step'],'the user corrected this task')

    def test_observed_evidence_keeps_original_text_and_redaction_without_disabling_persona_guard(self):
        self.ready();line='甲乙丙丁戊己庚';path=self.root/'windows.json'
        path.write_text(json.dumps({'n':7,'hashes':[hashlib.sha256(line.encode()).hexdigest()[:16]]}), encoding='utf-8')
        self.server.egress=fixture.EgressPolicy(guard=OutboundGuard(path))
        ident=self.source(line+' alice@example.com')
        self.assertIn(line,self.o.get(ident)['text']);self.assertNotIn('alice@example.com',self.o.get(ident)['text'])
        def factory(definitions):
            def script(session,prompt,options):
                self.assertIn(line,prompt)
                read=yield from session.use(options,'observation_read',{'observation_id':ident})
                self.assertIn(line,read['text'])
                yield {'type':'result','success':True,'final_text':dump(self.finding(ident,line)),'model':'fixture'}
            return FakeSession(script)
        self.c.session_factory_override=factory
        self.assertEqual(self.o.run_once()['state'],'completed')
        with self.assertRaises(OutboundBlocked):self.server.egress.authored('system',line)
        with self.assertRaises(OutboundBlocked):self.server.egress.replayed('test',line)

    def test_all_selected_sources_reach_harness_beyond_generic_hundred_item_limit(self):
        self.ready();now=time.time()
        self.o.ingest_inputs([{'id':i,'ts':now,'kind':'value','app':'E','value':f'Compile failed {i}'} for i in range(150)])
        def factory(definitions):
            def script(session,prompt,options):
                rows=json.loads(prompt)['evidence']['observations'];self.assertEqual(len(rows),128)
                yield {'type':'result','success':True,'final_text':dump(self.finding(rows[0]['id'])),'model':'fixture'}
            return FakeSession(script)
        self.c.session_factory_override=factory;self.o.run_once()
        self.assertEqual(self.o.backlog_count(),22)

    def test_tool_callback_exception_fails_promptly_with_pending_evidence(self):
        self.ready();ident=self.source();knowledge=self.c.knowledge();call=knowledge.call
        def broken(name,args):
            if name=='observation_read':raise RuntimeError('private diagnostic')
            return call(name,args)
        knowledge.call=broken
        def factory(definitions):
            def script(session,prompt,options):
                yield from session.use(options,'observation_read',{'observation_id':ident})
                self.fail('callback failure must abort before another model turn')
            return FakeSession(script)
        self.c.session_factory_override=factory
        with patch.object(self.c,'knowledge',return_value=knowledge):
            with self.assertRaisesRegex(ValueError,'knowledge_tool_failed'):self.o.run_once()
        self.assertEqual(self.o.backlog_count(),1)

    def test_live_hook_releases_attention_lock_and_rechecks_capture_generation(self):
        self.ready();attention=self.server.attention=AttentionStore(self.root/'attention.sqlite',Blacklist(deny_blacklist(self.root/'blacklist.json')))
        body={'session_id':'lock-test','tool_name':'exec_command','tool_input':{'command':'echo allowed'}}
        event=normalize_codex({**body,'hook_event_name':'PostToolUse'});ingest=self.o.ingest
        def checked(*args,**kwargs):
            acquired=attention.lock.acquire(False);self.assertTrue(acquired)
            if acquired:attention.lock.release()
            return ingest(*args,**kwargs)
        try:
            with patch.object(self.o,'ingest',checked):self.server.record_agent_event(event,body)
            self.assertEqual(self.o.backlog_count(),1);self.o.clear()
            observed=self.server.egress.observed
            def revoke(value):attention.typed_generation+=1;return observed(value)
            with patch.object(self.server.egress,'observed',revoke):
                self.assertIsNone(self.o.ingest_hook(event,body,typed_generation=attention.typed_generation))
            self.assertEqual(self.o.backlog_count(),0)
        finally:attention.db.close();self.server.attention=None

    def test_unchanged_refresh_keeps_read_dependency_but_revocation_invalidates_it(self):
        self.ready();ident=self.source();knowledge=self.c.knowledge()
        self.assertIn('Compile failed',knowledge.call('observation_read',{'observation_id':ident})['text'])
        self.assertEqual(self.source(),ident)
        self.assertTrue(knowledge.valid())
        self.server.capture.share_text=False;self.server.sync_privacy()
        self.assertFalse(knowledge.valid())

    def test_loop_reads_the_run_interval_only_once_min_gap_has_passed(self):
        self.ready();now=time.time();self.o.clock=lambda:now;calls=[]
        class Turns:
            def __init__(self,count):self.count=count
            def wait(self,timeout):self.count-=1;return self.count<0
            def is_set(self):return False
            def set(self):pass
        stopped=self.o.stopped
        def run(last_attempt):
            self.o.last_attempt=last_attempt;self.o.worker=None;self.o.stopped=Turns(3)
            self.o.start();self.o.worker.join(5)
        try:
            with patch.object(self.o,'next_scope',return_value=self.o),patch.object(self.o,'interval',side_effect=lambda:calls.append(1) or math.inf):
                run(now-30);self.assertEqual(calls,[])
                run(now-60);self.assertEqual(len(calls),3)
        finally:self.o.stopped=stopped;self.o.worker=None

    def tree_frame(self,i,at):
        tree=[{'id':n,'parent':0,'role':'AXStaticText','value':f'step {i} row {n}','bounds':[n,0,1,1]} for n in range(40)]
        return self.o.ingest('native_ax',f'Compile log step {i}',source_key='editor',at=at,metadata={'app':'Xcode','nodes':tree}),tree

    def stored_metadata(self,ident):
        return json.loads(self.db.execute('SELECT metadata FROM observation_frames WHERE id=?',(ident,)).fetchone()[0])

    def assert_node_changes(self,ident,before,after):
        lines=lambda nodes:[dump({k:v for k,v in n.items() if k not in ('id','parent','bounds')})+'\n' for n in nodes]
        delta=''.join(difflib.unified_diff(lines(before),lines(after),n=1))
        view=self.o._view(self.o.get(ident),maximum=16000,seen=set(),bodies={})
        self.assertEqual(view['node_changes'],{'text':delta[:4000],'total_chars':len(delta),'complete':len(delta)<=4000,
            'tree_changed':True,'read_more':'observation_read part=tree retains full nodes and geometry'})

    def test_a_superseded_frame_keeps_only_a_hash_of_its_tree_and_changes_stay_against_the_base(self):
        self.ready();now=time.time()
        base,base_tree=self.tree_frame(0,now-30)
        self.reply=self.finding(base,'Compile log');self.o.run_once()
        middle,middle_tree=self.tree_frame(1,now-20)
        newest,newest_tree=self.tree_frame(2,now-10)
        stored=self.stored_metadata(middle)
        self.assertNotIn('nodes',stored)
        self.assertEqual((stored['nodes_sha256'],stored['nodes_count']),(hashlib.sha256(dump(middle_tree).encode()).hexdigest(),40))
        self.assertEqual(self.stored_metadata(base)['nodes'],base_tree)
        self.assertEqual(self.stored_metadata(newest)['nodes'],newest_tree)
        self.assert_node_changes(newest,base_tree,newest_tree)

    def test_frames_arriving_during_a_run_keep_the_tree_of_the_frame_it_reads(self):
        self.ready();now=time.time()
        first,first_tree=self.tree_frame(0,now-40)
        arrived=[]
        def factory(definitions):
            def script(session,prompt,options):
                arrived.extend(self.tree_frame(i,now-40+i)[0] for i in (1,2))
                yield {'type':'result','success':True,'final_text':dump(self.finding(first,'Compile log')),'model':'fixture'}
            return FakeSession(script)
        self.c.session_factory_override=factory
        self.assertEqual(self.o.run_once()['state'],'completed')
        newest,newest_tree=self.tree_frame(3,now-30)
        self.assertEqual(self.stored_metadata(first)['nodes'],first_tree)
        self.assertEqual([('nodes' in self.stored_metadata(ident),self.stored_metadata(ident)['nodes_count']) for ident in arrived],[(False,40)]*2)
        self.assert_node_changes(newest,first_tree,newest_tree)

    def test_ingest_writes_the_permission_signature_only_when_it_changes(self):
        self.ready();writes=[]
        expected=int(self.o.memory.setting('observation_permission_signature')!=self.o._permission_signature())
        self.db.set_trace_callback(lambda sql:writes.append(sql) if 'INSERT' in sql and 'observation_permission_signature' in sql else None)
        try:
            for i in range(3):self.source('Compile failed '+str(i),key='editor-'+str(i))
        finally:self.db.set_trace_callback(None)
        self.assertEqual(len(writes),expected)

    def test_first_pending_reads_content_from_an_index(self):
        self.ready()
        plan=[row[3] for row in self.db.execute('EXPLAIN QUERY PLAN '+FIRST_PENDING,(self.o.character,0))]
        self.assertTrue(any(line.startswith('SEARCH c USING COVERING INDEX') for line in plan),plan)

    def test_retention_drops_the_screenshot_then_the_text_and_metadata_then_the_frame(self):
        self.ready();now=time.time();self.o.clock=lambda:now
        png=b'\x89PNG\r\n\x1a\n'+b'\x00\x00\x00\rIHDR'+(640).to_bytes(4,'big')+(480).to_bytes(4,'big')+b'fake-test-pixels'
        image=self.o.ingest_image(7,'request-one',png,{'app':'Canvas','bundle_id':'fixture.canvas','title':'Private board'})
        nodes=[{'id':n,'role':'AXStaticText','value':'row '+str(n)} for n in range(3)]
        body='Compile failed: private body'
        text=self.source(body,nodes=nodes,title='Private title')
        hook=self.o.ingest('input_event',dump({'tool_response':'ok'}),source_key='hook',metadata={'kind':'live_hook','app':'claude',
            'label':'s1','doc':'/repo','role':'tool_end','subrole':'Bash','ts':now,'id':'event-one','cwd_title':'Private'})
        content_hash=self.o.get(text)['content_hash']
        def stored(ident):
            row=self.db.execute('SELECT c.text,c.image,f.metadata FROM observation_frames f JOIN observation_content c ON c.hash=f.content_hash WHERE f.id=?',(ident,)).fetchone()
            return row and (row[0],row[1],json.loads(row[2]))
        def at(offset): self.o.clock=lambda:now+offset;self.o.prune()
        at(IMAGE_KEEP_S-1);self.assertEqual(stored(image)[1],png)
        at(IMAGE_KEEP_S+1)
        self.assertIsNone(stored(image)[1]);self.assertEqual(self.o.image(image)['error']['code'],'image_unavailable')
        self.assertEqual(stored(text)[0],body)
        at(TEXT_KEEP_S-1);self.assertEqual(stored(text)[0],body);self.assertIn('nodes',stored(text)[2])
        at(TEXT_KEEP_S+1)
        self.assertEqual(stored(text),('',None,{'app':'Xcode','bundle_id':'fixture.editor','nodes_sha256':hashlib.sha256(dump(nodes).encode()).hexdigest(),'nodes_count':3}))
        self.assertEqual(stored(image)[2],{'app':'Canvas','bundle_id':'fixture.canvas'})
        self.assertEqual(stored(hook),('',None,{'kind':'live_hook','app':'claude','label':'s1','doc':'/repo','role':'tool_end','subrole':'Bash','ts':now}))
        self.assertEqual((self.o.get(text)['text'],self.o.get(text)['content_hash']),('',content_hash))
        # An unchanged recapture brings back the text the frame had lost.
        self.assertEqual(self.source(body,nodes=nodes,title='Private title'),text)
        self.assertEqual(stored(text)[0],body)
        at(FRAME_KEEP_S-1);self.assertIsNotNone(stored(image))
        at(FRAME_KEEP_S+1)
        self.assertIsNone(stored(image));self.assertIsNone(stored(hook));self.assertEqual(stored(text)[0],'')
        self.assertIsNone(self.db.execute('SELECT 1 FROM observation_content WHERE hash=?',(hashlib.sha256(png).hexdigest(),)).fetchone())

    def test_a_long_hook_result_keeps_its_head_and_tail_and_the_worklog_reads_it_the_same(self):
        self.ready();attention=self.server.attention=AttentionStore(self.root/'attention.sqlite',Blacklist(deny_blacklist(self.root/'blacklist.json')))
        log='Exit code: 1\n'+'collected line\n'*800+'FAILED tests/test_render.py::test_target - KeyError\n1 failed, 4 passed in 2.10s\n'
        patch_text='*** Begin Patch\n*** Update File: app/Render.swift\n'+'+let row = 1\n'*800+'*** End Patch\n'
        calls={'check':('exec_command',{'command':'python3 -m pytest tests'},{'stdout':log,'stderr':'','is_error':True}),
            'edit':('apply_patch',{'input':patch_text},{'output':'Success. Updated '*400,'files':['app/Render.swift']}),
            'fail':('exec_command',{'command':'make build'},'Exit code: 2\nerror: '+'missing symbol '*600)}
        try:
            for tag,(tool,inputs,response) in calls.items():
                body={'session_id':'long-'+tag,'cwd':str(self.root),'tool_name':tool,'tool_input':inputs,'tool_response':response}
                self.server.record_agent_event(normalize_codex({**body,'hook_event_name':'PostToolUse'}),body)
            rows={r['metadata']['label']:r for r in self.o.latest() if r['metadata']['kind']=='live_hook'}
            for tag,(tool,inputs,response) in calls.items():
                row=rows['long-'+tag];kept=json.loads(row['text'])
                self.assertEqual(kept['tool_input'],inputs)
                self.assertLess(len(dump(kept['tool_response'])),4600)
                line=_line(row['metadata']['role'],tool,kept)
                self.assertEqual(line,_line(row['metadata']['role'],tool,{'tool_input':inputs,'tool_response':response}))
                self.assertEqual(line[0],tag)
            clipped=json.loads(rows['long-check']['text'])['tool_response']
            self.assertEqual((clipped['stderr'],clipped['is_error']),('',True))
            self.assertEqual(clipped['stdout'],log[:2048]+f'…[truncated {len(log)-4096} chars]…'+log[-2048:])
            self.assertEqual(json.loads(rows['long-edit']['text'])['tool_response']['files'],['app/Render.swift'])
        finally: attention.db.close();self.server.attention=None

    def test_the_scheduler_reuses_its_due_time_until_a_frame_arrives(self):
        self.ready();ident=self.source();self.reply=self.finding(ident);self.o.run_once()
        self.source(self.BUILT)
        self.assertEqual(self.o.interval(),60);self.assertIs(self.o.next_scope(0),self.o)
        queries=[];self.db.set_trace_callback(queries.append)
        try:
            later=time.time()+30;self.o.clock=lambda:later
            for _ in range(3):
                self.assertEqual(self.o.interval(),60);self.assertIs(self.o.next_scope(0),self.o)
            self.assertEqual(queries,[])
            self.source(self.BUILT)  # an unchanged recapture of a pending frame moves its time
            queries.clear();self.o.interval()
            self.assertTrue(any('json_extract' in q for q in queries),queries)
            queries.clear();self.o.interval();self.assertEqual(queries,[])
            self.server.activity=lambda:{'activity':'away','mode':'away','confidence':1}
            self.assertEqual(self.o.interval(),math.inf)
            self.server.activity=lambda:{'activity':'editing_code','mode':'coding','confidence':.9}
            queries.clear();self.assertEqual(self.o.interval(),60);self.assertTrue(queries)
            self.reply=self.finding(self.o.pending(1)[0]['id'],'Build succeeded',state='result_observed');self.o.run_once()
            self.assertEqual(self.o.interval(),600);self.assertIsNone(self.o.next_scope(0))
        finally: self.db.set_trace_callback(None);self.o.clock=time.time

    LOG='Compile failed: missing RenderTarget declaration\n'+'build step ok\n'*40
    # Differs from source()'s default text by more than SMALL_CHANGE_CHARS.
    BUILT='Build succeeded\n'+'test passed\n'*20

    def interpreted(self,now,**extra):
        """The clock fixed at now, LOG interpreted on the editor source, and a due check."""
        self.ready();self.o.clock=lambda:now
        ident=self.source(self.LOG,**extra);self.reply=self.finding(ident)
        self.assertEqual(self.o.run_once()['state'],'completed')
        return lambda:self.o.clock()-self.o.last_attempt>=self.o.interval()

    def tick(self,turns=2):
        """Runs the scheduler loop for turns seconds at the current clock."""
        class Turns:
            def __init__(self,count):self.count=count
            def wait(self,timeout):self.count-=1;return self.count<0
            def is_set(self):return False
            def set(self):pass
        stopped=self.o.stopped;self.o.worker=None;self.o.stopped=Turns(turns)
        try:self.o.start();self.o.worker.join(5)
        finally:self.o.stopped=stopped;self.o.worker=None

    def attempts(self):
        return self.db.execute("SELECT count(*) FROM semantic_attempts WHERE purpose='observation_interpret'").fetchone()[0]

    def test_a_small_text_change_waits_without_a_model_call(self):
        now=time.time();due=self.interpreted(now)
        self.o.clock=lambda:now+5;self.source(self.LOG+'streamed reply chunk 30 chars.')
        self.o.clock=lambda:now+300;self.assertFalse(due())
        self.tick();self.assertEqual(self.attempts(),1)
        self.assertEqual(self.o.last_attempt,now)
        self.assertEqual(self.o.backlog_count(),1)
        self.assertEqual(self.o.small_skips[self.o.character][0],1)

    def test_small_changes_that_add_up_to_200_characters_run(self):
        now=time.time();due=self.interpreted(now)
        for i in range(1,7):
            self.o.clock=lambda i=i:now+5*i;self.source(self.LOG+'x'*(30*i))
        self.o.clock=lambda:now+130;self.assertFalse(due())
        self.source(self.LOG+'x'*210);self.assertTrue(due())
        self.reply=self.finding(self.o.pending(1)[0]['id']);self.tick()
        self.assertEqual(self.attempts(),2);self.assertEqual(self.o.backlog_count(),0)

    def test_switching_app_runs_at_once_even_for_a_small_change(self):
        now=time.time();self.ready();self.o.clock=lambda:now
        self.source(self.LOG,key='xcode')
        self.o.clock=lambda:now+1
        claude=self.source('Claude chat\n'+self.LOG,key='claude',app='Claude',bundle_id='com.anthropic.claudefordesktop',window_id=9)
        self.reply=self.finding(claude);self.o.run_once()
        due=lambda:self.o.clock()-self.o.last_attempt>=self.o.interval()
        self.o.clock=lambda:now+5
        self.source('Claude chat\n'+self.LOG+'tiny',key='claude',app='Claude',bundle_id='com.anthropic.claudefordesktop',window_id=9)
        self.o.clock=lambda:now+100;self.assertFalse(due())
        self.source(self.LOG+'tiny',key='xcode')
        self.o.clock=lambda:now+116;self.assertTrue(due())

    def test_a_control_tree_change_runs_but_a_changed_value_waits(self):
        now=time.time();due=self.interpreted(now,nodes=[{'role':'AXStaticText','value':'a'}])
        self.o.clock=lambda:now+5;self.source(self.LOG+'tiny',nodes=[{'role':'AXStaticText','value':'b'}])
        self.o.clock=lambda:now+130;self.assertFalse(due())
        self.source(self.LOG+'tiny',nodes=[{'role':'AXStaticText','value':'b'},{'role':'AXButton','value':'Stop'}])
        self.o.clock=lambda:now+146;self.assertTrue(due())

    def test_a_small_change_runs_ten_minutes_after_its_text_arrived(self):
        now=time.time();due=self.interpreted(now)
        self.o.clock=lambda:now+5;ident=self.source(self.LOG+'tiny change')
        self.o.clock=lambda:now+604;self.assertFalse(due())
        self.o.clock=lambda:now+605;self.assertTrue(due())
        self.reply=self.finding(ident);self.tick()
        self.assertEqual(self.attempts(),2);self.assertEqual(self.o.backlog_count(),0)

    def test_a_waiting_small_change_is_measured_once_per_queue_change(self):
        now=time.time();due=self.interpreted(now)
        self.o.clock=lambda:now+5;self.source(self.LOG+'tiny change')
        calls=[];change=self.o._change
        queries=[]
        with patch.object(self.o,'_change',side_effect=lambda character:calls.append(character) or change(character)):
            self.o.clock=lambda:now+70;self.assertEqual(self.o.interval(),605);self.assertEqual(len(calls),1)
            self.assertIs(self.o.next_scope(0),self.o)
            self.db.set_trace_callback(queries.append)
            try:
                for second in range(71,605):
                    self.o.clock=lambda second=second:now+second
                    self.assertFalse(due());self.assertIs(self.o.next_scope(0),self.o)
                self.assertEqual(queries,[]);self.assertEqual(len(calls),1)
                self.source(self.LOG+'tiny change 2')
                self.assertFalse(due());self.assertEqual(len(calls),2)
                self.o.clock=lambda:now+605;self.assertTrue(due());self.assertEqual(len(calls),2)
            finally: self.db.set_trace_callback(None)
        self.assertEqual(self.o.small_skips[self.o.character][0],1)

    def test_a_jpeg_screenshot_keeps_its_size_and_media_type(self):
        self.ready()
        sof=b'\xff\xc2'+(17).to_bytes(2,'big')+b'\x08'+(720).to_bytes(2,'big')+(1280).to_bytes(2,'big')+b'\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01'
        jpeg=b'\xff\xd8\xff\xe0'+(16).to_bytes(2,'big')+b'JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00'+sof+b'fake-test-pixels'
        ident=self.o.ingest_image(7,'request-jpeg',jpeg,{'app':'Canvas'})
        self.assertEqual({k:self.o.get(ident)['metadata'][k] for k in ('pixel_width','pixel_height')},{'pixel_width':1280,'pixel_height':720})
        self.assertEqual(self.o.image(ident)['content'][0]['mimeType'],'image/jpeg')
        png=b'\x89PNG\r\n\x1a\n'+b'\x00\x00\x00\rIHDR'+(64).to_bytes(4,'big')+(48).to_bytes(4,'big')+b'fake-test-pixels'
        self.assertEqual(self.o.image(self.o.ingest_image(8,'request-png',png,{'app':'Canvas'}))['content'][0]['mimeType'],'image/png')
        self.assertNotIn('jpeg_base64',self.o.get(self.o.ingest_text({'app':'Xcode','window_id':9,'text':'body','jpeg_base64':'AAAA'}))['metadata'])

if __name__=='__main__':unittest.main()
