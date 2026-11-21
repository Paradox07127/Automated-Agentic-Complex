"""The observation queue reads, the activity's understanding read and the shared store's tuning."""
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import test_continuous_observation as base
from character_agent.services.observation import CHANGED_PENDING, FRESH, TEXT_KEEP_S
from infra.store import open_store
from observation.activity_decisions import ActivityDecisions

# The plain queries the queue answered before it was memoized; every read must still equal them.
PENDING = "FROM observation_frames f LEFT JOIN observation_processed p ON p.id=f.id WHERE p.id IS NULL AND NOT EXISTS (SELECT 1 FROM observation_aliases a WHERE a.id=f.id) AND COALESCE(json_extract(f.metadata,'$.transport_page'),0)=0"
QUEUE_KEYS = ('pending_sources','queue','observed_at','current_sources')


def reference(o):
    db,cid,cutoff,fresh=o.db,o.character,o.clock()-TEXT_KEEP_S,o.clock()-FRESH
    newest=db.execute("SELECT max(f.at) "+PENDING+" AND f.character_id=? AND f.origin!='input_event' AND f.at>=?",(cid,fresh)).fetchone()[0]
    interval=600 if newest is None or not db.execute(CHANGED_PENDING,(cid,)).fetchone() else max(60,newest+15-o.last_attempt)
    latest,seen=[],set()
    for ident,key,page in db.execute("SELECT id,source_key,json_extract(metadata,'$.transport_page') FROM observation_frames WHERE character_id=? AND at>=? ORDER BY rowid DESC LIMIT 256",(cid,cutoff)):
        if not page and key not in seen and len(latest)<4: latest.append(ident);seen.add(key)
    by_origin=db.execute('SELECT f.origin,count(*),min(f.at) '+PENDING+' AND f.character_id=? AND f.at>=? GROUP BY f.origin',(cid,fresh)).fetchall()
    return {'pending_characters':[tuple(r) for r in db.execute('SELECT f.character_id,count(*),min(f.at) '+PENDING+' AND f.at>=? GROUP BY f.character_id ORDER BY min(f.at)',(fresh,))],
        'interval':interval,
        'pending':[r[0] for r in db.execute('SELECT f.id '+PENDING+' AND f.character_id=? AND f.at>=? ORDER BY f.at DESC,f.rowid DESC LIMIT 10',(cid,fresh))],
        'backlog':db.execute('SELECT count(*) '+PENDING+' AND f.character_id=? AND f.at>=?',(cid,fresh)).fetchone()[0],
        'by_origin':{origin:n for origin,n,_ in by_origin},
        'oldest':max(0,o.clock()-min((at for _,_,at in by_origin),default=o.clock())),
        'aliases':db.execute('SELECT count(*) FROM observation_aliases a JOIN observation_frames f ON f.id=a.id WHERE f.character_id=?',(cid,)).fetchone()[0],
        'latest':latest}


def actual(o):
    metrics=o.queue_metrics()
    return {'pending_characters':[tuple(r) for r in o.pending_characters()],'interval':o.interval(),
        'pending':[r['id'] for r in o.pending()],'backlog':o.backlog_count(),'by_origin':metrics['by_origin'],
        'oldest':metrics['oldest_pending_age_seconds'],'aliases':metrics['exact_replay_aliases'],
        'latest':[r['id'] for r in o.latest(4)]}


