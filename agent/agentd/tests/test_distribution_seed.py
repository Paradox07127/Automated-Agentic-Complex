import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_library import Library, PackageError, digest, read_json, write_json
from distribution_seed import merge_seed
from test_character_library import fixture, tool_command
from test_motion_tool import motion_fixture, needs_numpy
import native_bundle  # test_motion_tool puts the packaging folder on sys.path
from test_import_outfit import package_fixture, si_mod, write_map

CLOTH = 'S_actor_test_cloth_01_lod0'


def ref(path, root):
    data = path.read_bytes()
    return dict(file=path.relative_to(root).as_posix(), sha256=hashlib.sha256(data).hexdigest(), byte_count=len(data))


def packaged(root, cid, version, scene, rig=None, **options):
    """A package directory at root at `version`: package_fixture (options go to it) for cid fixture without a rig, else
    motion_fixture, with the actions file motion_tool reads and shared scene objects labelled `scene` in its native bundle."""
    if cid == 'fixture' and rig is None: package_fixture(root, **options)
    else: motion_fixture(root, cid=cid, rig=rig)
    definition = read_json(root / 'character.json'); runtime = root / 'runtime'
    native = read_json(runtime / 'bundle.json'); entry = native['characters'][0]
    pack_path = runtime / entry['c7']['file']; animation = pack_path.parent / 'animation'
    if not (animation / 'actions.json').exists():
        pack = read_json(pack_path)
        write_json(animation / 'actions.json', {'schema': 'endfield-character-actions-v1', 'actions': []})
        pack['animation']['data'].append(ref(animation / 'actions.json', animation)); write_json(pack_path, pack)
        entry['c7'] = ref(pack_path, runtime)
        coverage = runtime / entry['coverage']['file']
        write_json(coverage, native_bundle.character_coverage(runtime, entry)); entry['coverage'] = ref(coverage, runtime)
    objects = runtime / 'scene/objects.json'
    write_json(objects, {'schema': 'endfield-scene-objects-v1', 'objects': [scene]})
    native['scene'] = {'objects': ref(objects, runtime)}
    native['files'] = [dict(ref(p, runtime), roles=['runtime']) for p in sorted(runtime.rglob('*')) if p.is_file() and p != runtime / 'bundle.json']
    write_json(runtime / 'bundle.json', native)
    definition['version'] = version
    definition['components']['render']['native_bundle'] = ref(runtime / 'bundle.json', root)
    definition['inventory'] = [x for x in definition['inventory'] if not x['file'].startswith('runtime/')] + \
        [ref(p, root) for p in sorted(runtime.rglob('*')) if p.is_file()]
    write_json(root / 'character.json', definition)


