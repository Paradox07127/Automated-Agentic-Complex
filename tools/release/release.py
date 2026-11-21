"""Canonical main-based portable or split release; diagnostics are explicit."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[2]
# The canonical shell entry uses Python -I, which omits the script directory.
sys.path.insert(0,str(Path(__file__).resolve().parent))
import gate_receipt
import source_fingerprint


def git(root,*args):
    return subprocess.check_output(['git','-C',str(root),*args],text=True).strip()


PROFILE_ENV='AAC_RELEASE_PROFILE'


def default_profile(root=ROOT):
    """$AAC_RELEASE_PROFILE when set (the profile of this release in every checkout), else the local release profile
    when the checkout has one, else the public app/packaging/release.json."""
    if os.environ.get(PROFILE_ENV):return Path(os.environ[PROFILE_ENV])
    local=Path(root)/'private/release/release.json'
    return local if local.is_file() else Path(root)/'app/packaging/release.json'


# The motion and outfit importers and the live Kimodo retarget staged in the agentd component's content/.
CONTENT_SOURCES=('characters/agentic_complex_build/import_vmd.py','characters/agentic_complex_build/common.py',
    'characters/agentic_complex_build/stance.py','characters/packaging/native_bundle.py','characters/packaging/neutral_package.py','characters/packaging/package_format.py',
    'characters/agentic_complex_build/import_generated.py','characters/agentic_complex_build/secondary_fit.py',
    'characters/agentic_complex_build/keys_v2.py','characters/agentic_complex_build/live_motion.py',
    'characters/agentic_complex_build/style_retarget.py','characters/agentic_complex_build/kimodo_stand_reference.json',
    'characters/agentic_complex_build/efmi_mod.py','characters/agentic_complex_build/outfit_compose.py',
    'characters/agentic_complex_build/import_outfit.py','characters/agentic_complex_build/motion_graph.py',
    'characters/agentic_complex_build/pose_family.py',
    'characters/agentic_complex_build/motion_families.py',
    'characters/agentic_complex_build/mesh_codec.py','characters/agentic_complex_build/efmi_geometry.py',
    'characters/agentic_complex_build/mod_settings.py','characters/agentic_complex_build/texture_mips.py')
CONTENT_PACKAGES=('characters/agentic_complex_build/mmd/','characters/agentic_complex_build/motion_import/')


def shipping_path(path):
    """True for a source that goes into the release app."""
    parts=Path(path).parts
    if any(x in ('.build','.swiftpm','build','__pycache__','tests','Tests','node_modules','dist','test-results','.shots','playwright-report') for x in parts):return False
    if path in CONTENT_SOURCES or path.startswith(CONTENT_PACKAGES):return True
    if path.startswith(('app/electron/','app/helpers/mac/')):
        return parts[:3]!=source_fingerprint.ELECTRON_TESTS
    if path.startswith(('app/Resources/','app/packaging/','web/','agent/agentd/',
        'tools/release/','characters/sample-library/','protocol/ui-bridge/')):return True
    if path.startswith(source_fingerprint.RENDERER+'/'):
        return '/Sources/' in path or path.endswith('/Package.swift')
    return path in ['AGENTS.md','tools/platform/sign_bundle.sh'] or path.startswith('app/') and path.endswith('.sh') and '/' not in path[len('app/'):]


def source_state(root):
    head=git(root,'rev-parse','HEAD');main=git(root,'rev-parse','refs/heads/main')
    changed=set(git(root,'diff','--name-only','HEAD').splitlines()) | set(git(root,'ls-files','--others','--exclude-standard').splitlines())
    dirty=sorted(p for p in changed if shipping_path(p))
    return dict(head=head,main=main,shipping_sources_clean=not dirty,dirty_shipping=dirty)


def release_guard(root):
    state=source_state(root)
    if state['head']!=state['main']:raise ValueError('Release HEAD is not main. Integrate the feature branch first.')
    if state['dirty_shipping']:raise ValueError('Uncommitted shipping sources; commit and validate before release: '+', '.join(state['dirty_shipping'][:12]))
    return state


def sources_moved(before,after):
    """Main moving during a build does not count: release_guard already checked HEAD against main at the start."""
    return {k:v for k,v in before.items() if k!='main'}!={k:v for k,v in after.items() if k!='main'}


def check_no_imported_appearance(catalog):
    """Refuses a release library with a kind=imported appearance in any pack: a user's mod never ships."""
    library=catalog.parent;found=[]
    for row in json.loads(catalog.read_text()).get('characters',[]):
        definition=library/row['definition']['file'];render=json.loads(definition.read_text())['components'].get('render')
        if render is None:continue
        bundle=definition.parent/render['native_bundle']['file']
        for character in json.loads(bundle.read_text())['characters']:
            pack=json.loads((bundle.parent/character['c7']['file']).read_text())
            found+=[row['id']+'/'+a['id'] for a in pack.get('appearances',[]) if a.get('kind')=='imported']
    if found:raise ValueError('release_contains_imported_appearance: '+', '.join(found))