class ObservationQueueTests(unittest.TestCase):
    setUp=base.ObservationTests.setUp
    tearDown=base.ObservationTests.tearDown
    factory=base.ObservationTests.factory
    ready=base.ObservationTests.ready
    source=base.ObservationTests.source
    finding=base.ObservationTests.finding

    def same(self):
        now=time.time();self.o.clock=lambda:now  # one instant for both sides
        try: self.assertEqual(actual(self.o),reference(self.o))
        finally: self.o.clock=time.time

    def frames(self):
        self.ready()
        ids=[self.source('Compile failed: missing RenderTarget declaration '+str(n),key='editor-'+str(n%3)) for n in range(6)]
        self.o.ingest_inputs([{'id':n,'ts':time.time(),'kind':'value','app':'Editor','value':'typed '+str(n)} for n in range(3)])
        self.same()
        return ids

    def test_frame_write_outside_the_service_refreshes_the_queue(self):
        ids=self.frames()
        self.db.execute("INSERT INTO observation_frames SELECT 'obs-'||hex(randomblob(16)),character_id,at+1,origin,'other',revision,consent_epoch,requires,metadata,content_hash,NULL FROM observation_frames WHERE id=?",(ids[0],))
        self.db.commit()
        self.o.queue_version+=1  # the scheduler's due time holds until the service's own queue writes
        self.same()

    def test_processed_mark_refreshes_the_queue(self):
        ids=self.frames()
        self.db.execute("INSERT INTO observation_processed VALUES(?,'analysis-direct',?)",(ids[-1],time.time()))
        self.db.commit()
        self.o.queue_version+=1  # the scheduler's due time holds until the service's own queue writes
        self.same()

    def test_alias_write_refreshes_the_queue(self):
        ids=self.frames()
        self.db.execute('INSERT INTO observation_aliases VALUES(?,?)',(ids[1],ids[0]))
        self.db.commit();self.same()

    def test_unchanged_recapture_and_prune_refresh_the_queue(self):
        ids=self.frames()
        self.db.execute('UPDATE observation_frames SET at=at-100 WHERE id=?',(ids[2],));self.db.commit();self.same()
        self.db.execute('DELETE FROM observation_frames WHERE id=?',(ids[3],));self.db.commit();self.same()

    @unittest.skipIf(sys.platform == "win32", "the test keeps an SQLite file open while deleting or replacing it, which Windows refuses (WinError 32)")
    def test_commit_from_another_connection_refreshes_the_queue(self):
        ids=self.frames()
        other=sqlite3.connect(str(self.root/'domain.sqlite'));self.addCleanup(other.close)
        other.execute("INSERT INTO observation_processed VALUES(?,'analysis-other',?)",(ids[0],time.time()));other.commit()
        self.same()

    def test_service_writes_and_a_run_keep_the_queue_exact(self):
        ids=self.frames()
        self.reply=self.finding(ids[-1]);self.assertEqual(self.o.run_once()['state'],'completed');self.same()
        self.source('Build succeeded; tests not run',key='editor-0');self.same()
        self.source('Build succeeded; tests not run',key='editor-0');self.same()  # unchanged: only its at moves

    def test_frames_age_out_of_the_window_without_a_write(self):
        self.frames()
        later=time.time()+FRESH-30
        for offset in (0,60):
            self.o.clock=lambda:later+offset
            self.assertEqual(actual(self.o),reference(self.o))
        self.assertEqual(self.o.backlog_count(),0)

    def test_activity_reads_the_latest_analysis_without_the_queue(self):
        ids=self.frames()
        self.reply=self.finding(ids[-1]);self.o.run_once()
        decisions=ActivityDecisions(self.c.semantic)
        boom=AssertionError('queue read on the activity path')
        with patch.object(type(self.o),'context',side_effect=boom),patch.object(type(self.o),'backlog_count',side_effect=boom), \
                patch.object(type(self.o),'queue_metrics',side_effect=boom),patch.object(type(self.o),'latest',side_effect=boom):
            scene=decisions.apply({},{'activity':'coding'})
        self.assertEqual(scene['activity'],'coding')
        self.assertTrue(scene['semantic_available'])
        self.assertEqual(scene['understanding']['tasks'][0]['task_key'],'render-fix')
        context=self.o.context()
        self.assertEqual(scene['understanding'],{k:v for k,v in context.items() if k not in QUEUE_KEYS})
        self.assertEqual(scene['semantic_as_of'],context['interpreted_at'])
        # An analysis write is seen at once.
        at,body,deps=self.db.execute('SELECT at,body,dependencies FROM observation_analyses').fetchone()
        self.db.execute("INSERT INTO observation_analyses VALUES('analysis-newer',?,?,'run-newer',?,?)",
            (self.o.character,at+1,body.replace('render-fix','render-verify'),deps));self.db.commit()
        scene=decisions.apply({},{})
        self.assertEqual(scene['understanding']['tasks'][0]['task_key'],'render-verify')
        self.assertEqual(scene['semantic_as_of'],at+1)

    def test_latest_analysis_lookup_uses_an_index(self):
        self.ready()
        plan=' '.join(r[3] for r in self.db.execute('EXPLAIN QUERY PLAN SELECT at,body,dependencies FROM observation_analyses WHERE character_id=? ORDER BY at DESC,rowid DESC LIMIT 1',('aster',)))
        self.assertIn('observation_analyses_character',plan)
        self.assertNotIn('TEMP B-TREE',plan)

    def test_latest_keeps_capture_order_when_a_recapture_moves_at(self):
        self.ready()
        first,second,third=(self.source('window body '+key,key=key) for key in ('a','b','c'))
        self.db.execute('UPDATE observation_frames SET at=? WHERE id=?',(time.time()+1,first));self.db.commit()
        self.assertEqual([r['id'] for r in self.o.latest(3)],[third,second,first])
        self.same()


class SharedStoreTests(unittest.TestCase):
    def test_shared_store_maps_the_file(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as directory:
            db=open_store(Path(directory)/'agentd.sqlite')
            try: self.assertEqual(db.execute('PRAGMA mmap_size').fetchone()[0],256*1024*1024)
            finally: db.close()


if __name__=='__main__':
    unittest.main()
