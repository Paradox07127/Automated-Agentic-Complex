"""BVH parsing and forward kinematics, and humanoid joint names onto the canonical joints."""
import math
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
CHARACTERS=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(CHARACTERS)]
from agentic_complex_build.motion_import import bvh, humanoid_map
from agentic_complex_build.motion_import.take import CANONICAL,resample

J={name:index for index,name in enumerate(CANONICAL)}
# Y up, facing +Z, the character's left on +X.
CMU_SPINE=[('Hips',None,(0,9,0)),('LowerBack','Hips',(0,1,0)),('Spine','LowerBack',(0,2,0)),('Spine1','Spine',(0,2,0)),
           ('Neck','Spine1',(0,2,0)),('Neck1','Neck',(0,1,0)),('Head','Neck1',(0,1,0))]
END_SITES={'Head':(0,2,0),'LeftHand':(1,0,0),'RightHand':(-1,0,0),'LeftToeBase':(0,0,1),'RightToeBase':(0,0,1),
           'LeftHandIndex3':(.5,0,0)}
Z_UP=np.array([[1,0,0],[0,0,-1],[0,1,0]])  # +90 degrees about X


def cmu_joints(fingers=False):
    joints=list(CMU_SPINE)
    for side,x in (('Left',1),('Right',-1)):
        joints+=[(side+'Shoulder','Spine1',(x,1,0)),(side+'Arm',side+'Shoulder',(2*x,0,0)),
                 (side+'ForeArm',side+'Arm',(3*x,0,0)),(side+'Hand',side+'ForeArm',(2*x,0,0))]
    if fingers:
        joints+=[('LeftHandIndex1','LeftHand',(1,0,.2)),('LeftHandIndex2','LeftHandIndex1',(.5,0,0)),
                 ('LeftHandIndex3','LeftHandIndex2',(.5,0,0))]
    for side,x in (('Left',1),('Right',-1)):
        joints+=[(side+'UpLeg','Hips',(x,-1,0)),(side+'Leg',side+'UpLeg',(0,-4,0)),
                 (side+'Foot',side+'Leg',(0,-4,0)),(side+'ToeBase',side+'Foot',(0,-1,2))]
    return joints


def without(joints,drop):
    """joints without the drop names; their children keep their positions under the nearest kept parent."""
    rows={name:(parent,offset) for name,parent,offset in joints};kept=[]
    for name,parent,offset in joints:
        if name in drop:continue
        offset=np.asarray(offset,float)
        while parent in drop:offset=offset+rows[parent][1];parent=rows[parent][0]
        kept.append((name,parent,tuple(offset)))
    return kept


def cmu_bvh_text(scale=1.0,z_up=False,fingers=False,drop=()):
    """A CMU-style T-pose at 30 fps, 3 frames; frame 2 turns LeftForeArm 90 degrees about Z. fingers adds a left index,
    drop leaves those joints out."""
    joints=without(cmu_joints(fingers),drop);turn=np.eye(3) if not z_up else Z_UP
    def vector(v):return ' '.join('%g'%c for c in turn@np.asarray(v,float)*scale)
    lines=['HIERARCHY'];order=[]
    def emit(name,parent,offset,depth):
        pad='  '*depth;order.append(name)
        lines.extend([pad+('ROOT ' if parent is None else 'JOINT ')+name,pad+'{',pad+'  OFFSET '+vector(offset),
                      pad+('  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation' if parent is None
                           else '  CHANNELS 3 Zrotation Xrotation Yrotation')])
        kids=[j for j in joints if j[1]==name]
        for kid in kids:emit(*kid,depth+1)
        if not kids:lines.extend([pad+'  End Site',pad+'  {',pad+'    OFFSET '+vector(END_SITES[name]),pad+'  }'])
        lines.append(pad+'}')
    emit(*joints[0],0)
    # Z 90 in the Y-up file is -90 about Y once the skeleton is turned Z up.
    turned='90 0 0' if not z_up else '0 0 -90'
    lines+=['MOTION','Frames: 3','Frame Time: %.10f'%(1/30)]
    for frame in range(3):
        values=[]
        for name in order:
            if name=='Hips':values.append(vector((frame,9,2*frame))+' 0 0 0')
            else:values.append(turned if name=='LeftForeArm' and frame==1 else '0 0 0')
        lines.append(' '.join(values))
    return '\n'.join(lines)+'\n'