def build_web(root,ui):
    """Builds web into ui with the node on PATH."""
    web=root/'web'
    try:version=subprocess.check_output(['node','--version'],text=True).strip()
    except OSError:version='none'
    if not version.startswith('v') or int(version[1:].split('.')[0])<24:
        raise ValueError('web build needs node >= 24 on PATH; found '+version)
    if not (web/'node_modules').exists():
        subprocess.run(['npm','--prefix',str(web),'ci','--ignore-scripts','--prefer-offline'],check=True)
    subprocess.run([str(web/'node_modules/.bin/vite'),'build','--mode','app','--outDir',str(ui),'--emptyOutDir'],cwd=web,check=True)
    missing=[name for name in ('main.html','stack.html') if not (ui/name).is_file()]
    if missing:raise ValueError('web build lacks '+', '.join(missing))
    # The app's CSP allows fonts only from agentic-complex-ui:, so an inlined data: font would not load.
    inline=[str(p.relative_to(ui)) for p in sorted(ui.rglob('*')) if p.is_file() and b'data:font' in p.read_bytes()]
    if inline:raise ValueError('web build inlines data:font in '+', '.join(inline))
    return ui


def build_electron(root):
    """Builds app/electron's main process, preload and preview addon into its dist/."""
    electron=root/'app/electron'
    subprocess.run(['npm','--prefix',str(electron),'ci','--ignore-scripts','--prefer-offline'],check=True)
    subprocess.run(['npm','run','build'],cwd=electron,check=True)


def signing_identity(root):
    """The identity sign_bundle.sh signs with: AAC_SIGN_IDENTITY, else the first line of the main checkout's .local/signing-identity, else ad hoc."""
    if os.environ.get('AAC_SIGN_IDENTITY'):return os.environ['AAC_SIGN_IDENTITY']
    common=Path(git(root,'rev-parse','--path-format=absolute','--git-common-dir'))
    try:return (common.parent/'.local/signing-identity').read_text().splitlines()[0] or '-'
    except (OSError,IndexError):return '-'


def build_fbx_tool(root,directory):
    """Builds fbx-motion from the vendored ufbx into directory; returns its path."""
    tool=Path(directory)/'fbx-motion'
    subprocess.run(['bash',str(root/'characters/agentic_complex_build/motion_import/native/build.sh'),str(tool)],check=True)
    return tool


