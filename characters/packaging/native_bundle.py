#!/usr/bin/env python3
"""Build/verify relocatable native character assets without Unity, Metal or network.
Only the generated HDRI/lighting descriptors may be rebased; original documents
and every payload/program byte are retained and SHA-bound separately.
"""
from __future__ import annotations
import argparse, hashlib, json, os, pathlib, shutil, tempfile, uuid, sys
from dataclasses import dataclass
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[2]/'agent/agentd'))
from resource_store import clone_or_copy
import pool_codec
import neutral_package, package_format

class BundleError(ValueError): pass
# The neutral package written beside each character's frame graph: entry field, path in the folder that holds graph/.
NEUTRAL=(('neutral_scene','neutral/scene.json'),('neutral_build_record','neutral/build-record.json'),('metal_product','metal/product.json'))
# The Windows frame table in the same folder; its blob records name files of that folder.
VULKAN=('vulkan_frame','vulkan/frame.bin')

def require(ok, message):
    if not ok: raise BundleError(message)
def digest(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        while b:=f.read(4*1024*1024): h.update(b)
    return h.hexdigest()
def load(path):
    def unique(pairs):
        d={}
        for k,v in pairs:
            require(k not in d,f'duplicate JSON key: {k}');d[k]=v
        return d
    return json.loads(pathlib.Path(path).read_bytes(),object_pairs_hook=unique,parse_constant=lambda v:(_ for _ in ()).throw(BundleError(f'nonfinite JSON: {v}')))
def json_bytes(value): return (json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n').encode()
def relative(value):
    require(isinstance(value,str) and value and '\\' not in value and '\x00' not in value,'invalid relative path')
    p=pathlib.PurePosixPath(value)
    require(not p.is_absolute() and '..' not in p.parts and p.as_posix()==value and value not in ('.','..'),'path must be normalized and stay inside its component: '+value)
    return p

def pointers(value,prefix=()):
    if isinstance(value,dict):
        if isinstance(value.get('file'),str) and isinstance(value.get('sha256'),str):
            yield prefix,value
            return
        for key,child in value.items():yield from pointers(child,prefix+(key,))
    elif isinstance(value,list):
        for i,child in enumerate(value):yield from pointers(child,prefix+(i,))

def references(doc,kind):
    """Only fields actually consumed by the current typed native readers.
    Other absolute paths are provenance, not silently treated as runtime inputs.
    """
    if kind=='source':
        require(doc.get('schema') in ['endfield-whole-source-sampler-v4','endfield-native-character-manifest-v1'],'unknown source schema')
        for i,draw in enumerate(doc['draws']):
            yield ('draws',i,'indices'),draw['indices'],'blob',''
            for j,r in enumerate(draw['attributes']):yield ('draws',i,'attributes',j),r,'blob',''
            for j,r in enumerate(draw['resources']):
                if 'cube' in str(r.get('reflected_type','')).lower() and doc.get('original_cube'):continue
                if isinstance(r.get('file'),str) and isinstance(r.get('sha256'),str):yield ('draws',i,'resources',j),r,'blob',''
        if doc.get('original_cube'):yield ('original_cube',),doc['original_cube'],'blob',''
    elif kind=='library':
        require(doc.get('schema')=='metal-program-library-v1','unknown program schema')
        for i,p in enumerate(doc['programs']):
            for artifact in ['library','msl','air','reflection']:
                if p.get(artifact):yield ('programs',i,artifact),p[artifact],'blob',''
    elif kind=='graph':
        require(doc.get('schema')=='metal-frame-graph-v1','unknown graph schema')
        for key in ['textures','passes','frame_inputs']:
            for p,r in pointers(doc.get(key),(key,)):yield p,r,'blob',''
    elif kind=='archive':
        require(doc.get('schema')=='metal-actor-source-export-v1','unknown actor schema')
        yield ('rig',),doc['rig'],'opaque',''
        for i,r in enumerate(doc['clips']):yield ('clips',i),r,'actor_clip',''
    elif kind=='actor_clip':
        require(doc.get('schema')=='metal-actor-clip-v1','unknown actor clip schema')
        # The oracle file is test and build-time evidence; a release bundle may leave it out.
        yield ('keys',),doc['keys'],'blob','';yield ('oracle',),doc['oracle'],'optional_blob',''
    elif kind=='c7':
        require(doc.get('schema')=='endfield-character-pack/v1','unknown C7 schema')
        for section in ['render','animation','interaction']:
            for p,r in pointers(doc.get(section),(section,)):
                # render.manifest names the native source manifest by identity; it is not a file under render/.
                if p==('render','manifest'):continue
                typed={'motion-media.json':'motion_media','facial-animations.json':'facial_library'} if section=='animation' else {'bone-physics.json':'bone_physics','composites.json':'composites'} if section=='interaction' else {}
                yield p,r,typed.get(r['file'],'opaque'),section
    elif kind=='facial_library':
        require(doc.get('schema')=='endfield-runtime-facial-library/v1','unknown facial library schema')
        for i,row in enumerate(doc['clips']):yield ('clips',i,'animation'),row['animation'],'opaque',''
    elif kind=='composites':
        require(doc.get('schema')=='endfield-runtime-composites/v1','unknown composite schema')
        for i,row in enumerate(doc['entities']):
            yield ('entities',i,'archive'),row['archive'],'archive',''
            yield ('entities',i,'palette'),row['palette'],'opaque',''
    elif kind=='motion_media':
        require(doc.get('schema') in ['endfield-motion-media/v1','endfield-motion-media/v2'],'unknown motion media schema')
        for i,track in enumerate(doc['tracks']):
            # v2 tracks without BGM carry no audio.
            if doc['schema']=='endfield-motion-media/v1' or 'audio' in track:yield ('tracks',i,'audio'),track['audio'],'blob',''
            if doc['schema']=='endfield-motion-media/v2' and 'camera' in track:yield ('tracks',i,'camera'),track['camera'],'blob',''
    elif kind=='bone_physics':
        require(doc.get('schema') in ['metal-actor-bone-physics/v1','metal-actor-bone-physics/v2'],'unknown bone physics schema')
        for i,r in enumerate(doc['source_files']):yield ('source_files',i),r,'blob',''
    elif kind=='lighting':
        require(doc.get('schema')=='metal-product-lighting/v1','unknown lighting schema')
        yield ('sphere_source',),doc['sphere_source'],'opaque',''
        if doc.get('environment'):yield ('environment',),doc['environment'],'hdri',''
    elif kind=='hdri':
        require(doc.get('schema')=='metal-product-hdri-environment-input-v1','unknown HDRI schema')
        for key in ['source_manifest','probe_evidence']:yield (key,),doc[key],'opaque',''
        yield ('reflection_cube',),doc['reflection_cube'],'blob',''
    elif kind=='scene_objects':
        require(doc.get('schema')=='endfield-scene-objects-v1','unknown scene objects schema')
    elif kind not in ['blob','optional_blob','opaque']:raise BundleError('unknown component kind: '+kind)

@dataclass
class Copied:
    path:str
    sha256:str
    byte_count:int
    def ref(self):return dict(file=self.path,sha256=self.sha256,byte_count=self.byte_count)

class Builder:
    def __init__(self,root):self.root=pathlib.Path(root);self.files={};self.folded={};self.documents={};self.relocations=[];self.provenance_paths=[]
    def target(self,path):
        p=relative(str(path));fold=str(p).casefold()
        require(fold not in self.folded or self.folded[fold]==str(p),'case-colliding portable path')
        self.folded[fold]=str(p);out=self.root/str(p);out.parent.mkdir(parents=True,exist_ok=True);return out
    def record(self,path,sha,size,role):
        key=str(path);old=self.files.get(key)
        require(old is None or (old['sha256']==sha and old['byte_count']==size),'different bytes at '+key)
        if old:old['roles']=sorted(set(old['roles']+[role]))
        else:self.files[key]=dict(file=key,sha256=sha,byte_count=size,roles=[role])
        return Copied(key,sha,size)
    def copy(self,source,target,expected=None,expected_size=None,role='runtime'):
        source=pathlib.Path(source);require(source.is_file(),'missing dependency: '+str(source))
        sha=digest(source);size=source.stat().st_size
        require(expected is None or sha==expected,'source SHA mismatch: '+str(source));require(expected_size is None or size==expected_size,'source byte count mismatch: '+str(source))
        out=self.target(target)
        if not out.exists():clone_or_copy(source,out)
        require(digest(out)==sha and out.stat().st_size==size,'copied bytes mismatch: '+str(out))
        return self.record(target,sha,size,role)
    def write(self,value,target,role):
        data=json_bytes(value);out=self.target(target);sha=hashlib.sha256(data).hexdigest()
        if out.exists():require(out.read_bytes()==data,'generated path collision')
        else:out.write_bytes(data)
        return self.record(target,sha,len(data),role)
    def component(self,source,target,kind,expected=None,expected_size=None,actor_source_root=None,actor_target_root=None):
        source=pathlib.Path(source).resolve();target=str(relative(str(target)))
        if kind=='optional_blob':
            if not source.is_file():return None
            kind='blob'
        identity=(str(source),target,kind)
        source_base=actor_source_root if kind=='actor_clip' else source.parent
        target_base=actor_target_root if kind=='actor_clip' else pathlib.PurePosixPath(target).parent
        require(source_base is not None and target_base is not None,'actor clip must resolve against its archive root')
        if identity in self.documents:return self.documents[identity]
        original=self.copy(source,target,expected,expected_size,'runtime_'+kind)
        if kind in ['blob','opaque']:self.documents[identity]=original;return original
        doc=load(source);changed=False
        # Retain exact source documents outside the runtime input tree.
        self.copy(source,'provenance/documents/'+original.sha256+'.json',original.sha256,original.byte_count,'source_document')
        refs=list(references(doc,kind));runtime_pointers={p for p,_,_,_ in refs}
        for p,r,sub,section in refs:
            raw=r['file'];abs_path=pathlib.PurePosixPath(raw).is_absolute()
            # ProductHDRIInput currently accepts an absolute proof reference.
            # Rebase only this explicit consumed boundary, never arbitrary blobs.
            require(not abs_path or kind=='hdri' and p in [('source_manifest',),('probe_evidence',)],'absolute runtime dependency: '+str(p))
            src=(pathlib.Path(raw) if abs_path else source_base/section/str(relative(raw))).resolve()
            if not abs_path:require(src.is_relative_to((source_base/section).resolve()),'source dependency symlink escapes component')
            if abs_path:rel='evidence/'+r['sha256']+'.json'
            else:rel=raw
            dst=target_base/section/rel
            child=self.component(src,str(dst),sub,r['sha256'],r.get('byte_count'),source.parent if kind=='archive' else None,pathlib.PurePosixPath(target).parent if kind=='archive' else None)
            if child is None:continue
            if child.sha256 != r['sha256'] or rel != raw:
                require(kind in ['hdri','lighting'],'unexpected payload/source mutation')
                old=dict(r);r['file']=rel;r['sha256']=child.sha256
                if 'byte_count' in r:r['byte_count']=child.byte_count
                changed=True;self.relocations.append(dict(document=target,pointer='/'.join(map(str,p)),before=old,after=dict(r)))
        # Absolute provenance is reported, never opened as an implicit dependency.
        def strings(v,p=()):
            if isinstance(v,str) and v.startswith('/'):yield p,v
            elif isinstance(v,dict):
                for k,x in v.items():yield from strings(x,p+(k,))
            elif isinstance(v,list):
                for i,x in enumerate(v):yield from strings(x,p+(i,))
        for p,value in strings(doc):self.provenance_paths.append(dict(document=target,pointer='/'.join(map(str,p)),value=value,runtime_dependency=False))
        if changed:
            # The original is retained above; only this generated descriptor is
            # rewritten. Its consuming reference receives the new SHA.
            out=self.root/target;data=json_bytes(doc);out.write_bytes(data)
            self.files.pop(target);original=self.record(target,hashlib.sha256(data).hexdigest(),len(data),'runtime_'+kind)
        self.documents[identity]=original;return original

def character_coverage(root,entry):
    source=load(root/entry['source']['file']);graph=load(root/entry['graph']['file']);pack=load(root/entry['c7']['file']);archive=load(root/entry['actor_archive']['file'])
    contract=load((root/entry['c7']['file']).parent/'animation'/pack['animation']['palette_contract']['file'])
    aliases={}
    shared=next((r for r in pack['interaction']['data'] if r['file']=='shared-interactions.json'),None)
    if shared:
        path=(root/entry['c7']['file']).parent/'interaction'/shared['file']
        require(digest(path)==shared['sha256'],'shared interaction identity mismatch')
        doc=load(path);require(doc['schema']=='endfield-shared-interactions/v1','unsupported shared interactions')
        aliases=doc['visibility_aliases']
        original={c['name'] for c in contract['clips']};playable={c['name'] for c in archive['clips']}
        require(set(aliases).issubset(playable) and all(v in original and k not in original for k,v in aliases.items()),'invalid derived visibility aliases')
    prepared={i for p in graph['passes'] for i in p.get('draws',[])};by_mesh={}
    for i,d in enumerate(source['draws']):
        # NativeEndfieldRenderer source schedule: opaque PreGBuffer only.
        if (d['pass_name']!='PreGBuffer' or d['queue']<=2500) and d.get('serialized_disabled_lightmode_match') is not True:by_mesh.setdefault(d['mesh'],[]).append(i)
    blocked={};appearances=[a['id'] for a in pack['appearances']]
    require(pack['id']==entry['id'],'bundle/C7 character identity mismatch')
    require(entry['default_appearance'] in appearances,'default appearance absent from C7')
    require(entry['default_clip'] in {c['name'] for c in archive['clips']},'default clip absent from ActorArchive')
    require(pack['render']['manifest']['sha256']==entry['source']['sha256'] and graph['manifest_sha256']==entry['source']['sha256'],'C7/graph/native source identity mismatch')
    composites={}
    composite_ref=next((r for r in pack['interaction']['data'] if r['file']=='composites.json'),None)
    if composite_ref:
        base=(root/entry['c7']['file']).parent/'interaction'
        def checked(ref):
            path=base/str(relative(ref['file']))
            require(path.resolve().is_relative_to(root.resolve()) and digest(path)==ref['sha256'],'composite dependency identity mismatch')
            return load(path)
        doc=checked(composite_ref)
        require(doc.get('schema')=='endfield-runtime-composites/v1' and doc['character']==entry['id'],'invalid composite owner')
        entities={}
        for entity in doc['entities']:
            require(entity['id'] not in entities,'duplicate composite entity')
            palette=checked(entity['palette']);aux=checked(entity['archive'])
            names=[m['mesh'] for m in palette['meshes']]
            require(names and all(n.startswith('entity:'+entity['id']+'/') for n in names),'invalid composite mesh namespace')
            entities[entity['id']]=(names,{c['name'] for c in aux['clips']})
        owner_clips={c['name'] for c in archive['clips']}
        for binding in doc['bindings']:
            require(binding['ownerClip'] in owner_clips and binding['entity'] in entities,'invalid composite binding owner')
            names,clips=entities[binding['entity']]
            require(binding['animation'] in clips,'absent composite source animation')
            composites.setdefault(binding['ownerClip'],set()).update(names)
    for appearance in appearances:
        for clip in archive['clips']:
            missing=[]
            visibility_clip=aliases.get(clip['name'],clip['name'])
            for m in contract['meshes']:
                if m.get('visible_with_clips') is not None and visibility_clip not in m['visible_with_clips']:continue
                if m.get('appearances') is not None and appearance not in m['appearances']:continue
                indices=by_mesh.get(m['mesh'],[])
                if not indices:
                    # Action-only props are required when that action is active,
                    # just like the body. Silently skipping them hides incomplete
                    # packages (for example a reading action without its book).
                    missing.append(dict(mesh=m['mesh'],reason='absent_source_mesh'))
                elif any(i not in prepared for i in indices):missing.append(dict(mesh=m['mesh'],reason='unprepared_source_draws',draws=[i for i in indices if i not in prepared]))
            for name in sorted(composites.get(clip['name'],())):
                indices=by_mesh.get(name,[])
                if not indices:missing.append(dict(mesh=name,reason='absent_source_mesh'))
                elif any(i not in prepared for i in indices):missing.append(dict(mesh=name,reason='unprepared_source_draws',draws=[i for i in indices if i not in prepared]))
            if missing:blocked[appearance+':'+clip['name']]=missing
    require(entry['default_appearance']+':'+entry['default_clip'] not in blocked,'default clip is not fully prepared')
    return dict(clip_count=len(archive['clips']),appearances=appearances,prepared_draws=len(prepared),source_draws=len(source['draws']),blocked_clip_appearance_count=len(blocked),blocked=blocked,scope='geometry draw closure only; no GPU, fidelity, missing-UV or material acceptance inferred')

def motion_media_faces(root,entry):
    pack=load(root/entry['c7']['file']);base=(root/entry['c7']['file']).parent/'animation'
    def checked(file):
        ref=next((r for r in pack['animation']['data'] if r['file']==file),None)
        if ref is None:return None
        path=base/str(relative(ref['file']))
        require(path.resolve().is_relative_to(root.resolve()) and digest(path)==ref['sha256'],'motion media dependency identity mismatch')
        return load(path)
    media=checked('motion-media.json')
    if media is None or media['schema']!='endfield-motion-media/v2':return
    faces=[t['face'] for t in media['tracks'] if 'face' in t]
    if not faces:return
    library=checked('facial-animations.json');ids={row.get('id') for row in library['clips']} if library else set()
    require(all(isinstance(f,dict) and isinstance(f.get('facial_animation'),str) and f['facial_animation'] in ids for f in faces),'motion media face names an absent facial animation')

def emitted(scene,record,metal):return neutral_package.dumps(neutral_package.emit_metal(scene,metal,record)).encode()
def neutral_documents(raw):
    """The neutral scene, build record and Metal product of the frame graph bytes raw, in NEUTRAL order; they must emit raw byte for byte."""
    scene,metal,record=neutral_package.split(json.loads(raw))
    require(emitted(scene,record,metal)==raw,'neutral package does not emit the frame graph byte for byte')
    return scene,record,metal
def neutral_path(entry,path):return str(pathlib.PurePosixPath(entry['graph']['file']).parent.parent/path)
def vulkan_blobs(data,scene_sha256):
    """(name, sha256, size) of each blob record of the frame table bytes data, which must be bound to the neutral scene scene_sha256."""
    f=package_format;head=f.STRUCTS['Header']
    require(data[:8]==f.MAGIC and len(data)>=head.size,'vulkan frame table is not '+f.MAGIC.decode())
    h=head.unpack(data)
    require(h['version']==f.VERSION,f"vulkan frame table is version {h['version']}, not {f.VERSION}")
    require(h['header_bytes']==head.size and h['file_bytes']==len(data),'vulkan frame table length mismatch')
    for t in f.TABLES:
        size=1 if t=='strings' else f.table_struct(t).size
        require(head.size<=h[t+'_offset'] and h[t+'_offset']+h[t+'_count']*size<=len(data),'vulkan frame table lies outside the file: '+t)
    require(h['scene_sha256'].hex()==scene_sha256,f"vulkan frame table is bound to neutral scene {h['scene_sha256'].hex()}, not {scene_sha256}")
    strings=data[h['strings_offset']:h['strings_offset']+h['strings_count']];blob=f.table_struct('blobs')
    for i in range(h['blobs_count']):
        b=blob.unpack(data,h['blobs_offset']+i*blob.size);end=strings.find(b'\0',b['file'])
        require(end>=0,'vulkan blob name is not NUL-terminated');name=strings[b['file']:end].decode(errors='replace')
        require(f.blob_name_ok(name),'vulkan blob name leaves the character directory: '+name)
        yield name,b['sha256'].hex(),b['size']
def write_neutral(root,entry,graph):
    """For tools that change a frame graph: writes graph as entry's frame graph, in emit_metal's form, and its neutral package beside it,
    and points entry's NEUTRAL fields at them. root is the bundle directory; the caller lists the files in bundle.json."""
    # The Vulkan frame table is bound to the scene it was built from.
    entry.pop(VULKAN[0],None)
    for p in graph['passes']:
        for f in p.get('fullscreen') or []:
            # A key-sorted graph has fragment_adapter first, which split refuses; emit_metal writes the adapters last.
            for key in neutral_package.ADAPTER_KEYS:
                if key in f:f[key]=f.pop(key)
    scene,metal,record=neutral_package.split(graph)
    root=pathlib.Path(root);raw=emitted(scene,record,metal);(root/entry['graph']['file']).write_bytes(raw)
    for (field,path),value in zip(NEUTRAL,neutral_documents(raw)):
        rel=neutral_path(entry,path);data=json_bytes(value);out=root/rel;out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(data)
        entry[field]=dict(file=rel,sha256=hashlib.sha256(data).hexdigest(),byte_count=len(data))

def build(recipe_path,output):
    recipe_path=pathlib.Path(recipe_path).resolve();recipe=load(recipe_path);require(recipe.get('schema')=='metal-native-bundle-recipe/v1','unknown recipe')
    output=pathlib.Path(output).resolve();require(not output.exists(),'output already exists');output.parent.mkdir(parents=True,exist_ok=True)
    staging=output.with_name(output.name+'.partial-'+uuid.uuid4().hex);staging.mkdir();b=Builder(staging)
    try:
        entries=[]
        for c in recipe['characters']:
            name=c['id'];relative(name);require('/' not in name and name not in [e['id'] for e in entries],'duplicate/invalid character id')
            e=dict(id=name,default_clip=c['default_clip'],default_appearance=c.get('default_appearance','default'))
            for field,kind,directory in [('c7','c7','c7'),('actor_archive','archive','actor'),('source','source','source'),('library','library','programs'),('graph','graph','graph'),('lighting','lighting','lighting')]:
                item=c[field];path=pathlib.Path(item['file']);path=path if path.is_absolute() else recipe_path.parent/path;dest=f'characters/{name}/{directory}/{path.name}'
                e[field]=b.component(path,dest,kind,item['sha256'],item.get('byte_count')).ref()
            pack=load(staging/e['c7']['file']);graph=load(staging/e['graph']['file'])
            require(pack['id']==name and pack['render']['manifest']['sha256']==e['source']['sha256'],'C7/native source identity mismatch')
            require(graph['manifest_sha256']==e['source']['sha256'],'graph/source identity mismatch')
            for (field,path),value in zip(NEUTRAL,neutral_documents((staging/e['graph']['file']).read_bytes())):e[field]=b.write(value,neutral_path(e,path),'runtime_'+field).ref()
            coverage=character_coverage(staging,e);e['coverage']=b.write(coverage,f'characters/{name}/coverage.json','closure_receipt').ref()
            if 'library_ssaa1' in c:
                # Fixed name beside manifest.json, whose artifacts it shares.
                item=c['library_ssaa1'];path=pathlib.Path(item['file']);path=path if path.is_absolute() else recipe_path.parent/path
                e['library_ssaa1']=b.component(path,f'characters/{name}/programs/manifest-ssaa1.json','library',item['sha256'],item.get('byte_count')).ref()
            entries.append(e)
        # Scene data is shared by every character.
        scene={}
        if 'scene' in recipe:
            item=recipe['scene']['objects'];path=pathlib.Path(item['file']);path=path if path.is_absolute() else recipe_path.parent/path
            scene['objects']=b.component(path,'scene/objects.json','scene_objects',item['sha256'],item.get('byte_count')).ref()
        b.write(recipe,'provenance/build-recipe.json','provenance_not_runtime')
        b.write(dict(relocations=b.relocations,ignored_absolute_provenance=b.provenance_paths),'provenance/relocations.json','provenance_not_runtime')
        manifest=dict(schema='metal-native-character-bundle/v1',characters=entries,**(dict(scene=scene) if scene else {}),files=[b.files[k] for k in sorted(b.files)],requirements=dict(platform='macOS',minimum_os='26',host_supplied_separately=True,unity_runtime_required=False),claims=dict(byte_closed=True,gpu_revalidated=False,third_character_validated=False,full_feature_migration=False))
        (staging/'bundle.json').write_bytes(json_bytes(manifest));verify(staging);staging.rename(output);return output
    except BaseException:
        shutil.rmtree(staging);raise

def holds(root,item,sha,size=None):
    """True when the indexed file item holds the bytes sha (of size bytes, when given): as they are, or as a pool container of them."""
    if item['sha256']==sha and size in (None,item['byte_count']):return True
    if item['byte_count']==size:return False
    try:raw=pool_codec.raw_identity(root/item['file'],item['byte_count'])
    except ValueError:return False
    return raw[0]==sha and size in (None,raw[1])
def verify(root):
    root=pathlib.Path(root).resolve();manifest=load(root/'bundle.json');require(manifest.get('schema')=='metal-native-character-bundle/v1','unknown bundle')
    require(len({e['id'] for e in manifest['characters']})==len(manifest['characters']),'duplicate character ID')
    indexed={};folded=set();bytes_total=0
    for item in manifest['files']:
        rel=str(relative(item['file']));require(rel not in indexed and rel.casefold() not in folded,'duplicate/case-colliding inventory path');folded.add(rel.casefold());path=root/rel
        require(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(root),'absent/escaping/nonregular packaged file: '+rel)
        require(path.stat().st_size==item['byte_count'] and digest(path)==item['sha256'],'packaged SHA/length mismatch: '+rel);indexed[rel]=item;bytes_total+=item['byte_count']
    visited=set();runtime=set();pools={}
    def visit(ref,kind,actor_root=None,pool=None):
        named=path=str(relative(ref['file']));item=indexed.get(path)
        # As the runtime does, a graph blob absent under graph/ is read from the character's source Files by SHA.
        if item is None and pool is not None:path=str(pool/(ref['sha256']+'.bytes'));item=indexed.get(path)
        if item is None and kind=='optional_blob':return
        require(item is not None and holds(root,item,ref['sha256'],ref.get('byte_count')),'reference/inventory mismatch: '+named);runtime.add(path)
        if (path,kind) in visited:return
        visited.add((path,kind))
        if kind in ['opaque','blob','optional_blob']:return
        for _,child,sub,section in references(load(root/path),kind):
            relative(child['file']);base=actor_root if kind=='actor_clip' else pathlib.PurePosixPath(path).parent;require(base is not None,'actor clip root missing');target=str(base/section/child['file']);visit(dict(child,file=target),sub,pathlib.PurePosixPath(path).parent if kind=='archive' else None,pools.get(path) if kind=='graph' else None)
    for e in manifest['characters']:
        pools[str(relative(e['graph']['file']))]=pathlib.PurePosixPath(e['source']['file']).parent/'Files'
        for field,kind in [('c7','c7'),('actor_archive','archive'),('source','source'),('library','library'),('graph','graph'),('lighting','lighting')]:visit(e[field],kind)
        visit(e['coverage'],'opaque')
        if 'library_ssaa1' in e:visit(e['library_ssaa1'],'library')
        # Packages built before the neutral package have none of its fields.
        if any(field in e for field,_ in NEUTRAL):
            require(all(field in e for field,_ in NEUTRAL),'neutral package is incomplete')
            for field,_ in NEUTRAL:visit(e[field],'opaque')
            require(emitted(*(load(root/e[field]['file']) for field,_ in NEUTRAL))==(root/e['graph']['file']).read_bytes(),'neutral package does not emit the frame graph byte for byte')
        if VULKAN[0] in e:
            require(all(field in e for field,_ in NEUTRAL),'vulkan_frame needs the neutral package')
            require(e[VULKAN[0]]['file']==neutral_path(e,VULKAN[1]),'vulkan_frame must be '+neutral_path(e,VULKAN[1]))
            visit(e[VULKAN[0]],'opaque');folder=pathlib.PurePosixPath(e[VULKAN[0]]['file']).parent.parent
            for name,sha,size in vulkan_blobs((root/e[VULKAN[0]]['file']).read_bytes(),e['neutral_scene']['sha256']):
                path=str(folder/name);item=indexed.get(path);require(item is not None,'vulkan blob is not in the bundle: '+path)
                require(holds(root,item,sha,size),'vulkan blob does not match its sha256/size: '+path);runtime.add(path)
        require(character_coverage(root,e)==load(root/e['coverage']['file']),'coverage receipt differs')
        motion_media_faces(root,e)
    if 'scene' in manifest:visit(manifest['scene']['objects'],'scene_objects')
    # No symlink or unlisted asset may smuggle an external dependency into copy.
    actual={str(p.relative_to(root)) for p in root.rglob('*') if p.is_file()};require(actual==set(indexed)|{'bundle.json'},'unlisted/absent bundle file')
    return dict(schema='metal-native-bundle-verify/v1',bundle_sha256=digest(root/'bundle.json'),characters=[e['id'] for e in manifest['characters']],**({'scene':manifest['scene']} if 'scene' in manifest else {}),file_count=len(indexed),runtime_file_count=len(runtime),byte_count=bytes_total,all_runtime_dependencies_relative=True,unity_runtime_required=False)

def verify_isolated(root):
    root=pathlib.Path(root).resolve()
    # Preload pathlib's lazy stdlib glob implementation before isolating assets.
    list(root.rglob('bundle.json'));state={'enabled':True,'opens':0}
    def audit(event,args):
        if state['enabled'] and event=='open' and isinstance(args[0],(str,bytes)):
            path=pathlib.Path(os.fsdecode(args[0])).resolve()
            require(path.is_relative_to(root),'external read during isolated bundle verification: '+str(path))
            state['opens']+=1
    sys.addaudithook(audit)
    try:result=verify(root)
    finally:state['enabled']=False
    result.update(external_resource_reads_allowed=False,checked_open_calls=state['opens'])
    return result

def main():
    p=argparse.ArgumentParser();sub=p.add_subparsers(dest='command',required=True)
    a=sub.add_parser('build');a.add_argument('--recipe',required=True);a.add_argument('--output',required=True)
    a=sub.add_parser('verify');a.add_argument('bundle');a.add_argument('--receipt');a.add_argument('--deny-external-reads',action='store_true')
    args=p.parse_args()
    if args.command=='build':result=verify(build(args.recipe,args.output))
    else:result=(verify_isolated if args.deny_external_reads else verify)(args.bundle)
    if getattr(args,'receipt',None):pathlib.Path(args.receipt).write_bytes(json_bytes(result))
    print(json.dumps(result,indent=2))
if __name__=='__main__':main()
