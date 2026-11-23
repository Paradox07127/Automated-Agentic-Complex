#!/usr/bin/env python3
"""Smoke check of a signed release app (release.py runs it after signing).

Usage: artifact_smoke.py --app <Agentic Complex.app> --fingerprint <F> [--port N] [--output <json>]
Verifies the signature and Info.plist AgenticComplexBuildFingerprint, that the component python imports numpy and the staged VMD
importer and that agentd's fbx-motion answers --version, then launches the app under the gpu lock with an explicit config on a temp support dir
and --no-push-to-talk --no-attention. Passes when agentd runs from the resolved component, the avatar says hello when the default character
has a renderer, /health is ok and nothing of the run is left after SIGTERM. Prints the result JSON; exits 1 on FAIL. The temporary
directory is kept on FAIL for its logs.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tools/release'))
import component_manifest

GPU_LOCK = REPO / 'tools/platform/gpu-lock.sh'
PORT = 48811
# Companion's own agentd port; the smoke must never take it.
FORBIDDEN_PORT = 48800
# The Electron shell's arguments for a run that takes no hot key, microphone or window title of the user's.
ELECTRON_ARGUMENTS = ['--no-push-to-talk', '--no-attention']
# Import roots as the VMD import helper sets them: payload/, payload/content, payload/agentd.
CONTENT_PROBE = 'import sys; sys.path[:0] = sys.argv[1:4]; import numpy, content.import_vmd'


class SmokeFailure(Exception):
    pass


def codesign_verify(app):
    """None when the bundle verifies, else codesign's message."""
    run = subprocess.run(['codesign', '--verify', '--strict', '--deep', str(app)], capture_output=True, text=True)
    return None if run.returncode == 0 else (run.stderr.strip() or 'exit %d' % run.returncode)


def plist_fingerprint(app):
    return plistlib.loads((app / 'Contents/Info.plist').read_bytes()).get('AgenticComplexBuildFingerprint')


def content_import_error(config):
    """None when the component python imports numpy and the staged VMD importer, else the reason."""
    agentd = Path(config['agentd_dir'])
    run = subprocess.run([config['python'], '-c', CONTENT_PROBE, str(agentd.parent), str(agentd.parent / 'content'),
        str(agentd)], capture_output=True, text=True, timeout=120)
    if run.returncode == 0: return None
    lines = run.stderr.strip().splitlines()
    return 'bundled python cannot import numpy and content.import_vmd: ' + (lines[-1] if lines else 'exit %d' % run.returncode)


def fbx_tool_error(config):
    """None when the agentd component's fbx-motion answers --version, else the reason."""
    tool = Path(config['agentd_dir']).parent / 'tools/fbx-motion'
    try: run = subprocess.run([str(tool), '--version'], capture_output=True, text=True, timeout=30)
    except OSError as e: return 'fbx-motion --version: ' + str(e)
    if run.returncode == 0: return None
    lines = run.stderr.strip().splitlines()
    return 'fbx-motion --version: ' + (lines[-1] if lines else 'exit %d' % run.returncode)


