"""openjtalk mora groups to japanese_mfa tokens; run: python3 -m unittest test_mfa_worker (no MFA needed)."""
import pathlib,sys,unittest
HERE=pathlib.Path(__file__).resolve().parent
sys.path[:0]=[str(HERE)]
from mfa_worker import ja_groups,ja_token

class JaTokenTest(unittest.TestCase):
    def test_fragment_ending_in_a_lone_geminate_is_a_glottal_stop(self):
        # あっ！: the trailing っ has no following consonant to join.
        morae=[{'vowel':'a','cons':[],'phones':[0],'long':False},{'vowel':'cl','cons':[],'phones':[1],'long':False}]
        group=ja_groups(morae)[-1]
        self.assertEqual(group,[morae[1]])
        self.assertEqual(ja_token(group,{'ʔ','a'}),('q',[['ʔ']],[(1,0,0.,1.)]))

if __name__=='__main__':unittest.main()
