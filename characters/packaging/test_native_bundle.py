import json,pathlib,tempfile,unittest,shutil,hashlib,sys,subprocess
import native_bundle as n
import host_inputs
import neutral_package,package_format
import test_neutral_package
import pool_codec

POOLED=b''.join(b'pooled texel %d ' % (i % 61) for i in range(4000))
def other_container(data):
 # A container whose header names bytes other than data.
 c=pool_codec.encode(data);return c[:20]+hashlib.sha256(b'other').digest()+c[pool_codec.HEADER.size:]

def frame_graph(manifest):
 # One original pass and one product pass, in the shape neutral_package splits.
 target=lambda name:dict(target=name,load='clear',store='store',clear=[0,0,0,0])
 return dict(schema='metal-frame-graph-v1',manifest_sha256=manifest,width=1,height=1,
  targets=[dict(id='hdr',width=1,height=1,format='rgba16Float'),dict(id='l1',width=1,height=1,format='rgba16Float')],textures=[],sampler_overrides={},
  passes=[dict(id='forward',phase='forward',kind='render',colors=[target('hdr')],reads=[],draws=[0]),
          dict(id='linearize-post',phase='l1',kind='linearize_post',colors=[target('l1')],reads=['hdr'])],
  output='l1',source_coordinate_policy='unity-reversed-z-msl-boundary',frame_inputs=dict(visible_draws=[0],producer_mode='fixture'))

