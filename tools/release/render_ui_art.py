#!/usr/bin/env python3
"""Render app/packaging/ui-art-src/<path>.svg to app/packaging/ui-art/<path>.png at the viewBox size, make
brand/AppIcon.icns from brand/AppIcon-1024.png and write art-manifest.json (macOS: Google Chrome, iconutil, Pillow).
Usage: python3 -I tools/release/render_ui_art.py"""
import hashlib, json, re, shutil, subprocess, tempfile
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE, ART = ROOT / 'app/packaging/ui-art-src', ROOT / 'app/packaging/ui-art'
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'


def render(svg, out, tmp):
    w, h = (round(float(n)) for n in re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg.read_text()).groups())
    page, shot = tmp / 'p.html', tmp / 's.png'
    page.write_text(f'<!doctype html><style>html,body{{margin:0;background:transparent}}img{{display:block}}</style>'
                    f'<img src="{svg.as_uri()}" width="{w}" height="{h}">')
    # The window is at least 500 px a side: headless Chrome clips smaller windows' screenshots.
    subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                    '--allow-file-access-from-files', '--default-background-color=00000000',
                    f'--window-size={max(w, 500)},{max(h, 500)}', f'--screenshot={shot}', page.as_uri()],
                   check=True, capture_output=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.open(shot).convert('RGBA').crop((0, 0, w, h)).save(out, optimize=True)


def icns(png, out, tmp):
    iconset = tmp / 'AppIcon.iconset'; iconset.mkdir()
    image = Image.open(png)
    for points in (16, 32, 128, 256, 512):
        for scale, suffix in ((1, ''), (2, '@2x')):
            image.resize((points * scale,) * 2, Image.LANCZOS).save(iconset / f'icon_{points}x{points}{suffix}.png')
    subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(out)], check=True)


shutil.rmtree(ART, ignore_errors=True)
with tempfile.TemporaryDirectory() as tmp:
    for svg in sorted(SOURCE.rglob('*.svg')):
        render(svg, ART / svg.relative_to(SOURCE).with_suffix('.png'), Path(tmp))
    icns(ART / 'brand/AppIcon-1024.png', ART / 'brand/AppIcon.icns', Path(tmp))
files = [dict(file=p.relative_to(ART).as_posix(), sha256=hashlib.sha256(p.read_bytes()).hexdigest())
         for p in sorted(ART.rglob('*')) if p.is_file()]
(ART / 'art-manifest.json').write_text(json.dumps(dict(schema='endfield-ui-art/v1', files=files), indent=1) + '\n')
print(len(files), 'files in', ART)