def build_config(app, support, port=PORT):
    """Config for `--config`: managed paths from the components, the fresh-install defaults of
    PackagedDistribution.prepare, and all user state under support."""
    contents = app / 'Contents'
    resources = contents / 'Resources'
    manifest = json.loads((resources / 'distribution.json').read_text())
    if manifest['schema'] != 'endfield-distribution/v3':
        raise SmokeFailure('distribution.json must use endfield-distribution/v3')
    if manifest['layout'] == 'portable':
        lock = json.loads((resources / 'composition.lock.json').read_text())
        references = [lock['host'], *lock['components']]
        directories = {ref['id']: resources / 'components' / ref['id'] for ref in references}
    elif manifest['layout'] == 'split':
        external = app.parent / 'components'
        signed = (resources / 'components-index.json').read_bytes()
        if (external / 'index.json').read_bytes() != signed: raise SmokeFailure('external component index mismatch')
        references = json.loads(signed)['components']
        directories = {path.name: path for path in (resources / 'components').iterdir() if path.is_dir()}
        for ref in references:
            destination = support / 'components' / ref['id'] / (ref['version'] + '-' + ref['tree_sha256'][:8])
            shutil.copytree(external / ref['dir'], destination, symlinks=True)
            if hashlib.sha256((destination / 'component.json').read_bytes()).hexdigest() != ref['manifest_sha256']:
                raise SmokeFailure('component manifest mismatch: ' + ref['id'])
            directories[ref['id']] = destination
    else:
        raise SmokeFailure('distribution.json layout must be portable or split')
    components = {id: json.loads((directory / 'component.json').read_text()) for id, directory in directories.items()}
    payloads = {id: directory / 'payload' for id, directory in directories.items()}
    if manifest['layout'] == 'split':
        for ref in references:
            id = ref['id']
            if any(payloads[id].rglob('__pycache__')): raise SmokeFailure('unsealed bytecode cache: ' + id)
            digest = component_manifest.tree_sha256(payloads[id])
            if digest != ref['tree_sha256'] or digest != components[id]['tree_sha256']:
                raise SmokeFailure('component %s tree_sha256 mismatch: copied %s, index %s, manifest %s' % (
                    id, digest, ref['tree_sha256'], components[id]['tree_sha256']))
    python = payloads['runtime.python'] / components['runtime.python']['entrypoints']['python']
    agentd = payloads['agentd'] / 'agentd'
    library = support / 'characters'
    command = [str(python), str(agentd / 'character_tool.py'), 'compose']
    for id in sorted(payloads):
        if id.startswith('characters.'): command.extend(['--package', str(payloads[id])])
    if manifest['defaultCharacter'] is not None: command.extend(['--default', manifest['defaultCharacter']])
    command.extend(['--output', str(library)])
    run = subprocess.run(command, capture_output=True, text=True)
    if run.returncode:
        raise SmokeFailure('character compose failed: ' + (run.stderr.strip() or 'exit %d' % run.returncode))
    catalog = library / 'current.json'
    digest = hashlib.sha256(catalog.read_bytes()).hexdigest()
    if digest != manifest['catalogSHA256']:
        raise SmokeFailure('composed catalog SHA256 %s is not catalogSHA256 %s' % (digest, manifest['catalogSHA256']))
    return dict(avatar_app=str(app), avatar_executable=str(contents / 'MacOS/AgenticComplexMetalAvatar'),
        agentd_dir=str(agentd), python=str(python),
        agentd_launcher=str(payloads['agentd'] / components['agentd']['entrypoints']['launcher']),
        harness_sites={id: str(payloads[id]) for id in ('harness.pi',) if id in payloads},
        character_catalog=str(catalog), agentd_port=port,
        support_dir=str(support), agentd_state_dir=str(support / 'agentd'),
        gpu_hold_files=[], characters=[], voice_hotkey='', hotkey_quick_input='', hotkey_look='',
        hotkey_toggle_avatar='', hotkey_click_through='', hotkey_radial_menu='', hotkey_selection='', viewport='fullscreen',
        plugins=dict(screen_awareness=False, computer_use=False), sense_input_counts=False,
        share_page_text=False, share_window_text=False, share_typed_text=False, share_screenshots=False,
        proactive_speech=False, mute=True,
        system_notifications=False)


def launch(app, config, label, output):
    """Starts the app's executable under `AAC_LOCK=gpu gpu-lock.sh release-smoke:<label>` with config and ELECTRON_ARGUMENTS."""
    executable = app / 'Contents/MacOS' / plistlib.loads((app / 'Contents/Info.plist').read_bytes())['CFBundleExecutable']
    with open(output, 'ab') as out:
        return subprocess.Popen(['bash', str(GPU_LOCK), 'release-smoke:' + label, str(executable), '--config', str(config)]
            + ELECTRON_ARGUMENTS, env=dict(os.environ, AAC_LOCK='gpu'),
            stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT)


def wait_log(log, pattern, seconds, proc=None):
    """The first match of pattern in log within seconds; None on timeout or once proc has exited."""
    deadline = time.monotonic() + seconds
    while True:
        match = re.search(pattern, log.read_text(errors='replace')) if log.is_file() else None
        if match or time.monotonic() >= deadline: return match
        if proc is not None and proc.poll() is not None:
            return re.search(pattern, log.read_text(errors='replace')) if log.is_file() else None
        time.sleep(0.2)


def health_ok(port):
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d/health' % port, timeout=5) as response:
            return json.loads(response.read()).get('status') == 'ok'
    except (OSError, ValueError):
        return False


def processes(support):
    """`pid command line` naming the support dir."""
    pattern = ''.join(c if c.isalnum() or c in '/_-' else '[' + c + ']' for c in str(support))
    run = subprocess.run(['pgrep', '-fl', pattern], capture_output=True, text=True)
    return sorted(set(run.stdout.splitlines()))


def agentd_from_bundle(lines, agentd_dir):
    """None when agentd's command lines all name the resolved agentd directory, else the reason."""
    agentd = [line for line in lines if '--state-dir' in line]
    if not agentd: return 'no agentd process names the temp support dir'
    inside = str(agentd_dir)
    outside = [line for line in agentd if inside not in line]
    return 'agentd does not run from %s: %s' % (inside, outside[0]) if outside else None


def default_has_renderer(catalog, character):
    if character is None: return False
    catalog = Path(catalog)
    row = next(row for row in json.loads(catalog.read_text())['characters'] if row['id'] == character)
    return 'render' in json.loads((catalog.parent / row['definition']['file']).read_text())['components']


def window_envelope_error(log, character):
    """None when the started character uses bundled window envelopes, else the reason."""
    lines = log.read_text(errors='replace').splitlines() if log.is_file() else []
    lines = [line for line in lines if 'AAC_WINDOW ' in line
        and re.search(r'\bcharacter=' + re.escape(character) + r'(?:\s|$)', line)]
    if not lines: return 'avatar.log has no AAC_WINDOW line for character=' + character
    for line in lines:
        if not re.search(r'AAC_WINDOW envelope=bundle(?:\s|$)', line):
            return 'avatar.log needs AAC_WINDOW envelope=bundle for character=%s: %s' % (character, line)
    return None


