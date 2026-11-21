import hashlib
from importlib import metadata
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tools/release'))
import build_components
from harness_runtime import lock_hashes, normalized, python_pins, validate_runtime

PROBE = '''
import importlib, json, sys
from pathlib import Path
runtime = Path(sys.argv[1]).resolve()
assert sys.flags.isolated and Path(sys.prefix).resolve() == runtime
assert all(p and Path(p).resolve().is_relative_to(runtime) for p in sys.path), sys.path
names = json.loads(sys.argv[2])
for name in names:
    try:
        module = importlib.import_module(name)
        paths = [module.__file__] if getattr(module, '__file__', None) else list(module.__path__)
        assert paths and all(Path(p).resolve().is_relative_to(runtime) for p in paths), paths
    except Exception as exc:
        raise SystemExit(f'{name}: {type(exc).__name__}: {exc}')
assert all(p and Path(p).resolve().is_relative_to(runtime) for p in sys.path), sys.path
print('runtime.python imports: ' + ', '.join(names))
'''


@unittest.skipUnless((ROOT / '.git').exists(), 'finds the main checkout through git')
class RuntimePythonSmokeTests(unittest.TestCase):
    def test_standalone_imports(self):
        started = time.monotonic()
        main = Path(subprocess.check_output(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
                                           cwd=ROOT, text=True).strip()).parent
        python = main / 'agent/.venv/bin/python'
        if not python.exists():
            self.skipTest('No agent/.venv in ' + str(main))
        if not (main / '.local').is_dir():
            self.skipTest('No .local release inputs in ' + str(main))
        site = main / 'agent/.venv/lib/python3.12/site-packages'
        key = hashlib.sha256(json.dumps(lock_hashes(), sort_keys=True).encode()).hexdigest()[:16]
        prepared = main / '.local/cache/personal-agent-runtime' / key
        for path in (python, site, prepared / 'manifest.json', prepared / 'python-site'):
            self.assertTrue(path.exists(), 'Missing release input: ' + str(path))
        runtime = Path(subprocess.check_output([str(python), '-I', '-B', '-c',
            'import sys; print(sys.base_prefix)'], text=True).strip())
        self.assertTrue((runtime / 'bin/python3').is_file(), 'Missing release input: ' + str(runtime / 'bin/python3'))
        validate_runtime(prepared)
        pins = python_pins()
        distributions = {normalized(dist.metadata['Name']): dist
                         for source in (site, prepared / 'python-site')
                         for dist in metadata.distributions(path=[str(source)])}
        excluded = set(build_components.RETIRED_DISTRIBUTIONS)
        modules = set()
        # Read the selected base + locked overlay RECORDs, never the staged copy being tested.
        for name, dist in sorted(distributions.items()):
            if name in excluded: continue
            self.assertTrue(dist.files, 'Missing release input RECORD: ' + name)
            names = {p.parts[0].split('.')[0] for p in dist.files if p.suffix in ('.py', '.so')}
            names = {name for name in names if name.isidentifier()}
            self.assertTrue(names, 'No import modules in release input: ' + name)
            modules.update(names)
        with tempfile.TemporaryDirectory(prefix='runtime-python-smoke-') as temporary:
            stage = Path(temporary)
            component = build_components.stage_runtime_python(stage, python=runtime, site_packages=site,
                prepared_site=prepared / 'python-site', pins=pins)
            self.assertEqual({p.name for p in stage.iterdir()}, {'runtime.python'})
            payload = stage / component['id'] / 'payload'
            run = subprocess.run([str(payload / component['entrypoints']['python']), '-I', '-c', PROBE,
                                  str(payload), json.dumps(sorted(modules))],
                                 cwd=stage, capture_output=True, text=True, timeout=30)
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            print(run.stdout.strip())
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 60, f'runtime.python smoke took {elapsed:.2f}s')


if __name__ == '__main__': unittest.main()
