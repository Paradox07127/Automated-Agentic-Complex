"""Original-rig math and compact GLB export for the local and remote experiment."""
from pathlib import Path
import hashlib
import json
import numpy as np
from . import rotation

HUMANOID_FILE='humanoid.json';HUMANOID_SCHEMA='endfield-humanoid-map/v1'
HUMANOID_REQUIRED=('hips','spine','head','leftUpperLeg','leftLowerLeg','leftFoot','rightUpperLeg','rightLowerLeg','rightFoot',
                   'leftUpperArm','leftLowerArm','leftHand','rightUpperArm','rightLowerArm','rightHand')
# The rig's finger n (0 thumb .. 4 little): its VRM 1.0 name and joints from the hand out.
DIGITS=(('Thumb',('Metacarpal','Proximal','Distal')),('Index',('Proximal','Intermediate','Distal')),('Middle',('Proximal','Intermediate','Distal')),
        ('Ring',('Proximal','Intermediate','Distal')),('Little',('Proximal','Intermediate','Distal')))
def bone(side,part):
    """The humanoid name of part ('UpperArm', 'IndexProximal', 'UpperArmTwist', ...) on side 'L' or 'R'."""
    return ('left' if side=='L' else 'right')+part

def humanoid_ids(document,paths):
    """{humanoid bone or twist name: node index} of humanoid.json's bones and extras.twist by node path (paths, in node order)."""
    if document is None:raise ValueError('humanoid_map_missing')
    bones=document.get('bones');twist=document.get('extras',{}).get('twist',{})
    if document.get('schema')!=HUMANOID_SCHEMA or not isinstance(bones,dict) or not isinstance(twist,dict):raise ValueError('invalid_humanoid_map')
    missing=[b for b in HUMANOID_REQUIRED if b not in bones]
    if missing:raise ValueError('humanoid_map_lacks: '+','.join(missing))
    at={p:i for i,p in enumerate(paths)};out={}
    for key,path in {**bones,**twist}.items():
        if path not in at:raise ValueError('humanoid_node_missing: '+key)
        out[key]=at[path]
    return out
def pack_humanoid(pack_path):
    """The humanoid.json document the C7 pack at pack_path lists in animation.data, None without one."""
    pack_path=Path(pack_path)
    ref=next((r for r in json.loads(pack_path.read_text(encoding='utf-8'))['animation']['data'] if r['file']==HUMANOID_FILE),None)
    if ref is None:return None
    blob=(pack_path.parent/'animation'/HUMANOID_FILE).read_bytes()
    if hashlib.sha256(blob).hexdigest()!=ref['sha256']:raise ValueError('humanoid_map_sha256_mismatch')
    return json.loads(blob)

def unit(v):
    return np.asarray(v)/max(np.linalg.norm(v),1e-12)
def swing(a,b):
    a=unit(a);b=unit(b);v=np.cross(a,b);c=np.dot(a,b)
    if c<-.999999:
        axis=unit(np.cross(a,[1,0,0]) if abs(a[0])<.8 else np.cross(a,[0,1,0]))
        return rotation.as_matrix(rotation.from_rotvec(axis*np.pi))
    k=np.array([[0,-v[2],v[1]],[v[2],0,-v[0]],[-v[1],v[0],0]])
    return np.eye(3)+k+k@k/max(1+c,1e-12)
def basis(right,up):
    x=unit(right);y=unit(up-x*np.dot(up,x));return np.stack([x,y,np.cross(x,y)],axis=1)
def ease(x):
    x=np.clip(x,0,1);return x*x*x*(10+x*(-15+6*x))