def build(args,root=ROOT):
    from harness_runtime import lock_hashes, prepare, validate_runtime
    import local_paths
    profile_path=getattr(args,'profile',None) or default_profile(root)
    profile_bytes=profile_path.read_bytes();profile=json.loads(profile_bytes)
    if profile['schema']!='endfield-release-config/v1':raise ValueError('Unsupported release profile')
    if profile.get('notary_keychain_profile') and not signing_identity(root).startswith('Developer ID Application:'):
        raise ValueError('Notarization requires a Developer ID Application: identity. Set AAC_SIGN_IDENTITY to the full certificate name.')
    # A profile's ui_art names the art directory; null or absent ships without game UI art and without an app icon.
    art=None if profile.get('ui_art') is None else root/profile['ui_art']
    if art is not None and not (art/'art-manifest.json').is_file():raise ValueError('UI art missing: '+str(art)+'. Build it with the local tool build_ui_art.py (not in the public repository).')
    if art is not None and not (art/'brand/AppIcon.icns').is_file():raise ValueError('App icon missing: '+str(art/'brand/AppIcon.icns')+'. Build it with the local tool build_ui_art.py (not in the public repository).')
    # A profile's photo_looks names the filter directory; null or absent ships without photo-mode filters.
    looks=None if profile.get('photo_looks') is None else root/profile['photo_looks']
    if looks is not None and not (looks/'looks.json').is_file():raise ValueError('Photo looks missing: '+str(looks)+'. Build them with the local tool build_photo_looks.py (not in the public repository).')
    # {path in a component's staged content: repo-relative source} copied over the staged content before signing.
    overrides=[x for relative,source in profile.get('content_overrides',{}).items() for x in ('--content-override',relative+'='+str(root/source))]
    state=release_guard(root)
    files,fingerprint=source_fingerprint.compute(root)
    if files.get(source_fingerprint.PROFILE_KEY)!=hashlib.sha256(profile_bytes).hexdigest():
        raise ValueError('Release profile differs from the fingerprinted profile; set '+PROFILE_ENV+'='+str(profile_path))
    gate=gate_error=None
    try:gate=gate_receipt.require(root,fingerprint,getattr(args,'gate_receipt',None))
    except ValueError as e:
        if not args.check:raise
        gate_error=str(e)
    gated=dict(source_fingerprint=fingerprint,gate_receipt=str(gate[0]) if gate else None,
        gate_profile=gate[1]['profile'] if gate else None,gate_result=gate[1]['result'] if gate else None)
    # A profile's character_catalog null ships an empty library; characters are imported later.
    catalog=args.library.resolve()/'current.json' if args.library else None if profile.get('character_catalog') is None else root/profile['character_catalog']
    if catalog is not None and not catalog.is_file():raise ValueError('Private release character library missing: '+str(catalog))
    sha=None if catalog is None else hashlib.sha256(catalog.read_bytes()).hexdigest()
    if catalog is not None and not args.library and sha!=profile['catalog_sha256']:raise ValueError('Default release catalog SHA differs from the pinned profile')
    if catalog is not None:local_paths.require_none(catalog.parent)
    if catalog is not None:check_no_imported_appearance(catalog)
    stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    base=root/profile['output_root'];output=args.output or base/(stamp+'-'+state['head'][:8])
    if output.exists():raise ValueError('Release output already exists')
    layout=getattr(args,'layout','portable')
    runtime_key=hashlib.sha256(json.dumps(lock_hashes(root),sort_keys=True).encode()).hexdigest()[:16]
    harness=getattr(args,'harness_runtime',None) or root/'.local/cache/personal-agent-runtime'/runtime_key
    if args.check:
        ready=harness.exists()
        if ready:validate_runtime(harness,root)
        print(json.dumps(dict(checked=True,**state,layout=layout,catalog=catalog and str(catalog),catalog_sha256=sha,output=str(output),
            personal_agent_runtime=str(harness),personal_agent_runtime_prepared=ready,
            **(dict(source_fingerprint=fingerprint,gate_receipt_error=gate_error) if gate_error else gated))))
        return int(gate_error is not None)
    # Removed when build() returns or raises.
    web=tempfile.TemporaryDirectory(prefix='endfield-web-')
    ui=build_web(root,Path(web.name)/'ui')
    python=Path(subprocess.check_output(['bash',str(root/'tools/platform/agentd-python.sh')],text=True).strip())
    # An empty directory is a library without characters to package_app.py.
    library=Path(web.name)/'library' if catalog is None else catalog.parent
    if catalog is None:library.mkdir()
    runtime=args.python_runtime or Path(subprocess.check_output([str(python),'-I','-c','import sys;print(sys.base_prefix)'],text=True).strip())
    site=args.site_packages or Path(subprocess.check_output([str(python),'-I','-c','import sysconfig;print(sysconfig.get_path("purelib"))'],text=True).strip())
    if getattr(args,'harness_runtime',None):validate_runtime(harness,root,execute=True)
    else:prepare(harness,python,root)
    helper=root/'app/helpers/mac'
    # A public checkout has no renderer: its app runs text-only characters.
    renderer=root/source_fingerprint.RENDERER/'host'
    for package in [helper]+([renderer] if renderer.is_dir() else []):
        subprocess.run(['swift','build','-c','release','--package-path',str(package)],check=True)
    tools=tempfile.TemporaryDirectory(prefix='endfield-fbx-')
    fbx_tool=build_fbx_tool(root,tools.name)
    def binary_path(package):return Path(subprocess.check_output(['swift','build','-c','release','--package-path',str(package),'--show-bin-path'],text=True).strip())
    import electron_runtime
    electron_app,electron=electron_runtime.prepare(root/'.local/cache/electron-runtime',root)
    build_electron(root)
    shell=['--electron-app',str(electron_app),'--electron-dir',str(root/'app/electron'),
        '--helper',str(binary_path(helper)/'ac-helper'),
        *(['--product-name',profile['product_name']] if profile.get('product_name') else []),
        *(['--app-version',profile['app_version']] if profile.get('app_version') else [])]
    command=[str(python),'-I',str(root/'tools/release/package_app.py'),
        '--library',str(library),'--output',str(output),*shell,
        *(['--host',str(binary_path(renderer)/'metal-avatar-host')] if renderer.is_dir() else []),
        '--python',str(runtime),'--site-packages',str(site),'--harness-runtime',str(harness),'--web-dist',str(ui),'--fbx-tool',str(fbx_tool),*(['--ui-art',str(art)] if art else []),*(['--photo-looks',str(looks)] if looks else []),*overrides,'--layout',layout,
        '--build-version',args.build_version or datetime.datetime.now().strftime('%Y%m%d.%H%M%S')]
    if args.port is not None:command+=['--port',str(args.port)]
    subprocess.run(command,check=True)
    if json.loads((output/'source-manifest.json').read_text())['fingerprint']!=fingerprint:raise ValueError('Packaged sources differ from the gated source fingerprint '+fingerprint)
    staged=json.loads((output/'staging-manifest.json').read_text());app=output/staged['app']
    subprocess.run(['bash',str(root/'tools/platform/sign_bundle.sh'),str(app)],check=True)
    # Only a Developer ID signature can be notarized; the ticket is stapled before the inventory and the smoke.
    notarization=None
    if profile.get('notary_keychain_profile'):
        import notarize
        try:notarization=notarize.notarize(app,profile['notary_keychain_profile'])
        except notarize.NotarizationError as e:raise ValueError(str(e)) from e
    subprocess.run([str(python),'-I',str(root/'tools/release/inventory_app.py'),'--app',str(app),'--output',str(output/'bundle-manifest.json')],check=True)
    smoke_path=output/'artifact-smoke.json'
    subprocess.run([str(python),'-I',str(root/'tools/qa/artifact_smoke.py'),'--app',str(app),'--fingerprint',fingerprint,'--output',str(smoke_path)])
    smoke=json.loads(smoke_path.read_text()) if smoke_path.is_file() else {}
    if smoke.get('result')!='PASS':raise ValueError('Artifact smoke failed: '+str(smoke.get('error') or 'no result in '+str(smoke_path)))
    if gate:shutil.copyfile(gate[0],output/gate_receipt.LATEST)
    if sources_moved(state,source_state(root)):raise ValueError('Sources changed while building')
    (output/'release-receipt.json').write_text(json.dumps(dict(schema='endfield-canonical-release/v1',**state,
        layout=layout,catalog_sha256=sha,app=app.name,distribution=layout,
        electron_runtime={k:v for k,v in electron.items() if k!='files'},electron_fuses=staged['electron_fuses'],notarization=notarization,
        host=staged['host'],components=staged['components'],**gated,artifact_smoke=smoke),indent=2)+'\n')
    print(json.dumps(dict(release_ready=True,app=str(app),**state)))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['library','output','python-runtime','site-packages','harness-runtime']:p.add_argument('--'+name,type=Path)
    p.add_argument('--profile',type=Path,help='Release config; default: the local profile when present, else app/packaging/release.json')
    p.add_argument('--print-profile',action='store_true',help='Print the path of the profile in use and exit')
    p.add_argument('--port',type=int)
    p.add_argument('--layout',choices=['portable','split'],default='portable')
    p.add_argument('--build-version');p.add_argument('--check',action='store_true')
    p.add_argument('--gate-receipt',type=Path,help='Gate receipt to release on; default: the newest valid one in .local/gate-receipts')
    args=p.parse_args()
    if args.print_profile:print(args.profile.resolve() if args.profile else default_profile());raise SystemExit(0)
    try:sys.exit(build(args))
    except (ValueError,OSError,subprocess.CalledProcessError) as e:print('release: '+str(e),file=sys.stderr);raise SystemExit(2)
