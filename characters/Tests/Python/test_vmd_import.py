"""Authored fixtures only. Real licensed VMD/character acceptance is opt-in."""
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import wave

import numpy as np
CHARACTERS=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(CHARACTERS))
from agentic_complex_build.import_vmd import checked_vmd,checked_morph_vmd,checked_pmd,append_clip,encode_clip,import_motion,prepare_music,ref
from agentic_complex_build.mmd.io import Vmd,BoneKey,MorphKey,write_vmd,write_pmd
from agentic_complex_build.mmd.reference import build_pmd
from agentic_complex_build.mmd.native_rig import NativeRig
from agentic_complex_build.mmd.skeleton import MmdSkeleton,add_semi_standard_bones
from agentic_complex_build.mmd.retarget import VmdToNative
from agentic_complex_build import secondary_fit,stance
from agentic_complex_build.pose_family import Poses
from agentic_complex_build.mmd.rig_math import DIGITS,Retarget,bone,pack_humanoid
import native_bundle

# The fixture rigs' node name of each humanoid bone and extras.twist name.
LIMBS={'Shoulder':'Clavicle','UpperArm':'UpperArm','LowerArm':'Forearm','Hand':'Hand','UpperLeg':'Thigh','LowerLeg':'Calf','Foot':'Foot','Toes':'Toe0'}
TWISTS={'UpperArmTwist':'UpArmTwist','UpperArmTwist1':'UpArmTwist1','LowerArmTwist':'_ForeTwist','LowerArmTwist1':'_ForeTwist1',
        'UpperLegTwist':'ThighTwist','UpperLegTwist1':'ThighTwist1','LowerLegTwist':'CalfTwist','LowerLegTwist1':'CalfTwist1'}
BONES={'hips':'Bip001','spine':'Bip001_Spine','chest':'Bip001_Spine1','upperChest':'Bip001_Spine2','neck':'Bip001_Neck','head':'Bip001_Head',
       **{bone(s,part):f'Bip001_{s}_{name}' for s in 'LR' for part,name in LIMBS.items()},
       **{bone(s,digit+segment):f'Bip001_{s}_Finger{n}'+(str(k) if k else '') for s in 'LR' for n,(digit,segments) in enumerate(DIGITS) for k,segment in enumerate(segments)}}
TWIST={bone(s,twist):f'Bip001_{s}{suffix}' for s in 'LR' for twist,suffix in TWISTS.items()}


def humanoid_map(doc):
    """doc's humanoid.json: each BONES bone and TWIST node whose name is on exactly one of doc's nodes."""
    names=[n['path'].rsplit('/',1)[-1] for n in doc['nodes']]
    at={name:n['path'] for name,n in zip(names,doc['nodes']) if names.count(name)==1}
    bones={k:at[v] for k,v in BONES.items() if v in at}
    twist={k:at[v] for k,v in TWIST.items() if v in at}
    return dict(schema='endfield-humanoid-map/v1',bones=bones,**(dict(extras=dict(twist=twist)) if twist else {}))


def renamed(doc,humanoid):
    """doc and its humanoid map with every node moved under Armature/ and no Bip001, Nub or Twist in a name."""
    name=lambda path:'Armature/'+path.replace('Bip001','Rig').replace('Nub','End').replace('Twist','Roll')
    hum=json.loads(json.dumps(humanoid))
    for table in [hum['bones']]+([hum['extras']['twist']] if 'extras' in hum else []):
        table.update({k:name(v) for k,v in table.items()})
    return dict(doc,nodes=[dict(n,path=name(n['path'])) for n in doc['nodes']]),hum


def step_vmd(path):
    """A step with a crouch, a foot IK goal, an arm and forearm roll and a bent index finger."""
    turn=lambda axis,a:tuple(math.sin(a) if k==axis else 0 for k in range(3))+(math.cos(a),)
    write_vmd(Vmd(bones=[BoneKey('センター',0,(0,0,0),(0,0,0,1)),BoneKey('センター',12,(0,-2.5,.8),(0,0,0,1)),
                        BoneKey('左足ＩＫ',12,(.6,1.5,1.2),turn(1,.3)),BoneKey('上半身',20,(0,0,0),turn(1,.2)),
                        BoneKey('右腕',10,(0,0,0),turn(0,.4)),BoneKey('右腕捩',15,(0,0,0),turn(0,.3)),
                        BoneKey('右手捩',15,(0,0,0),turn(0,.3)),BoneKey('右人指１',12,(0,0,0),turn(2,.3))]),path)
    return path