class BundleTests(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name);self.inputs=self.root/'inputs';self.inputs.mkdir()
 def tearDown(self):self.temp.cleanup()
 def blob(self,path,data=b'asset'):
  p=self.inputs/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data);return dict(file=p.name,sha256=n.digest(p),byte_count=len(data))
 def doc(self,path,data):return self.blob(path,n.json_bytes(data))
 def recipe(self,oracle=False):
  # Synthetic closure fixtures, never a third character or renderer oracle.
  asset=self.blob('source/data.bin');source=self.doc('source/manifest.json',dict(schema='endfield-native-character-manifest-v1',draws=[dict(mesh='body',pass_name='ForwardLit',queue=2000,indices=asset,attributes=[],resources=[dict(asset,previous_probe_resource=dict(file='not-shipped-old-probe.bin',sha256='0'*64))])]))
  graph=self.doc('graph/frame-graph.json',frame_graph(source['sha256']))
  metal=self.blob('programs/program.metallib');lib=self.doc('programs/manifest.json',dict(schema='metal-program-library-v1',programs=[dict(library=metal)],inputs=[dict(file='/not-a-runtime-input/old-manifest',sha256='0'*64)]))
  keys=self.blob('actor/clips/curve.keys',b'EFKEY001');keys['file']='clips/curve.keys'
  if oracle:oracle=self.blob('actor/clips/curve.oracle',b'EFPOSE01');oracle['file']='clips/curve.oracle'
  clip=self.doc('actor/clips/clip.json',dict(schema='metal-actor-clip-v1',keys=keys,oracle=oracle or keys));clip['file']='clips/clip.json';clip.update(name='idle',length=1,loop=True,curve_count=0)
  rig=self.doc('actor/rig.json',dict(schema='metal-actor-rig-v1',nodes=[]));archive=self.doc('actor/manifest.json',dict(schema='metal-actor-source-export-v1',rig=rig,clips=[clip]))
  contract=self.doc('c7/animation/palette.json',dict(meshes=[dict(mesh='body')]))
  config=self.doc('c7/render/config.json',dict(camera='fixture'));bundle=self.blob('c7/animation/clips.bundle',b'opaque source container, not runtime Unity')
  c7=self.doc('c7/pack.json',dict(schema='endfield-character-pack/v1',id='fixture',appearances=[dict(id='default')],render=dict(manifest=source,config=config),animation=dict(palette_contract=contract,clips=bundle,data=[]),interaction=dict(data=[])))
  evidence=self.doc('proof.json',dict(proof=True));evidence['file']=str(self.inputs/'proof.json')
  sourceproof=self.doc('lighting/env/provenance.json',dict(source='proof only'));cube=self.blob('lighting/env/cube.bytes');hdri=self.doc('lighting/env/hdri.json',dict(schema='metal-product-hdri-environment-input-v1',source_manifest=sourceproof,probe_evidence=evidence,reflection_cube=cube));hdri['file']='env/hdri.json'
  sphere=self.doc('lighting/sphere.json',dict(spheres=[]));lighting=self.doc('lighting/lighting.json',dict(schema='metal-product-lighting/v1',sphere_source=sphere,environment=hdri))
  def absolute(r,p):return dict(r,file=str(self.inputs/p))
  e=dict(id='fixture',default_clip='idle',c7=absolute(c7,'c7/pack.json'),actor_archive=absolute(archive,'actor/manifest.json'),source=absolute(source,'source/manifest.json'),library=absolute(lib,'programs/manifest.json'),graph=absolute(graph,'graph/frame-graph.json'),lighting=absolute(lighting,'lighting/lighting.json'))
  path=self.root/'recipe.json';path.write_bytes(n.json_bytes(dict(schema='metal-native-bundle-recipe/v1',characters=[e])));return path
 def testRelocateAfterOriginalInputsRemovedAndCascadeSHA(self):
  recipe=self.recipe();original=n.load(recipe)['characters'][0];out=n.build(recipe,self.root/'bundle');manifest=n.load(out/'bundle.json');e=manifest['characters'][0]
  self.assertEqual(e['source']['sha256'],original['source']['sha256']);self.assertEqual(e['c7']['sha256'],original['c7']['sha256']);self.assertNotEqual(e['lighting']['sha256'],original['lighting']['sha256'])
  relocated=self.root/'new location'/'renamed';relocated.parent.mkdir();out.rename(relocated);shutil.rmtree(self.inputs);result=n.verify_isolated(relocated)
  self.assertTrue(result['all_runtime_dependencies_relative']);self.assertTrue((relocated/'characters/fixture/actor/clips/curve.keys').is_file())
  self.assertFalse(any('not-shipped' in f['file'] for f in manifest['files']))
 def testPackWhoseRenderFolderHoldsOnlyTheConfigVerifies(self):
  out=n.build(self.recipe(),self.root/'bundle');render=out/'characters/fixture/c7/render'
  for p in [p for p in render.rglob('*') if p.is_file() and p.name!='config.json']:p.unlink()
  manifest=n.load(out/'bundle.json');manifest['files']=[f for f in manifest['files'] if (out/f['file']).is_file()];(out/'bundle.json').write_bytes(n.json_bytes(manifest))
  self.assertEqual([p.name for p in render.rglob('*') if p.is_file()],['config.json'])
  n.verify(out)
 def withoutClipFile(self,name):
  out=n.build(self.recipe(oracle=True),self.root/'bundle');rel='characters/fixture/actor/clips/'+name;(out/rel).unlink()
  manifest=n.load(out/'bundle.json');manifest['files']=[f for f in manifest['files'] if f['file']!=rel];(out/'bundle.json').write_bytes(n.json_bytes(manifest))
  return out
 def testClipWhoseOracleFileIsAbsentVerifies(self):
  n.verify(self.withoutClipFile('curve.oracle'))
 def testClipWhoseKeysFileIsAbsentFails(self):
  with self.assertRaisesRegex(n.BundleError,'reference/inventory mismatch: characters/fixture/actor/clips/curve.keys'):n.verify(self.withoutClipFile('curve.keys'))
 def testClipWhoseOracleInputIsAbsentBuildsWithoutIt(self):
  recipe=self.recipe(oracle=True);(self.inputs/'actor/clips/curve.oracle').unlink();out=n.build(recipe,self.root/'bundle')
  self.assertFalse((out/'characters/fixture/actor/clips/curve.oracle').exists());n.verify(out)
 def pooledGraph(self,pooled,data=b'texture shared with the source',store=None):
  # The graph names a texture absent under graph/; pooled puts its bytes in the source Files pool by SHA, as store(data) when given.
  out=n.build(self.recipe(),self.root/'bundle');manifest=n.load(out/'bundle.json');e=manifest['characters'][0];files={f['file']:f for f in manifest['files']}
  sha=hashlib.sha256(data).hexdigest()
  if pooled:
   stored=data if store is None else store(data)
   path=out/'characters/fixture/source/Files'/(sha+'.bytes');path.parent.mkdir();path.write_bytes(stored);rel=path.relative_to(out).as_posix()
   files[rel]=dict(file=rel,sha256=hashlib.sha256(stored).hexdigest(),byte_count=len(stored),roles=['runtime_blob'])
  gp=out/e['graph']['file'];g=n.load(gp);g['textures']=[dict(id='texture',file='Files/texture.bytes',sha256=sha,byte_count=len(data))];n.write_neutral(out,e,g)
  e['graph'].update(sha256=n.digest(gp),byte_count=gp.stat().st_size)
  for field in ['graph']+[f for f,_ in n.NEUTRAL]:files[e[field]['file']].update(sha256=e[field]['sha256'],byte_count=e[field]['byte_count'])
  manifest['files']=[files[k] for k in sorted(files)];(out/'bundle.json').write_bytes(n.json_bytes(manifest));return out
 def testGraphBlobAbsentUnderGraphIsReadFromTheSourcePoolBySha(self):
  n.verify_isolated(self.pooledGraph(True))
 def testPoolBlobStoredAsAContainerOfItsBytesVerifies(self):
  out=self.pooledGraph(True,POOLED,pool_codec.encode);n.verify_isolated(out);shutil.rmtree(out)
  with self.assertRaisesRegex(n.BundleError,'reference/inventory mismatch: characters/fixture/graph/Files/texture.bytes'):n.verify(self.pooledGraph(True,POOLED,other_container))
 def testGraphBlobAbsentUnderGraphAndPoolFails(self):
  with self.assertRaisesRegex(n.BundleError,'reference/inventory mismatch: characters/fixture/graph/Files/texture.bytes'):n.verify(self.pooledGraph(False))
 def testTamperedCopiedBlobFails(self):
  out=n.build(self.recipe(),self.root/'bundle');(out/'characters/fixture/source/data.bin').write_bytes(b'bad');self.assertRaises(n.BundleError,n.verify,out)
 def testDerivedVisibilityHasTheOriginalRolesDrawCoverageAndRejectsUnknownTargets(self):
  out=n.build(self.recipe(),self.root/'bundle');entry=n.load(out/'bundle.json')['characters'][0]
  pack_path=out/entry['c7']['file'];pack=n.load(pack_path)
  contract_path=pack_path.parent/'animation'/pack['animation']['palette_contract']['file']
  contract=n.load(contract_path);contract['clips']=[dict(name='idle')]
  contract['meshes'][0]['visible_with_clips']=['idle'];contract_path.write_bytes(n.json_bytes(contract))
  archive_path=out/entry['actor_archive']['file'];archive=n.load(archive_path)
  archive['clips'].append(dict(archive['clips'][0],name='shared-walk'));archive_path.write_bytes(n.json_bytes(archive))
  alias_path=pack_path.parent/'interaction/shared-interactions.json';alias_path.parent.mkdir(exist_ok=True)
  alias=dict(schema='endfield-shared-interactions/v1',visibility_aliases={'shared-walk':'idle'})
  alias_path.write_bytes(n.json_bytes(alias))
  pack['interaction']['data']=[dict(file=alias_path.name,sha256=n.digest(alias_path))];pack_path.write_bytes(n.json_bytes(pack))
  coverage=n.character_coverage(out,entry)
  self.assertEqual(coverage['blocked_clip_appearance_count'],0);self.assertEqual(coverage['clip_count'],2)
  alias['visibility_aliases']['shared-walk']='foreign-role-motion';alias_path.write_bytes(n.json_bytes(alias))
  pack['interaction']['data'][0]['sha256']=n.digest(alias_path);pack_path.write_bytes(n.json_bytes(pack))
  self.assertRaises(n.BundleError,n.character_coverage,out,entry)
 def testActionOnlyPropMustHaveDrawsAndBlocksOnlyItsAction(self):
  out=n.build(self.recipe(),self.root/'bundle');entry=n.load(out/'bundle.json')['characters'][0]
  pack_path=out/entry['c7']['file'];pack=n.load(pack_path)
  contract_path=pack_path.parent/'animation'/pack['animation']['palette_contract']['file'];contract=n.load(contract_path)
  contract['meshes'].append(dict(mesh='book',visible_with_clips=['read']))
  contract_path.write_bytes(n.json_bytes(contract))
  archive_path=out/entry['actor_archive']['file'];archive=n.load(archive_path)
  archive['clips'].append(dict(archive['clips'][0],name='read'));archive_path.write_bytes(n.json_bytes(archive))
  coverage=n.character_coverage(out,entry)
  self.assertEqual(coverage['blocked'],{'default:read':[dict(mesh='book',reason='absent_source_mesh')]})
  self.assertNotIn('default:idle',coverage['blocked'])
 def testADrawWhoseMaterialDisablesItsPassIsNotRequired(self):
  recipe=self.recipe();r=n.load(recipe);e=r['characters'][0];source=self.inputs/'source/manifest.json';s=n.load(source)
  s['draws'].append(dict(s['draws'][0],pass_name='CharacterOutline',serialized_disabled_lightmode_match=True));source.write_bytes(n.json_bytes(s))
  c7=self.inputs/'c7/pack.json';pack=n.load(c7)
  pack['render']['manifest'].update(sha256=n.digest(source),byte_count=source.stat().st_size);c7.write_bytes(n.json_bytes(pack))
  e['c7'].update(sha256=n.digest(c7),byte_count=c7.stat().st_size);e['source'].update(sha256=n.digest(source),byte_count=source.stat().st_size)
  graph=self.inputs/'graph/frame-graph.json';g=n.load(graph);g['manifest_sha256']=n.digest(source);graph.write_bytes(n.json_bytes(g))
  e['graph'].update(sha256=n.digest(graph),byte_count=graph.stat().st_size);recipe.write_bytes(n.json_bytes(r))
  out=n.build(recipe,self.root/'bundle');coverage=n.character_coverage(out,n.load(out/'bundle.json')['characters'][0])
  self.assertEqual((coverage['blocked'],coverage['prepared_draws'],coverage['source_draws']),({},1,2))
 def testIndependentCompositeAndFacialPayloadsRemainClosedAfterRelocation(self):
  recipe=self.recipe();r=n.load(recipe);c7=self.inputs/'c7/pack.json';pack=n.load(c7)
  root=self.inputs/'c7/interaction/entities/ink';root.mkdir(parents=True)
  shutil.copytree(self.inputs/'actor',root/'actor')
  palette=self.doc('c7/interaction/entities/ink/palette.json',dict(meshes=[dict(mesh='entity:ink/body')]))
  palette['file']='entities/ink/palette.json'
  aux=n.load(root/'actor/manifest.json');ar=dict(file='entities/ink/actor/manifest.json',sha256=n.digest(root/'actor/manifest.json'))
  composite=self.doc('c7/interaction/composites.json',dict(schema='endfield-runtime-composites/v1',character='fixture',entities=[dict(id='ink',archive=ar,palette=palette)],bindings=[dict(ownerClip='idle',entity='ink',animation=aux['clips'][0]['name'])]))
  pack['interaction']['data'].append(composite)
  curve=self.doc('c7/animation/facial-clips/source.json',dict(curves=[]));curve['file']='facial-clips/source.json'
  facial=self.doc('c7/animation/facial-animations.json',dict(schema='endfield-runtime-facial-library/v1',clips=[dict(animation=curve)]));pack['animation']['data'].append(facial)
  c7.write_bytes(n.json_bytes(pack));r['characters'][0]['c7'].update(sha256=n.digest(c7),byte_count=c7.stat().st_size)
  source=self.inputs/'source/manifest.json';s=n.load(source);s['draws'].append(dict(s['draws'][0],mesh='entity:ink/body'));source.write_bytes(n.json_bytes(s))
  # Keep C7's source and graph identities in step with the fixture.
  pack['render']['manifest'].update(sha256=n.digest(source),byte_count=source.stat().st_size);c7.write_bytes(n.json_bytes(pack));r['characters'][0]['c7'].update(sha256=n.digest(c7),byte_count=c7.stat().st_size)
  r['characters'][0]['source'].update(sha256=n.digest(source),byte_count=source.stat().st_size)
  graph=self.inputs/'graph/frame-graph.json';g=n.load(graph);g['manifest_sha256']=n.digest(source);g['passes'][0]['draws']=[0,1];graph.write_bytes(n.json_bytes(g));r['characters'][0]['graph'].update(sha256=n.digest(graph),byte_count=graph.stat().st_size);recipe.write_bytes(n.json_bytes(r))
  out=n.build(recipe,self.root/'bundle');e=n.load(out/'bundle.json')['characters'][0]
  self.assertEqual(n.character_coverage(out,e)['blocked'],{})
  gp=out/e['graph']['file'];g=n.load(gp);g['passes'][0]['draws']=[0];gp.write_bytes(n.json_bytes(g))
  with self.assertRaisesRegex(n.BundleError,'default clip is not fully prepared'):n.character_coverage(out,e)
  g['passes'][0]['draws']=[0,1];gp.write_bytes(n.json_bytes(g))
  relocated=self.root/'relocated';out.rename(relocated);shutil.rmtree(self.inputs)
  n.verify_isolated(relocated)
  self.assertTrue((relocated/'characters/fixture/c7/interaction/entities/ink/actor/clips/curve.keys').is_file())
  self.assertTrue((relocated/'characters/fixture/c7/animation/facial-clips/source.json').is_file())
 def testMissingOrMismatchedInputFailsAtomically(self):
  recipe=self.recipe();(self.inputs/'source/data.bin').write_bytes(b'bad');self.assertRaises(n.BundleError,n.build,recipe,self.root/'bundle');self.assertFalse((self.root/'bundle').exists());self.assertEqual(list(self.root.glob('bundle.partial-*')),[])
 def testPathTraversalAndAbsoluteBlobRejected(self):
  for value in ['../x','/x','a/../b','a//b','a\\b','.','']:
   with self.assertRaises(n.BundleError):n.relative(value)
  b=n.Builder(self.root/'out');self.assertRaises(n.BundleError,b.copy,self.inputs/'absent','../bad')
 def testMissingDefaultClipAndDuplicateCharacterFail(self):
  recipe=self.recipe();d=n.load(recipe);d['characters'][0]['default_clip']='absent';recipe.write_bytes(n.json_bytes(d));self.assertRaises(n.BundleError,n.build,recipe,self.root/'bundle')
  d['characters'][0]['default_clip']='idle';d['characters'].append(d['characters'][0]);recipe.write_bytes(n.json_bytes(d));self.assertRaises(n.BundleError,n.build,recipe,self.root/'bundle')
 def testRelativeRecipeResolvesAtRecipeAndCoverageRefCannotEscape(self):
  recipe=self.recipe();d=n.load(recipe)
  for field in ['c7','actor_archive','source','library','graph','lighting']:
   d['characters'][0][field]['file']=str(pathlib.Path(d['characters'][0][field]['file']).relative_to(recipe.parent))
  recipe.write_bytes(n.json_bytes(d));out=n.build(recipe,self.root/'bundle');n.verify_isolated(out)
  manifest=n.load(out/'bundle.json');manifest['characters'][0]['coverage']['file']='../outside-coverage.json'
  (out/'bundle.json').write_bytes(n.json_bytes(manifest));self.assertRaises(n.BundleError,n.verify,out)
 def sceneRecipe(self,schema='endfield-scene-objects-v1'):
  recipe=self.recipe();d=n.load(recipe);objects=self.doc('scene/objects.json',dict(schema=schema,objects=[dict(id='stool_a',kind='seat',attach='actor_root',points=dict(seat=dict(at=[0,0.5115,0.1])))]))
  d['scene']=dict(objects=dict(objects,file=str(self.inputs/'scene/objects.json')));recipe.write_bytes(n.json_bytes(d));return recipe
 def testSceneObjectsBuildAndVerify(self):
  original=(self.inputs/'scene/objects.json');recipe=self.sceneRecipe();out=n.build(recipe,self.root/'bundle');manifest=n.load(out/'bundle.json')
  self.assertEqual(manifest['scene']['objects'],dict(file='scene/objects.json',sha256=n.digest(original),byte_count=original.stat().st_size))
  self.assertEqual((out/'scene/objects.json').read_bytes(),original.read_bytes())
  shutil.rmtree(self.inputs);self.assertEqual(n.verify_isolated(out)['scene'],manifest['scene'])
 def testSceneObjectsShaMismatchRejected(self):
  recipe=self.sceneRecipe();d=n.load(recipe);sha=d['scene']['objects']['sha256'];d['scene']['objects']['sha256']='0'*64;recipe.write_bytes(n.json_bytes(d))
  self.assertRaises(n.BundleError,n.build,recipe,self.root/'bundle');self.assertFalse((self.root/'bundle').exists())
  d['scene']['objects']['sha256']=sha;recipe.write_bytes(n.json_bytes(d));out=n.build(recipe,self.root/'bundle');(out/'scene/objects.json').write_bytes(b'{}');self.assertRaises(n.BundleError,n.verify,out)
 def testSceneObjectsUnknownSchemaRejected(self):
  self.assertRaises(n.BundleError,n.build,self.sceneRecipe('endfield-scene-objects-v0'),self.root/'bundle')
 def testRecipeWithoutSceneBuildsWithoutScene(self):
  out=n.build(self.recipe(),self.root/'bundle');self.assertNotIn('scene',n.load(out/'bundle.json'));self.assertNotIn('scene',n.verify(out));self.assertFalse((out/'scene').exists())
 def ssaa1Recipe(self):
  # Same metallib bytes as the default library plus one new program; source file name collides with manifest.json.
  recipe=self.recipe();d=n.load(recipe);shared=self.blob('plain/program.metallib');plain=self.blob('plain/plain.metallib',b'plain post')
  lib=self.doc('plain/manifest.json',dict(schema='metal-program-library-v1',programs=[dict(library=shared),dict(library=plain)]))
  d['characters'][0]['library_ssaa1']=dict(lib,file=str(self.inputs/'plain/manifest.json'));recipe.write_bytes(n.json_bytes(d));return recipe
 def testRecipeWithoutSsaa1BuildsWithoutIt(self):
  out=n.build(self.recipe(),self.root/'bundle');e=n.load(out/'bundle.json')['characters'][0]
  self.assertEqual(list(e),['id','default_clip','default_appearance','c7','actor_archive','source','library','graph','lighting','neutral_scene','neutral_build_record','metal_product','coverage'])
  self.assertFalse((out/'characters/fixture/programs/manifest-ssaa1.json').exists());self.assertNotIn('--library-ssaa1',host_inputs.host_inputs(out,'fixture')['argv'])
 def testSsaa1LibraryBuildsVerifiesAndDedupesArtifacts(self):
  original=self.inputs/'plain/manifest.json';out=n.build(self.ssaa1Recipe(),self.root/'bundle');manifest=n.load(out/'bundle.json');e=manifest['characters'][0]
  self.assertEqual(list(e)[-2:],['coverage','library_ssaa1'])
  self.assertEqual(e['library_ssaa1'],dict(file='characters/fixture/programs/manifest-ssaa1.json',sha256=n.digest(original),byte_count=original.stat().st_size))
  self.assertNotEqual(e['library']['sha256'],e['library_ssaa1']['sha256']);self.assertEqual((out/e['library_ssaa1']['file']).read_bytes(),original.read_bytes())
  programs=sorted(f['file'] for f in manifest['files'] if f['file'].startswith('characters/fixture/programs/'))
  self.assertEqual(programs,['characters/fixture/programs/manifest-ssaa1.json','characters/fixture/programs/manifest.json','characters/fixture/programs/plain.metallib','characters/fixture/programs/program.metallib'])
  argv=host_inputs.host_inputs(out,'fixture')['argv'];self.assertEqual(argv[argv.index('--library-ssaa1')+1],str(out.resolve()/e['library_ssaa1']['file']))
  shutil.rmtree(self.inputs);n.verify_isolated(out);(out/'characters/fixture/programs/plain.metallib').write_bytes(b'bad');self.assertRaises(n.BundleError,n.verify,out)
 def testSsaa1LibraryShaMismatchRejected(self):
  recipe=self.ssaa1Recipe();d=n.load(recipe);d['characters'][0]['library_ssaa1']['sha256']='0'*64;recipe.write_bytes(n.json_bytes(d))
  self.assertRaises(n.BundleError,n.build,recipe,self.root/'bundle');self.assertFalse((self.root/'bundle').exists())
 def mediaRecipe(self,media,clips=None):
  recipe=self.recipe();r=n.load(recipe);c7=self.inputs/'c7/pack.json';pack=n.load(c7)
  if clips is not None:pack['animation']['data'].append(self.doc('c7/animation/facial-animations.json',dict(schema='endfield-runtime-facial-library/v1',clips=clips)))
  pack['animation']['data'].append(self.doc('c7/animation/motion-media.json',media))
  c7.write_bytes(n.json_bytes(pack));r['characters'][0]['c7'].update(sha256=n.digest(c7),byte_count=c7.stat().st_size);recipe.write_bytes(n.json_bytes(r));return recipe
 def faceClips(self):
  curve=self.doc('c7/animation/face/dance.json',dict(curves=[]));curve['file']='face/dance.json'
  return [dict(id='mmd_dance',name='dance',duration=1,animation=curve,motion_only=True)]
 def testMotionMediaV1TrackWithAudioStillVerifies(self):
  audio=self.blob('c7/animation/bgm.wav',b'RIFF')
  out=n.build(self.mediaRecipe(dict(schema='endfield-motion-media/v1',tracks=[dict(action='dance',clip='dance_clip',audio=audio,length=1,sample_rate=48000,channels=2)])),self.root/'bundle')
  shutil.rmtree(self.inputs);n.verify_isolated(out);self.assertTrue((out/'characters/fixture/c7/animation/bgm.wav').is_file())
 def testMotionMediaV2TrackWithoutAudioVerifies(self):
  audio=self.blob('c7/animation/bgm.wav',b'RIFF');face=dict(facial_animation='mmd_dance')
  tracks=[dict(action='dance',clip='dance_clip',length=1,face=face),dict(action='song',clip='song_clip',audio=audio,length=1,sample_rate=48000,channels=2,face=face)]
  out=n.build(self.mediaRecipe(dict(schema='endfield-motion-media/v2',tracks=tracks),self.faceClips()),self.root/'bundle')
  shutil.rmtree(self.inputs);n.verify_isolated(out);self.assertTrue((out/'characters/fixture/c7/animation/bgm.wav').is_file())
 def testMotionMediaV2CameraIsVerifiedByReference(self):
  camera=self.doc('c7/animation/camera/dance.json',dict(schema='endfield-motion-camera/v1'));camera['file']='camera/dance.json'
  out=n.build(self.mediaRecipe(dict(schema='endfield-motion-media/v2',tracks=[dict(action='dance',clip='dance_clip',length=1,camera=camera)])),self.root/'bundle')
  path=out/'characters/fixture/c7/animation/camera/dance.json';self.assertTrue(path.is_file())
  data=bytearray(path.read_bytes());data[0]^=1;path.write_bytes(bytes(data));self.assertRaises(n.BundleError,n.verify,out)
 def testMotionMediaV2FaceMustNameALibraryEntry(self):
  for face,library in [(dict(facial_animation='mmd_absent'),True),(dict(facial_animation=7),True),(dict(facial_animation='mmd_dance'),False)]:
   with self.subTest(face=face,library=library):
    shutil.rmtree(self.inputs);self.inputs.mkdir()
    media=dict(schema='endfield-motion-media/v2',tracks=[dict(action='dance',clip='dance_clip',length=1,face=face)])
    with self.assertRaisesRegex(n.BundleError,'absent facial animation'):n.build(self.mediaRecipe(media,self.faceClips() if library else None),self.root/'bundle')
 def emitted(self,out,e):
  scene,record,metal=(n.load(out/e[field]['file']) for field,_ in n.NEUTRAL)
  return neutral_package.dumps(neutral_package.emit_metal(scene,metal,record)).encode()
 def testBuildWritesTheNeutralPackageBesideTheGraph(self):
  out=n.build(self.recipe(),self.root/'bundle');manifest=n.load(out/'bundle.json');e=manifest['characters'][0];files={f['file']:f for f in manifest['files']}
  self.assertEqual({field:e[field]['file'] for field,_ in n.NEUTRAL},dict(neutral_scene='characters/fixture/neutral/scene.json',
   neutral_build_record='characters/fixture/neutral/build-record.json',metal_product='characters/fixture/metal/product.json'))
  for field,_ in n.NEUTRAL:
   path=out/e[field]['file'];self.assertEqual(e[field],dict(file=e[field]['file'],sha256=n.digest(path),byte_count=path.stat().st_size))
   self.assertEqual({k:files[e[field]['file']][k] for k in ('file','sha256','byte_count')},e[field])
  self.assertEqual(self.emitted(out,e),(out/e['graph']['file']).read_bytes())
  self.assertEqual([p['id'] for p in n.load(out/e['metal_product']['file'])['passes']],['linearize-post'])
 def testBuildRefusesAGraphItsNeutralPackageDoesNotEmit(self):
  recipe=self.recipe();d=n.load(recipe);path=self.inputs/'graph/frame-graph.json'
  path.write_bytes(json.dumps(n.load(path)).encode());d['characters'][0]['graph'].update(sha256=n.digest(path),byte_count=path.stat().st_size);recipe.write_bytes(n.json_bytes(d))
  with self.assertRaisesRegex(n.BundleError,'does not emit the frame graph'):n.build(recipe,self.root/'bundle')
  self.assertFalse((self.root/'bundle').exists())
 def testVerifyRejectsASceneThatNoLongerEmitsTheGraph(self):
  out=n.build(self.recipe(),self.root/'bundle');manifest=n.load(out/'bundle.json');e=manifest['characters'][0]
  path=out/e['neutral_scene']['file'];scene=n.load(path);scene['frame_inputs']['visible_draws']=[];path.write_bytes(n.json_bytes(scene))
  with self.assertRaisesRegex(n.BundleError,'packaged SHA/length mismatch: characters/fixture/neutral/scene.json'):n.verify(out)
  e['neutral_scene'].update(sha256=n.digest(path),byte_count=path.stat().st_size)
  manifest['files']=[dict(f,**e['neutral_scene']) if f['file']==e['neutral_scene']['file'] else f for f in manifest['files']];(out/'bundle.json').write_bytes(n.json_bytes(manifest))
  with self.assertRaisesRegex(n.BundleError,'does not emit the frame graph'):n.verify(out)
 def testBundleWithoutTheNeutralPackageStillVerifies(self):
  out=n.build(self.recipe(),self.root/'bundle');manifest=n.load(out/'bundle.json');e=manifest['characters'][0]
  (out/e.pop('metal_product')['file']).unlink();manifest['files']=[f for f in manifest['files'] if (out/f['file']).is_file()];(out/'bundle.json').write_bytes(n.json_bytes(manifest))
  with self.assertRaisesRegex(n.BundleError,'neutral package is incomplete'):n.verify(out)
  for field in ['neutral_scene','neutral_build_record']:(out/e.pop(field)['file']).unlink()
  manifest['files']=[f for f in manifest['files'] if (out/f['file']).is_file()];(out/'bundle.json').write_bytes(n.json_bytes(manifest))
  n.verify_isolated(out)
 def testWriteNeutralFollowsAnEditedGraph(self):
  out=n.build(self.recipe(),self.root/'bundle');e=n.load(out/'bundle.json')['characters'][0];before=dict(e)
  g=n.load(out/e['graph']['file']);g['frame_inputs']['visible_draws']=[];n.write_neutral(out,e,g)
  self.assertEqual(n.load(out/e['graph']['file']),g);self.assertEqual(self.emitted(out,e),(out/e['graph']['file']).read_bytes())
  self.assertEqual(n.load(out/e['neutral_scene']['file'])['frame_inputs']['visible_draws'],[])
  self.assertNotEqual(e['neutral_scene'],before['neutral_scene']);self.assertEqual(e['metal_product'],before['metal_product'])
  for field,_ in n.NEUTRAL:path=out/e[field]['file'];self.assertEqual(e[field],dict(file=e[field]['file'],sha256=n.digest(path),byte_count=path.stat().st_size))
 def testWriteNeutralTakesAKeySortedGraph(self):
  # Outfit tools wrote frame graphs key-sorted before they wrote the neutral package.
  g=test_neutral_package.graph(additive=True);ordered=json.loads(json.dumps(g,sort_keys=True));e=dict(graph=dict(file='characters/fixture/graph/frame-graph.json'))
  self.assertRaisesRegex(ValueError,'adapters are not the last',neutral_package.split,json.loads(json.dumps(ordered)))
  path=self.root/e['graph']['file'];path.parent.mkdir(parents=True);n.write_neutral(self.root,e,ordered)
  self.assertEqual(n.load(path),g);self.assertEqual(self.emitted(self.root,e),path.read_bytes())
 def testNeutralFieldsAndSchemasEqualTheLibraryContract(self):
  contract=json.loads((pathlib.Path(__file__).resolve().parents[2]/'protocol/character-library/constants.json').read_text())
  self.assertEqual([field for field,_ in n.NEUTRAL],contract['neutral_fields']['optional'])
  self.assertEqual([contract['schemas'][field] for field,_ in n.NEUTRAL],[neutral_package.SCENE_SCHEMA,neutral_package.RECORD_SCHEMA,neutral_package.PRODUCT_SCHEMA])
 def relist(self,out,manifest):
  # As the outfit tools do: every file under the bundle, recorded roles kept.
  roles={f['file']:f['roles'] for f in manifest['files']}
  manifest['files']=[dict(file=p.relative_to(out).as_posix(),sha256=n.digest(p),byte_count=p.stat().st_size,roles=roles.get(p.relative_to(out).as_posix(),['runtime']))
                     for p in sorted(out.rglob('*')) if p.is_file() and p.name!='bundle.json'];(out/'bundle.json').write_bytes(n.json_bytes(manifest))
 def vulkan(self,blobs,scene=None,version=None,magic=None):
  """A bundle whose character has a Vulkan section: a frame table holding only strings and the blob records blobs ((name, bytes);
  bytes are written to vulkan/blobs/<sha256> when the name is there), bound to scene (default: the neutral scene's sha256)."""
  out=n.build(self.recipe(),self.root/'bundle');manifest=n.load(out/'bundle.json');e=manifest['characters'][0];f=package_format
  folder=out/'characters/fixture';strings=bytearray(b'\0');records=[]
  for name,data in blobs:
   records.append(dict(sha256=hashlib.sha256(data).digest(),size=len(data),file=len(strings)));strings+=name.encode()+b'\0'
   if name.startswith('vulkan/blobs/'):(folder/name).parent.mkdir(parents=True,exist_ok=True);(folder/name).write_bytes(data)
  head=f.STRUCTS['Header'];body=dict(strings=bytes(strings),blobs=b''.join(f.table_struct('blobs').pack(r) for r in records))
  values=dict(magic=magic or f.MAGIC,version=f.VERSION if version is None else version,header_bytes=head.size,scene_sha256=bytes.fromhex(scene or e['neutral_scene']['sha256']));offset=head.size;layout=[]
  for t in f.TABLES:
   data=body.get(t,b'');offset=(offset+15)&~15;values.update({t+'_offset':offset,t+'_count':len(records) if t=='blobs' else len(data)});layout.append((offset,data));offset+=len(data)
  raw=bytearray(offset);values['file_bytes']=offset;raw[:head.size]=head.pack(values)
  for o,data in layout:raw[o:o+len(data)]=data
  (folder/'vulkan/frame.bin').parent.mkdir(parents=True,exist_ok=True);(folder/'vulkan/frame.bin').write_bytes(raw)
  e['vulkan_frame']=dict(file='characters/fixture/vulkan/frame.bin',sha256=hashlib.sha256(raw).hexdigest(),byte_count=len(raw));self.relist(out,manifest)
  return out,manifest,e
 def rewrite(self,out,e,g):
  # As an outfit import does: write_neutral, then the graph reference.
  n.write_neutral(out,e,g);path=out/e['graph']['file'];e['graph'].update(sha256=n.digest(path),byte_count=path.stat().st_size)
 def own(self,data=b'only the vulkan section has this'):return ('vulkan/blobs/'+hashlib.sha256(data).hexdigest(),data)
 def testVulkanSectionWhoseBlobsNameCharacterFilesVerifies(self):
  out,manifest,e=self.vulkan([('source/data.bin',b'asset'),self.own()]);n.verify_isolated(out)
  files={f['file'] for f in manifest['files']};self.assertLessEqual({'characters/fixture/vulkan/frame.bin','characters/fixture/'+self.own()[0]},files)
  self.assertEqual(set(e['vulkan_frame']),{'file','sha256','byte_count'})
 def testVulkanBlobStoredAsAContainerOfItsBytesVerifies(self):
  name,_=self.own(POOLED);out,manifest,e=self.vulkan([(name,POOLED)])
  (out/'characters/fixture'/name).write_bytes(pool_codec.encode(POOLED));self.relist(out,manifest);n.verify_isolated(out)
  (out/'characters/fixture'/name).write_bytes(other_container(POOLED));self.relist(out,manifest)
  with self.assertRaisesRegex(n.BundleError,'vulkan blob does not match its sha256/size: characters/fixture/vulkan/blobs/'):n.verify(out)
 def testStagedContentVerifiesAVulkanSection(self):
  # The agentd component carries only CONTENT_SOURCES; verify of a package with a frame table must not need anything else.
  root=pathlib.Path(__file__).resolve().parents[2];sys.path.insert(0,str(root/'tools/release'));import build_components
  out,_,_=self.vulkan([self.own()]);content=build_components.stage_content(self.root/'runtime/content')
  probe='import sys;sys.path[:0]=sys.argv[2:4];import native_bundle;native_bundle.verify(sys.argv[1])'
  run=subprocess.run([sys.executable,'-I','-B','-c',probe,str(out),str(content),str(root/'agent/agentd')],capture_output=True,text=True)
  self.assertEqual(run.returncode,0,run.stderr)
 def testVulkanBlobNameOutsideTheCharacterDirectoryFails(self):
  for name in ['../fixture/source/data.bin','source//data.bin','source/da ta.bin']:
   with self.subTest(name=name):
    shutil.rmtree(self.root/'bundle',ignore_errors=True);out,_,_=self.vulkan([(name,b'asset')])
    with self.assertRaisesRegex(n.BundleError,'vulkan blob name leaves the character directory: '):n.verify(out)
 def testVulkanBlobMissingOrDifferentFails(self):
  out,manifest,e=self.vulkan([self.own()]);(out/'characters/fixture'/self.own()[0]).unlink();self.relist(out,manifest)
  with self.assertRaisesRegex(n.BundleError,'vulkan blob is not in the bundle: characters/fixture/vulkan/blobs/'):n.verify(out)
  shutil.rmtree(out);out,_,_=self.vulkan([('source/data.bin',b'other bytes')])
  with self.assertRaisesRegex(n.BundleError,'vulkan blob does not match its sha256/size: characters/fixture/source/data.bin'):n.verify(out)
 def testVulkanFrameOfAnotherSceneVersionOrFormatFails(self):
  out,manifest,e=self.vulkan([self.own()],scene='0'*64)
  with self.assertRaisesRegex(n.BundleError,'vulkan frame table is bound to neutral scene 0{64}, not '):n.verify(out)
  shutil.rmtree(out);out,manifest,e=self.vulkan([self.own()],version=package_format.VERSION-1)
  with self.assertRaisesRegex(n.BundleError,'vulkan frame table is version'):n.verify(out)
  # Another frame table's magic is not one.
  shutil.rmtree(out);out,manifest,e=self.vulkan([self.own()],magic=b'EFWPKG01')
  with self.assertRaisesRegex(n.BundleError,'vulkan frame table is not EFWVKP01'):n.verify(out)
 def testVulkanFrameAfterTheSceneChangedFails(self):
  # A tool that edits the frame graph but keeps the reference.
  out,manifest,e=self.vulkan([self.own()]);ref=e['vulkan_frame'];g=n.load(out/e['graph']['file']);g['frame_inputs']['visible_draws']=[]
  self.rewrite(out,e,g);e['vulkan_frame']=ref;self.relist(out,manifest)
  with self.assertRaisesRegex(n.BundleError,'vulkan frame table is bound to neutral scene'):n.verify(out)
 def testVulkanFrameNeedsTheNeutralPackage(self):
  out,manifest,e=self.vulkan([self.own()])
  for field,_ in n.NEUTRAL:(out/e.pop(field)['file']).unlink()
  self.relist(out,manifest)
  with self.assertRaisesRegex(n.BundleError,'vulkan_frame needs the neutral package'):n.verify(out)
 def testWriteNeutralDropsTheVulkanFrameAndTheRelistedBundleVerifies(self):
  out,manifest,e=self.vulkan([('source/data.bin',b'asset'),self.own()]);g=n.load(out/e['graph']['file']);g['frame_inputs']['visible_draws']=[]
  self.rewrite(out,e,g);self.assertNotIn('vulkan_frame',e);self.relist(out,manifest);n.verify(out)
 def testVulkanFieldEqualsTheLibraryContract(self):
  contract=json.loads((pathlib.Path(__file__).resolve().parents[2]/'protocol/character-library/constants.json').read_text())
  self.assertEqual([n.VULKAN[0]],contract['vulkan_fields']['optional'])
 def testSymlinkCannotEscapePack(self):
  out=n.build(self.recipe(),self.root/'bundle');path=out/'characters/fixture/source/data.bin';copy=self.root/'external';copy.write_bytes(path.read_bytes());path.unlink();path.symlink_to(copy);self.assertRaises(n.BundleError,n.verify,out)
if __name__=='__main__':unittest.main()
