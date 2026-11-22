"""Checkpoint loading in tts_runtime with torch and the GPT-SoVITS imports stubbed; run: python3 -m unittest test_tts_runtime (no torch needed)."""
import importlib,os,pathlib,sys,tempfile,types,unittest
from unittest import mock
HERE=pathlib.Path(__file__).resolve().parent
sys.path[:0]=[str(HERE)]

class TtsRuntimeLoadTest(unittest.TestCase):
    def setUp(self):
        repo=pathlib.Path(self.enterContext(tempfile.TemporaryDirectory()))
        torch=types.ModuleType('torch');torch.set_num_threads=lambda n:None;torch.load=mock.Mock(return_value={'weight':{'w':1}})
        tts=types.ModuleType('TTS_infer_pack.TTS');tts.TTS=tts.TTS_Config=object
        stubs={'torch':torch,'numpy':types.ModuleType('numpy'),'soundfile':types.ModuleType('soundfile'),'yaml':types.ModuleType('yaml'),'TTS_infer_pack':types.ModuleType('TTS_infer_pack'),'TTS_infer_pack.TTS':tts}
        self.torch=torch
        self.enterContext(mock.patch.dict(sys.modules,stubs))
        self.enterContext(mock.patch.dict(os.environ,{'AAC_GPT_SOVITS':str(repo),'AAC_VOICE_ROOT':str(repo)}))
        self.enterContext(mock.patch.object(sys,'path',list(sys.path)))
        cwd=os.getcwd();self.addCleanup(os.chdir,cwd)
        sys.modules.pop('tts_runtime',None);self.addCleanup(sys.modules.pop,'tts_runtime',None)
        self.runtime=importlib.import_module('tts_runtime')

    def test_checkpoint_weights_load_without_unpickling_arbitrary_objects(self):
        self.assertEqual(self.runtime.load_weight(pathlib.Path('s1.ckpt')),{'w':1})
        self.torch.load.assert_called_once_with(pathlib.Path('s1.ckpt'),map_location='cpu',weights_only=True)

if __name__=='__main__':unittest.main()