def quit_and_reap(pid, proc, support, seconds):
    """SIGTERMs Companion, waits up to seconds for every process of the run to end, SIGKILLs the rest and returns them."""
    if pid is not None:
        try: os.kill(pid, signal.SIGTERM)
        except ProcessLookupError: pass
    elif proc is not None and proc.poll() is None:
        proc.terminate()
    deadline = time.monotonic() + seconds
    while True:
        if proc is not None: proc.poll()
        left = processes(support)
        if not left or time.monotonic() >= deadline: break
        time.sleep(0.2)
    for line in left:
        try: os.kill(int(line.split()[0]), signal.SIGKILL)
        except (ProcessLookupError, ValueError): pass
    if proc is not None:
        try: proc.wait(5)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()
    return left


def smoke(app, fingerprint, port=PORT, label=None, status_s=90, hello_s=180, quit_s=12, start_s=900):
    """Runs the check; start_s bounds the wait for the gpu lock and the STARTED line, the others count from STARTED."""
    if port == FORBIDDEN_PORT: raise ValueError('artifact smoke must not use Companion port %d' % FORBIDDEN_PORT)
    app = Path(os.path.realpath(app))
    result = dict(schema='endfield-artifact-smoke/v1', app=str(app), fingerprint=fingerprint, port=port,
        result='FAIL', error=None, leftover=[], support_dir=None, layout=None)
    try:
        error = codesign_verify(app)
        if error: raise SmokeFailure('codesign --verify --strict --deep: ' + error)
        found = plist_fingerprint(app)
        if found != fingerprint: raise SmokeFailure('Info.plist AgenticComplexBuildFingerprint %s is not %s' % (found, fingerprint))
        manifest = json.loads((app / 'Contents/Resources/distribution.json').read_text())
        result['layout'] = manifest['layout']
        support = Path(os.path.realpath(tempfile.mkdtemp(prefix='endfield-smoke-')))
        result['support_dir'] = str(support)
        settings = build_config(app, support, port)
        has_renderer = default_has_renderer(settings['character_catalog'], manifest['defaultCharacter'])
        error = content_import_error(settings) or fbx_tool_error(settings)
        if error: raise SmokeFailure(error)
        config = support / 'config.json'
        config.write_text(json.dumps(settings, indent=2) + '\n')
        log = support / 'logs/companion.log'
        proc, pid = None, None
        try:
            proc = launch(app, config, label or app.parent.name, support / 'launch.log')
            started = wait_log(log, r'STARTED pid=(\d+)', start_s, proc)
            if not started: raise SmokeFailure('Companion wrote no STARTED line within %d s' % start_s)
            pid, t0 = int(started.group(1)), time.monotonic()
            ready = wait_log(log, r'STATUS agentd=running|ERROR config[^\n]*', status_s, proc)
            if ready and ready.group().startswith('ERROR config'): raise SmokeFailure('companion.log: ' + ready.group())
            if not ready: raise SmokeFailure('no STATUS agentd=running within %d s' % status_s)
            hello = wait_log(log, r'HOSTLINK hello character=(\S+)', max(0, t0 + hello_s - time.monotonic()), proc) if has_renderer else None
            errors = [line for line in log.read_text(errors='replace').splitlines() if 'ERROR config' in line or 'dev_resources' in line]
            if errors: raise SmokeFailure('companion.log: ' + errors[0])
            if has_renderer and not hello: raise SmokeFailure('no HOSTLINK hello character= within %d s' % hello_s)
            if not health_ok(settings['agentd_port']): raise SmokeFailure('GET /health on port %d is not status ok' % settings['agentd_port'])
            error = agentd_from_bundle(processes(support), settings['agentd_dir'])
            if error: raise SmokeFailure(error)
            if has_renderer:
                error = window_envelope_error(support / 'logs/avatar.log', hello.group(1))
                if error: raise SmokeFailure(error)
            result['result'] = 'PASS'
        except (SmokeFailure, OSError, ValueError, KeyError) as e:
            result['result'], result['error'] = 'FAIL', str(e)
        finally:
            result['leftover'] = quit_and_reap(pid, proc, support, quit_s)
        if result['leftover']:
            message = '%d process(es) still running %d s after SIGTERM' % (len(result['leftover']), quit_s)
            result['result'], result['error'] = 'FAIL', '; '.join(filter(None, [result['error'], message]))
    except SmokeFailure as e:
        result['result'], result['error'] = 'FAIL', str(e)
    if result['result'] == 'PASS':
        shutil.rmtree(result['support_dir'], ignore_errors=True)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--fingerprint', required=True, help='Source fingerprint the app must carry')
    parser.add_argument('--port', type=int, default=PORT)
    parser.add_argument('--output', type=Path, help='Also write the result JSON here')
    args = parser.parse_args(argv)
    try: result = smoke(args.app, args.fingerprint, port=args.port)
    except ValueError as e: parser.error(str(e))
    text = json.dumps(result, indent=2) + '\n'
    if args.output: args.output.write_text(text)
    print(text, end='')
    return 0 if result['result'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
