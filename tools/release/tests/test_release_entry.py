import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import gate_receipt
import harness_runtime
import local_paths
import notarize
import release
from release import release_guard,shipping_path,source_state,sources_moved


class CanonicalReleaseTests(unittest.TestCase):
    def test_release_build_loads_runtime_helper_in_isolated_python(self):
        script=Path(__file__).resolve().parents[1]/'release.py'
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);profile=root/'app/packaging/release.json'
            profile.parent.mkdir(parents=True);profile.write_text('{"schema":"invalid"}')
            code='import runpy,sys;from pathlib import Path;runpy.run_path(sys.argv[1])["build"](None,root=Path(sys.argv[2]))'
            result=subprocess.run([sys.executable,'-I','-c',code,str(script),str(root)],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('Unsupported release profile',result.stderr)
            self.assertNotIn('ModuleNotFoundError',result.stderr)

    def test_release_refuses_to_ship_without_ui_art(self):
        script=Path(__file__).resolve().parents[1]/'release.py'
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);profile=root/'app/packaging/release.json'
            profile.parent.mkdir(parents=True);profile.write_text('{"schema":"endfield-release-config/v1","ui_art":".local/output/ui-art-20261031/art"}')
            code='import runpy,sys;from pathlib import Path;runpy.run_path(sys.argv[1])["build"](None,root=Path(sys.argv[2]))'
            result=subprocess.run([sys.executable,'-I','-c',code,str(script),str(root)],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('UI art missing: '+str(root/'.local/output/ui-art-20261031/art'),result.stderr)
    def test_release_refuses_to_ship_without_app_icon(self):
        script=Path(__file__).resolve().parents[1]/'release.py'
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);profile=root/'app/packaging/release.json'
            profile.parent.mkdir(parents=True);profile.write_text('{"schema":"endfield-release-config/v1","ui_art":".local/output/ui-art-20261031b/art"}')
            art=root/'.local/output/ui-art-20261031b/art';art.mkdir(parents=True);(art/'art-manifest.json').write_text('{}')
            code='import runpy,sys;from pathlib import Path;runpy.run_path(sys.argv[1])["build"](None,root=Path(sys.argv[2]))'
            result=subprocess.run([sys.executable,'-I','-c',code,str(script),str(root)],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('App icon missing: '+str(art/'brand/AppIcon.icns'),result.stderr)
    def test_default_profile_is_the_local_one_when_the_checkout_has_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);public=root/'app/packaging/release.json';local=root/'private/release/release.json'
            for path in (public,local):path.parent.mkdir(parents=True)
            public.write_text('{}')
            self.assertEqual(release.default_profile(root),public)
            local.write_text('{}')
            self.assertEqual(release.default_profile(root),local)
        script=Path(__file__).resolve().parents[1]/'release.py'
        for extra,expected in [([],release.default_profile()),(['--profile','app/packaging/release.json'],Path('app/packaging/release.json').resolve())]:
            result=subprocess.run([sys.executable,'-I',str(script),'--print-profile',*extra],capture_output=True,text=True)
            self.assertEqual((result.returncode,result.stdout),(0,str(expected)+'\n'),result.stderr)

    def test_the_release_profile_variable_names_the_profile_of_every_checkout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'checkout';root.mkdir();self.repo(root);electron=Path(tmp)/'electron.json'
            local=root/'private/release/release.json';local.parent.mkdir(parents=True);local.write_text('{}')
            electron.write_text('{}')
            with mock.patch.dict('os.environ',{'AAC_RELEASE_PROFILE':str(electron)}):
                self.assertEqual(release.default_profile(root),electron)
            script=Path(__file__).resolve().parents[1]/'release.py'
            result=subprocess.run([sys.executable,'-I',str(script),'--print-profile'],capture_output=True,text=True,env=dict(os.environ,AAC_RELEASE_PROFILE=str(electron)))
            self.assertEqual((result.returncode,result.stdout),(0,str(electron)+'\n'),result.stderr)

    def test_a_profile_the_fingerprint_does_not_use_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root)
            doc=json.loads((root/'app/packaging/release.json').read_text());doc.update(app_version='9.9.9')
            profile=root/'electron.json';profile.write_text(json.dumps(doc))
            with self.assertRaisesRegex(ValueError,'set AAC_RELEASE_PROFILE='+re.escape(str(profile))+'$'):
                self.build(root,self.args(profile=profile))
            with mock.patch.dict('os.environ',{'AAC_RELEASE_PROFILE':str(profile)}),self.assertRaisesRegex(AssertionError,'before the gate receipt'):
                gate_receipt.write(self.receipt(root),store=gate_receipt.store_dir(root))
                self.build(root,self.args(profile=profile))

    def test_staging_imports_guard_in_isolated_python_used_by_release_entry(self):
        script=Path(__file__).resolve().parents[1]/'package_app.py'
        subprocess.run([sys.executable,'-I','-c','import runpy,sys;runpy.run_path(sys.argv[1])',str(script)],check=True,capture_output=True)

    def test_same_shell_profile_cannot_release_other_gated_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root);output=root/'out/release'
            gate_receipt.write(self.receipt(root),store=gate_receipt.store_dir(root))
            doc=json.loads((root/'app/packaging/release.json').read_text());doc['ui_art']=None
            profile=root/'public.json';profile.write_text(json.dumps(doc))
            with self.assertRaisesRegex(ValueError,'AAC_RELEASE_PROFILE'):
                self.build(root,self.args(profile=profile,output=output),run=self.packaging(output,'PASS'))

    def repo(self,root):
        self.git(root,'init','-b','main');self.git(root,'config','user.name','Fixture');self.git(root,'config','user.email','fixture@example.invalid')
        path=root/'app/electron/src/main/index.ts';path.parent.mkdir(parents=True);path.write_text('initial')
        self.git(root,'add','.');self.git(root,'commit','-m','fixture');return path
    def git(self,root,*args):return subprocess.check_output(['git','-C',str(root),*args],stderr=subprocess.DEVNULL,text=True)
    def test_dirty_shipping_refused_but_unrelated_research_does_not_block(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=self.repo(root);(root/'research.md').write_text('unrelated')
            self.assertTrue(release_guard(root)['shipping_sources_clean'])
            source.write_text('changed')
            with self.assertRaisesRegex(ValueError,'Uncommitted'):release_guard(root)
            self.assertFalse(source_state(root)['shipping_sources_clean'])
    def test_web_sources_ship_but_web_build_products_do_not(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.repo(root)
            for generated in ['web/node_modules/vite/index.js','web/dist/main.html','web/test-results/a.png',
                    'web/.shots/webkit/a.png','web/playwright-report/index.html']:
                path=root/generated;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('generated')
            self.assertTrue(release_guard(root)['shipping_sources_clean'])
            source=root/'web/src/main.tsx';source.parent.mkdir(parents=True);source.write_text('new')
            with self.assertRaisesRegex(ValueError,'Uncommitted.*web/src/main.tsx'):release_guard(root)
    def test_unmerged_feature_head_cannot_be_released(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=self.repo(root);self.git(root,'switch','-c','codex/feature');source.write_text('feature');self.git(root,'add','.');self.git(root,'commit','-m','feature')
            with self.assertRaisesRegex(ValueError,'not main'):release_guard(root)
    def test_build_survives_main_moving_but_not_its_own_head_or_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=self.repo(root);self.git(root,'switch','-q','--detach')
            before=release_guard(root)
            self.git(root,'switch','-q','main');source.write_text('other session');self.git(root,'commit','-qam','moved');self.git(root,'switch','-q','--detach','HEAD~1')
            self.assertFalse(sources_moved(before,source_state(root)))
            source.write_text('edited mid-build')
            self.assertTrue(sources_moved(before,source_state(root)))
            self.git(root,'checkout','-q','--',str(source));self.git(root,'switch','-q','--detach','main')
            self.assertTrue(sources_moved(before,source_state(root)))
    def release_repo(self,root,renderer=True):
        self.repo(root)
        if renderer:(root/'private/renderer/host').mkdir(parents=True)
        catalog=root/'library/current.json';catalog.parent.mkdir(parents=True);catalog.write_text('{}')
        profile=dict(schema='endfield-release-config/v1',character_catalog='library/current.json',
            catalog_sha256=hashlib.sha256(b'{}').hexdigest(),ui_art='.local/art',output_root='out')
        for name in [*release.source_fingerprint.RELEASE_TOOLS,'tools/qa/suites.json']:
            path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.touch()
        path=root/'app/packaging/release.json';path.parent.mkdir(parents=True);path.write_text(json.dumps(profile))
        self.git(root,'add','.');self.git(root,'commit','-m','release fixture')
        art=root/'.local/art';(art/'brand').mkdir(parents=True);(art/'art-manifest.json').write_text('{}');(art/'brand/AppIcon.icns').write_text('icon')
    def receipt(self,root,profile='commit',**fields):
        def sha(*names):
            h=hashlib.sha256()
            for name in names:h.update((root/name).read_bytes())
            return h.hexdigest()
        receipt=gate_receipt.build(profile=profile,result='PASS',partial=False,started_at='2026-11-01T01:00:00Z',
            source=dict(algorithm='endfield-release-source/v1',fingerprint='F'*64,changed_during_run=False),
            suites_sha256=sha('tools/qa/suites.json'),
            runner_sha256=gate_receipt.runner_digest(root))
        receipt.update(fields);return receipt
    def args(self,**fields):
        values=dict(layout='portable',library=None,output=None,port=None,build_version='1',check=False,
            harness_runtime=None,python_runtime=Path('/runtime'),gate_receipt=None)
        values.update(fields);return argparse.Namespace(**values)
    def build(self,root,args,run=None):
        runtime=types.ModuleType('harness_runtime')
        runtime.lock_hashes=lambda root:{};runtime.prepare=mock.Mock();runtime.validate_runtime=mock.Mock()
        def no_run(*a,**k):raise AssertionError('subprocess.run before the gate receipt check')
        real_run,real=subprocess.run,subprocess.check_output
        # check_output runs git through subprocess.run, so git passes the patched run.
        def run_or_git(argv,**k):return real_run(argv,**k) if argv[0]=='git' else (run or no_run)(argv,**k)
        def check_output(argv,**k):return real(argv,**k) if argv[0]=='git' else '/bin'
        electron=types.ModuleType('electron_runtime')
        def prepare(cache,root_):
            (run or no_run)(['prepare',str(cache),str(root_)])
            return Path('/cache/Electron.app'),dict(schema='endfield-electron-runtime/v1',version='45.4.1',sha256='e'*64,files={'x':{}})
        electron.prepare=prepare
        profile_hash=hashlib.sha256(release.default_profile(root).read_bytes()).hexdigest()
        with mock.patch.dict(sys.modules,{'harness_runtime':runtime,'electron_runtime':electron}),mock.patch.object(release.source_fingerprint,'compute',return_value=({release.source_fingerprint.PROFILE_KEY:profile_hash},'F'*64)),\
                mock.patch.object(release.subprocess,'run',side_effect=run_or_git),mock.patch.object(release.subprocess,'check_output',side_effect=check_output),\
                mock.patch.object(release,'build_web',side_effect=lambda root,ui:ui) as web:
            release.build(args,root=root)
        return web
    def test_release_without_gate_receipt_is_refused_before_any_subprocess(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root)
            with self.assertRaisesRegex(ValueError,'gate receipt.*gate.py --profile commit --checkout '+str(root)):self.build(root,self.args())
    def test_gate_receipt_must_pass_whole_on_these_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root);store=gate_receipt.store_dir(root)
            for bad,reason in [(dict(source=dict(fingerprint='0'*64,changed_during_run=False)),'fingerprint'),(dict(result='FAIL'),'result'),
                    (dict(partial=True),'partial'),(dict(profile='web'),'profile'),(dict(runner_sha256='0'*64),'runner')]:
                path=root/'bad.json';path.write_text(json.dumps(self.receipt(root,**bad)))
                with self.assertRaisesRegex(ValueError,'gate receipt.*'+reason):self.build(root,self.args(gate_receipt=path))
                if reason not in ('profile','runner'):gate_receipt.write(self.receipt(root,**bad),store=store)
            with self.assertRaisesRegex(ValueError,'gate receipt'):self.build(root,self.args())
            gate_receipt.write(self.receipt(root,profile='release'),store=store)
            with self.assertRaisesRegex(AssertionError,'before the gate receipt'):self.build(root,self.args())
    def test_full_failure_revokes_older_pass_for_these_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root);store=gate_receipt.store_dir(root)
            receipt=self.receipt(root);fingerprint=receipt['source']['fingerprint']
            path=gate_receipt.write(receipt,store=store)
            failure=dict(receipt,result='FAIL',started_at='2026-11-01T02:00:00Z')
            for unrelated in (dict(failure,partial=True),dict(failure,profile='release'),
                              dict(failure,source=dict(receipt['source'],fingerprint='0'*64))):
                gate_receipt.write(unrelated,store=store)
            self.assertEqual(gate_receipt.require(root,fingerprint)[0],path)
            gate_receipt.write(failure,store=store)
            for explicit in (None,path,path.parent/gate_receipt.LATEST):
                with self.subTest(explicit=explicit),self.assertRaisesRegex(ValueError,'gate receipt'):
                    gate_receipt.require(root,fingerprint,explicit)
            newer=gate_receipt.write(dict(receipt,started_at='2026-11-01T03:00:00Z'),store=store)
            self.assertEqual(gate_receipt.require(root,fingerprint)[0],newer)

    def test_a_receipt_from_another_runner_gives_way_to_an_older_one_that_vouches(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root);store=gate_receipt.store_dir(root)
            good=self.receipt(root);fingerprint=good['source']['fingerprint']
            older=gate_receipt.write(good,store=store)
            gate_receipt.write(dict(good,runner_sha256='0'*64,started_at='2026-11-01T02:00:00Z'),store=store)
            self.assertEqual(gate_receipt.require(root,fingerprint)[0],older)
            release=gate_receipt.write(self.receipt(root,profile='release'),store=store)
            for path in older.parent.glob('*.json'):
                if path.name!=gate_receipt.LATEST and path!=older:continue
                path.unlink()
            self.assertEqual(gate_receipt.require(root,fingerprint)[0],release)
    def test_full_runs_starting_in_the_same_second_follow_store_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root);store=gate_receipt.store_dir(root)
            receipt=self.receipt(root);fingerprint=receipt['source']['fingerprint']
            gate_receipt.write(receipt,store=store)
            gate_receipt.write(dict(receipt,result='FAIL'),store=store)
            self.assertIsNone(gate_receipt.find(store,'commit',fingerprint))
            newer=gate_receipt.write(receipt,store=store)
            self.assertEqual(gate_receipt.find(store,'commit',fingerprint)[0],newer)

    def test_gate_receipt_covers_private_suites_when_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root);(root/'private/suites.json').write_text('{"private":1}')
            def sha(*names):
                h=hashlib.sha256()
                for name in names:h.update((root/name).read_bytes())
                return h.hexdigest()
            path=root/'receipt.json'
            path.write_text(json.dumps(self.receipt(root)))
            with self.assertRaisesRegex(ValueError,'gate receipt.*suites'):self.build(root,self.args(gate_receipt=path))
            path.write_text(json.dumps(self.receipt(root,suites_sha256=sha('tools/qa/suites.json','private/suites.json'))))
            with self.assertRaisesRegex(AssertionError,'before the gate receipt'):self.build(root,self.args(gate_receipt=path))
    def test_a_library_holding_a_local_absolute_path_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root);gate_receipt.write(self.receipt(root),store=gate_receipt.store_dir(root))
            leak=root/'library/packages/a/source.json';leak.parent.mkdir(parents=True);leak.write_text(json.dumps(dict(source_spirv='/Users/someone/v.spv')))
            for args in [self.args(),self.args(library=root/'library')]:
                with self.assertRaisesRegex(ValueError,'release library holds 2 local absolute paths: packages/a/source.json source_spirv, packages/a/source.json$'):
                    self.build(root,args)
            leak.write_text(json.dumps(dict(source_spirv='A/v.spv')))
            with self.assertRaisesRegex(AssertionError,'before the gate receipt'):self.build(root,self.args())
    def test_check_reports_gate_receipt_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root)
            for name in [*release.source_fingerprint.EXTRA_FILES,*harness_runtime.LOCKS]:
                path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.touch()
            for name in ('release.py','source_fingerprint.py','gate_receipt.py','local_paths.py','harness_runtime.py'):
                shutil.copyfile(Path(release.__file__).with_name(name),root/'tools/release'/name)
            self.git(root,'add','.');self.git(root,'commit','-m','release check fixture')
            command=[sys.executable,'-I',str(root/'tools/release/release.py'),'--check']
            result=subprocess.run(command,capture_output=True,text=True)
            report=json.loads(result.stdout)
            self.assertEqual(report['layout'],'portable')
            self.assertIn('gate.py --profile commit',report['gate_receipt_error'])
            self.assertNotEqual(result.returncode,0)
            receipt=self.receipt(root)
            receipt['source']['fingerprint']=report['source_fingerprint']
            path=gate_receipt.write(receipt,store=gate_receipt.store_dir(root))
            result=subprocess.run(command,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(json.loads(result.stdout)['gate_receipt'],str(path.resolve()))
    def test_release_receipt_records_the_gate_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root);output=root/'out/release'
            path=gate_receipt.write(self.receipt(root),store=gate_receipt.store_dir(root))
            with mock.patch('sys.stdout',new_callable=io.StringIO) as out:self.build(root,self.args(output=output),run=self.packaging(output,'PASS'))
            receipt=json.loads((output/'release-receipt.json').read_text())
            self.assertEqual((receipt['gate_receipt'],receipt['source_fingerprint'],receipt['gate_profile'],receipt['gate_result']),(gate_receipt.LATEST,'F'*64,'commit','PASS'))
            self.assertEqual((output/'gate-receipt.json').read_text(),path.read_text())
            self.assertEqual(receipt['artifact_smoke'],dict(result='PASS',error=None,app='Agentic Complex.app'))
            self.assertEqual((receipt['layout'],receipt['distribution']),('portable','portable'))
            self.assertIn('release_ready',out.getvalue())
    def test_package_app_gets_the_profile_library_after_the_renderer_libraries_are_built(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root);output=root/'out/release'
            gate_receipt.write(self.receipt(root),store=gate_receipt.store_dir(root))
            package,seen=self.packaging(output,'PASS'),[]
            def run(argv,**kwargs):
                if len(argv)>2 and 'package_app.py' in argv[2]:seen.append(argv[argv.index('--library')+1])
                return package(argv,**kwargs)
            with mock.patch('sys.stdout',new_callable=io.StringIO):self.build(root,self.args(output=output),run=run)
            self.assertEqual(seen,[str(root/'library')])
    def test_shipped_receipts_omit_builder_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root);output=root/'out/release'
            suite=dict(id='release',status='PASS',log=str(root/'log'),lines=[str(root/'suite')],
                       cached=dict(from_checkout=str(root/'other'),key='abc'))
            gate_receipt.write(self.receipt(root,checkout=str(root),suites=[suite]),store=gate_receipt.store_dir(root))
            package=self.packaging(output,'PASS')
            def run(argv,**kwargs):
                result=package(argv,**kwargs)
                if len(argv)>2 and 'artifact_smoke.py' in argv[2]:
                    Path(argv[8]).write_text(json.dumps(dict(result='PASS',app=argv[4],support_dir=str(root/'temp'))))
                return result
            self.build(root,self.args(output=output),run=run)
            for name in ('release-receipt.json','gate-receipt.json','artifact-smoke.json'):
                self.assertNotIn(str(root),(output/name).read_text(),name)

    def test_split_layout_reaches_packager_check_and_release_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root);output=root/'out/split'
            gate_receipt.write(self.receipt(root),store=gate_receipt.store_dir(root))
            commands=[];package=self.packaging(output,'PASS',layout='split')
            def run(argv,**kwargs):
                commands.append(argv)
                return package(argv,**kwargs)
            with mock.patch('sys.stdout',new_callable=io.StringIO):
                self.build(root,self.args(output=output,layout='split'),run=run)
            packages = [Path(argv[argv.index('--package-path')+1]) for argv in commands if argv[:2] == ['swift', 'build']]
            self.assertEqual(packages, [root/'app/helpers/mac', root/'private/renderer/host'])
            command=next(argv for argv in commands if len(argv)>2 and 'package_app.py' in argv[2])
            self.assertIn('--layout',command)
            self.assertEqual(command[command.index('--layout')+1],'split')
            receipt=json.loads((output/'release-receipt.json').read_text())
            staged=json.loads((output/'staging-manifest.json').read_text())
            self.assertEqual((receipt['layout'],receipt['distribution']),('split','split'))
            self.assertEqual(receipt['host'],staged['host'])
            self.assertEqual(receipt['components'],staged['components'])
            with mock.patch('sys.stdout',new_callable=io.StringIO) as out:
                self.build(root,self.args(check=True,layout='split'))
            self.assertEqual(json.loads(out.getvalue())['layout'],'split')
            for name in ['release.py','package_app.py']:
                result=subprocess.run([sys.executable,'-I',str(Path(__file__).resolve().parents[1]/name),'--help'],capture_output=True,text=True)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertIn('--layout {portable,split}',result.stdout)
    def packaging(self,output,smoke_result,layout='portable'):
        """Stub of the packaging subprocesses; the artifact smoke run must name the app and the gated fingerprint."""
        def run(argv,**k):
            if argv[0]=='bash':return subprocess.CompletedProcess(argv,0)
            if 'package_app.py' in argv[2]:
                host=dict(id='host',version='1',tree_sha256='a'*64)
                components=[dict(id=id,version='1',tree_sha256=hashlib.sha256(id.encode()).hexdigest(),
                    placement='bundle' if layout=='portable' or id in ('renderer','web-ui') else 'support')
                    for id in ['renderer','web-ui','agentd','characters.fixture']]
                fuses=dict(file='f',version='1',fuses={'RunAsNode':'disabled'}) if '--electron-app' in argv else None
                output.mkdir(parents=True);(output/'staging-manifest.json').write_text(json.dumps(dict(
                    app='Agentic Complex.app',layout=layout,host=host,components=components,electron_fuses=fuses)))
                (output/'source-manifest.json').write_text(json.dumps(dict(fingerprint='F'*64)))
            if 'artifact_smoke.py' in argv[2]:
                self.assertEqual(argv[3:8],['--app',str(output/'Agentic Complex.app'),'--fingerprint','F'*64,'--output'])
                Path(argv[8]).write_text(json.dumps(dict(result=smoke_result,error=None if smoke_result=='PASS' else 'no HOSTLINK hello character= within 180 s')))
            return subprocess.CompletedProcess(argv,0 if smoke_result=='PASS' else 1)
        return run
    def profile_release(self,root,ui_art,**fields):
        """Runs a full stubbed release on a --profile whose ui_art and fields are given; returns the package_app.py argv."""
        doc=json.loads((root/'app/packaging/release.json').read_text());doc['ui_art']=ui_art;doc.update(fields)
        return self.release_command(root,doc)
    def release_command(self,root,doc):
        """Runs a full stubbed release on the profile document doc; returns the package_app.py argv."""
        output=root/'out/release';profile=root/'public.json';profile.write_text(json.dumps(doc))
        commands=[];package=self.packaging(output,'PASS')
        def run(argv,**k):
            commands.append(argv);return package(argv,**k)
        with mock.patch.dict(os.environ,{'AAC_RELEASE_PROFILE':str(profile)}),mock.patch('sys.stdout',new_callable=io.StringIO):
            gate_receipt.write(self.receipt(root),store=gate_receipt.store_dir(root))
            self.build(root,self.args(output=output,profile=profile),run=run)
        return next(argv for argv in commands if len(argv)>2 and 'package_app.py' in argv[2])
    def test_profile_with_null_ui_art_ships_without_art_or_icon(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root)
            for path in [root/'.local/art/art-manifest.json',root/'.local/art/brand/AppIcon.icns']:path.unlink()
            self.assertNotIn('--ui-art',self.profile_release(root,None))
    def test_profile_ui_art_directory_replaces_the_ui_art_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root)
            with self.assertRaisesRegex(ValueError,'UI art missing: '+str(root/'custom/art')):self.profile_release(root,'custom/art')
            (root/'custom').mkdir();(root/'.local/art').rename(root/'custom/art')
            command=self.profile_release(root,'custom/art')
            self.assertEqual(command[command.index('--ui-art')+1],str(root/'custom/art'))
    def test_a_profile_without_content_overrides_passes_none_to_the_packager(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root)
            self.assertNotIn('--content-override',self.profile_release(root,'.local/art'))
    def test_a_profile_without_ui_art_ships_without_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root)
            doc=json.loads((root/'app/packaging/release.json').read_text());del doc['ui_art']
            command=self.release_command(root,doc)
            self.assertNotIn('--ui-art',command)
    def test_profile_with_null_character_catalog_packages_an_empty_library(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root);(root/'library/current.json').unlink()
            command=self.profile_release(root,'.local/art',character_catalog=None,catalog_sha256=None)
            self.assertNotEqual(command[command.index('--library')+1],str(root/'library'))
            receipt=json.loads((root/'out/release/release-receipt.json').read_text())
            self.assertIsNone(receipt['catalog_sha256'])
    def test_release_python_is_resolved_not_the_checkout_venv(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root)
            command=self.profile_release(root,'.local/art')
            # check_output answers '/bin' for the resolver; the checkout has no agent/.venv.
            self.assertEqual(command[0],'/bin')
    def test_profile_content_overrides_reach_the_packager_with_sources_in_the_checkout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root)
            overrides={'agentd/agentd/brain/canon-windows.json':'local/canon-windows.json','renderer/Resources/window-envelopes.json':'local/envelopes.json'}
            (root/'local').mkdir()
            for source in overrides.values():(root/source).write_text('{}')
            command=self.profile_release(root,'.local/art',content_overrides=overrides)
            self.assertEqual([command[i+1] for i,x in enumerate(command) if x=='--content-override'],
                ['agentd/agentd/brain/canon-windows.json='+str(root/'local/canon-windows.json'),
                 'renderer/Resources/window-envelopes.json='+str(root/'local/envelopes.json')])
    def test_failed_artifact_smoke_stops_the_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root);output=root/'out/release'
            gate_receipt.write(self.receipt(root),store=gate_receipt.store_dir(root))
            with mock.patch('sys.stdout',new_callable=io.StringIO) as out,self.assertRaisesRegex(ValueError,'Artifact smoke failed: no HOSTLINK hello'):
                self.build(root,self.args(output=output),run=self.packaging(output,'FAIL'))
            self.assertNotIn('release_ready',out.getvalue())
            self.assertFalse((output/'release-receipt.json').exists())
    def shell_release(self,root,identity='-',status='Accepted',**fields):
        """A full stubbed release on the fixture profile plus fields, signed as identity; returns (commands, receipt)."""
        doc=json.loads((root/'app/packaging/release.json').read_text());doc.update(fields)
        output=root/'out/release';profile=root/'public.json';profile.write_text(json.dumps(doc))
        commands=[];package=self.packaging(output,'PASS')
        def run(argv,**k):
            commands.append((argv,k))
            return package(argv,**k)
        def notarized(app,keychain_profile):
            commands.append((['notarize',str(app),keychain_profile],{}))
            if status!='Accepted':raise notarize.NotarizationError('notarization '+status+': submission sub-1')
            return dict(id='sub-1',status=status)
        with mock.patch.dict('os.environ',{'AAC_SIGN_IDENTITY':identity,'AAC_RELEASE_PROFILE':str(profile)}),\
                mock.patch.object(notarize,'notarize',side_effect=notarized),mock.patch('sys.stdout',new_callable=io.StringIO):
            gate_receipt.write(self.receipt(root),store=gate_receipt.store_dir(root))
            self.build(root,self.args(output=output,profile=profile),run=run)
        return commands,json.loads((output/'release-receipt.json').read_text())
    def test_a_release_builds_the_main_process_and_helper_and_stages_the_locked_electron(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root)
            commands,receipt=self.shell_release(root,product_name='Agentic Complex',app_version='0.3.0')
            argvs=[argv for argv,_ in commands]
            self.assertEqual([Path(argv[argv.index('--package-path')+1]) for argv in argvs if argv[:3]==['swift','build','-c'] and '--show-bin-path' not in argv],
                             [root/'app/helpers/mac',root/'private/renderer/host'])
            host_build=argvs.index(next(argv for argv in argvs if argv[:2]==['swift','build'] and str(root/'private/renderer/host') in argv))
            self.assertEqual([argv for argv in argvs[:host_build] if argv[0]=='bash'],
                             [['bash',str(root/'private/renderer/core/build.sh')],['bash',str(root/'private/renderer/common/build.sh')]])
            self.assertIn(['prepare',str(root/'.local/cache/electron-runtime'),str(root)],argvs)
            self.assertIn(['npm','--prefix',str(root/'app/electron'),'ci','--ignore-scripts','--prefer-offline'],argvs)
            self.assertEqual([k['cwd'] for argv,k in commands if argv==['npm','run','build']],[root/'app/electron'])
            command=next(argv for argv in argvs if len(argv)>2 and 'package_app.py' in argv[2])
            options={command[i]:command[i+1] for i in range(len(command)-1) if command[i] in ('--electron-app','--electron-dir','--helper','--product-name','--app-version')}
            self.assertEqual(options,{'--electron-app':'/cache/Electron.app','--electron-dir':str(root/'app/electron'),
                '--helper':'/bin/ac-helper','--product-name':'Agentic Complex','--app-version':'0.3.0'})
            self.assertIsNone(receipt['notarization'])
            self.assertEqual(receipt['electron_runtime'],dict(schema='endfield-electron-runtime/v1',version='45.4.1',sha256='e'*64))
            self.assertFalse(any('flip_fuses.mjs' in part for argv in argvs for part in argv))
            self.assertEqual(receipt['electron_fuses'],dict(file='f',version='1',fuses={'RunAsNode':'disabled'}))
    def test_a_checkout_without_the_renderer_builds_no_renderer_host(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root,renderer=False)
            commands,_=self.shell_release(root,product_name='Agentic Complex',app_version='0.3.0')
            argvs=[argv for argv,_ in commands]
            self.assertEqual([Path(argv[argv.index('--package-path')+1]) for argv in argvs if argv[:3]==['swift','build','-c'] and '--show-bin-path' not in argv],
                             [root/'app/helpers/mac'])
            command=next(argv for argv in argvs if len(argv)>2 and 'package_app.py' in argv[2])
            self.assertNotIn('--host',command)
    def test_existing_electron_dependencies_are_installed_from_the_lock_before_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);electron=root/'app/electron';(electron/'node_modules').mkdir(parents=True)
            with mock.patch.object(subprocess,'run') as run:release.build_electron(root)
            self.assertEqual(run.call_args_list,[
                mock.call(['npm','--prefix',str(electron),'ci','--ignore-scripts','--prefer-offline'],check=True),
                mock.call(['npm','run','build'],cwd=electron,check=True)])
    def test_a_notary_profile_notarizes_only_a_developer_id_signature_after_signing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root);app=str(root/'out/release/Agentic Complex.app')
            commands,receipt=self.shell_release(root,'Developer ID Application: Example (TEAMID1234)',notary_keychain_profile='ac-notary')
            argvs=[argv for argv,_ in commands]
            order=[next(i for i,argv in enumerate(argvs) if any(key in part for part in argv)) for key in ('sign_bundle.sh','notarize','inventory_app.py','artifact_smoke.py')]
            self.assertEqual(order,sorted(order))
            self.assertIn(['notarize',app,'ac-notary'],argvs)
            self.assertEqual(receipt['notarization'],dict(id='sub-1',status='Accepted'))
            shutil.rmtree(root/'out/release')
            with self.assertRaisesRegex(ValueError,'^notarization Invalid: submission sub-1$'):
                self.shell_release(root,'Developer ID Application: Example (TEAMID1234)',status='Invalid',notary_keychain_profile='ac-notary')
            self.assertFalse((root/'out/release/release-receipt.json').exists())
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release_repo(root)
            commands,receipt=self.shell_release(root,'Developer ID Application: Example (TEAMID1234)')
            self.assertFalse([argv for argv,_ in commands if argv[0]=='notarize'])
            self.assertIsNone(receipt['notarization'])
    def test_requested_notarization_rejects_identities_without_developer_id_signing(self):
        for identity in ('Apple Development: Example (TEAMID1234)','-','0123456789abcdef'*2+'01234567'):
            with self.subTest(identity=identity),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);self.release_repo(root)
                with self.assertRaisesRegex(ValueError,'Developer ID Application:'):
                    self.shell_release(root,identity,notary_keychain_profile='ac-notary')
                self.assertFalse((root/'out/release').exists())
    def test_generated_builds_excluded_and_runtime_helpers_included(self):
        self.assertFalse(shipping_path('app/.swiftpm/ide-state'))
        self.assertFalse(shipping_path('app/build/releases/Agentic Complex.app/Contents/MacOS/AgenticComplex'))
        self.assertTrue(shipping_path('app/package_release.sh'))
        self.assertTrue(shipping_path('agent/agentd/distribution_seed.py'))
        self.assertTrue(shipping_path('private/renderer/host/Sources/NativeHostBridge/HostBridge.mm'))
    def test_the_electron_shell_and_helper_sources_ship_and_their_builds_and_tests_do_not(self):
        sources=['app/electron/src/main/index.ts','app/electron/package.json','app/electron/build.mjs',
                 'app/helpers/mac/Sources/HelperCore/Permissions.swift','app/helpers/mac/Package.swift']
        outside=['app/electron/node_modules/electron/index.js','app/electron/dist/main.mjs','app/electron/test/config.test.ts',
                 'app/helpers/mac/.build/release/ac-helper','app/helpers/mac/Tests/HelperCoreTests/ControlTests.swift']
        for path in sources:self.assertTrue(shipping_path(path),path)
        for path in outside:self.assertFalse(shipping_path(path),path)