class Rig:
    """Rig math over nodes, parent, order, t0, q0, s, rest, restR, ids, humanoid, hips and twists, which a subclass sets."""
    def chain(self,j):
        c=[]
        while j>=0:c.append(j);j=self.parent[j]
        return c[::-1]
    def fk(self,q,t,nodes=None):
        """q (...,N,4), t (...,N,3) -> world (...,N,4,4); leading frame axes are batched per node.
        With nodes, only they and their ancestors are filled; the other rows stay zero."""
        order=self.order if nodes is None else list(dict.fromkeys(k for j in nodes for k in self.chain(j)))
        m=np.broadcast_to(np.eye(4),q.shape[:-2]+(len(order),4,4)).copy();m[...,:3,:3]=rotation.as_matrix(q[...,order,:])*self.s[order,None,:];m[...,:3,3]=t[...,order,:]
        local=np.zeros(q.shape[:-1]+(4,4));local[...,order,:,:]=m;world=np.zeros_like(local)
        for i in order:world[...,i,:,:]=local[...,i,:,:] if self.parent[i]<0 else world[...,self.parent[i],:,:]@local[...,i,:,:]
        return world
    def rotations(self,world):
        r=world[...,:3,:3];return r/np.linalg.norm(r,axis=-2)[...,None,:]
    def set_world_rotation(self,q,t,j,r):
        par=self.parent[j];pw=np.eye(3) if par<0 else self.fk(q,t,[par])[par,:3,:3]
        q[j]=rotation.from_matrix(np.linalg.inv(pw)@r)
    def solve_limb(self,q,t,chain,target,endR=None,hint=None):
        a,b,c=[self.ids[x] if isinstance(x,str) else x for x in chain];w=self.fk(q,t,[a,b,c]);wr=dict(zip([a,b],self.rotations(w[[a,b]])))
        p,e,h=w[[a,b,c],:3,3];l1=np.linalg.norm(e-p);l2=np.linalg.norm(h-e)
        d=target-p;rawdist=np.linalg.norm(d);d=unit(d);dist=np.clip(rawdist,abs(l1-l2)+1e-6,l1+l2-1e-6)
        along=(l1*l1-l2*l2+dist*dist)/(2*dist);height=np.sqrt(max(0,l1*l1-along*along))
        hint=(e-p) if hint is None else hint
        pole=hint-d*np.dot(hint,d)
        if np.linalg.norm(pole)<1e-6:pole=np.cross(d,[0,0,1]) if abs(d[2])<.8 else np.cross(d,[1,0,0])
        desired_elbow=p+d*along+unit(pole)*height;clamped=p+d*dist
        newA=swing(e-p,desired_elbow-p)@wr[a];newB=swing(h-e,clamped-desired_elbow)@wr[b]
        self.set_world_rotation(q,t,a,newA);self.set_world_rotation(q,t,b,newB)
        if endR is not None:self.set_world_rotation(q,t,c,endR)
        return max(0,rawdist-l1-l2)
    def finger(self,side,n):
        """Finger n's (0 thumb .. 4 little) joint nodes from the hand out and its tip node, None for each the rig lacks;
        without a named tip, the last joint's first child."""
        digit,segments=DIGITS[n];joints=[self.humanoid.get(bone(side,digit+x)) for x in segments];tip=self.humanoid.get(bone(side,digit+'Tip'))
        if tip is None and joints[-1] is not None:tip=next((int(k) for k in np.flatnonzero(self.parent==joints[-1])),None)
        return joints+[tip]
    def palm(self,side='R'):
        h,m,ix,pk=(self.humanoid[bone(side,x)] for x in ['Hand','MiddleProximal','IndexProximal','LittleProximal'])
        inv=self.restR[h].T;forward=inv@(self.rest[m,:3,3]-self.rest[h,:3,3]);across=inv@(self.rest[ix,:3,3]-self.rest[pk,:3,3])
        # Right hand: little-to-index cross finger points dorsally; negate across
        # so the third axis denotes the palmar surface normal.
        return .65*forward,basis(across*(-1 if side=='R' else 1),forward)

