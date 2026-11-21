import json
from pathlib import Path
import sys
import unittest

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'tools/release'))
from release import default_profile
ENVELOPES='renderer/Resources/window-envelopes.json'


class WindowEnvelopeTests(unittest.TestCase):
    def setUp(self):
        self.profile=json.loads(default_profile(ROOT).read_text())
        source=self.profile.get('content_overrides',{}).get(ENVELOPES)
        if source is None:self.skipTest('the release profile ships no window envelopes')
        self.envelopes=json.loads((ROOT/source).read_text())

    def test_envelopes_were_measured_on_the_pinned_release_catalog(self):
        self.assertEqual(self.envelopes['schema'],'endfield-window-envelopes/v1')
        self.assertEqual(self.envelopes['library_sha256'],self.profile['catalog_sha256'])

    def test_every_release_character_has_an_envelope_for_its_package_version(self):
        catalog=ROOT/self.profile['character_catalog']
        if not catalog.is_file():self.skipTest('release catalog is not on this machine: '+str(catalog))
        snapshot=json.loads(catalog.read_text())
        definitions={e['id']:json.loads((catalog.parent/e['definition']['file']).read_text()) for e in snapshot['characters']}
        # A character without a render component (a text-only one) draws no window, so it has no envelope.
        versions={cid:d['version'] for cid,d in definitions.items() if 'render' in d['components']}
        self.assertEqual({k:v['package_version'] for k,v in self.envelopes['characters'].items()},versions)
        for cid,row in self.envelopes['characters'].items():
            self.assertTrue(row['clips']>0 and set(row['extents_pt'])=={'left','right','top','bottom'},cid)


if __name__=='__main__':
    unittest.main()
