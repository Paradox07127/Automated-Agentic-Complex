"""Notarize a Developer ID signed app with notarytool and staple the ticket to it."""
import json
from pathlib import Path
import subprocess
import tempfile


class NotarizationError(RuntimeError):
    pass


def notarize(app, keychain_profile, run=subprocess.run):
    """Submit the app in one archive, with the components/ a split layout puts beside it; return {'id', 'status', 'covers'}
    of an accepted submission, covers the names the archive holds, or raise NotarizationError. Only the app is stapled."""
    app = Path(app)
    profile = ['--keychain-profile', keychain_profile]
    # The split layout's external components are loose executables and dylibs: the ticket covers them only if submitted.
    submitted = app.parent if (app.parent / 'components').is_dir() else app
    covers = sorted(path.name for path in submitted.iterdir()) if submitted != app else [app.name]
    with tempfile.TemporaryDirectory(prefix='notarize-') as temporary:
        archive = Path(temporary) / (app.stem + '.zip')
        run(['ditto', '-c', '-k', '--keepParent', str(submitted), str(archive)], check=True)
        submitted = run(['xcrun', 'notarytool', 'submit', str(archive), *profile, '--wait', '--output-format', 'json'],
                        capture_output=True, text=True)
    try:
        submission = json.loads(submitted.stdout)
        identifier, status = submission['id'], submission['status']
    except (ValueError, TypeError, KeyError):
        raise NotarizationError(f'notarytool submit failed ({submitted.returncode}): '
                                f'{submitted.stderr.strip() or submitted.stdout.strip()}') from None
    if status != 'Accepted':
        log = run(['xcrun', 'notarytool', 'log', identifier, *profile], capture_output=True, text=True)
        raise NotarizationError(f'notarization {status}: submission {identifier}\n{log.stdout.strip() or log.stderr.strip()}')
    run(['xcrun', 'stapler', 'staple', str(app)], check=True)
    run(['xcrun', 'stapler', 'validate', str(app)], check=True)
    return dict(id=identifier, status=status, covers=covers)