class Retarget:
    # True: the hips take the mapped source Hips rotation; False: the leg-line/neck body basis.
    hips_from_rotation=False
    def __init__(self,rig,sk):
        self.rig=rig;self.names=sk['names'];self.si={n:i for i,n in enumerate(self.names)};self.neutral=np.array(sk['neutral_joints']);self.parents=np.array(sk['parents'])
        r=rig;si=self.si;neutral=self.neutral
        h=r.humanoid;mapping={'hips':'Hips','spine':'Spine1','chest':'Spine2','upperChest':'Chest','neck':'Neck1','head':'Head'}
        for side,word in [('L','Left'),('R','Right')]:
            for target,source in [('Shoulder','Shoulder'),('UpperArm','Arm'),('LowerArm','ForeArm'),('Hand','Hand'),('UpperLeg','Leg'),('LowerLeg','Shin'),('Foot','Foot'),('Toes','ToeBase')]:mapping[bone(side,target)]=word+source
        self.mapping={h[k]:si[v] for k,v in mapping.items()};children={}
        for j in self.mapping:
            c=[k for k in self.mapping if r.parent[k]==j]
            if c:children[j]=c[0]
        for side in ['L','R']:children[h[bone(side,'Hand')]]=h[bone(side,'MiddleProximal')]
        tb=basis(r.rest[h['rightUpperLeg'],:3,3]-r.rest[h['leftUpperLeg'],:3,3],r.rest[h['neck'],:3,3]-r.rest[r.hips,:3,3]);self.sb=basis(neutral[si['RightLeg']]-neutral[si['LeftLeg']],neutral[si['Neck1']]-neutral[si['Hips']]);self.C=tb@self.sb.T
        aims={}
        for j in range(len(self.names)):
            c=np.flatnonzero(self.parents==j)
            if len(c):aims[j]=int(c[0])
        aims[si['Hips']]=si['Spine1'];aims[si['Chest']]=si['Neck1'];self.cal={}
        for j,k in self.mapping.items():self.cal[j]=swing(r.rest[children[j],:3,3]-r.rest[j,:3,3],self.C@(neutral[aims[k]]-neutral[k]))@r.restR[j] if j in children and k in aims else r.restR[j]
        sl=sum(np.linalg.norm(neutral[si[k]]-neutral[si[p]]) for k,p in [('LeftShin','LeftLeg'),('LeftFoot','LeftShin')]);tl=sum(np.linalg.norm(r.rest[h[k],:3,3]-r.rest[h[p],:3,3]) for k,p in [('leftLowerLeg','leftUpperLeg'),('leftFoot','leftLowerLeg')]);self.scale=tl/sl
        # frame() keeps q0 on every node it does not drive; their local rotation-scale blocks, batched once.
        self.rest_local=rotation.as_matrix(r.q0)*r.s[:,None,:]
        # The hips' world rotation when the SOMA body basis equals the neutral's (sb).
        self.root_cal=r.restR[r.hips]
    def frame(self,xyz,srcR,initialroot,offset=None):
        q,t,world=self.frames(xyz[None],srcR[None],initialroot,offset);return q[0],t[0],world[0]
    def frames(self,xyz,srcR,initialroot,offset=None):
        """frame() over a leading frame axis: xyz (F,J,3), srcR (F,J,3,3) -> q (F,N,4), t (F,N,3), world (F,N,4,4)."""
        r=self.rig;si=self.si;C=self.C;F=len(xyz);q=np.repeat(r.q0[None],F,0);t=np.repeat(r.t0[None],F,0);world=np.zeros((F,)+r.rest.shape)
        # basis, the root position and the hips' translation stay per frame, so their 1-D norms, dots and
        # matrix-vector products keep the per-frame rounding.
        body=np.array([basis(x[si['RightLeg']]-x[si['LeftLeg']],x[si['Neck1']]-x[si['Hips']]) for x in xyz]);rootDelta=C@body@self.sb.T@C.T
        desired={j:C@srcR[:,k]@C.T@self.cal[j] for j,k in self.mapping.items()}
        if not self.hips_from_rotation:desired[r.hips]=rootDelta@self.root_cal
        for j,b in r.twists.items():desired[j]=desired[b]@r.restR[b].T@r.restR[j]
        rootpos=[r.rest[r.hips,:3,3]+self.scale*C@(x[si['Hips']]-initialroot)+(np.zeros(3) if offset is None else offset) for x in xyz]
        eye=np.broadcast_to(np.eye(4),(F,4,4))
        for j in r.order:
            par=r.parent[j];pw=eye if par<0 else world[:,par]
            if j in desired:q[:,j]=rotation.from_matrix(np.linalg.inv(pw[:,:3,:3])@desired[j])
            if j==r.hips:
                inv=np.linalg.inv(pw)
                for f in range(F):t[f,j]=(inv[f]@np.r_[rootpos[f],1])[:3]
            m=eye.copy();m[:,:3,:3]=rotation.as_matrix(q[:,j])*r.s[j][None,:] if j in desired else self.rest_local[j];m[:,:3,3]=t[:,j];world[:,j]=pw@m
        return q,t,world