class DistributionSeedTests(unittest.TestCase):
    def host(self, root):
        host = root / 'host'
        host.write_text('#!' + sys.executable + "\nimport sys\nassert sys.argv[1] == '--validate-pack'\n", encoding='utf-8'); host.chmod(0o700)
        return host

    def imported_library(self, root):
        """The old library, in scene A: fixture 1.0.0 with one outfit import, so 1.0.1, second 1.0.0, and an MMD motion whose bake
        failed on fixture; returns it and the imported appearance's id."""
        old = Library(root / 'old')
        for cid in ('fixture', 'second'): packaged(root / ('old-' + cid), cid, '1.0.0', 'A'); old.install(root / ('old-' + cid))
        result = tool_command('outfit_tool.py', 'import', '--library', str(old.root), '--character', 'fixture', '--source', str(si_mod(root / 'si')),
                              '--map', str(write_map(root / 'map.json', textures={'1': '_ClearCoatMask'})), '--validate-with', str(self.host(root)))
        self.assertEqual(result.returncode, 0, result.stderr)
        aid = json.loads(result.stdout.splitlines()[-1])['appearance']['id']
        sources = old.root / 'mmd-library/sources'; sources.mkdir(parents=True); (sources / 'dance.vmd').write_bytes(b'vmd')
        failure = dict(reason='missing_bones', detail='fixture', package_sha256=old.package('fixture').sha256)
        write_json(old.root / 'mmd-library/index.json', dict(schema='endfield-mmd-library/v1', entries=[dict(
            id='mmd_0123456789abcdef', title='dance', duration_s=1.0, created_at='2026-11-01T00:00:00+00:00', removed_at=None,
            source=dict(file='dance.vmd', sha256=hashlib.sha256(b'vmd').hexdigest(), name='dance.vmd'), camera=None, bgm=None, zip=None,
            failures=dict(fixture=failure))]))
        return old, aid

    def seed_library(self, root, **options):
        """The new seed, in scene B: fixture 1.0.5 (options go to its package_fixture) and second, other content at 1.0.0."""
        seed = Library(root / 'seed')
        for cid, version in (('fixture', '1.0.5'), ('second', '1.0.0')):
            packaged(root / ('seed-' + cid), cid, version, 'B', **(options if cid == 'fixture' else {})); seed.install(root / ('seed-' + cid))
        return seed

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_seed_packages_are_the_base_and_carry_the_users_imports(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); old, aid = self.imported_library(root); seed = self.seed_library(root)
            out = root / 'next'
            merge_seed(seed.root / 'current.json', digest(seed.root / 'current.json'), old.root / 'current.json',
                       digest(old.root / 'current.json'), out, validate_with=self.host(root))
            packages = {p.id: p for p in Library(out).packages()}
            package, second = packages['fixture'], packages['second']
            self.assertEqual((package.version, package.document['base_package_version']), ('1.0.6', '1.0.5'))
            self.assertEqual(package.native['scene'], seed.package('fixture').native['scene'])
            pack = read_json(package.root / 'runtime' / package.native_entry['c7']['file'])
            self.assertEqual([a['id'] for a in pack['appearances']], ['default', 'top', aid])
            source = read_json(package.root / 'runtime' / package.native_entry['source']['file'])
            self.assertEqual([d['mesh'] for d in source['draws']].count('outfit:%s/%s' % (aid, CLOTH)), 1)
            self.assertTrue((package.root / 'provenance' / ('outfit-' + aid + '.json')).is_file())
            self.assertEqual(second.sha256, seed.package('second').sha256)
            [entry] = read_json(out / 'outfit-imports/fixture/imports.json')['imports']
            self.assertEqual((entry['appearance'], entry['removed_at']), (aid, None))
            self.assertEqual((out / 'mmd-library/sources/dance.vmd').read_bytes(), b'vmd')

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_mmd_motions_wait_for_mmd_sync_to_bake_them_on_the_new_packages(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); old, _ = self.imported_library(root); seed = self.seed_library(root)
            out = root / 'next'
            merge_seed(seed.root / 'current.json', digest(seed.root / 'current.json'), old.root / 'current.json',
                       digest(old.root / 'current.json'), out, validate_with=self.host(root))
            listed = tool_command('motion_tool.py', 'mmd-list', '--library', str(out))
            self.assertEqual(listed.returncode, 0, listed.stderr)
            [shared] = json.loads(listed.stdout.splitlines()[-1])['entries']
            self.assertEqual(shared['characters'], [dict(id='fixture', state='pending', reason=None), dict(id='second', state='pending', reason=None)])

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_a_motion_import_is_baked_again_onto_the_seed_package(self):
        from test_bvh_import import cmu_bvh_text
        from test_vmd_import import authored_rig
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); old = Library(root / 'old'); seed = Library(root / 'seed')
            packaged(root / 'old-fixture', 'fixture', '1.0.0', 'A', rig=authored_rig()); old.install(root / 'old-fixture')
            packaged(root / 'seed-fixture', 'fixture', '1.0.5', 'B', rig=authored_rig()); seed.install(root / 'seed-fixture')
            bvh = root / 'walk.bvh'; bvh.write_text(cmu_bvh_text(), encoding='utf-8')
            result = tool_command('motion_tool.py', 'import', '--library', str(old.root), '--character', 'fixture', '--source', str(bvh),
                                  '--validate-with', str(self.host(root)))
            self.assertEqual(result.returncode, 0, result.stderr)
            action = json.loads(result.stdout.splitlines()[-1])['action']['id']
            out = root / 'next'
            merge_seed(seed.root / 'current.json', digest(seed.root / 'current.json'), old.root / 'current.json',
                       digest(old.root / 'current.json'), out, validate_with=self.host(root))
            package = Library(out).package('fixture')
            self.assertEqual((package.version, package.document['base_package_version']), ('1.0.6', '1.0.5'))
            self.assertEqual(package.native['scene'], seed.package('fixture').native['scene'])
            pack = package.root / 'runtime' / package.native_entry['c7']['file']
            self.assertIn(action, [a['id'] for a in read_json(pack.parent / 'animation/actions.json')['actions']])
            [entry] = read_json(out / 'motion-imports/fixture/imports.json')['imports']
            self.assertEqual((entry['action'], entry['removed_at']), (action, None))

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "Windows refuses a bgm import: test_a_bgm_import_on_windows_is_refused_before_the_package_is_copied")
    def test_a_two_file_gltf_and_a_bgm_start_of_zero_are_baked_again_with_their_ids(self):
        from test_bvh_import import cmu_bvh_text, cmu_joints
        from test_vmd_import import authored_rig
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); old = Library(root / 'old'); seed = Library(root / 'seed')
            packaged(root / 'old-fixture', 'fixture', '1.0.0', 'A', rig=authored_rig()); old.install(root / 'old-fixture')
            packaged(root / 'seed-fixture', 'fixture', '1.0.5', 'B', rig=authored_rig()); seed.install(root / 'seed-fixture')
            # A CMU-like skeleton whose hips move over three frames, its keys and values in walk.bin beside walk.gltf.
            joints = cmu_joints(); names = [name for name, _, _ in joints]
            times, moves = struct.pack('<3f', 0, 1 / 30, 2 / 30), struct.pack('<9f', 0, .9, 0, .1, .9, .2, .2, .9, .4)
            (root / 'walk.bin').write_bytes(times + moves)
            nodes = [dict(name=name, translation=[c / 10 for c in offset], children=[names.index(n) for n, p, _ in joints if p == name])
                     for name, _, offset in joints]
            write_json(root / 'walk.gltf', dict(asset=dict(version='2.0'), nodes=nodes, scenes=[dict(nodes=[0])],
                buffers=[dict(uri='walk.bin', byteLength=48)],
                bufferViews=[dict(buffer=0, byteOffset=0, byteLength=12), dict(buffer=0, byteOffset=12, byteLength=36)],
                accessors=[dict(bufferView=0, componentType=5126, count=3, type='SCALAR', min=[0], max=[2 / 30]),
                           dict(bufferView=1, componentType=5126, count=3, type='VEC3')],
                animations=[dict(samplers=[dict(input=0, output=1)], channels=[dict(sampler=0, target=dict(node=0, path='translation'))])]))
            bvh = root / 'walk.bvh'; bvh.write_text(cmu_bvh_text(), encoding='utf-8')
            with wave.open(str(root / 'song.wav'), 'wb') as audio:
                audio.setparams((2, 2, 48000, 0, 'NONE', 'not compressed')); audio.writeframes(bytes(4 * 48000))
            actions = []
            for args in (['--source', str(root / 'walk.gltf')], ['--source', str(bvh), '--bgm', str(root / 'song.wav'), '--bgm-start', '0']):
                result = tool_command('motion_tool.py', 'import', '--library', str(old.root), '--character', 'fixture', *args,
                                      '--validate-with', str(self.host(root)))
                self.assertEqual(result.returncode, 0, result.stderr)
                actions.append(json.loads(result.stdout.splitlines()[-1])['action']['id'])
            self.merge(seed, old, root / 'next', self.host(root))
            entries = read_json(root / 'next/motion-imports/fixture/imports.json')['imports']
            self.assertEqual([(e['action'], e['removed_at']) for e in entries], [(action, None) for action in actions])
            package = Library(root / 'next').package('fixture')
            self.assertEqual((package.version, package.document['base_package_version']), ('1.0.6', '1.0.5'))

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_an_import_the_seed_cannot_take_keeps_the_seed_package_and_marks_its_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); old, aid = self.imported_library(root)
            # The seed's cloth draws gained a texture, so the import's clone of them no longer fits.
            seed = self.seed_library(root, cloth_extra=[('_Extra', 'BC7_UNORM_BLOCK', False, 3)])
            out = root / 'next'
            result = tool_command('distribution_seed.py', '--seed-catalog', str(seed.root / 'current.json'),
                                  '--seed-sha256', digest(seed.root / 'current.json'), '--existing-catalog', str(old.root / 'current.json'),
                                  '--existing-sha256', digest(old.root / 'current.json'), '--output', str(out), '--validate-with', str(self.host(root)))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('template_changed:' + CLOTH, result.stderr)
            self.assertEqual(Library(out).package('fixture').sha256, seed.package('fixture').sha256)
            [entry] = read_json(out / 'outfit-imports/fixture/imports.json')['imports']
            self.assertEqual(entry['appearance'], aid); self.assertIsNotNone(entry['removed_at'])
            self.assertIn('template_changed:' + CLOTH, entry['migration_failure'])
            self.assertEqual(read_json(out / 'distribution-seed.json')['imports_not_carried_over'], dict(fixture=[entry['migration_failure']]))

    def merge(self, seed, old, out, host):
        return merge_seed(seed.root / 'current.json', digest(seed.root / 'current.json'), old.root / 'current.json',
                          digest(old.root / 'current.json'), out, validate_with=host)

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_a_missing_validator_aborts_the_merge(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); old, _ = self.imported_library(root); seed = self.seed_library(root)
            with self.assertRaisesRegex(PackageError, 'host executable is missing'): self.merge(seed, old, root / 'next', root / 'missing')
            self.assertFalse((root / 'next').exists())

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_an_os_error_while_rebuilding_aborts_the_merge_and_keeps_the_records(self):
        import outfit_tool
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); old, _ = self.imported_library(root); seed = self.seed_library(root)
            before = read_json(old.root / 'outfit-imports/fixture/imports.json')
            with mock.patch.object(outfit_tool, 'graft', side_effect=OSError('disk full')), self.assertRaises(OSError):
                self.merge(seed, old, root / 'next', self.host(root))
            self.assertFalse((root / 'next').exists())
            self.assertEqual([p.name for p in root.iterdir() if p.name.startswith('.seed-')], [])
            self.assertEqual(read_json(old.root / 'outfit-imports/fixture/imports.json'), before)

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_a_validator_that_times_out_aborts_the_merge_and_keeps_the_records(self):
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); old, _ = self.imported_library(root); seed = self.seed_library(root); host = self.host(root)
            before = read_json(old.root / 'outfit-imports/fixture/imports.json')
            with mock.patch('subprocess.run', side_effect=subprocess.TimeoutExpired(str(host), 1)), self.assertRaises(TimeoutError):
                self.merge(seed, old, root / 'next', host)
            self.assertFalse((root / 'next').exists())
            self.assertEqual(read_json(old.root / 'outfit-imports/fixture/imports.json'), before)

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_a_validator_that_rejects_the_rebuilt_package_marks_its_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); old, aid = self.imported_library(root); seed = self.seed_library(root)
            reject = root / 'reject'; reject.write_text('#!' + sys.executable + "\nimport sys\nsys.exit(1)\n", encoding='utf-8'); reject.chmod(0o700)
            self.merge(seed, old, root / 'next', reject)
            self.assertEqual(Library(root / 'next').package('fixture').sha256, seed.package('fixture').sha256)
            [entry] = read_json(root / 'next/outfit-imports/fixture/imports.json')['imports']
            self.assertEqual(entry['appearance'], aid); self.assertIsNotNone(entry['removed_at'])
            self.assertIn('validate_failed', entry['migration_failure'])

    def test_offline_generation_takes_every_seed_package_and_retains_custom_roles_and_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); old = Library(root/'old'); seed = Library(root/'seed')
            for cid, version in [('custom', '1.0.0'), ('one', '1.0.0'), ('newer', '3.0.0')]:
                source=root/('old-'+cid);d=fixture(source,cid);d['version']=version;write_json(source/'character.json',d);old.install(source)
            for cid, version in [('one', '2.0.0'), ('two', '1.0.0'), ('newer', '2.0.0')]:
                source=root/('seed-'+cid);d=fixture(source,cid);d['version']=version;write_json(source/'character.json',d);seed.install(source)
            before=digest(old.root/'current.json');out=root/'generation'
            run=lambda:merge_seed(seed.root/'current.json',digest(seed.root/'current.json'),old.root/'current.json',before,out)
            result=run();self.assertEqual(result['default_character'],'custom')
            self.assertEqual({p.id:p.version for p in Library(out).packages()},dict(custom='1.0.0',one='2.0.0',two='1.0.0',newer='2.0.0'))
            self.assertEqual(digest(old.root/'current.json'),before);self.assertEqual(run(),result)

    def test_import_records_are_copied_without_a_shell_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); old = Library(root/'old'); seed = Library(root/'seed')
            source = root/'custom'; fixture(source, 'custom'); old.install(source)
            source = root/'one'; fixture(source, 'one'); seed.install(source)
            records = old.root/'outfit-imports/custom'; records.mkdir(parents=True); write_json(records/'imports.json', dict(imports=[]))
            out = root/'next'
            with mock.patch('subprocess.run', side_effect=FileNotFoundError('/bin/cp')):
                merge_seed(seed.root/'current.json', digest(seed.root/'current.json'), old.root/'current.json',
                           digest(old.root/'current.json'), out)
            self.assertEqual(read_json(out/'outfit-imports/custom/imports.json'), dict(imports=[]))

    def test_same_version_user_content_without_imports_becomes_the_seeds_and_live_import_still_refuses_update(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);old=Library(root/'old');seed=Library(root/'seed')
            one=root/'one';fixture(one,'one');old.install(one)
            newer=root/'newer';d=fixture(newer,'one');d['aliases']=['localone'];write_json(newer/'character.json',d);seed.install(newer)
            result=merge_seed(seed.root/'current.json',digest(seed.root/'current.json'),old.root/'current.json',digest(old.root/'current.json'),root/'next')
            self.assertEqual(Library(root/'next').packages()[0].sha256,seed.packages()[0].sha256)
            self.assertEqual(len(result['characters']),1)
            with self.assertRaises(PackageError):old.install(newer)

    def test_bad_source_cannot_publish_or_modify_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);old=Library(root/'old');seed=Library(root/'seed')
            for name,library in [('old',old),('seed',seed)]:
                source=root/(name+'-role');fixture(source,name);library.install(source)
            before=digest(old.root/'current.json');image=seed.packages()[0].root/'ui/head.png';image.write_bytes(b'x'*image.stat().st_size)
            with self.assertRaises(PackageError):merge_seed(seed.root/'current.json',digest(seed.root/'current.json'),old.root/'current.json',before,root/'next')
            self.assertFalse((root/'next').exists());self.assertEqual(digest(old.root/'current.json'),before)
            with self.assertRaisesRegex(PackageError,'existing_catalog_changed'):
                merge_seed(seed.root/'current.json',digest(seed.root/'current.json'),old.root/'current.json','0'*64,root/'next')


if __name__ == '__main__': unittest.main()