def skeleton(text):
    joints,_,_=bvh.parse(text)
    return [j['name'] for j in joints],[j['parent'] for j in joints]


def rot_z(degrees):
    a=math.radians(degrees);c,s=math.cos(a),math.sin(a)
    return np.array([[c,-s,0],[s,c,0],[0,0,1]])


class BvhTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)

    def write(self,text,name='walk.bvh'):
        path=Path(self.tmp.name)/name;path.write_text(text);return path

    def load(self,text,**options):
        return bvh.load(self.write(text),options=options or None)

    def test_cmu_maps_every_joint(self):
        names,parents=skeleton(cmu_bvh_text())
        mapping,chain,unmapped=humanoid_map.map_skeleton(names,parents)
        self.assertEqual(set(mapping),set(CANONICAL)-{'Spine1','Spine2','Chest','LeftHandTip','RightHandTip'})
        self.assertEqual(mapping['LeftLeg'],names.index('LeftUpLeg'))
        self.assertEqual(mapping['LeftShin'],names.index('LeftLeg'))
        self.assertEqual(mapping['Neck1'],names.index('Neck'))
        self.assertEqual(chain,[names.index(n) for n in ('LowerBack','Spine','Spine1')])
        self.assertEqual(unmapped,['Neck1'])

    def test_forearm_turn_moves_the_hand(self):
        take=self.load(cmu_bvh_text())
        self.assertEqual((take.format,take.source_frames,take.contacts),('bvh',3,None))
        self.assertAlmostEqual(take.frame_rate,30,places=6)
        self.assertEqual(take.warnings,['hand_tip_synthesized','unmapped_bones','fingers_rest'])
        hand,fore=J['LeftHand'],J['LeftForeArm']
        expected=take.xyz[1,fore]+rot_z(90)@(take.xyz[0,hand]-take.xyz[0,fore])
        self.assertLess(np.abs(take.xyz[1,hand]-expected).max(),1e-6)
        self.assertLess(np.abs(take.xyz[1,hand]-take.xyz[1,fore]-[0,2,0]).max(),1e-6)
        self.assertLess(np.abs(take.R[1,fore]-rot_z(90)).max(),1e-12)
        self.assertLess(np.abs(take.R[0]-np.eye(3)).max(),1e-12)

    def test_left_hand_index_maps_to_the_index_finger(self):
        names,parents=skeleton(cmu_bvh_text(fingers=True))
        mapping,_,unmapped=humanoid_map.map_skeleton(names,parents)
        for k in (1,2,3):self.assertEqual(mapping['LeftIndex%d'%k],names.index('LeftHandIndex%d'%k))
        self.assertEqual(unmapped,['Neck1'])
        take=self.load(cmu_bvh_text(fingers=True))
        self.assertEqual(sorted(take.fingers),['LeftIndex1','LeftIndex2','LeftIndex3'])
        neutral,R=take.fingers['LeftIndex1']
        np.testing.assert_allclose(neutral,take.neutral[J['LeftHand']]+[1,0,.2],atol=1e-12)
        self.assertEqual(R.shape,(3,3,3))
        # The forearm turn carries the finger with it.
        self.assertLess(np.abs(R[1]-rot_z(90)).max(),1e-12);self.assertLess(np.abs(R[0]-np.eye(3)).max(),1e-12)

    def test_scale_is_not_guessed(self):
        take,big=self.load(cmu_bvh_text()),self.load(cmu_bvh_text(scale=10))
        np.testing.assert_allclose(big.xyz,take.xyz*10,rtol=0,atol=1e-12)
        np.testing.assert_allclose(big.neutral,take.neutral*10,rtol=0,atol=1e-12)
        np.testing.assert_array_equal(big.R,take.R)

    def test_axes_are_not_corrected(self):
        take,z_up=self.load(cmu_bvh_text()),self.load(cmu_bvh_text(z_up=True))
        np.testing.assert_allclose(z_up.neutral,take.neutral@Z_UP.T,rtol=0,atol=1e-12)

    def test_namespace_prefix(self):
        text=cmu_bvh_text().replace('ROOT ','ROOT mixamorig:').replace('JOINT ','JOINT mixamorig:')
        names,parents=skeleton(text)
        self.assertEqual(humanoid_map.map_skeleton(names,parents)[0],
                         humanoid_map.map_skeleton(*skeleton(cmu_bvh_text()))[0])

    def test_missing_up_leg(self):
        names,parents=skeleton(cmu_bvh_text())
        gone=names.index('LeftUpLeg');keep=[k for k in range(len(names)) if k!=gone]
        new={old:k for k,old in enumerate(keep)}
        parents=[-1 if parents[k]<0 else new[parents[gone] if parents[k]==gone else parents[k]] for k in keep]
        with self.assertRaisesRegex(ValueError,'^unmapped_skeleton: LeftLeg$'):
            humanoid_map.map_skeleton([names[k] for k in keep],parents)

    def between(self,neutral,low,high,name):
        """neutral[name] at SPINE_HEIGHTS' share of low->high."""
        H=humanoid_map.SPINE_HEIGHTS;share=(H[name]-H[low])/(H[high]-H[low])
        np.testing.assert_allclose(neutral[J[name]],neutral[J[low]]+share*(neutral[J[high]]-neutral[J[low]]),atol=1e-12)
        self.assertTrue(0<share<1)

    def test_missing_neck_is_synthesized(self):
        take=self.load(cmu_bvh_text(drop=('Neck','Neck1')))
        take.validate()
        self.assertEqual(take.warnings,['synthesized_bones: Neck1','hand_tip_synthesized','fingers_rest'])
        # Head's parent Spine1 at y 14 is the Chest; the head at y 18.
        np.testing.assert_allclose(take.neutral[J['Chest']],[0,14,0],atol=1e-12)
        np.testing.assert_allclose(take.neutral[J['Head']],[0,18,0],atol=1e-12)
        self.between(take.neutral,'Chest','Head','Neck1')
        np.testing.assert_array_equal(take.R[:,J['Neck1']],take.R[:,J['Chest']])

    def test_hips_straight_to_neck(self):
        text=cmu_bvh_text(drop=('LowerBack','Spine','Spine1'))
        mapping,chain,unmapped=humanoid_map.map_skeleton(*skeleton(text))
        self.assertEqual((chain,unmapped),([],['Neck1']))
        take=self.load(text)
        take.validate()
        self.assertEqual(take.warnings,['synthesized_bones: Spine1,Spine2,Chest','hand_tip_synthesized','unmapped_bones',
                                        'fingers_rest'])
        np.testing.assert_allclose(take.neutral[J['Neck1']],[0,16,0],atol=1e-12)
        for name in ('Spine1','Spine2','Chest'):
            self.between(take.neutral,'Hips','Neck1',name)
            np.testing.assert_array_equal(take.R[:,J[name]],take.R[:,J['Hips']])

    def test_missing_head_is_unmapped(self):
        with self.assertRaisesRegex(ValueError,'^unmapped_skeleton: Head$'):
            humanoid_map.map_skeleton(*skeleton(cmu_bvh_text().replace('Head','Skull')))

    def test_truncated_file(self):
        text=cmu_bvh_text()
        for cut in (text[:-12],text[:len(text)//3]):
            with self.assertRaisesRegex(ValueError,'^bad_source: '):self.load(cut)

    def test_bone_map_override(self):
        text=cmu_bvh_text().replace('LeftUpLeg','L_UpLeg')
        with self.assertRaisesRegex(ValueError,'^unmapped_skeleton: LeftLeg$'):self.load(text)
        take=self.load(text,bone_map={'LeftLeg':'L_UpLeg'})
        np.testing.assert_array_equal(take.xyz,self.load(cmu_bvh_text()).xyz)
        self.assertEqual(take.unmapped,['Neck1'])

    def test_probe_leaves_the_skeleton_to_load(self):
        """The --bone-map override reaches load only, so probe must not map the skeleton without it."""
        info=bvh.probe(self.write(cmu_bvh_text().replace('LeftUpLeg','L_UpLeg')))
        self.assertEqual((info['takes'][0]['frames'],info['warnings']),(3,[]))

    def test_toe_synthesized_forward(self):
        take=self.load(cmu_bvh_text().replace('ToeBase','Toes'))
        self.assertIn('toe_synthesized',take.warnings)
        for side in ('Left','Right'):
            # 0.12 x (4 + 4) along +Z, the facing direction.
            np.testing.assert_allclose(take.neutral[J[side+'ToeBase']],take.neutral[J[side+'Foot']]+[0,0,.96],atol=1e-12)

    def test_resampling_keeps_the_last_source_pose(self):
        """A take whose length is no multiple of 1/30 s ends on its own last pose, and a 2-frame take stays animated."""
        from agentic_complex_build.motion_import.bake import import_take
        sys.path.insert(0,str(CHARACTERS.parent/'agent/agentd/tests'))
        from test_motion_tool import motion_fixture
        from test_vmd_import import authored_rig
        package=Path(self.tmp.name)/'package';motion_fixture(package,rig=authored_rig())
        for frames,rate in ((2,60),(3,24),(2,24)):
            with self.subTest(frames=frames,rate=rate):
                head,motion=cmu_bvh_text().split('MOTION\n')
                rows=motion.splitlines()[2:2+frames]
                text=head+'MOTION\nFrames: %d\nFrame Time: %.10f\n'%(frames,1/rate)+'\n'.join(rows)+'\n'
                take=self.load(text);out=resample(take)
                self.assertGreaterEqual(len(out.xyz),2)
                np.testing.assert_allclose(out.xyz[-1],take.xyz[-1],atol=1e-9)
                np.testing.assert_allclose(out.R[-1],take.R[-1],atol=1e-9)
                np.testing.assert_allclose(out.xyz[0],take.xyz[0],atol=1e-12)
                import_take(package,take,Path(self.tmp.name)/('out-%d-%d'%(frames,rate)),title='walk')

    def test_probe(self):
        path=self.write(cmu_bvh_text())
        info=bvh.probe(path)
        self.assertEqual(info['takes'][0]['frames'],3)
        self.assertEqual(info['takes'][0]['name'],'walk.bvh')
        self.assertAlmostEqual(info['takes'][0]['duration_s'],2/30,places=6)
        self.assertEqual((info['has_face'],info['has_camera']),(False,False))
        self.assertEqual(info['warnings'],[])
        with self.assertRaisesRegex(ValueError,'^bad_source: take$'):bvh.probe(path,take=1)


class CanonicalArrayTests(unittest.TestCase):
    def spine2(self,chain_names):
        names,parents=skeleton(cmu_bvh_text())
        mapping,_,_=humanoid_map.map_skeleton(names,parents)
        joints,_,_=bvh.parse(cmu_bvh_text())
        neutral=np.zeros((len(joints),3))
        for k,j in enumerate(joints):neutral[k]=(neutral[j['parent']] if j['parent']>=0 else 0)+np.asarray(j['offset'])
        xyz,R,_=humanoid_map.canonical_arrays(mapping,[names.index(n) for n in chain_names],neutral[None],
                                                np.tile(np.eye(3),(1,len(joints),1,1)))
        return xyz[0,J['Spine2']]

    def test_spine2_by_chain_length(self):
        # Spine1 at y 14 and Neck at y 16: a third of the way.
        np.testing.assert_allclose(self.spine2(['Spine1']),[0,14+2/3,0],atol=1e-12)
        np.testing.assert_allclose(self.spine2(['Spine','Spine1']),[0,13,0],atol=1e-12)
        np.testing.assert_allclose(self.spine2(['LowerBack','Spine','Spine1']),[0,12,0],atol=1e-12)


if __name__=='__main__':
    unittest.main()
