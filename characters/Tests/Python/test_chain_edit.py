"""Authored fixtures only: a motion-chain proposal rebuilds the package with its chains rewritten, or is refused whole with a reason per problem."""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import numpy

CHARACTERS=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(CHARACTERS),str(Path(__file__).resolve().parent),str(CHARACTERS.parent/'agent/agentd/tests')]
from agentic_complex_build.motion_graph import FILE as GRAPH,graft,pack_graph,text
from agentic_complex_build.motion_import.chain_edit import SCHEMA,Refused,chain_package,check
from character_library import Package
from test_motion_tool import motion_fixture

STAND=dict(stance_start='stand',stance_end='stand')
# A clicked wave: start, a held-for-a-while loop, end; nod and shrug stand alone; sit leaves her seated.
MOTION=dict(
    clips={'wave_start':(.5,False),'wave_loop':(1.,True),'wave_end':(.5,False),'nod':(.4,False),'shrug':(.6,False),'sit':(.8,False)},
    animation={'intent-motion-map.json':{'crossfade_seconds':.25,'clips':{
                   'idle':{},'wave_start':{'next':'wave_loop'},'wave_loop':{'next':'wave_end','hold_seconds':1.},'wave_end':{'next':None},
                   'nod':{'next':None},'shrug':{'next':None},'sit':{'next':None}},
               'events':{'click.head':{'pool':[{'clip':'wave_start','weight':1}]}}},
               'pose-families.json':{'schema':'endfield-pose-families/v1','bases':{'stand':'idle'},'references':{},'hub':'stand','bridges':{},
                   'family_gaps_cm':{'stand':{}},'clips':{
                   'idle':dict(start='stand',end='stand',start_cm=0.,end_cm=0.),'wave_start':dict(start='stand',end='other',start_cm=1.,end_cm=20.),
                   'wave_loop':dict(start='other',end='other',start_cm=20.,end_cm=20.),'wave_end':dict(start='other',end='stand',start_cm=20.,end_cm=1.),
                   'nod':dict(start='stand',end='stand',start_cm=2.,end_cm=2.),'shrug':dict(start='other',end='other',start_cm=15.,end_cm=15.),
                   'sit':dict(start='stand',end='other',start_cm=2.,end_cm=60.)}}},
    interaction={'motion-metadata.json':{'clips':{**{c:STAND for c in ['idle','wave_start','wave_loop','wave_end','nod','shrug']},
                                                   'sit':dict(stance_start='stand',stance_end='sit')}},
                 'blend-times.json':{'clips':{'wave_start':{'blend_in_s':.2,'source':'fixture'}}}})


def files(root):
    return {p.relative_to(root).as_posix():p.read_bytes() for p in Path(root).rglob('*') if p.is_file()}


def doc(root,name):
    return json.loads((Path(root)/'runtime'/name).read_text())


def rules(root):
    return doc(root,'animation/intent-motion-map.json')['clips']


class ChainEditTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        source=self.root/'source';motion_fixture(source,motion=MOTION)
        self.pkg=self.root/'pkg';graft(source,self.pkg);self.out=self.root/'out'

    def proposal(self,*edits,sha=None):
        return dict(schema=SCHEMA,character='fixture',package_sha256=sha or Package(self.pkg).sha256,edits=list(edits))

    def refused(self,*edits,**options):
        proposal=self.proposal(*edits,**options)
        with self.assertRaises(Refused) as caught:chain_package(self.pkg,self.out,proposal)
        self.assertFalse(self.out.exists())
        self.assertEqual(check(self.pkg,proposal)['problems'],caught.exception.problems)
        return caught.exception.problems

    def test_set_rewrites_next_and_hold_and_null_drops_a_field(self):
        report=chain_package(self.pkg,self.out,self.proposal(dict(op='set',clip='wave_end',next='nod'),dict(op='set',clip='wave_loop',hold=None)))
        after=rules(self.out)
        self.assertEqual((after['wave_end'],after['wave_loop']),({'next':'nod'},{'next':'wave_end'}))
        self.assertEqual((report['schema'],report['op'],Package(self.out).version),('endfield-motion-edit/v1','chain','1.0.2'))
        [edit]=(self.out/'provenance').glob('edit-*.json')
        self.assertEqual(json.loads(edit.read_text()),report)

    def test_replace_rewrites_the_previous_clips_next(self):
        chain_package(self.pkg,self.out,self.proposal(dict(op='replace',chain='wave_start',index=2,clip='nod')))
        after=rules(self.out)
        self.assertEqual((after['wave_loop']['next'],after['nod']),('nod',{}))

    def test_insert_puts_the_clip_before_the_index(self):
        chain_package(self.pkg,self.out,self.proposal(dict(op='insert',chain='wave_start',index=1,clip='nod')))
        after=rules(self.out)
        self.assertEqual((after['wave_start']['next'],after['nod']['next'],after['wave_loop']['next']),('nod','wave_loop','wave_end'))

    def test_blend_sets_blend_in(self):
        chain_package(self.pkg,self.out,self.proposal(dict(op='blend',clip='wave_loop',seconds=.5),dict(op='blend',clip='wave_start',seconds=0)))
        blends=doc(self.out,'interaction/blend-times.json')['clips']
        self.assertEqual((blends['wave_loop']['blend_in_s'],blends['wave_start']['blend_in_s']),(.5,0))

    def test_blend_outside_zero_to_two_seconds_is_refused(self):
        problems=self.refused(dict(op='blend',clip='wave_loop',seconds=2.5),dict(op='blend',clip='wave_loop',seconds=True))
        self.assertEqual(problems,[dict(edit=0,reason='bad_blend'),dict(edit=1,reason='bad_blend')])

    def test_stale_sha_is_refused(self):
        self.assertEqual(self.refused(dict(op='set',clip='wave_end',next='nod'),sha='0'*64),[dict(edit=None,reason='stale')])

    def test_unknown_clip_is_refused(self):
        problems=self.refused(dict(op='replace',chain='wave_start',index=2,clip='nothing'),dict(op='set',clip='nod',next='gone'),
                              dict(op='insert',chain='wave_start',index=4,clip='nod'))
        self.assertEqual(problems,[dict(edit=0,reason='unknown_clip:nothing'),dict(edit=1,reason='unknown_clip:gone'),
                                   dict(edit=2,reason='bad_index')])

    def test_a_cycle_is_refused(self):
        problems=self.refused(dict(op='set',clip='wave_end',next='wave_start'))
        self.assertIn(dict(edit=None,reason='cycle:wave_start'),problems)

    def test_a_chain_that_does_not_return_to_its_stance_is_refused(self):
        problems=self.refused(dict(op='replace',chain='wave_start',index=2,clip='sit'))
        self.assertIn(dict(edit=None,reason='no_return:wave_start'),problems)

    def test_a_pooled_chain_resting_off_a_base_family_is_refused(self):
        self.assertEqual(self.refused(dict(op='replace',chain='wave_start',index=2,clip='shrug')),
                         [dict(edit=None,reason='pool_chain_end_off_base:wave_start')])

    def test_the_graph_is_rewritten_and_check_names_the_changed_chains(self):
        proposal=self.proposal(dict(op='insert',chain='wave_start',index=1,clip='nod'))
        previous=json.loads((self.pkg/'runtime/animation'/GRAPH).read_text())
        self.assertEqual(check(self.pkg,proposal),dict(ok=True,problems=[],graph_changes=dict(
            chains_added=[],chains_removed=['nod'],chains_changed=['wave_start'])))
        chain_package(self.pkg,self.out,proposal)
        runtime=self.out/'runtime';written=(runtime/'animation'/GRAPH).read_text()
        self.assertEqual(written,text(pack_graph('fixture',runtime/'pack.json',runtime/'actor.json',previous=previous)))
        self.assertEqual([s['clip'] for s in json.loads(written)['chains']['wave_start']],['wave_start','nod','wave_loop','wave_end'])
        Package(self.out)

    def test_documents_no_edit_touches_keep_their_bytes(self):
        before=copy.deepcopy(files(self.pkg))
        chain_package(self.pkg,self.out,self.proposal(dict(op='set',clip='wave_end',next='nod')))
        after=files(self.out)
        changed={x for x in set(before)|set(after) if before.get(x)!=after.get(x)}
        self.assertEqual({x for x in changed if not x.startswith('provenance/edit-')},
                         {'runtime/animation/intent-motion-map.json','runtime/animation/'+GRAPH,'runtime/pack.json','runtime/bundle.json','character.json'})

    def test_the_intent_motion_map_keeps_its_clip_order(self):
        chain_package(self.pkg,self.out,self.proposal(dict(op='set',clip='wave_end',next='nod')))
        self.assertEqual(list(rules(self.out)),list(rules(self.pkg)))

    def test_an_action_row_on_a_changed_chain_takes_its_required_clips_and_duration(self):
        rows=[dict(id='wave',name='wave',section='idle',clips=['wave_start'],required_clips=['wave_loop','wave_end'],duration=2.),
              dict(id='shrug',name='shrug',section='idle',clips=['shrug'],duration=.6)]
        motion=dict(MOTION,animation=dict(MOTION['animation'],**{'actions.json':dict(schema='endfield-character-actions-v1',actions=rows)}))
        source=self.root/'acted';motion_fixture(source,motion=motion);self.pkg=self.root/'acted-pkg';graft(source,self.pkg)
        chain_package(self.pkg,self.out,self.proposal(dict(op='insert',chain='wave_start',index=1,clip='nod')))
        wave,shrug=doc(self.out,'animation/actions.json')['actions']
        self.assertEqual(wave['required_clips'],['nod','wave_loop','wave_end'])
        self.assertAlmostEqual(wave['duration'],.5+.4+1.+.5)
        self.assertEqual(shrug,rows[1])

    def test_it_imports_from_the_shipped_content_with_numpy_alone(self):
        # The app stages CONTENT_SOURCES and CONTENT_PACKAGES as the package content; its runtime has numpy but not scipy.
        sys.path.insert(0,str(CHARACTERS.parent/'tools/release'))
        from release import CONTENT_PACKAGES,CONTENT_SOURCES
        content=self.root/'shipped/content';content.mkdir(parents=True);(content/'__init__.py').write_text('')
        for relative in CONTENT_SOURCES:shutil.copy2(CHARACTERS.parent/relative,content/Path(relative).name)
        for package in CONTENT_PACKAGES:
            (content/Path(package).name).mkdir()
            for path in (CHARACTERS.parent/package).glob('*.py'):shutil.copy2(path,content/Path(package).name/path.name)
        site=self.root/'site';site.mkdir();(site/'numpy').symlink_to(Path(numpy.__file__).parent)
        # motion_tool.importer's import roots: the content's parent and the content itself.
        run=subprocess.run([sys.executable,'-I','-S','-c','import sys;sys.path[:0]=sys.argv[1:5];import content.motion_import.chain_edit',
                            str(content.parent),str(content),str(CHARACTERS.parent/'agent/agentd'),str(site)],capture_output=True,text=True)
        self.assertEqual(run.returncode,0,run.stderr)


if __name__=='__main__':
    unittest.main()
