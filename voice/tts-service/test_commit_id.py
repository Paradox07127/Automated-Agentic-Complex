"""Tests for serve_tts.gpt_sovits_commit; run: python3 -m unittest test_commit_id (no fastapi or torch needed)."""
import ast,pathlib,subprocess,tempfile,unittest
HERE=pathlib.Path(__file__).resolve().parent

def load():
    """Only that function: importing serve_tts needs fastapi, torch and the ws checkout."""
    tree=ast.parse((HERE/'serve_tts.py').read_text())
    node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='gpt_sovits_commit')
    namespace={'subprocess':subprocess}
    exec(compile(ast.Module([node],[]),'serve_tts.py','exec'),namespace)
    return namespace['gpt_sovits_commit']

def git(directory,*args):
    return subprocess.run(['git','-C',directory,*args],check=True,capture_output=True,text=True).stdout.strip()

class CommitIdTest(unittest.TestCase):
    def test_a_checkout_gives_its_eight_digit_short_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            git(directory,'init','-q')
            git(directory,'-c','user.name=t','-c','user.email=t@example.invalid','commit','-q','--allow-empty','-m','x')
            commit=load()(pathlib.Path(directory))
            self.assertEqual(len(commit),8)
            self.assertEqual(commit,git(directory,'rev-parse','HEAD')[:8])
    def test_no_git_directory_is_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(load()(pathlib.Path(directory)),'unknown')
            self.assertEqual(load()(pathlib.Path(directory)/'missing'),'unknown')

if __name__=='__main__':unittest.main()
