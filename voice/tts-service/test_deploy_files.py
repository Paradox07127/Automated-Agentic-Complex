"""Deployment checks without importing the TTS runtime or torch."""
import argparse,ast,pathlib,unittest

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
