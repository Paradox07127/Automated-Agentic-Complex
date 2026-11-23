"""build.py import_motion: the offline entry through motion_import.pipeline.import_file, its import-result.json checked like the app's result."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CHARACTERS=Path(__file__).resolve().parents[2];REPO=CHARACTERS.parent
sys.path[:0]=[str(CHARACTERS),str(Path(__file__).resolve().parent),str(REPO/'agent/agentd/tests')]
from agentic_complex_build.motion_import.take import check_result
from character_library import Library,Package,read_json
from test_bvh_import import cmu_bvh_text
from test_motion_tool import motion_fixture
from test_vmd_import import authored_rig


def build(*args):
    return subprocess.run([sys.executable,'-I','characters/build.py','import_motion',*map(str,args)],
                          cwd=REPO,capture_output=True,text=True)


class ImportMotionCliTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)

    def test_help(self):
        run=build('--help')
        self.assertEqual(run.returncode,0,run.stderr)
        self.assertIn('--source',run.stdout)

    def test_format_takes_every_format_the_pipeline_detects(self):
        run=build('--help')
        self.assertIn('{auto,vmd,bvh,gltf,vrma,fbx,zip}',run.stdout)
        run=build('--library',self.root/'none','--character','fixture','--source',self.root/'x.fbx','--output',self.root/'out',
                  '--format','fbx')
        self.assertNotIn('invalid choice',run.stderr)

    def test_bvh_import_writes_checked_results(self):
        source=self.root/'source';motion_fixture(source,rig=authored_rig())
        library=Library(self.root/'library');library.install(source)
        path=self.root/'walk.bvh';path.write_text(cmu_bvh_text());out=self.root/'out'
        run=build('--library',library.root,'--character','fixture','--source',path,'--output',out)
        self.assertEqual(run.returncode,0,run.stderr)
        results=read_json(out/'import-result.json')
        self.assertIsInstance(results,list);self.assertEqual(len(results),1)
        for result in results:check_result(result)
        result=results[0]
        self.assertEqual((result['character'],result['format'],result['action']['title']),('fixture','bvh','walk'))
        self.assertEqual(result['version'],Package(out/'packages-built/fixture').version)
        self.assertTrue(result['created_at'].endswith('+00:00'))


if __name__=='__main__':
    unittest.main()
