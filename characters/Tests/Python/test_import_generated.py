"""Authored fixtures only: a SOMA-30 skeleton laid on the authored rig, synthetic Kimodo outputs, no model or game assets."""
from dataclasses import replace
import hashlib
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
CHARACTERS=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(CHARACTERS),str(Path(__file__).resolve().parent),str(CHARACTERS.parent/'agent/agentd/tests')]
from agentic_complex_build import secondary_fit,stance
from agentic_complex_build.import_generated import SomaToRig,import_generated
from agentic_complex_build.import_vmd import import_motion
from agentic_complex_build.secondary_fit import _oracle
from agentic_complex_build.mmd import rotation
from agentic_complex_build.mmd.native_rig import NativeRig
from agentic_complex_build.motion_import import bvh
from agentic_complex_build.motion_import.bake import HumanoidToRig,resample_fingers
from agentic_complex_build.motion_import.take import resample
from character_library import Package,read_json
import native_bundle
from test_bvh_import import cmu_bvh_text
from test_vmd_import import authored_rig,humanoid_map,renamed,step_vmd
from test_motion_tool import motion_fixture

SOMA=['Hips','Spine1','Spine2','Chest','Neck1','Neck2','Head','Jaw','LeftEye','RightEye',
      'LeftShoulder','LeftArm','LeftForeArm','LeftHand','LeftHandThumbEnd','LeftHandMiddleEnd',
      'RightShoulder','RightArm','RightForeArm','RightHand','RightHandThumbEnd','RightHandMiddleEnd',
      'LeftLeg','LeftShin','LeftFoot','LeftToeBase','RightLeg','RightShin','RightFoot','RightToeBase']
PARENTS=[-1,0,1,2,3,4,5,6,6,6,3,10,11,12,13,13,3,16,17,18,19,19,0,22,23,24,0,26,27,28]


def twisted_rig():
    """authored_rig plus the upper-arm and forearm twist nodes the TWISTS table drives."""
    doc=authored_rig();rest=NativeRig(doc,humanoid_map(doc)).rest[:,:3,3];ids={n['path']:n['index']for n in doc['nodes']}
    for side in 'LR':
        for chain,start,end in [([f'Bip001_{side}UpArmTwist',f'Bip001_{side}UpArmTwist1'],'UpperArm','Forearm'),
                                ([f'Bip001_{side}_ForeTwist',f'Bip001_{side}_ForeTwist1'],'Forearm','Hand')]:
            a,b=rest[ids[f'Bip001_{side}_{start}']],rest[ids[f'Bip001_{side}_{end}']];parent=ids[f'Bip001_{side}_{start}'];last=a
            for k,name in enumerate(chain):
                p=a+(b-a)*(k+1)/3;index=len(doc['nodes']);ids[name]=index
                doc['nodes'].append(dict(index=index,parent=parent,path=name,gltf_node_index=index,
                                         position=((p-last)*[-1,1,1]).tolist(),rotation=[0,0,0,1],scale=[1,1,1]))
                parent=index;last=p
    return doc


def soma_skeleton(rig):
    """SOMA joints placed on the rig's rest joints, so the calibration of every mapped node is its rest rotation."""
    at=lambda name:rig.rest[rig.ids[name],:3,3]
    where=dict(Hips='Bip001',Spine1='Bip001_Spine',Spine2='Bip001_Spine1',Chest='Bip001_Spine2',Neck1='Bip001_Neck',Head='Bip001_Head')
    for side,word in [('L','Left'),('R','Right')]:
        for soma,node in [('Shoulder','Clavicle'),('Arm','UpperArm'),('ForeArm','Forearm'),('Hand','Hand'),('HandThumbEnd','Finger0'),
                          ('HandMiddleEnd','Finger2'),('Leg','Thigh'),('Shin','Calf'),('Foot','Foot'),('ToeBase','Toe0')]:where[word+soma]=f'Bip001_{side}_{node}'
    neutral={k:at(v)for k,v in where.items()}
    neutral['Neck2']=(neutral['Neck1']+neutral['Head'])/2;neutral['Jaw']=neutral['Head']+[0,.05,.05]
    neutral['LeftEye']=neutral['Head']+[.03,.08,.08];neutral['RightEye']=neutral['Head']+[-.03,.08,.08]
    return dict(names=SOMA,parents=PARENTS,neutral_joints=[neutral[n].tolist()for n in SOMA],foot_indices=[24,25,28,29])


