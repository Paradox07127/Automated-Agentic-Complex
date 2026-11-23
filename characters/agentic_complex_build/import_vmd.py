#!/usr/bin/env python3
"""Compile a VMD onto an existing character's native rig and emit a validated package.

The output creates a NEW offline generation, never mutates the
input library or an installed package. The ordinary character installer consumes
the output; replacing an existing ID is performed offline, not during a live character switch.
"""
from pathlib import Path
import argparse
import copy
import json
import math
import shutil
import struct
import subprocess
import tempfile
import wave

from character_library import Package, Library, digest, read_json, write_json, need, export_package
import native_bundle
from .common import canonical_json, reference as ref, sha256_bytes
from .stance import stances
from .motion_import.edit import write_document


def _read_checked_vmd_raw(path):
    """Validate VMD 0002 bounds and section offsets before allocating arrays."""
    from .mmd.io import read_vmd
    path = Path(path); need(path.is_file() and path.stat().st_size <= 64 * 1024**2, 'vmd_file_limit')
    data = path.read_bytes(); need(data.startswith(b'Vocaloid Motion Data 0002'), 'unsupported_vmd_header')
    need(len(data) >= 54, 'truncated_vmd')
    cursor = 50
    # Fixed-width sections, followed by the variable IK visibility section.
    for width in [111, 23, 61, 28, 9]:
        if cursor == len(data): break
        need(cursor + 4 <= len(data), 'truncated_vmd_count')
        count = struct.unpack_from('<I', data, cursor)[0]; cursor += 4
        need(count <= 500000 and count <= (len(data)-cursor)//width, 'vmd_section_bounds')
        cursor += count * width
    else:
        if cursor < len(data):
            need(cursor + 4 <= len(data), 'truncated_vmd_ik')
            count = struct.unpack_from('<I', data, cursor)[0]; cursor += 4
            need(count <= 54000, 'vmd_ik_limit')
            for _ in range(count):
                need(cursor + 9 <= len(data), 'truncated_vmd_ik')
                bones = struct.unpack_from('<I', data, cursor+5)[0]; cursor += 9
                need(bones <= 4096 and bones <= (len(data)-cursor)//21, 'vmd_ik_bounds')
                cursor += bones * 21
    need(cursor == len(data), 'trailing_vmd_data')
    try: return read_vmd(path)
    except (ValueError, struct.error, IndexError) as error: raise ValueError('invalid_vmd: ' + str(error)) from error


def checked_vmd(path):
    """Validate bounds before the research parser or numpy can allocate arrays."""
    from .mmd.io import last_frame
    vmd = _read_checked_vmd_raw(path)
    need(vmd.bones and last_frame(vmd) <= 54000, 'vmd_frame_limit')
    for key in vmd.bones:
        need(key.frame >= 0 and all(math.isfinite(x) for x in (*key.pos, *key.rot))
             and sum(x*x for x in key.rot) > 1e-12, 'invalid_vmd_transform')
    return vmd


def checked_camera_vmd(path):
    """checked_vmd's bounds for a camera VMD: camera keys required, bone keys not."""
    from .mmd.io import last_frame
    vmd = _read_checked_vmd_raw(path)
    need(vmd.cameras and max(k[0] for k in vmd.cameras) <= 54000 and last_frame(vmd) <= 54000, 'vmd_camera_frame_limit')
    for _, distance, center, euler, _, _, _ in vmd.cameras:
        need(all(math.isfinite(x) for x in (distance, *center, *euler)), 'invalid_vmd_camera')
    return vmd


def checked_morph_vmd(path):
    """checked_vmd's bounds for a morph/facial VMD: morph keys required, bone keys optional."""
    from .mmd.io import last_frame
    vmd = _read_checked_vmd_raw(path)
    need(vmd.morphs and last_frame(vmd) <= 54000, 'vmd_morph_limit')
    for key in vmd.morphs:
        need(key.frame >= 0 and math.isfinite(key.weight), 'invalid_vmd_morph')
    return vmd


def checked_pmd(path):
    from .mmd.io import read_pmd
    path=Path(path);need(path.is_file() and path.stat().st_size<=64*1024**2,'pmd_file_limit')
    try: model=read_pmd(path)
    except (ValueError,struct.error,IndexError) as error:raise ValueError('invalid_pmd') from error
    count=len(model.bones)
    need(0<count<=4096 and len({b.name for b in model.bones})==count,'invalid_source_bones')
    for i,bone in enumerate(model.bones):
        need(-1<=bone.parent<count and all(math.isfinite(x) for x in bone.pos),'invalid_source_bone')
        seen=set();cursor=i
        while cursor>=0:
            need(cursor not in seen and len(seen)<256,'cyclic_or_deep_source_rig')
            seen.add(cursor);cursor=model.bones[cursor].parent
    for ik in model.iks:
        need(all(0<=x<count for x in [ik.bone,ik.target,*ik.chain]) and
             0<ik.iterations<=256 and math.isfinite(ik.limit) and 0<ik.limit<=math.pi,'invalid_source_ik')
    return model


def _pchip_tangents(ts, vs):
    """Fritsch-Carlson monotone piecewise cubic Hermite tangents (C1 continuous, zero overshoot)."""
    from .mmd.morph import pchip_slopes
    return pchip_slopes(ts, vs)


def encode_clip(rig_doc, name, q, t, sample_rate, provenance, tangent_mode='linear'):
    """The clip document without its keys, oracle and samples, and its EFKEY001 bytes; q is made sign-continuous and
    normalised in place. tangent_mode='pchip' emits C1 monotone Hermite tangents; 'linear' keeps secants."""
    import numpy as np
    need(tangent_mode in ('linear', 'pchip'), 'invalid_tangent_mode')
    frames, nodes = q.shape[:2]; need(frames >= 2 and nodes == len(rig_doc['nodes']), 'invalid_bake_shape')
    need(np.isfinite(q).all() and np.isfinite(t).all(), 'nonfinite_bake')
    # Quaternion components are sampled independently by ActorClip. Keep adjacent
    # signs continuous before emitting curves.
    for f in range(1, frames):
        q[f] *= np.where(np.sum(q[f-1]*q[f], axis=1, keepdims=True) < 0, -1, 1)
    q /= np.linalg.norm(q, axis=-1, keepdims=True)
    times = np.arange(frames)/sample_rate
    keys = bytearray(b'EFKEY001'); curves = []
    for i, node in enumerate(rig_doc['nodes']):
        for attribute, data in [('position', t[:, i]), ('rotation', q[:, i])]:
            if np.max(np.abs(data - np.asarray(node[attribute]))) < 1e-7: continue
            for component in range(data.shape[1]):
                values = data[:, component]
                ts, vs = (times[:1], values[:1]) if np.max(np.abs(values-values[0])) < 1e-8 else (times, values)
                offset = len(keys)
                if tangent_mode == 'pchip':
                    d = _pchip_tangents(ts, vs)
                    for k, (time, value) in enumerate(zip(ts, vs)):
                        keys.extend(struct.pack('<6fI', time, value, d[k], d[k], 1/3, 1/3, 0))
                else:
                    slopes = np.diff(vs)/np.diff(ts) if len(ts)>1 else np.array([])
                    for k, (time, value) in enumerate(zip(ts, vs)):
                        keys.extend(struct.pack('<6fI', time, value, slopes[k-1] if k else 0,
                            slopes[k] if k<len(slopes) else 0, 1/3, 1/3, 0))
                curves.append(dict(node=i, attribute=attribute, component=component, offset=offset,
                                   count=len(ts), stride=28, pre_wrap=1, post_wrap=1))
    need(curves, 'vmd_has_no_target_motion')
    metadata = dict(schema='metal-actor-clip-v1', name=name, length=float(times[-1]), frame_rate=sample_rate,
        loop=False, curves=curves,
        curve_provenance=dict(dict(kind='external-vmd-retargeted-linear-samples'), **provenance))
    return metadata, bytes(keys)


def append_clip(root, manifest_path, rig_doc, name, q, t, sample_rate, provenance, tangent_mode='linear'):
    import numpy as np
    archive = read_json(manifest_path)
    need(name not in {c['name'] for c in archive['clips']}, 'motion_already_imported')
    metadata, keys = encode_clip(rig_doc, name, q, t, sample_rate, provenance, tangent_mode=tangent_mode)
    frames, nodes = q.shape[:2]; times = np.arange(frames)/sample_rate
    stem = sha256_bytes(name.encode()); base = manifest_path.parent
    kp = base/'clips'/(stem+'.keys'); kp.parent.mkdir(exist_ok=True); kp.write_bytes(keys)
    oracle = bytearray(b'EFPOSE01'); samples=[]
    for frame in sorted({0, frames//2, frames-1}):
        offset = len(oracle)
        for i, node in enumerate(rig_doc['nodes']):
            oracle.extend(struct.pack('<10f', *t[frame,i], *q[frame,i], *node['scale']))
        samples.append(dict(time=float(times[frame]), offset=offset, node_count=nodes, stride=40))
    op = base/'clips'/(stem+'.oracle'); op.write_bytes(oracle)
    metadata = dict(metadata, keys=ref(kp,base), oracle=ref(op,base), samples=samples, independent_game_oracle=False)
    mp = base/'clips'/(stem+'.json'); write_json(mp, metadata)
    archive['clips'].append(dict(ref(mp,base), name=name, length=metadata['length'], loop=False, curve_count=len(metadata['curves'])))
    source = provenance.get('vmd_sha256') or provenance.get('npz_sha256') or provenance['source_sha256']
    archive['source_bundle_sha256'] = sha256_bytes((archive['source_bundle_sha256']+source).encode())
    write_json(manifest_path, archive)
    return metadata


def prepare_music(source, output, start, duration):
    """Use the OS decoder, then trim/pad to the motion's exact 48k stereo clock."""
    need(math.isfinite(start) and start >= 0, 'invalid_bgm_start')
    source = Path(source); need(source.is_file() and source.stat().st_size <= 256*1024**2, 'bgm_file_limit')
    with tempfile.TemporaryDirectory(prefix='endfield-bgm-') as tmp:
        decoded = Path(tmp)/'decoded.wav'
        result = subprocess.run(['/usr/bin/afconvert','-f','WAVE','-d','LEI16@48000','-c','2',str(source),str(decoded)], capture_output=True, text=True, timeout=120)
        need(result.returncode == 0, 'bgm_decode_failed: '+result.stderr[-800:])
        with wave.open(str(decoded),'rb') as audio:
            need(audio.getnchannels()==2 and audio.getframerate()==48000 and audio.getsampwidth()==2, 'unexpected_bgm_format')
            audio.setpos(min(audio.getnframes(), round(start*48000)))
            frames = max(1, math.ceil(duration*48000)); raw=audio.readframes(frames)
        missing=frames-len(raw)//4; raw+=bytes(missing*4)
        output.parent.mkdir(parents=True,exist_ok=True)
        with wave.open(str(output),'wb') as audio:
            audio.setparams((2,2,48000,0,'NONE','not compressed')); audio.writeframes(raw)
    return dict(source_sha256=digest(source), source_start_seconds=start, padded_frames=missing, frames=frames, sample_rate=48000)


def import_motion(package_path, vmd_path, output, source_model=None, duration=None, start=0,
                  title=None, bgm=None, bgm_start=None, foot_ik=True, face=True, camera=None, progress=None,
                  source_fps=None, morph_vmd=None, morph_fps=30.0, sample_rate=30, preroll=0.0, tangent_mode='pchip'):
    """progress(stage, fraction) is told the stages sample, retarget and write, each from 0 to 1."""
    import numpy as np
    from .mmd.io import last_frame, detect_source_fps, _slerp
    from .mmd.skeleton import MmdSkeleton, add_semi_standard_bones
    from .mmd.reference import build_pmd
    from .mmd.native_rig import NativeRig, package_humanoid
    from .mmd.rig_math import Retarget
    from .mmd.retarget import VmdToNative, coverage
    progress = progress or (lambda stage, fraction: None)
    progress('sample', 0)
    # install_clips checks the inventory's SHA-256 of each file it rewrites; the library checks the others when it publishes.
    package = Package(package_path, deep=False); output = Path(output).resolve()
    need(not output.exists(), 'output_already_exists')
    need(not output.is_relative_to(package.root),'output_inside_input_package')
    need(math.isfinite(start) and start >= 0, 'invalid_motion_start')
    need(isinstance(sample_rate, (int, float)) and not isinstance(sample_rate, bool) and 15 <= sample_rate <= 120, 'invalid_sample_rate')
    sample_rate = int(round(sample_rate))
    need(math.isfinite(morph_fps) and 1 <= morph_fps <= 240, 'invalid_morph_fps')
    need(math.isfinite(preroll) and 0 <= preroll <= 10.0, 'invalid_preroll')
    if bgm:need(Path(bgm).is_file() and Path(bgm).stat().st_size<=256*1024**2,'bgm_file_limit')
    vmd=checked_vmd(vmd_path)
    extra_morph=checked_morph_vmd(morph_vmd) if morph_vmd else None
    camera_vmd=checked_camera_vmd(camera) if camera else None
    if source_fps is None:
        src_fps = 30.0
    elif isinstance(source_fps, str) and source_fps.lower() == 'auto':
        src_fps = detect_source_fps(vmd, extra_morph)
    else:
        src_fps = float(source_fps)
        need(math.isfinite(src_fps) and 1 <= src_fps <= 240, 'invalid_source_fps')
    source_frames=last_frame(vmd)+1
    first_src=round(start*src_fps); available=(source_frames-1-first_src)/src_fps
    seconds=available if duration is None else duration
    need(math.isfinite(seconds) and 0 < seconds <= 180 and seconds <= available+1e-6, 'motion_range_limit_180_seconds')
    count=round(seconds*sample_rate)+1
    start=first_src/src_fps; seconds=(count-1)/sample_rate
    frame_times=first_src + np.arange(count, dtype=float)*(src_fps/sample_rate)
    if source_model:
        model=checked_pmd(source_model); model_source=digest(source_model)
    else: model=build_pmd(); model_source='authored-standard-control-reference-v1'
    need(len(model.bones)<=4096 and len({b.name for b in model.bones})==len(model.bones), 'invalid_source_bones')
    model=add_semi_standard_bones(model); sk=MmdSkeleton(model)
    need(count*sk.B<=4_000_000,'source_evaluation_budget')
    ev=sk.evaluate_vmd(vmd, frame_times=frame_times)
    progress('sample', 1); progress('retarget', 0)
    extra_identity = {}
    if source_fps is not None: extra_identity['source_fps'] = src_fps
    if sample_rate != 30: extra_identity['sample_rate'] = sample_rate
    if morph_vmd: extra_identity.update(morph_vmd=digest(morph_vmd), morph_fps=float(morph_fps))
    if preroll > 0: extra_identity['preroll'] = float(preroll)
    identity=sha256_bytes(canonical_json(dict(vmd=digest(vmd_path),model=model_source,start=start,duration=seconds,
        foot_ik=foot_ik,bgm=digest(bgm) if bgm else None,bgm_start=bgm_start,
        **(dict(camera=digest(camera)) if camera else {}), **extra_identity)))[:16]
    name='imported_vmd_'+identity; action='mmd_'+identity
    rig_doc,rig_sha=package_rig(package); rig=NativeRig(rig_doc,package_humanoid(package))
    conv=VmdToNative(rig,Retarget,sk); bake=conv.bake(ev,foot_ik=foot_ik,progress=lambda fraction:progress('retarget',fraction))
    q,t=rig.unity_pose(bake['Q'],bake['T'])
    preroll_frames=round(preroll*sample_rate)
    preroll_seconds=preroll_frames/sample_rate
    if preroll_frames > 0:
        q_rest,t_rest=rig.unity_pose(rig.q0[None],rig.t0[None])
        u=np.arange(preroll_frames, dtype=float)/preroll_frames
        w=(u**3)*(10.0+u*(-15.0+6.0*u))
        pre_q=_slerp(np.broadcast_to(q_rest[0],(preroll_frames,rig.N,4)),
                     np.broadcast_to(q[0],(preroll_frames,rig.N,4)), w[:,None])
        pre_t=t_rest[0][None,:,:]+(t[0][None,:,:]-t_rest[0][None,:,:])*w[:,None,None]
        q=np.concatenate([pre_q,q],axis=0)
        t=np.concatenate([pre_t,t],axis=0)
    total_frames=q.shape[0]; total_seconds=(total_frames-1)/sample_rate
    provenance=dict(vmd_sha256=digest(vmd_path),source_model=model_source,source_start_seconds=start,foot_ik=foot_ik,
                    target_rig_sha256=rig_sha,coordinate_boundary='MMD mirrorZ -> calibrated RH -> Unity mirrorX',
                    **({'source_fps': src_fps} if source_fps is not None else {}),
                    **({'preroll_seconds': preroll_seconds} if preroll_frames > 0 else {}))
    clip=dict(name=name,action=action,title=title or Path(vmd_path).stem,trigger='导入 VMD · 手动播放',q=q,t=t,provenance=provenance,
              sample_rate=sample_rate,tangent_mode=tangent_mode,
              bgm=dict(source=bgm,start=start if bgm_start is None else bgm_start,file=identity+'.wav') if bgm else None)
    if camera_vmd:
        from .mmd import camera as mmd_camera
        sampled=mmd_camera.sample(camera_vmd.cameras,first_src,count,frame_times=frame_times)
        # The source hips the bake measures the root offset from (VmdToNative.bake's init).
        source_origin=conv.src.positions(ev['wp'][:1],ev['wq'][:1])[0,conv.ret.si['Hips']]
        to_rig=dict(scale=float(conv.ret.scale),basis=conv.C.tolist(),source_origin=source_origin.tolist(),
                    rig_origin=conv.rig.rest[conv.rig.hips,:3,3].tolist(),unity_mirror='x')
        clip['camera']=mmd_camera.document(name,sampled,to_rig,frame_rate=sample_rate)
    warnings=[];has_any_morph=bool(vmd.morphs) or bool(extra_morph and extra_morph.morphs)
    inputs=package_face(package) if face and has_any_morph else None
    if inputs:
        from .mmd import morph
        mapping=morph.resolve(*inputs)
        dense={}; mapped_set=set(); unmapped_set=set()
        if vmd.morphs:
            d0, m0, u0 = morph.bake(vmd.morphs, first_src, count, mapping, frame_times=frame_times)
            for k, arr in d0.items(): dense[k] = arr
            mapped_set.update(m0); unmapped_set.update(u0)
        if extra_morph and extra_morph.morphs:
            morph_times = start * float(morph_fps) + np.arange(count, dtype=float) * (float(morph_fps) / sample_rate)
            d1, m1, u1 = morph.bake(extra_morph.morphs, 0, count, mapping, frame_times=morph_times)
            for k, arr in d1.items():
                dense[k] = np.clip(dense[k] + arr, 0, 1) if k in dense else arr
            mapped_set.update(m1); unmapped_set.update(u1)
        mapped=sorted(mapped_set); unmapped=sorted(unmapped_set - mapped_set)
        result=morph.budgeted(dense,fps=sample_rate,tangent_mode=tangent_mode,time_offset=preroll_seconds) if mapped else None
        if mapped and result is None:warnings.append('face_budget')
        if result:
            curves,tolerance=result;slots=morph.load_slots()
            blink=any(slots.get(x) in ('blink','blink_l','blink_r') for x in mapped)
            clip['face']=dict(document=morph.clip_document(clip['title'],total_seconds,curves,blink,fps=sample_rate,tangent_mode=tangent_mode,time_offset=preroll_seconds),
                              mapped=mapped,unmapped=unmapped,controls=len(curves),keys=sum(map(len,curves.values())),tolerance=tolerance)
    def report(installed,rig_unchanged):
        [(metadata,music_info)]=installed
        doc=dict(schema='endfield-vmd-import/v1',character=package.id,action=action,clip=name,frames=total_frames,duration=metadata['length'],target_nodes=rig.N,
            provenance=provenance,coverage=coverage(conv,vmd),bgm=music_info,original_rig_unchanged=rig_unchanged,
            scope='retargeted body/fingers; source morph/camera/light/physics are not applied')
        # Without a face clip the report keeps its earlier bytes.
        if 'face' in clip:
            # install_clips writes every clip's face document before it calls report, so the face is applied.
            doc.update(face=dict({k:clip['face'][k] for k in ['mapped','unmapped','controls','keys','tolerance']},
                                 facial_animation=action,file='animation/face/'+name+'.json',
                                 mapping='package' if inputs[2] is not None else 'default',applied=True),
                       scope='retargeted body/fingers; mapped morphs→face controls; source camera/light/physics are not applied')
        if warnings:doc.update(face=None,warnings=warnings)
        # The camera track is stored for the host, which does not play it (scope: source camera is not applied).
        if camera_vmd:doc.update(camera=dict(keys=len(camera_vmd.cameras),frames=count,cuts=clip['camera']['cuts'],
            file='animation/camera/'+name+'.json',source_sha256=digest(camera),perspective=all(clip['camera']['perspective']),
            coordinate_boundary=provenance['coordinate_boundary'],applied=False))
        return doc
    progress('write', 0)
    document=install_clips(package,output,[clip],'vmd-'+identity,report)
    progress('write', 1)
    return document


def package_rig(package):
    """The package's native rig document and the SHA-256 its actor archive records for it."""
    native=read_json(package.root/package.native_ref['file']); entry=native['characters'][0]
    archive_path=package.root/Path(package.native_ref['file']).parent/entry['actor_archive']['file']; archive=read_json(archive_path)
    return read_json(archive_path.parent/archive['rig']['file']),archive['rig']['sha256']


def package_face(package):
    """(face controls, emotion map, morph map or None) from the package's c7 animation folder; None without both inputs."""
    native=read_json(package.root/package.native_ref['file'])
    animation=package.root/Path(package.native_ref['file']).parent/Path(native['characters'][0]['c7']['file']).parent/'animation'
    controls,emotion,override=(animation/x for x in ['original-face-controls.json','emotion-lipsync.json','mmd-morph-map.json'])
    if not (controls.is_file() and emotion.is_file()):return None
    face_controls=read_json(controls)
    if face_controls.get('schema')!='endfield-original-face-controls-v2':return None
    return face_controls,read_json(emotion),read_json(override) if override.is_file() else None


def install_clips(package,output,clips,report_name,report):
    """Clone the package to the NEW directory output and add each clip to its archive, palette and action menu.

    A clip holds name, action, title, trigger, q/t in Unity coordinates (F×N×4, F×N×3), the curve provenance and
    bgm (None or source/start/file), and optionally face (its facial-animation document and mapping summary) and camera (its camera document). report(installed, rig_unchanged) returns the provenance/<report_name>.json
    document, installed being each clip's (metadata, music info)."""
    from .mmd.native_rig import package_humanoid
    output=Path(output).resolve()
    need(not output.exists(), 'output_already_exists')
    need(not output.is_relative_to(package.root),'output_inside_input_package')
    humanoid=package_humanoid(package)
    output.parent.mkdir(parents=True,exist_ok=True)
    stage=Path(tempfile.mkdtemp(prefix='.vmd-',dir=output.parent)); shutil.rmtree(stage)
    try:
        subprocess.run(['/bin/cp','-cR',str(package.root),str(stage)],check=True)
        definition=read_json(stage/'character.json'); runtime=stage/Path(package.native_ref['file']).parent
        native_path=stage/package.native_ref['file']; native=read_json(native_path); entry=native['characters'][0]
        archive_path=runtime/entry['actor_archive']['file']; archive=read_json(archive_path)
        rig_doc=read_json(archive_path.parent/archive['rig']['file'])
        pack_path=runtime/entry['c7']['file']; pack=read_json(pack_path); animation=pack_path.parent/'animation'; interaction=pack_path.parent/'interaction'
        palette_path=animation/pack['animation']['palette_contract']['file']; palette=read_json(palette_path)
        def change(folder,file,fn):
            p=folder/file; d=read_json(p);fn(d);write_document(p,d)
        def reference(p,root):
            """ref(p,root); a file still as cloned (cp -c keeps size and mtime) keeps the hash of the package's inventory, which the
            library checks in the copy it publishes; a file the import rewrote was read from a package file that must match it."""
            # String slices: p lies under root and root under stage, and relative_to is slow over every file of a package.
            key=str(p)[len(str(stage))+1:];known=package.inventory.get(key)
            if known is None:return ref(p,root)
            a,b=p.stat(),(package.root/key).stat()
            if (a.st_size,a.st_mtime_ns)!=(b.st_size,b.st_mtime_ns):
                need(digest(package.root/key)==known['sha256'],'file_sha_mismatch')
                return ref(p,root)
            return dict(file=str(p)[len(str(root))+1:],sha256=known['sha256'],byte_count=known['byte_count'])
        installed=[]
        for clip in clips:
            name,action,q,t,bgm=clip['name'],clip['action'],clip['q'],clip['t'],clip['bgm']
            metadata=append_clip(runtime,archive_path,rig_doc,name,q,t,clip.get('sample_rate',30),clip['provenance'],tangent_mode=clip.get('tangent_mode','pchip'))
            stance_start,stance_end=stances(rig_doc,q,t,humanoid=humanoid)
            palette['clips'].append(dict(name=name,loop=False,length=metadata['length']))
            change(animation,'intent-motion-map.json',lambda d:d['clips'].update({name:dict(interruptible=True,end_at_length=True)}))
            change(animation,'actions.json',lambda d:d['actions'].append(dict(id=action,name=clip['title'],section='idle',clips=[name],trigger=clip['trigger'],duration=metadata['length'])))
            change(interaction,'motion-metadata.json',lambda d:d['clips'].update({name:dict(stance_start=stance_start,stance_end=stance_end)}))
            change(interaction,'blend-times.json',lambda d:d['clips'].update({name:dict(blend_in_s=0 if bgm else .25)}))
            music_info=None;face=clip.get('face')
            if face:
                face_path=animation/'face'/(name+'.json');write_json(face_path,face['document'])
                library_path=animation/'facial-animations.json'
                library=read_json(library_path) if library_path.exists() else dict(schema='endfield-runtime-facial-library/v1',
                    character=pack['id'],controls_sha256=digest(animation/'original-face-controls.json'),clips=[])
                library['clips'].append(dict(id=action,name=clip['title'],duration=metadata['length'],animation=ref(face_path,animation),motion_only=True))
                write_json(library_path,library)
                if not any(x['file']=='facial-animations.json'for x in pack['animation']['data']):pack['animation']['data'].append(ref(library_path,animation))
            camera=clip.get('camera')
            if camera:
                camera_path=animation/'camera'/(name+'.json');camera_path.parent.mkdir(exist_ok=True);write_json(camera_path,camera)
            if bgm or face or camera:
                media_path=animation/'motion-media.json'
                media=read_json(media_path) if media_path.exists() else dict(schema='endfield-motion-media/v1',tracks=[])
                track=dict(action=action,clip=name,length=metadata['length'])
                if bgm:
                    music=animation/'music'/bgm['file']
                    music_info=prepare_music(bgm['source'],music,bgm['start'],metadata['length'])
                    track.update(audio=ref(music,animation),sample_rate=48000,channels=2)
                if face:track['face']=dict(facial_animation=action)
                if camera:track['camera']=ref(camera_path,animation)
                media['tracks'].append(track)
                if any('face' in x or 'camera' in x for x in media['tracks']):media['schema']='endfield-motion-media/v2'
                write_json(media_path,media)
                if not any(x['file']=='motion-media.json'for x in pack['animation']['data']):pack['animation']['data'].append(ref(media_path,animation))
            installed.append((metadata,music_info))
        write_json(palette_path,palette); pack['animation']['palette_contract']=ref(palette_path,animation)
        if (animation/'supplemental-clips.json').exists():
            change(animation,'supplemental-clips.json',lambda d:d.update(base_contract_sha256=digest(palette_path)))
        for section in ['animation','interaction']:
            folder=pack_path.parent/section
            pack[section]['data']=[dict(x,**ref(folder/x['file'],folder))for x in pack[section]['data']]
        write_json(pack_path,pack);entry['c7']=ref(pack_path,runtime);entry['actor_archive']=ref(archive_path,runtime)
        cp=runtime/entry['coverage']['file'];write_json(cp,native_bundle.character_coverage(runtime,entry));entry['coverage']=ref(cp,runtime)
        roles={x['file']:x.get('roles',['runtime_imported_motion']) for x in native['files']}
        native['files']=[dict(**reference(p,runtime),roles=roles.get(p.relative_to(runtime).as_posix(),['runtime_imported_motion']))for p in sorted(runtime.rglob('*'))if p.is_file() and p!=native_path]
        write_json(native_path,native);native_bundle.verify(runtime)
        definition['components']['render']['native_bundle']=ref(native_path,stage)
        # The host finds the window envelope of an imported package by the version it derives from.
        definition.setdefault('base_package_version',definition['version'])
        major,minor,patch=map(int,definition['version'].split('.'));definition['version']=f'{major}.{minor}.{patch+1}'
        report=report(installed,digest(archive_path.parent/archive['rig']['file'])==archive['rig']['sha256'])
        write_json(stage/'provenance'/(report_name+'.json'),report)
        definition['inventory']=[reference(p,stage)for p in sorted(stage.rglob('*'))if p.is_file() and p!=stage/'character.json']
        write_json(stage/'character.json',definition);Package(stage,deep=False);stage.rename(output)
        return report
    finally:
        if stage.exists():shutil.rmtree(stage)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for key in ['library','vmd','output']:p.add_argument('--'+key,type=Path,required=True)
    p.add_argument('--character',action='append',required=True,help='repeat for several existing characters')
    p.add_argument('--source-model',type=Path,help='optional original PMD skeleton; default authored standard MMD control reference')
    p.add_argument('--bgm',type=Path);p.add_argument('--bgm-start',type=float);p.add_argument('--start',type=float,default=0);p.add_argument('--duration',type=float)
    p.add_argument('--title');p.add_argument('--no-foot-ik',action='store_true');p.add_argument('--export',action='store_true')
    p.add_argument('--source-fps',default=None,help='source VMD frame rate (30, 60, or auto)')
    p.add_argument('--sample-rate',type=int,default=30,help='target baked clip frame rate (15..120)')
    p.add_argument('--morph-vmd',type=Path,help='optional paired morph-only VMD')
    p.add_argument('--morph-fps',type=float,default=30.0,help='paired morph VMD frame rate')
    p.add_argument('--preroll',type=float,default=0.0,help='seconds of rest-to-frame-0 C2 ease-in preroll')
    a=p.parse_args();need(not a.output.exists(),'output_already_exists')
    need(not a.output.resolve().is_relative_to(a.library.resolve()),'output_inside_input_library')
    need(len(set(a.character))==len(a.character),'duplicate_character')
    packages=Library(a.library).packages();by={x.id:x for x in packages};need(set(a.character).issubset(by),'unknown_character')
    a.output.mkdir(parents=True);reports=[];selected={}
    try:
        for cid in a.character:
            target=a.output/'packages-built'/cid
            report=import_motion(by[cid].root,a.vmd,target,a.source_model,a.duration,a.start,a.title,a.bgm,a.bgm_start,
                                 not a.no_foot_ik,source_fps=a.source_fps,morph_vmd=a.morph_vmd,morph_fps=a.morph_fps,
                                 sample_rate=a.sample_rate,preroll=a.preroll)
            reports.append(report);selected[cid]=target
            if a.export:export_package(target,a.output/(cid+'.endfield-character'))
        library=Library(a.output/'library');library.root.mkdir()
        built=[]
        # A new offline generation owns real APFS clones, never write-through
        # symlinks/hardlinks or a replacement underneath a live character-switch transaction.
        for original in packages:
            source=Package(selected.get(original.id,original.root))
            destination=library.root/'packages'/source.id/source.sha256
            destination.parent.mkdir(parents=True,exist_ok=True)
            subprocess.run(['/bin/cp','-cR',str(source.root),str(destination)],check=True)
            built.append(Package(destination,deep=False))
        default=Library(a.library).snapshot()['default_character']
        library.publish(sorted(built,key=lambda package:(package.id!=default,package.id)))
        write_json(a.output/'import-result.json',dict(passed=True,catalog=str(a.output/'library/current.json'),reports=reports))
        print(json.dumps(dict(passed=True,catalog=str(a.output/'library/current.json'),reports=reports),ensure_ascii=False))
    except BaseException:
        shutil.rmtree(a.output);raise


if __name__=='__main__':main()
