"""Record the exact signed single-app payload; reject links escaping the bundle and nested apps other than Electron's helpers."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess

# The helper apps of the locked Electron.app, kept under their names in Contents/Frameworks (package_app.py stage_electron_host).
ELECTRON_HELPERS=('Electron Helper','Electron Helper (GPU)','Electron Helper (Plugin)','Electron Helper (Renderer)')


def inventory(app):
    app=Path(app).resolve()
    subprocess.run(['/usr/bin/codesign','--verify','--strict','--deep',str(app)],check=True)
    files={};links={}
    for path in sorted(app.rglob('*')):
        relative=path.relative_to(app).as_posix()
        if path.is_symlink():
            if not path.resolve().is_relative_to(app):raise ValueError('external symlink: '+relative)
            links[relative]=os.readlink(path)
        elif path.is_file():files[relative]=dict(sha256=hashlib.sha256(path.read_bytes()).hexdigest(),byte_count=path.stat().st_size)
    nested={path.relative_to(app).as_posix() for path in app.rglob('*.app')}
    helpers={'Contents/Frameworks/'+name+'.app' for name in ELECTRON_HELPERS}
    if nested-helpers:raise ValueError('nested application remains: '+', '.join(sorted(nested-helpers)))
    if helpers-nested:raise ValueError('Electron helper app missing: '+', '.join(sorted(helpers-nested)))
    info=plistlib.loads((app/'Contents/Info.plist').read_bytes())
    return dict(schema='endfield-signed-bundle-inventory/v2',files=files,symlinks=links,single_app=True,
        bundle_id=info['CFBundleIdentifier'],signature_verified=True)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--app',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    args=p.parse_args();args.output.write_text(json.dumps(inventory(args.app),indent=2)+'\n')