def rotvec_matrix(v):return rotation.as_matrix(rotation.from_rotvec(np.asarray(v,float)))
def rotation_angles(a,b):return np.degrees(2*np.arccos(np.clip(np.abs(np.sum(a*b,-1)),0,1)))
def steps(q):return rotation_angles(q[:-1],q[1:])


class GeneratedImportTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.doc=twisted_rig();self.rig=NativeRig(self.doc,humanoid_map(self.doc));self.sk=soma_skeleton(self.rig)
        self.neutral=np.array(self.sk['neutral_joints']);self.si={n:i for i,n in enumerate(SOMA)}
    def tearDown(self):self.temp.cleanup()
    def still(self,frames):
        return np.repeat(self.neutral[None],frames,0),np.broadcast_to(np.eye(3),(frames,30,3,3)).copy(),np.zeros((frames,4),bool)
    def npz(self,name,xyz,rot,contacts):
        path=self.root/(name+'.npz')
        np.savez(path,posed_joints=xyz[None],global_rot_mats=rot[None],foot_contacts=contacts[None],fps=np.int64(30))
        return path
    def testIdentityRotationsAtNeutralKeepTheRestPose(self):
        Q,T,info=SomaToRig(self.rig,self.sk).bake(*self.still(4))
        q,t=self.rig.unity_pose(Q,T)
        rest_q=np.array([n['rotation']for n in self.doc['nodes']]);rest_t=np.array([n['position']for n in self.doc['nodes']])
        np.testing.assert_allclose(np.abs(np.sum(q*rest_q,-1)),1,atol=1e-5);np.testing.assert_allclose(t,np.broadcast_to(rest_t,t.shape),atol=1e-5)
        self.assertEqual(info['twist_nodes'],8);self.assertTrue(info['finite']);self.assertEqual(info['contact_intervals'],dict(L=0,R=0))
    def testForearmRollIsSharedOverTheForeTwistNodes(self):
        xyz,rot,contacts=self.still(3);si=self.si
        axis=self.neutral[si['RightHand']]-self.neutral[si['RightForeArm']];axis/=np.linalg.norm(axis)
        rot[:,si['RightHand']]=rotvec_matrix(axis*math.radians(60))
        Q,_,_=SomaToRig(self.rig,self.sk).bake(xyz,rot,contacts)
        ids=self.rig.ids;first,second=Q[0,ids['Bip001_R_ForeTwist']],Q[0,ids['Bip001_R_ForeTwist1']]
        np.testing.assert_allclose(rotation.as_rotvec(first),axis*math.radians(20),atol=1e-6)
        np.testing.assert_allclose(rotation.as_rotvec(rotation.compose(first,second)),axis*math.radians(40),atol=1e-6)
        for name in ['Bip001_RUpArmTwist','Bip001_L_ForeTwist']:np.testing.assert_allclose(rotation.as_rotvec(Q[0,ids[name]]),0,atol=1e-6)
    def rolled_hand(self):
        xyz,rot,contacts=self.still(3);si=self.si
        axis=self.neutral[si['RightHand']]-self.neutral[si['RightForeArm']];axis/=np.linalg.norm(axis)
        rot[:,si['RightHand']]=rotvec_matrix(axis*math.radians(60));return xyz,rot,contacts
    def testHumanoidMapNamesTheTwistNodesOrNoneShareTheRoll(self):
        xyz,rot,contacts=self.rolled_hand();Q,T,_=SomaToRig(self.rig,self.sk).bake(xyz,rot,contacts)
        humanoid=humanoid_map(self.doc);other,other_map=renamed(self.doc,humanoid)
        for doc,hum in [(self.doc,humanoid),(other,other_map)]:
            q,t,info=SomaToRig(NativeRig(doc,hum),self.sk).bake(xyz,rot,contacts)
            self.assertEqual((q.tobytes(),t.tobytes(),info['twist_nodes']),(Q.tobytes(),T.tobytes(),8))
        del other_map['extras'];rig=NativeRig(other,other_map)
        q,_,info=SomaToRig(rig,self.sk).bake(xyz,rot,contacts);self.assertEqual(info['twist_nodes'],0)
        twists=[n['index']for n in other['nodes']if 'Roll' in n['path']];self.assertEqual(len(twists),8)
        np.testing.assert_array_equal(q[:,twists],np.broadcast_to(rig.q0[twists],q[:,twists].shape))
    def testHumanoidTakeBakesOntoARenamedRigByItsHumanoidMap(self):
        path=self.root/'walk.bvh';path.write_text(cmu_bvh_text(fingers=True));take=bvh.load(path)
        take=replace(resample(take,30),fingers=resample_fingers(take,30))
        humanoid=humanoid_map(self.doc);other,other_map=renamed(self.doc,humanoid)
        Q,T,info=HumanoidToRig(self.rig,take).bake()
        self.assertEqual((info['twist_nodes'],info['finger_nodes']),(8,3))
        for doc,hum in [(self.doc,humanoid),(other,other_map)]:
            q,t,got=HumanoidToRig(NativeRig(doc,hum),take).bake()
            self.assertEqual((q.tobytes(),t.tobytes(),got),(Q.tobytes(),T.tobytes(),info))
    def testStanceAndSecondaryRolesFollowTheHumanoidMap(self):
        humanoid=humanoid_map(self.doc);other,other_map=renamed(self.doc,humanoid)
        plain,moved=stance.Rig(self.doc,humanoid),stance.Rig(other,other_map)
        self.assertEqual((moved.bones,moved.reference.tolist()),(plain.bones,plain.reference.tolist()))
        def indices(doc,roles):
            names=[n['path'].rsplit('/',1)[-1]for n in doc['nodes']];body,kinds,fingers=roles
            return ([names.index(n)for n in body],{names.index(n):k for n,k in kinds.items()},
                    {side:sorted(names.index(n)for n in fingers[side])for side in 'LR'})
        roles=indices(self.doc,secondary_fit.roles(self.doc,humanoid))
        self.assertEqual(indices(other,secondary_fit.roles(other,other_map)),roles)
        self.assertEqual((len(roles[0]),list(roles[1].values()).count('twist'),len(roles[2]['L'])),(21,8,15))
        rules=lambda doc,hum:[(k,v[3])for k,v in secondary_fit.twist_rules(doc,hum).items()]
        self.assertEqual(len(rules(self.doc,humanoid)),8)
        self.assertEqual([share for _,share in rules(other,other_map)],[share for _,share in rules(self.doc,humanoid)])
    def testTheRigProfilePelvisLeadsTheSecondaryBodyBones(self):
        humanoid=humanoid_map(self.doc);other,other_map=renamed(self.doc,humanoid)
        for path in ['Armature/Rig_Spine','Rig_Spine']:
            self.assertEqual(secondary_fit.roles(other,other_map,path)[0][:2],['Rig_Spine','Rig_Spine'])
        for path in ['Nowhere','Spine']:
            with self.assertRaisesRegex(ValueError,'pelvis_node_missing_or_ambiguous'):secondary_fit.roles(other,other_map,path)
        runtime=self.root/'runtime';interaction=runtime/'interaction';interaction.mkdir(parents=True)
        pack=runtime/'pack.json';pack.write_text(json.dumps(dict(interaction=dict(data=[]))))
        self.assertIsNone(secondary_fit.pack_pelvis(pack))
        raw=json.dumps(dict(bones=[dict(slot='Bip001',path='Root/Bip001'),dict(slot='Pelvis',path='Root/Bip001/Bip001_Pelvis')])).encode()
        (interaction/'rig-profile.json').write_bytes(raw)
        pack.write_text(json.dumps(dict(interaction=dict(data=[dict(file='rig-profile.json',sha256=hashlib.sha256(raw).hexdigest())]))))
        self.assertEqual(secondary_fit.pack_pelvis(pack),'Root/Bip001/Bip001_Pelvis')
        (interaction/'rig-profile.json').write_bytes(raw+b' ')
        with self.assertRaisesRegex(ValueError,'rig_profile_sha256_mismatch'):secondary_fit.pack_pelvis(pack)
    def bent_forearm(self,degrees,flip=None):
        """30 frames of the right forearm bending by degrees(f) about x, its hand and fingertips following; flip (frames,
        degrees) rolls those frames about the forearm."""
        xyz,rot,contacts=self.still(30);si=self.si
        axis=self.neutral[si['RightHand']]-self.neutral[si['RightForeArm']];axis/=np.linalg.norm(axis)
        for f in range(30):
            R=rotvec_matrix([math.radians(degrees(f)),0,0])
            if flip and f in flip[0]:R=R@rotvec_matrix(axis*math.radians(flip[1]))
            for name in ['RightForeArm','RightHand','RightHandThumbEnd','RightHandMiddleEnd']:rot[f,si[name]]=R
        return xyz,rot,contacts
    def testAFlipInTheSourceForearmIsInterpolatedAway(self):
        convert=SomaToRig(self.rig,self.sk);forearm=self.rig.ids['Bip001_R_Forearm']
        clean,_,_=convert.bake(*self.bent_forearm(lambda f:20+f))
        Q,_,info=convert.bake(*self.bent_forearm(lambda f:20+f,([16,17,18],163)))
        self.assertLess(steps(Q[:,forearm]).max(),30)
        keep=[f for f in range(30)if f not in(16,17,18)]
        self.assertLess(rotation_angles(Q[keep],clean[keep]).max(),.1)
        self.assertEqual(info['despiked_frames'],5)
    def testASmoothLargeMotionIsNotDespiked(self):
        convert=SomaToRig(self.rig,self.sk);forearm=self.rig.ids['Bip001_R_Forearm']
        Q,_,info=convert.bake(*self.bent_forearm(lambda f:20*f))
        np.testing.assert_allclose(steps(Q[:,forearm]),20,atol=1e-6);self.assertEqual(info['despiked_frames'],0)
    def testContactIntervalLocksTheSlidingAnkle(self):
        frames=16;xyz,rot,contacts=self.still(frames);si=self.si
        xyz+=np.arange(frames)[:,None,None]*np.array([0,0,.01])
        # A bent left knee keeps the locked ankle within reach while the hips slide 15 cm.
        rot[:,si['LeftLeg']]=rotvec_matrix([math.radians(30),0,0]);rot[:,si['LeftShin']]=rotvec_matrix([-math.radians(30),0,0])
        contacts[3:13,0]=True
        convert=SomaToRig(self.rig,self.sk);foot=self.rig.ids['Bip001_L_Foot']
        Q,T,info=convert.bake(xyz,rot,contacts,foot_lock=False)
        ankle=np.array([self.rig.fk(Q[f],T[f])[foot,:3,3]for f in range(frames)])
        self.assertAlmostEqual(np.linalg.norm(ankle[12]-ankle[3]),.09,places=6)
        Q,T,info=convert.bake(xyz,rot,contacts)
        ankle=np.array([self.rig.fk(Q[f],T[f])[foot,:3,3]for f in range(frames)])
        self.assertLess(np.max(np.linalg.norm(ankle[3:13]-ankle[3],axis=1)),1e-3)
        self.assertEqual(info['contact_intervals'],dict(L=1,R=0));self.assertEqual(info['solve_limb_overshoot_max_m'],0)
        self.assertAlmostEqual(info['contact_ankle_speed_cm_s']['before_lock']['median'],30,places=2)
        self.assertLess(info['contact_ankle_speed_cm_s']['after_lock']['p95'],3)
    def testReferencePoseHipsTakeTheSourceHipsRotation(self):
        doc=twisted_rig()
        # The thighs on the hips' lateral axis, as on the game rigs, so pitching the hips leaves the legs in place.
        for node in doc['nodes']:
            if node['path'] in ('Bip001_L_Thigh','Bip001_R_Thigh'):node['position'][1:]=[0,0]
        rig=NativeRig(doc,humanoid_map(doc));sk=soma_skeleton(rig);neutral=np.array(sk['neutral_joints']);si=self.si;ids=rig.ids
        plain=SomaToRig(rig,sk);names={j:n for n,j in ids.items()}
        stand=dict(skeleton=sk,body_basis=plain.ret.sb.tolist(),rotations={n:np.eye(3).tolist()for n in SOMA})
        reference=dict(clip='idle',rotations={names[j]:rig.restR[j].tolist()for j in plain.ret.mapping})
        convert=SomaToRig(rig,sk,stand,reference);ret=convert.ret;self.assertEqual(convert.calibration,'reference-pose')
        # The spine bends forward to 40 degrees over the clip; the hips and legs stay still.
        up=neutral[si['Neck1']]-neutral[si['Hips']];forward=neutral[si['LeftToeBase']]-neutral[si['LeftFoot']];forward[1]=0
        axis=np.cross(up,forward);axis/=np.linalg.norm(axis);frames=5
        rot=np.broadcast_to(np.eye(3),(frames,30,3,3)).copy()
        for f in range(frames):rot[f,1:22]=rotvec_matrix(axis*math.radians(10*f))
        xyz=np.zeros((frames,30,3));xyz[:,0]=neutral[0]
        for k in range(1,30):p=PARENTS[k];xyz[:,k]=xyz[:,p]+rot[:,p]@(neutral[k]-neutral[p])
        world=ret.frames(xyz,rot,xyz[0,0])[2]
        ret.hips_from_rotation=False;basis=ret.frames(xyz,rot,xyz[0,0])[2]
        unscaled=lambda w:w[...,:3,:3]/np.linalg.norm(w[...,:3,:3],axis=-2,keepdims=True)
        between=lambda a,b:np.degrees(np.arccos(np.clip((np.einsum('...ij,...ij->...',a,b)-1)/2,-1,1)))
        hips=rig.hips;expected=ret.C@rot[:,0]@ret.C.T@ret.cal[hips]
        self.assertLess(between(unscaled(world[:,hips]),expected).max(),.01)
        self.assertGreater(between(unscaled(basis[:,hips]),expected).max(),10)
        for name in ('Bip001_Spine2','Bip001_Neck'):
            np.testing.assert_allclose(unscaled(world[:,ids[name]]),unscaled(basis[:,ids[name]]),atol=1e-6)
        for name in ('Bip001_L_Foot','Bip001_R_Foot','Bip001'):
            np.testing.assert_allclose(world[:,ids[name],:3,3],basis[:,ids[name],:3,3],atol=1e-6)
        self.assertEqual((SomaToRig(rig,sk,stand,reference).ret.hips_from_rotation,plain.ret.hips_from_rotation),(True,False))
    def testTheReferencePoseComesFromTheIdleBasesThePackageDeclares(self):
        from unittest import mock
        from agentic_complex_build import style_retarget
        bindings=lambda **extra:{'schema':'endfield-motion-bindings/v1','overview':'calm','relax':'idle','from_overview':'idle',**extra}
        for name,declared,want in [('bases',bindings(idle_bases=['calm']),['calm']),('overview',bindings(),['calm']),('none',None,[])]:
            with self.subTest(name):
                source=self.root/name;motion_fixture(source,rig=self.doc,motion=dict(clips={'calm':(1.0,True)},animation={'motion-bindings.json':declared}))
                sampled=[]
                def sample(actor,clip,rest,times,nodes):sampled.append(clip['name']);return np.repeat(rest[None],len(times),0)
                # The fixture's clip documents leave out the length real clips carry.
                clip_doc=lambda path:{'length':1.0,**read_json(path)}
                with mock.patch.object(secondary_fit,'sample_clip',sample),mock.patch.object(style_retarget,'read_json',clip_doc):
                    style_retarget.rig_reference(source)
                self.assertEqual(sampled,want)
    def testInstalledPackageVerifiesAndListsTheActions(self):
        source=self.root/'source';motion_fixture(source,rig=self.doc)
        skeleton=self.root/'skeleton.json';skeleton.write_text(json.dumps(self.sk))
        xyz,rot,contacts=self.still(10);rot[5:,self.si['Spine1']]=rotvec_matrix([0,.3,0])
        nod=rot.copy();nod[5:]=np.eye(3);nod[5:,self.si['Head']]=rotvec_matrix([.2,0,0])
        clips=[dict(npz=self.npz('nod',xyz,nod,contacts),slot=0,name='nod',title='点头'),
               dict(npz=self.npz('turn',xyz,rot,contacts),slot=0,name='turn',title='转身')]
        output=self.root/'built';report=import_generated(source,output,skeleton,clips)
        package=Package(output);runtime=output/'runtime';native_bundle.verify(runtime)
        pack=read_json(runtime/package.native_entry['c7']['file'])
        actions=read_json(runtime/'animation'/next(x['file']for x in pack['animation']['data']if x['file']=='actions.json'))['actions']
        self.assertEqual([a['id']for a in actions],['fixture_0','kimodo_nod','kimodo_turn'])
        self.assertEqual([a['name']for a in actions[1:]],['点头','转身'])
        self.assertEqual(report['schema'],'endfield-kimodo-import/v1');self.assertTrue(report['original_rig_unchanged'])
        self.assertEqual([c['provenance']['kind']for c in report['clips']],['kimodo-soma-retargeted-linear-samples']*2)
        with self.assertRaisesRegex(ValueError,'output_already_exists'):import_generated(source,output,skeleton,clips)

    def testThePackagedHumanoidMapDrivesTheImportAndIsChecked(self):
        skeleton=self.root/'skeleton.json';skeleton.write_text(json.dumps(self.sk))
        xyz,rot,contacts=self.rolled_hand();clips=[dict(npz=self.npz('roll',xyz,rot,contacts),slot=0,name='roll',title='转手')]
        stem=hashlib.sha256(b'kimodo_roll').hexdigest()
        source=self.root/'source-mapped';motion_fixture(source,rig=self.doc,motion=dict(animation={'humanoid.json':humanoid_map(self.doc)}))
        import_generated(source,self.root/'mapped',skeleton,clips)
        self.assertTrue(all((self.root/'mapped/runtime/clips'/(stem+suffix)).is_file()for suffix in ['.keys','.oracle']))
        broken=humanoid_map(self.doc);broken['bones']['head']='Nowhere'
        source=self.root/'source-broken';motion_fixture(source,rig=self.doc,motion=dict(animation={'humanoid.json':broken}))
        with self.assertRaisesRegex(ValueError,'humanoid_node_missing: head'):import_generated(source,self.root/'broken',skeleton,clips)

    def testAPackageWithoutAHumanoidMapImportsNothing(self):
        skeleton=self.root/'skeleton.json';skeleton.write_text(json.dumps(self.sk));vmd=step_vmd(self.root/'step.vmd')
        clips=[dict(npz=self.npz('still',*self.still(4)),slot=0,name='still',title='静止')]
        source=self.root/'source';motion_fixture(source,rig=self.doc,motion=dict(animation={'humanoid.json':None}))
        for kind,run in [('vmd',lambda out:import_motion(source,vmd,out)),('kimodo',lambda out:import_generated(source,out,skeleton,clips))]:
            with self.subTest(kind),self.assertRaisesRegex(ValueError,'humanoid_map_missing'):run(self.root/kind)
            self.assertFalse((self.root/kind).exists())

    def testARigNamedOnlyByItsPackedHumanoidMapImportsLikeTheBip001Rig(self):
        skeleton=self.root/'skeleton.json';skeleton.write_text(json.dumps(self.sk));vmd=step_vmd(self.root/'step.vmd')
        xyz,rot,contacts=self.still(10);rot[5:,self.si['Spine1']]=rotvec_matrix([0,.3,0])
        clips=[dict(npz=self.npz('turn',xyz,rot,contacts),slot=0,name='turn',title='转身')]
        other,other_map=renamed(self.doc,humanoid_map(self.doc));built={}
        for name,doc,data in [('plain',self.doc,{}),('renamed',other,{'humanoid.json':other_map})]:
            source=self.root/('source-'+name);motion_fixture(source,rig=doc,motion=dict(animation=data))
            for kind,run in [('vmd',lambda out:import_motion(source,vmd,out)),('kimodo',lambda out:import_generated(source,out,skeleton,clips))]:
                output=self.root/(name+'-'+kind);run(output);native_bundle.verify(output/'runtime')
                stances=read_json(output/'runtime/interaction/motion-metadata.json')['clips']
                built[name,kind]=stances,[p.read_bytes()for p in sorted((output/'runtime/clips').glob('*.keys'))]
        for kind in ['vmd','kimodo']:self.assertEqual(built['renamed',kind],built['plain',kind])

    def testSecondaryModelDrivesItsBonesInTheInstalledClip(self):
        source=self.root/'source';motion_fixture(source,rig=self.doc)
        skeleton=self.root/'skeleton.json';skeleton.write_text(json.dumps(self.sk))
        xyz,rot,contacts=self.still(4);rot[2:,self.si['Spine1']]=rotvec_matrix([0,.3,0]);bone='Bip001_LUpArmTwist'
        width=len(np.triu_indices(9)[0])+9
        model=dict(bones={bone:dict(drivers=['Bip001_L_UpperArm','Bip001_L_Clavicle','Bip001_L_Forearm'],
                                    feature_mean=[0]*width,feature_scale=[1]*width,feature_low=[-1]*width,feature_high=[1]*width,coef=[[0]*6]*width,
                                    intercept=[.01,.02,.03,0,0,.2])},fingers=dict(default={}))
        path=self.root/'secondary.json';path.write_text(json.dumps(model))
        report=import_generated(source,self.root/'built',skeleton,[dict(npz=self.npz('still',xyz,rot,contacts),slot=0,name='still',title='静止')],
                                secondary=path)
        j=[n['path']for n in self.doc['nodes']].index(bone)
        runtime=self.root/'built/runtime';clip=read_json(runtime/'clips'/(hashlib.sha256(b'kimodo_still').hexdigest()+'.json'))
        poses=[pose for _,pose in _oracle(runtime,clip)]
        self.assertTrue(poses);np.testing.assert_allclose(poses[0][j,:3],[.01,.02,.03],atol=1e-6)
        np.testing.assert_allclose(poses[0][j,3:7],[0,0,math.sin(.1),math.cos(.1)],atol=1e-6)
        self.assertEqual(len(report['clips'][0]['provenance']['secondary_sha256']),64)


if __name__=='__main__':unittest.main()
