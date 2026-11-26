"""Deployment checks without importing the TTS runtime or torch."""
import argparse,ast,json,os,pathlib,re,shlex,shutil,subprocess,sys,tempfile,unittest

HERE=pathlib.Path(__file__).resolve().parent

class DeployFilesTest(unittest.TestCase):
    def test_deploy_files_have_no_machine_paths(self):
        deploy=HERE/'deploy'
        for name in ('Dockerfile','compose.yaml','deploy.sh'):
            self.assertTrue((deploy/name).is_file(),f'Missing deploy/{name}')
        for path in sorted(deploy.rglob('*')):
            if path.is_file():
                with self.subTest(path=path.relative_to(deploy)):
                    text=path.read_text()
                    for prefix in ('/mnt/data','/home/'):
                        self.assertNotIn(prefix,text)

    def test_cuda_image_uses_a_registry_digest(self):
        image=(HERE/'deploy/Dockerfile').read_text().splitlines()[0]
        self.assertRegex(image,r'^FROM nvidia/cuda:12\.8\.0-cudnn-devel-ubuntu22\.04@sha256:[0-9a-f]{64}$')

    def test_apt_uses_only_a_dated_ubuntu_snapshot(self):
        dockerfile=(HERE/'deploy/Dockerfile').read_text()
        self.assertRegex(dockerfile,r'https://snapshot\.ubuntu\.com/ubuntu/\d{8}T\d{6}Z/')
        self.assertIn('/etc/apt/sources.list.d/',dockerfile)

    @unittest.skipUnless(shutil.which('docker-compose'),'Docker Compose executable required')
    def test_compose_renders_the_deployment_user_and_mount_modes(self):
        with tempfile.TemporaryDirectory() as root:
            env=dict(os.environ,DOCKER_CONFIG=root,AAC_TTS_ROOT=root,AAC_TTS_UID='1001',AAC_TTS_GID='1002',
                     AAC_TTS_BIND='127.0.0.1',AAC_TTS_PORT='9888',AAC_TTS_REMOTE='0')
            run=subprocess.run(['docker-compose','-f',str(HERE/'deploy/compose.yaml'),'config','--format','json'],
                               env=env,capture_output=True,text=True)
            self.assertEqual(run.returncode,0,run.stderr)
            service=json.loads(run.stdout)['services']['tts']
            self.assertEqual(service['user'],'1001:1002')
            mounts={v['source']:(v['target'],v.get('read_only',False)) for v in service['volumes']}
            self.assertEqual(mounts,{root+'/weights':('/srv/tts',True),root+'/state':('/srv/tts/state',True),
                                     root+'/output':('/srv/tts/output',False)})

    def test_deploy_rejects_root_before_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=pathlib.Path(tmp)
            for name,body in [('id','echo 0'),('docker','exit 0')]:
                stub=path/name
                stub.write_text('#!/bin/sh\n'+body+'\n')
                stub.chmod(0o755)
            run=subprocess.run(['bash',str(HERE/'deploy/deploy.sh'),'--root',str(path/'data'),'--port','9888'],
                               env={**os.environ,'PATH':tmp+':'+os.environ['PATH']},capture_output=True,text=True)
            self.assertNotEqual(run.returncode,0)
            self.assertFalse((path/'data').exists())

    def test_image_installs_python_packages_only_from_the_hash_lock(self):
        installs=[line for line in (HERE/'deploy/Dockerfile').read_text().splitlines() if 'pip install' in line]
        self.assertEqual(len(installs),1,installs)
        self.assertIn('--require-hashes',installs[0])
        self.assertIn('-r /tmp/requirements-tts.lock',installs[0])
        pins=[line for line in (HERE/'requirements-tts.lock').read_text().splitlines() if line[:1].isalnum()]
        self.assertIn('torch==2.8.0+cu128 \\',pins)
        self.assertTrue(all('==' in line for line in pins))

    def test_mfa_lock_is_a_single_explicit_conda_spec(self):
        lines=[line for line in (HERE/'requirements-mfa.lock').read_text().splitlines() if line and not line.startswith('#')]
        self.assertEqual(lines.pop(0),'@EXPLICIT')
        for artifact in lines:
            self.assertRegex(artifact,r'^https://[^ ]+\.(?:conda|tar\.bz2)#[0-9a-f]{32}$')

    def test_plain_voice_never_imports_the_optional_lexicon(self):
        import contextlib,runpy
        from unittest import mock
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp)
            pre=root/'GPT_SoVITS/pretrained_models'
            (pre/'gsv-v5-pretrained').mkdir(parents=True)
            (pre/'s1v3.ckpt').write_bytes(b'gpt')
            (pre/'gsv-v5-pretrained/s2Gv5dev.pth').write_bytes(b'sovits')
            run=root/'runs/plain'
            (run/'train').mkdir(parents=True)
            (run/'manifest.json').write_text('{}')
            reference=dict(duration=4,review={'neutral_probability':1},language='chinese',wav='ref.wav',wav_sha256='abc')
            (run/'train/source.jsonl').write_text(json.dumps(reference))
            modules={name:mock.MagicMock() for name in ('torch','numpy','soundfile','TTS_infer_pack.TTS','text','segment_meta','yaml')}
            modules['TTS_infer_pack.TTS'].TTS.return_value.configs.sampling_rate=48000
            modules['yaml'].safe_dump=json.dumps
            with contextlib.chdir(root),mock.patch.dict(os.environ,AAC_VOICE_ROOT=tmp,AAC_GPT_SOVITS=tmp), \
                    mock.patch.object(sys,'path',sys.path.copy()),mock.patch.dict(sys.modules,{**modules,'frontend_lexicon':None}):
                runtime=runpy.run_path(str(HERE/'tts_runtime.py'))['Runtime']('plain',base=True)
            self.assertIsNone(runtime.identity['frontend_lexicon_sha256'])
            self.assertTrue((root/'output/plain/runtime-base-v5dev.yaml').is_file())

    def test_documented_token_commands_include_both_destinations(self):
        root=HERE.parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            ssh=pathlib.Path(tmp)/'ssh'
            ssh.write_text('#!/bin/sh\nexit 0\n')
            ssh.chmod(0o755)
            env={'PATH':tmp,'AAC_TTS_TOKEN_FILE':str(pathlib.Path(tmp)/'tts-token')}
            for name in ('docs/architecture/agentd.md','docs/architecture/agentd.en.md'):
                commands=re.findall(r'`[^`\n]*tts_token\.py ((?:push|rotate)[^`\n]*)`',(root/name).read_text())
                self.assertTrue(commands,name)
                for command in commands:
                    run=subprocess.run([sys.executable,'-I',str(root/'agent/agentd/tools/tts_token.py'),*shlex.split(command)],
                                       env=env,capture_output=True,text=True)
                    self.assertEqual(run.returncode,0,run.stderr)

    def test_listen_address_argument(self):
        tree=ast.parse((HERE/'serve_tts.py').read_text())
        parser=next((node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='parse_args'),None)
        self.assertIsNotNone(parser,'serve_tts.py needs a listen-address argument parser')
        namespace={'argparse':argparse}
        exec(compile(ast.Module([parser],[]),'serve_tts.py','exec'),namespace)
        parse_args=namespace['parse_args']
        defaults=parse_args([])
        self.assertEqual(defaults.listen_address,'127.0.0.1')
        self.assertEqual(defaults.port,9888)
        configured=parse_args(['9988','--listen-address','0.0.0.0'])
        self.assertEqual(configured.listen_address,'0.0.0.0')
        self.assertEqual(configured.port,9988)

    def test_container_paths_and_bind_address_port(self):
        compose=(HERE/'deploy/compose.yaml').read_text()
        self.assertIn('"${AAC_TTS_BIND:?Run deploy.sh}:${AAC_TTS_PORT',compose)
        self.assertIn('\nbind=127.0.0.1\n',(HERE/'deploy/deploy.sh').read_text())
        runtime=(HERE/'tts_runtime.py').read_text()
        for name in ('AAC_VOICE_ROOT','AAC_GPT_SOVITS'):
            self.assertIn(name,runtime)
            self.assertIn(name+':',compose)

if __name__=='__main__':unittest.main()