def authored_rig():
    """Simple biped with the existing roles' semantic names, no game assets."""
    source=build_pmd();world={b.name:np.array(b.pos)*[1,1,-1]/10 for b in source.bones}
    nodes=[];ids={};positions={}
    def add(name,parent,pos):
        index=len(nodes);ids[name]=index;positions[name]=pos=np.asarray(pos,float)
        local=pos-positions[parent] if parent else pos
        nodes.append(dict(index=index,parent=ids[parent] if parent else -1,path=name,gltf_node_index=index,
                          position=(local*[-1,1,1]).tolist(),rotation=[0,0,0,1],scale=[1,1,1]))
    add('Bip001',None,world['下半身'])
    neck=world['首'];spine=world['上半身']
    parent='Bip001'
    for name,f in [('Spine',0),('Spine1',.33),('Spine2',.67),('Neck',1)]:
        name='Bip001_'+name;add(name,parent,spine+(neck-spine)*f);parent=name
    add('Bip001_Head',parent,world['頭'])
    for side,s in [('L','左'),('R','右')]:
        parent='Bip001_Spine2'
        for target,src in [('Clavicle','肩'),('UpperArm','腕'),('Forearm','ひじ'),('Hand','手首')]:
            name=f'Bip001_{side}_{target}';add(name,parent,world[s+src]);parent=name
        for f,src in enumerate(['親指','人指','中指','薬指','小指']):
            parent=f'Bip001_{side}_Hand';last=world[s+'手首']
            for j,digit in enumerate(['１','２','３']):
                p=world.get(s+src+digit,last+(last-positions[parent])*.5)
                if f==0:p=world[s+src+('１' if j<2 else '２')]+np.array([.005*j,0,.002*j])
                name=f'Bip001_{side}_Finger{f}'+('' if j==0 else str(j));add(name,parent,p);parent=name;last=p
            add(f'Bip001_{side}_Finger{f}Nub',parent,last+np.array([.01*(1 if side=='L' else -1),-.008,0]))
        parent='Bip001'
        for target,src in [('Thigh','足'),('Calf','ひざ'),('Foot','足首'),('Toe0','つま先')]:
            name=f'Bip001_{side}_{target}';add(name,parent,world[s+src]);parent=name
    return dict(schema='metal-actor-rig-v1',nodes=nodes)


class VmdImportTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
    def tearDown(self):self.temp.cleanup()
    def motion(self):
        path=self.root/'authored.vmd'
        write_vmd(Vmd(bones=[BoneKey('上半身',0,(0,0,0),(0,0,0,1)),
                            BoneKey('上半身',30,(0,0,0),(0,math.sin(.2),0,math.cos(.2)))]),path)
        return path
    def testParserBoundsAndNonfinite(self):
        path=self.motion();self.assertEqual(len(checked_vmd(path).bones),2);good=path.read_bytes()
        for bad in [good[:-1],good+b'x',good[:50]+struct.pack('<I',2**32-1),b'unknown']:
            path.write_bytes(bad)
            with self.assertRaises(ValueError):checked_vmd(path)
        for pos,rot,frame in [((float('nan'),0,0),(0,0,0,1),30),((0,0,0),(0,0,0,0),30),((0,0,0),(0,0,0,1),54001)]:
            write_vmd(Vmd(bones=[BoneKey('上半身',frame,pos,rot)]),path)
            with self.assertRaises(ValueError):checked_vmd(path)
    def testCLIProtectsExistingOutputAndInputLibrary(self):
        source=self.root/'library';source.mkdir();keep=source/'keep';keep.write_text('unchanged')
        for output,reason in [(source/'new-generation','output_inside_input_library'),(source,'output_already_exists')]:
            result=subprocess.run([sys.executable,str(CHARACTERS/'build.py'),'import_vmd','--library',str(source),
                '--vmd',str(self.motion()),'--character','aster','--output',str(output)],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0);self.assertIn(reason,result.stderr)
            self.assertEqual(keep.read_text(),'unchanged')
        self.assertEqual(list(source.iterdir()),[keep])
    def testPMDRejectsCyclesAndBadIK(self):
        path=self.root/'reference.pmd';p=build_pmd();write_pmd(p,path);self.assertTrue(checked_pmd(path).bones)
        p.bones[0].parent=0;write_pmd(p,path)
        with self.assertRaisesRegex(ValueError,'cyclic'):checked_pmd(path)
        path.write_bytes(b'Pmd')
        with self.assertRaises(ValueError):checked_pmd(path)
    def testRetargetUsesNativeSkeletonAndRoundTripsCoordinates(self):
        doc=authored_rig();rig=NativeRig(doc,humanoid_map(doc))
        q,t=rig.unity_pose(rig.q0,rig.t0)
        np.testing.assert_allclose(t,[n['position']for n in doc['nodes']]);np.testing.assert_allclose(q,[n['rotation']for n in doc['nodes']])
        sk=MmdSkeleton(add_semi_standard_bones(build_pmd()));conv=VmdToNative(rig,Retarget,sk)
        result=conv.bake(sk.evaluate_vmd(checked_vmd(self.motion()),31))
        self.assertEqual(result['Q'].shape,(31,len(doc['nodes']),4));self.assertTrue(np.isfinite(result['Q']).all())
        self.assertGreater(np.max(abs(result['Q'][0]-result['Q'][-1])),.05)
        doc['nodes'][0]['scale']=[.7,.7,.7];scaled=NativeRig(doc,humanoid_map(doc))
        np.testing.assert_allclose(scaled.s[0],[.7,.7,.7])
        doc['nodes'][1]['parent']=5
        with self.assertRaises(ValueError):NativeRig(doc,humanoid_map(doc))
    def testFootIKMatchesPerFrameSolveLimb(self):
        """The bake's foot IK equals Rig.solve_limb run frame by frame on the IK-free bake (leg nodes carry no twist)."""
        doc=authored_rig();rig=NativeRig(doc,humanoid_map(doc));sk=MmdSkeleton(add_semi_standard_bones(build_pmd()));conv=VmdToNative(rig,Retarget,sk)
        path=self.root/'step.vmd'
        write_vmd(Vmd(bones=[BoneKey('センター',0,(0,0,0),(0,0,0,1)),BoneKey('センター',12,(0,-2.5,.8),(0,0,0,1)),BoneKey('センター',24,(0,0,0),(0,0,0,1)),
                            BoneKey('左足ＩＫ',0,(0,0,0),(0,0,0,1)),BoneKey('左足ＩＫ',12,(.6,1.5,1.2),(0,math.sin(.3),0,math.cos(.3))),
                            BoneKey('右足ＩＫ',24,(0,6,-1),(0,0,0,1))]),path)
        ev=sk.evaluate_vmd(checked_vmd(path),25);ik=conv.bake(ev,foot_ik=True);fk=conv.bake(ev)
        wp,C,overshoot=ev['wp'],conv.C,0
        for f in range(25):
            q=fk['Q'][f].copy();w=rig.fk(q,fk['T'][f])
            for side in 'LR':
                th,ca,fo,to=conv.leg[side];a=conv.src_ankle[side]
                fwd=w[to,:3,3]-w[fo,:3,3];fwd[1]=0
                overshoot=max(overshoot,rig.solve_limb(q,fk['T'][f],(th,ca,fo),fk['P'][0,fo]+fk['scale']*C@(wp[f,a]-wp[0,a]),endR=rig.rotations(w)[fo],
                                                       hint=w[ca,:3,3]-w[th,:3,3]+.05*fwd/max(np.linalg.norm(fwd),1e-12)))
            legs=[j for side in 'LR' for j in conv.leg[side][:3]]
            np.testing.assert_allclose(ik['Q'][f][legs],q[legs],rtol=0,atol=1e-9)
        self.assertAlmostEqual(ik['overshoot_max_m'],overshoot,delta=1e-9)
        self.assertGreater(np.max(abs(ik['Q']-fk['Q'])),.02)
    def baked(self,rig,foot_ik):
        sk=MmdSkeleton(add_semi_standard_bones(build_pmd()));conv=VmdToNative(rig,Retarget,sk)
        result=conv.bake(sk.evaluate_vmd(checked_vmd(step_vmd(self.root/'step.vmd')),25),foot_ik=foot_ik)
        return b''.join(result[k].tobytes() for k in 'QTP')
    def testHumanoidMapAloneDrivesARenamedRigByteForByte(self):
        doc=authored_rig();humanoid=humanoid_map(doc);other,other_map=renamed(doc,humanoid)
        for foot_ik in [False,True]:
            self.assertEqual(self.baked(NativeRig(other,other_map),foot_ik),self.baked(NativeRig(doc,humanoid),foot_ik))
    def testHumanoidMapIsChecked(self):
        doc=authored_rig()
        for change,reason in [(lambda h:h['bones'].pop('leftFoot'),'humanoid_map_lacks: leftFoot'),
                              (lambda h:h['bones'].update(head='Nowhere'),'humanoid_node_missing: head'),
                              (lambda h:h.update(schema='other'),'invalid_humanoid_map')]:
            humanoid=humanoid_map(doc);change(humanoid)
            with self.assertRaisesRegex(ValueError,reason):NativeRig(doc,humanoid)
    def testARigWithoutAHumanoidMapIsRefused(self):
        doc=authored_rig()
        for build in [NativeRig,stance.Rig,Poses,secondary_fit.roles,secondary_fit.twist_rules]:
            with self.subTest(build.__qualname__),self.assertRaisesRegex(ValueError,'humanoid_map_missing'):build(doc)
    def testPackListsTheHumanoidMap(self):
        pack=self.root/'c7/pack.json';animation=pack.parent/'animation';animation.mkdir(parents=True)
        pack.write_text(json.dumps(dict(animation=dict(data=[]))));self.assertIsNone(pack_humanoid(pack))
        path=animation/'humanoid.json';path.write_text(json.dumps(humanoid_map(authored_rig())))
        pack.write_text(json.dumps(dict(animation=dict(data=[ref(path,animation)]))))
        self.assertEqual(pack_humanoid(pack),humanoid_map(authored_rig()))
        path.write_text('{}')
        with self.assertRaisesRegex(ValueError,'sha256'):pack_humanoid(pack)
    def testNativeCurveAndOraclePayloadKeepsRestScales(self):
        doc=authored_rig();doc['nodes'][0]['scale']=[.7,.7,.7];rig=NativeRig(doc,humanoid_map(doc))
        path=self.root/'manifest.json';path.write_text(json.dumps(dict(clips=[],source_bundle_sha256='a'*64)))
        q=np.broadcast_to([0.,0,0,1],(3,rig.N,4)).copy();q[1,:,3]=-1;q[2,:,1]=.1
        t=np.broadcast_to(np.array([n['position']for n in doc['nodes']]),(3,rig.N,3)).copy()
        metadata=append_clip(self.root,path,doc,'authored',q,t,30,dict(vmd_sha256='b'*64))
        self.assertEqual(metadata['length'],2/30);self.assertFalse(metadata['independent_game_oracle'])
        self.assertTrue(all(c['attribute']=='rotation'for c in metadata['curves']))
        oracle=(self.root/metadata['oracle']['file']).read_bytes()
        np.testing.assert_allclose(struct.unpack_from('<10f',oracle,8)[7:],[.7,.7,.7])
        self.assertTrue(np.all(np.sum(q[:-1]*q[1:],axis=2)>=0))
        with self.assertRaisesRegex(ValueError,'already_imported'):append_clip(self.root,path,doc,'authored',q,t,30,dict(vmd_sha256='b'*64))
    def testMusicTrimPaddingAndNativeDependencyClosure(self):
        source=self.root/'stereo.wav'
        with wave.open(str(source),'wb')as w:
            w.setparams((2,2,48000,0,'NONE','not compressed'));w.writeframes(struct.pack('<hh',800,-400)*4800)
        output=self.root/'animation/music/test.wav';report=prepare_music(source,output,.05,.1)
        self.assertEqual(report['padded_frames'],2400)
        with wave.open(str(output),'rb')as w:
            self.assertEqual(w.getnframes(),4800);self.assertEqual(struct.unpack('<hh',w.readframes(1)),(800,-400))
            w.setpos(4799);self.assertEqual(w.readframes(1),bytes(4))
        doc=dict(schema='endfield-motion-media/v1',tracks=[dict(audio=ref(output,self.root/'animation'))])
        deps=list(native_bundle.references(doc,'motion_media'))
        self.assertEqual(deps[0][1]['file'],'music/test.wav')
        with self.assertRaises(ValueError):prepare_music(source,output,float('nan'),.1)
    def testNegativeMusicStartLeadsWithSilence(self):
        source=self.root/'stereo.wav'
        with wave.open(str(source),'wb')as w:
            w.setparams((2,2,48000,0,'NONE','not compressed'));w.writeframes(struct.pack('<hh',800,-400)*4800)
        output=self.root/'music/early.wav';report=prepare_music(source,output,-.05,.1)
        self.assertEqual(report['source_start_seconds'],-.05);self.assertEqual(report['frames'],4800)
        with wave.open(str(output),'rb')as w:
            self.assertEqual(w.getnframes(),4800);self.assertEqual(w.readframes(2400),bytes(2400*4))
            self.assertEqual(struct.unpack('<hh',w.readframes(1)),(800,-400))
            w.setpos(4799);self.assertEqual(struct.unpack('<hh',w.readframes(1)),(800,-400))
        report=prepare_music(source,self.root/'music/late.wav',-1,.1)
        with wave.open(str(self.root/'music/late.wav'),'rb')as w:self.assertEqual(w.readframes(4800),bytes(4800*4))
    def testMotionRangeIs360Seconds(self):
        sys.path.insert(0,str(CHARACTERS.parent/'agent/agentd/tests'))
        from test_motion_tool import motion_fixture
        source=self.root/'source';motion_fixture(source,rig=authored_rig())
        for frame,reason in [(10800,'pmd_file_limit'),(10830,'motion_range_limit_360_seconds')]:
            path=self.root/f'long{frame}.vmd'
            write_vmd(Vmd(bones=[BoneKey('上半身',0,(0,0,0),(0,0,0,1)),BoneKey('上半身',frame,(0,0,0),(0,0,0,1))]),path)
            # A missing source model fails right after the range check, before any sampling.
            with self.subTest(frame=frame),self.assertRaisesRegex(ValueError,reason):
                import_motion(source,path,self.root/f'out{frame}',source_model=self.root/'missing.pmd')
    def testMorphSectionTakesAMillionKeys(self):
        path=self.root/'many.vmd'
        write_vmd(Vmd(morphs=[MorphKey('あ',f//12,.5) for f in range(600000)]),path)
        self.assertEqual(len(checked_morph_vmd(path).morphs),600000)
    def testFaceBudgetIsTheRenderersClipBudget(self):
        from agentic_complex_build.mmd import morph
        values=lambda n:np.where(np.arange(n)%2,.75,0)+np.random.default_rng(0).random(n)*.25
        curves,tol=morph.budgeted({'c':values(19000)})
        self.assertEqual((len(curves['c']),tol),(19000,.002))
        self.assertIsNone(morph.budgeted({'c':values(20001)}))
        self.assertIsNone(morph.budgeted({f'c{k}':np.zeros(2) for k in range(257)}))

    def testFaceSlotsTakeOnlyTheirRulesControlClass(self):
        from agentic_complex_build.mmd import morph
        rules=json.loads((CHARACTERS/'agentic_complex_build/mmd/face-slots.json').read_text(encoding='utf-8'))['slots']
        posed=sorted({r['pose'] for r in rules.values() if 'pose' in r})
        controls=lambda p:[f'eye_{p}_L_ctrl',f'brow_{p}_R_ctrl',f'mouth_{p}_ctrl']
        face=dict(controls=[dict(name=c,bones=['b']) for p in posed+['A'] for c in controls(p)],
                  poses=[dict(name=p,weights=[dict(control=c,weight=.5) for c in controls(p)]) for p in posed+['A']],
                  lipsync_groups=[dict(label='normal',vowels=dict(a='A'))])
        mapping=morph.resolve(face,dict(default='normal'),None,None)
        self.assertEqual(mapping['あ'],[(c,.5) for c in controls('A')])
        slots=morph.load_slots()
        for name,slot in slots.items():
            rule=rules[slot]
            if 'pose' not in rule:continue
            with self.subTest(name=name):
                self.assertEqual(mapping[name],[(c,.5*rule['weight']) for c in controls(rule['pose']) if c.startswith(rule['controls']+'_')])
        self.assertEqual([c for c,_ in mapping['笑い']],['eye_data_facialmorph_emotion_happysquinta_L_ctrl'])
        self.assertEqual([c for c,_ in mapping['困る']],['brow_data_facialmorph_emotion_worrieda_R_ctrl'])
        self.assertEqual([c for c,_ in mapping['ω']],['mouth_data_facialmorph_pose_happy_w_01_ctrl'])
        self.assertFalse({n for n,s in slots.items() if s.startswith('blink')}&mapping.keys())
    def testBlinkSlotsCloseTheirSide(self):
        from agentic_complex_build.mmd import morph
        names=['eye_close_L_ctrl','eye_close_R_ctrl','eye_scale_d_L_ctrl','eye_scale_d_R_ctrl','brow_offset_d_L_ctrl']
        face=dict(controls=[dict(name=c,bones=[] if c.startswith('brow') else ['b']) for c in names],poses=[],
                  lipsync_groups=[dict(label='normal',vowels={})])
        mapping=morph.resolve(face,dict(default='normal'),None,dict(zip(names,[1,1,.3,.3,.16])))
        self.assertEqual(sorted(mapping['まばたき']),[('eye_close_L_ctrl',1),('eye_close_R_ctrl',1),('eye_scale_d_L_ctrl',.3),('eye_scale_d_R_ctrl',.3)])
        for name in ['ウィンク','ウィンク２']:self.assertEqual(sorted(mapping[name]),[('eye_close_L_ctrl',1),('eye_scale_d_L_ctrl',.3)])
        for name in ['ウィンク右','ｳｨﾝｸ２右']:self.assertEqual(sorted(mapping[name]),[('eye_close_R_ctrl',1),('eye_scale_d_R_ctrl',.3)])
    def testBlinkNeedsThePaletteContract(self):
        from agentic_complex_build.import_vmd import package_face
        from character_library import Package
        sys.path.insert(0,str(CHARACTERS.parent/'agent/agentd/tests'))
        from test_motion_tool import motion_fixture
        doc=authored_rig()
        face={'original-face-controls.json':dict(schema='endfield-original-face-controls-v2',
                  controls=[dict(name='jaw_open',bones=['jawJoint']),dict(name='eye_close_L_ctrl',bones=['eyeL']),
                            dict(name='eye_close_R_ctrl',bones=['eyeR']),dict(name='brow_offset_d_L_ctrl',bones=[])],
                  poses=[dict(name='A',weights=[dict(control='jaw_open',weight=1.0)])],
                  lipsync_groups=[dict(label='normal',vowels=dict(a='A'))]),
              'emotion-lipsync.json':dict(default='normal')}
        curve=lambda control,peak:dict(control=control,curve=dict(m_Curve=[dict(time=0,value=0),dict(time=.25,value=peak),dict(time=.5,value=0)]))
        palette={'palette-contract.json':dict(blink=dict(duration=.5,curves=[curve('eye_close_L_ctrl',1.0),curve('eye_close_R_ctrl',.9),curve('brow_offset_d_L_ctrl',.16)]))}
        vmd=self.root/'blink.vmd'
        write_vmd(Vmd(bones=[BoneKey('上半身',0,(0,0,0),(0,0,0,1)),BoneKey('上半身',30,(0,0,0),(0,math.sin(.2),0,math.cos(.2)))],
                      morphs=[MorphKey('まばたき',0,0),MorphKey('まばたき',15,1),MorphKey('まばたき',30,0),MorphKey('あ',0,0),MorphKey('あ',30,1)]),vmd)
        for case,animation in [('palette',dict(face,**palette)),('none',face)]:
            source=self.root/('source-'+case);motion_fixture(source,rig=doc,motion=dict(animation=animation))
            blink=package_face(Package(source,deep=False))[3]
            self.assertEqual(blink,dict(eye_close_L_ctrl=1.0,eye_close_R_ctrl=.9,brow_offset_d_L_ctrl=.16) if case=='palette' else None)
            out=self.root/('imported-'+case);report=import_motion(source,vmd,out,foot_ik=False)
            clip=json.loads((out/'runtime'/report['face']['file']).read_text(encoding='utf-8'))
            controls=sorted(c['control'] for c in clip['curves'])
            with self.subTest(case=case):
                if case=='palette':
                    self.assertTrue(clip['pause_auto_blink']);self.assertIn('まばたき',report['face']['mapped'])
                    self.assertEqual(controls,['eye_close_L_ctrl','eye_close_R_ctrl','jaw_open'])
                    peak=next(c for c in clip['curves'] if c['control']=='eye_close_R_ctrl')
                    self.assertAlmostEqual(max(k['value'] for k in peak['curve']['m_curve']),.9,places=5)
                else:
                    self.assertFalse(clip['pause_auto_blink']);self.assertIn('まばたき',report['face']['unmapped'])
                    self.assertEqual(controls,['jaw_open'])
    def testCheckedMorphVmdAndAutoFpsAndToeEX(self):
        morph_only=self.root/'morph.vmd'
        write_vmd(Vmd(morphs=[MorphKey('あ',0,0.0),MorphKey('あ',30,1.0),MorphKey('まばたき',60,0.8)]),morph_only)
        with self.assertRaises(ValueError):checked_vmd(morph_only)
        parsed=checked_morph_vmd(morph_only)
        self.assertEqual(len(parsed.morphs),3)

        body60=self.root/'dance60.vmd'
        keys=[]
        for f in range(0,121):
            a=0.35*math.sin(f*math.pi/60.0)
            keys.append(BoneKey('上半身',f,(0,0,0),(0,math.sin(a/2),0,math.cos(a/2))))
        keys+=[BoneKey('左足先EX',0,(0,0,0),(0,0,0,1)),BoneKey('左足先EX',60,(0,0,0),(math.sin(.25),0,0,math.cos(.25)))]
        write_vmd(Vmd(bones=keys),body60)

        from agentic_complex_build.mmd.io import detect_source_fps
        self.assertEqual(detect_source_fps(checked_vmd(body60),parsed),60.0)

        doc=authored_rig();hum=humanoid_map(doc)
        rig=NativeRig(doc,hum)
        sk=MmdSkeleton(add_semi_standard_bones(build_pmd()))
        self.assertIn('左足先EX',sk.idx);self.assertIn('右足先EX',sk.idx)
        ev60=sk.evaluate_vmd(checked_vmd(body60),frame_times=np.arange(0,61,dtype=float)*2.0)
        conv=VmdToNative(rig,Retarget,sk)
        cov={row['bone']:row['status'] for row in conv and __import__('agentic_complex_build.mmd.retarget',fromlist=['coverage']).coverage(conv,checked_vmd(body60))['bones']}
        self.assertEqual(cov['左足先EX'],'mapped')
        bake=conv.bake(ev60)
        toes_q=bake['Q'][:,rig.humanoid['leftToes']]
        self.assertGreater(np.max(np.abs(toes_q[30]-toes_q[0])),0.05)

    def testPchipTangentsAndSourceFpsAndPrerollImport(self):
        doc=authored_rig();rig=NativeRig(doc,humanoid_map(doc))
        # Plateau + step input checks zero overshoot and C1 tangent continuity (in == out).
        frames=6
        q=np.broadcast_to([0.,0,0,1],(frames,rig.N,4)).copy()
        t=np.broadcast_to(np.array([n['position']for n in doc['nodes']]),(frames,rig.N,3)).copy()
        vals=np.array([0.0,0.0,0.5,1.0,1.0,1.0])
        t[:,0,1]+=vals
        meta,keys=encode_clip(doc,'pchip_test',q,t,30,dict(vmd_sha256='c'*64),tangent_mode='pchip')
        curve=next(c for c in meta['curves'] if c['node']==0 and c['attribute']=='position' and c['component']==1)
        rows=[struct.unpack_from('<6fI',keys,curve['offset']+28*i) for i in range(curve['count'])]
        for time_v,val_v,in_t,out_t,_,_,_ in rows:
            self.assertAlmostEqual(in_t,out_t,places=6)
        # Flat plateau knots 0, 4, 5 must have 0 slope (no cubic ring/overshoot).
        self.assertAlmostEqual(rows[0][2],0.0,places=6)
        self.assertAlmostEqual(rows[4][2],0.0,places=6)
        self.assertAlmostEqual(rows[5][2],0.0,places=6)
        # Midpoint of smooth ramp (segment 1->2 vs 2->3) must have non-linear Hermite cubic coefficients.
        dt=rows[2][0]-rows[1][0]
        m0=rows[1][3]*dt;m1=rows[2][2]*dt
        a_coef=2*rows[1][1]-2*rows[2][1]+m0+m1
        self.assertGreater(abs(a_coef),1e-4)

        # Full import_motion test with source_fps=60, paired morph_vmd, and preroll=0.5s.
        sys.path.insert(0,str(CHARACTERS.parent/'agent/agentd/tests'))
        from test_motion_tool import motion_fixture
        source=self.root/'source';motion_fixture(source,rig=doc,motion=dict(animation={
            'original-face-controls.json':dict(
                schema='endfield-original-face-controls-v2',
                controls=[dict(name='jaw_open',bones=['jawJoint'])],
                poses=[dict(name='A',weights=[dict(control='jaw_open',weight=1.0)])],
                lipsync_groups=[dict(label='neutral',vowels=dict(a='A'))]),
            'emotion-lipsync.json':dict(default='neutral')}))
        vmd_path=self.root/'b60.vmd'
        bones=[BoneKey('上半身',f,(0,0,0),(0,math.sin(0.25*f/60.0),0,math.cos(0.25*f/60.0))) for f in range(0,121,2)]
        write_vmd(Vmd(bones=bones),vmd_path)
        morph_path=self.root/'expr.vmd'
        write_vmd(Vmd(morphs=[MorphKey('あ',0,0.0),MorphKey('あ',60,0.9)]),morph_path)
        out_pkg=self.root/'imported_60'
        report=import_motion(source,vmd_path,out_pkg,source_fps=60,morph_vmd=morph_path,morph_fps=30,preroll=0.5)
        # 120 frames @ 60fps = 2.0s + 0.5s preroll = 2.5s (76 frames @ 30fps).
        self.assertAlmostEqual(report['duration'],2.5,places=5)
        self.assertEqual(report['frames'],76)
        manifest=json.loads((out_pkg/'runtime/actor.json').read_text())
        imported=next(c for c in manifest['clips'] if c['name']==report['clip'])
        self.assertAlmostEqual(imported['length'],2.5,places=5)
        self.assertEqual(report['face']['facial_animation'],report['action'])
        self.assertIn('あ',report['face']['mapped'])
        native_bundle.verify(out_pkg/'runtime')

    def testS3PchipTangentOrthogonalityAndPrerollSeamContinuity(self):
        doc=authored_rig();rig=NativeRig(doc,humanoid_map(doc))
        frames=12
        q=np.broadcast_to([0.,0,0,1],(frames,rig.N,4)).copy()
        angles=np.linspace(0.0,1.4,frames)
        # Non-planar rotation trajectory on spine node 1 so multiple quaternion components hit extrema.
        for f,a in enumerate(angles):
            ax=np.array([0.6,0.8,0.2*math.sin(a)])
            ax/=np.linalg.norm(ax)
            q[f,1]=np.array([math.sin(a/2)*ax[0],math.sin(a/2)*ax[1],math.sin(a/2)*ax[2],math.cos(a/2)])
        t=np.broadcast_to(np.array([n['position']for n in doc['nodes']]),(frames,rig.N,3)).copy()
        meta,keys=encode_clip(doc,'s3_pchip',q,t,30,dict(vmd_sha256='d'*64),tangent_mode='pchip')
        rot_curves={c['component']:c for c in meta['curves'] if c['node']==1 and c['attribute']=='rotation'}
        self.assertEqual(set(rot_curves.keys()),{0,1,2,3})
        deriv=np.zeros((frames,4),dtype=float)
        for comp,c in rot_curves.items():
            self.assertEqual(c['count'],frames)
            for k in range(frames):
                _,_,in_t,out_t,_,_,_=struct.unpack_from('<6fI',keys,c['offset']+28*k)
                self.assertAlmostEqual(in_t,out_t,places=6)
                deriv[k,comp]=in_t
        dots=np.sum(q[:,1]*deriv,axis=1)
        self.assertLess(float(np.max(np.abs(dots))),1e-6)

        # C1 velocity continuity across the preroll-to-motion seam when frame 0 has non-zero linear and angular velocity.
        sys.path.insert(0,str(CHARACTERS.parent/'agent/agentd/tests'))
        from test_motion_tool import motion_fixture
        source=self.root/'source_seam';motion_fixture(source,rig=doc)
        vmd_seam=self.root/'seam.vmd'
        # Constant angular velocity on 上半身 and constant linear velocity on センター from frame 0 onward.
        bones=[]
        for f in range(0,31):
            a=2.0*(f/30.0)
            bones.append(BoneKey('上半身',f,(0,0,0),(math.sin(a/2)*0.0,math.sin(a/2)*1.0,0.0,math.cos(a/2))))
            bones.append(BoneKey('センター',f,(0.0,0.0,3.0*(f/30.0)),(0,0,0,1)))
        write_vmd(Vmd(bones=bones),vmd_seam)
        out_pkg=self.root/'imported_seam'
        report=import_motion(source,vmd_seam,out_pkg,source_fps=30,preroll=0.5,foot_ik=False)
        clip_rel=json.loads((out_pkg/'runtime/actor.json').read_text())['clips'][-1]['file']
        clip_meta=json.loads((out_pkg/'runtime'/clip_rel).read_text())
        key_bytes=(out_pkg/'runtime'/clip_meta['keys']['file']).read_bytes()
        spine_idx=rig.humanoid['spine'];hips_idx=rig.humanoid['hips']
        pf=round(0.5*30)
        # Check linear Z velocity continuity across seam index pf.
        pos_z=next(c for c in clip_meta['curves'] if c['node']==hips_idx and c['attribute']=='position' and c['component']==2)
        z_vals=[struct.unpack_from('<6fI',key_bytes,pos_z['offset']+28*k)[1] for k in range(pf-2,pf+3)]
        v_pre=(z_vals[2]-z_vals[1])*30.0;v_post=(z_vals[3]-z_vals[2])*30.0
        self.assertAlmostEqual(v_pre,v_post,delta=0.05)
        # Check S^3 quaternion secant derivative continuity across seam index pf on rotated spine node.
        q_seam=np.zeros((3,4),dtype=float)
        for comp in range(4):
            c=next((x for x in clip_meta['curves'] if x['node']==spine_idx and x['attribute']=='rotation' and x['component']==comp),None)
            if c is None:
                q_seam[:,comp]=doc['nodes'][spine_idx]['rotation'][comp]
            else:
                for idx_k,k in enumerate((pf-1,pf,pf+1)):
                    q_seam[idx_k,comp]=struct.unpack_from('<6fI',key_bytes,c['offset']+28*k)[1]
        from agentic_complex_build.mmd import rotation
        from agentic_complex_build.mmd.skeleton import qconj,qmul
        w_pre=rotation.as_rotvec(qmul(q_seam[1],qconj(q_seam[0])))*30.0
        w_post=rotation.as_rotvec(qmul(q_seam[2],qconj(q_seam[1])))*30.0
        self.assertLess(float(np.linalg.norm(w_pre-w_post)),0.15)

    def testImportRewritesThePackagesMotionGraphWithTheNewClip(self):
        from agentic_complex_build.motion_graph import FILE as GRAPH,graft
        sys.path.insert(0,str(CHARACTERS.parent/'agent/agentd/tests'))
        from test_motion_tool import motion_fixture
        doc=authored_rig();source=self.root/'source';motion_fixture(source,rig=doc)
        grafted=self.root/'grafted';graft(source,grafted)
        report=import_motion(grafted,self.motion(),self.root/'imported',foot_ik=False)
        graph=json.loads((self.root/'imported/runtime/animation'/GRAPH).read_text(encoding='utf-8'))
        self.assertIn(report['clip'],[c['name'] for c in graph['clips']])
        native_bundle.verify(self.root/'imported/runtime')


if __name__=='__main__':unittest.main()
