"""Checkpoint loading in tts_runtime with torch and the GPT-SoVITS imports stubbed; run: python3 -m unittest test_tts_runtime (no torch needed)."""
import importlib,json,os,pathlib,sys,tempfile,types,unittest
from unittest import mock
HERE=pathlib.Path(__file__).resolve().parent
sys.path[:0]=[str(HERE)]

class Chunk(list):dtype='int16'

class TtsRuntimeLoadTest(unittest.TestCase):
    def setUp(self):
        repo=pathlib.Path(self.enterContext(tempfile.TemporaryDirectory()));self.repo=repo
        torch=types.ModuleType('torch');torch.set_num_threads=lambda n:None;torch.load=mock.Mock(return_value={'weight':{'w':1}});torch.cuda=mock.Mock()
        tts=types.ModuleType('TTS_infer_pack.TTS');tts.TTS=tts.TTS_Config=object
        numpy=types.ModuleType('numpy');numpy.int16='int16'
        yaml=types.ModuleType('yaml');yaml.safe_dump=json.dumps
        stubs={'torch':torch,'numpy':numpy,'soundfile':types.ModuleType('soundfile'),'yaml':yaml,'TTS_infer_pack':types.ModuleType('TTS_infer_pack'),'TTS_infer_pack.TTS':tts,'text':mock.MagicMock()}
        self.torch=torch;self.numpy=numpy
        self.enterContext(mock.patch.dict(sys.modules,stubs))
        self.enterContext(mock.patch.dict(os.environ,{'AAC_GPT_SOVITS':str(repo),'AAC_VOICE_ROOT':str(repo)}))
        self.enterContext(mock.patch.object(sys,'path',list(sys.path)))
        cwd=os.getcwd();self.addCleanup(os.chdir,cwd)
        sys.modules.pop('tts_runtime',None);self.addCleanup(sys.modules.pop,'tts_runtime',None)
        self.runtime=importlib.import_module('tts_runtime')

    def test_checkpoint_weights_load_without_unpickling_arbitrary_objects(self):
        self.assertEqual(self.runtime.load_weight(pathlib.Path('s1.ckpt')),{'w':1})
        self.torch.load.assert_called_once_with(pathlib.Path('s1.ckpt'),map_location='cpu',weights_only=True)

    def runtime_without_load(self,engine):
        runtime=object.__new__(self.runtime.Runtime)
        runtime.engine=engine;runtime.variant='v5dev';runtime.lang='zh';runtime.reference={'wav':'ref.wav','text':'参考'}
        runtime.segments=runtime.cancel_hook=runtime.t2s_hook=runtime.t2s_accel_hook=mock.Mock()
        return runtime

    def test_upstream_error_silence_is_refused_before_it_is_forwarded(self):
        class Engine:
            def run(self,params):
                yield 48000,Chunk([1]*480)
                # TTS.run's except branch, and its answer to text with no segments.
                yield 16000,Chunk([0]*16000)
        self.numpy.concatenate=lambda chunks:self.fail(f'stored chunks of {[len(c) for c in chunks]} samples')
        forwarded=[]
        with self.assertRaisesRegex(ValueError,'16000 Hz'):
            self.runtime_without_load(Engine()).synthesize('你好','x',on_chunk=lambda sr,chunk,elapsed:forwarded.append(sr),keep_files=False)
        self.assertEqual(forwarded,[48000])

    def write_base_run(self):
        pre=self.repo/'GPT_SoVITS/pretrained_models';(pre/'gsv-v5-pretrained').mkdir(parents=True)
        (pre/'s1v3.ckpt').write_bytes(b'gpt');(pre/'gsv-v5-pretrained/s2Gv5dev.pth').write_bytes(b'sovits')
        run=self.repo/'runs/X';(run/'train').mkdir(parents=True);(run/'manifest.json').write_text('{}')
        (run/'train/source.jsonl').write_text(json.dumps(dict(duration=4,review={'neutral_probability':1},language='chinese',wav='ref.wav',wav_sha256='abc')))

    def test_a_plain_voice_is_refused_once_the_game_lexicon_patched_its_frontend(self):
        self.write_base_run()
        lexicon=types.ModuleType('frontend_lexicon');lexicon.installed=lexicon.ja_installed=False;lexicon.LEXICON_SHA256='zh-lexicon';lexicon.JA_LEXICON_SHA256='ja-lexicon'
        lexicon.install=lambda:setattr(lexicon,'installed',True);lexicon.install_ja=lambda root:setattr(lexicon,'ja_installed',True)
        self.enterContext(mock.patch.dict(sys.modules,{'frontend_lexicon':lexicon}))
        engine=mock.Mock();engine.configs.sampling_rate=32000
        self.enterContext(mock.patch.object(self.runtime,'TTS',return_value=engine));self.enterContext(mock.patch.object(self.runtime,'TTS_Config'))
        Runtime=self.runtime.Runtime
        self.assertIsNone(Runtime('X',base=True).identity['frontend_lexicon_sha256'])
        self.assertEqual(Runtime('X',base=True,game_lexicon=True).identity['frontend_lexicon_sha256'],'zh-lexicon')
        with self.assertRaisesRegex(self.runtime.LexiconInstalled,'restart'):Runtime('X',base=True)

if __name__=='__main__':unittest.main()