class LocalPathTests(unittest.TestCase):
    def library(self,root,files):
        for name,data in files.items():
            path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data if isinstance(data,bytes) else json.dumps(data).encode())
        return root

    def test_json_values_with_a_local_path_are_found_by_file_and_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=self.library(Path(tmp),{'current.json':dict(schema='x'),
                'packages/a/source.json':dict(draws=[dict(stages=[dict(source_spirv='/Users/someone/shaders/A/v.spv',source_spirv_sha256='0'*64)])],
                    commands=[['tool','/private/tmp/work/in.bin']],note='kept/relative/path',root='/Volumes/disk/x',dir='C:/x/Users/y'),
                'packages/a/other.json':dict(path='/var/folders/x',when='/tmp/y',plain='/opt/homebrew/bin/tool')})
            self.assertEqual(local_paths.find(root),[
                dict(file='packages/a/other.json',key='path',value='/var/folders/x'),
                dict(file='packages/a/other.json',key='when',value='/tmp/y'),
                dict(file='packages/a/source.json',key='draws/0/stages/0/source_spirv',value='/Users/someone/shaders/A/v.spv'),
                dict(file='packages/a/source.json',key='commands/0/1',value='/private/tmp/work/in.bin'),
                dict(file='packages/a/source.json',key='root',value='/Volumes/disk/x'),
                dict(file='packages/a/source.json',key='dir',value='C:/x/Users/y'),
                dict(file='packages/a/source.json',key=None,value='/Users/ in the bytes')])

    def test_a_binary_naming_a_user_folder_is_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=self.library(Path(tmp),{'packages/a/program.air':b'\x00\x01built from /Users/someone/x.metal\x00','packages/a/image.png':b'\x89PNG /private/ is not a user folder'})
            self.assertEqual(local_paths.find(root),[dict(file='packages/a/program.air',key=None,value='/Users/ in the bytes')])

    def test_a_clean_library_passes_the_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=self.library(Path(tmp),{'current.json':dict(schema='x',file='packages/a/p.json'),'packages/a/p.json':dict(source_spirv='CharacterNPR/v.spv'),
                                         'packages/a/blob.bin':b'\x00bytes'})
            self.assertEqual(local_paths.find(root),[])
            with mock.patch('sys.stdout',new_callable=io.StringIO) as out:self.assertEqual(local_paths.main([str(root)]),0)
            self.assertEqual(out.getvalue(),'0 local absolute paths in '+str(root)+'\n')

    def test_the_command_lists_each_hit_and_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=self.library(Path(tmp),{'packages/a/p.json':dict(rows=[dict(json_path='/tmp/a.json')]),'packages/a/x.air':b'/Users/a'})
            with mock.patch('sys.stdout',new_callable=io.StringIO) as out:self.assertEqual(local_paths.main([str(root)]),1)
            self.assertEqual(out.getvalue().splitlines(),['packages/a/p.json\trows/0/json_path\t/tmp/a.json','packages/a/x.air\t-\t/Users/ in the bytes',
                                                          '2 local absolute paths in '+str(root)])
            with self.assertRaisesRegex(ValueError,r'release library holds 2 local absolute paths: packages/a/p.json rows/0/json_path, packages/a/x.air'):
                local_paths.require_none(root)

