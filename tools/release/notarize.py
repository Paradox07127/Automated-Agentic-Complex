"""Notarize a Developer ID signed app with notarytool and staple the ticket to it."""
import json
from pathlib import Path
import subprocess
import tempfile


class NotarizationError(RuntimeError):
    pass


def notarize(app, keychain_profile, run=subprocess.run):
    """Return {'id', 'status'} of an accepted submission; raise NotarizationError otherwise."""
    app = Path(app)
    profile = ['--keychain-profile', keychain_profile]
    with tempfile.TemporaryDirectory(prefix='notarize-') as temporary:
        archive = Path(temporary) / (app.stem + '.zip')
        run(['ditto', '-c', '-k', '--keepParent', str(app), str(archive)], check=True)
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
    return dict(id=identifier, status=status)
