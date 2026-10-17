from pathlib import Path
import hashlib
import json
import os
import subprocess
import sys
import zipfile

root = Path.cwd().resolve()
source = '2608353b8258995192e0d4aa6cd4ad5c3f979a9e'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == source
assert not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], text=True)
archive = Path(sys.argv[1])
assert hashlib.sha256(archive.read_bytes()).hexdigest() == '2bab3a168977a9661c905eaeb8f00fc13fae780d92996b0509047da595d07e32'
allowed = {
    'apps/web/src/index.css',
    'apps/web/src/components/OnboardingProvidersStep.browser.tsx',
    'apps/web/src/components/ThemePackEditor.browser.tsx',
    'docs/integration/issue-driven-selection-20261016.md',
}
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    manifests = [n for n in z.namelist() if n.endswith('/candidate-manifest.json')]
    assert len(manifests) == 1
    manifest = json.loads(z.read(manifests[0]))
    assert manifest['source'] == source
    assert manifest['finalTree'] == '415299b623a549bf66ebf27363fcb9eedc065be3'
    assert len(manifest['files']) == 42
    prefix = manifests[0].rsplit('/', 1)[0] + '/files/'
    for item in manifest['files']:
        path = item['path']
        assert path.startswith('apps/server/src/persistence/') or path in allowed, path
        dest = root / path
        assert dest.resolve().is_relative_to(root) and '..' not in Path(path).parts
        if item['status'] == 'D':
            assert dest.is_file() and not dest.is_symlink()
            dest.unlink()
            continue
        data = z.read(prefix + path)
        assert len(data) == item['bytes']
        assert hashlib.sha256(data).hexdigest() == item['sha256']
        blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        assert blob == item['sha'], path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
subprocess.run(['git', 'add', 'apps/server/src/persistence', 'apps/web/src/index.css', 'apps/web/src/components/OnboardingProvidersStep.browser.tsx', 'apps/web/src/components/ThemePackEditor.browser.tsx', 'docs/integration/issue-driven-selection-20261016.md'], check=True)
assert subprocess.check_output(['git', 'write-tree'], text=True).strip() == manifest['finalTree']

path = root / 'apps/server/src/persistence/Migrations/IntegrationMigrationCompatibility.test.ts'
text = path.read_text()
assert text.count('.map(([id, name]) => [id, name])') == 3
assert text.count('      releasedIdentities,') == 1
text = text.replace('.map(([id, name]) => [id, name])', '.map(([id, name]) => [id, name] as const)')
text = text.replace('      releasedIdentities,', '      [...releasedIdentities],')
path.write_text(text)

path = root / 'apps/web/src/components/chat/ComposerModelPicker.browser.tsx'
text = path.read_text()
assert text.count('../../../.github/pr-assets/fusion-picker/') == 4
text = text.replace('../../../.github/pr-assets/fusion-picker/', '__screenshots__/fusion-picker/')
path.write_text(text)

path = root / 'apps/web/src/components/SidebarSectionToolbar.tsx'
text = path.read_text()
before = 'pointer-events-none opacity-100 transition-opacity md:opacity-0'
after = 'pointer-events-auto opacity-100 transition-opacity md:pointer-events-none md:opacity-0'
assert text.count(before) == 1
path.write_text(text.replace(before, after))
(root / 'apps/web/src/components/SidebarSectionToolbar.browser.tsx').write_bytes((Path(sys.argv[2]) / 'toolbar-pointer-regression.txt').read_bytes())
subprocess.run(['git', 'add', 'apps/web/src/components/SidebarSectionToolbar.tsx', 'apps/web/src/components/SidebarSectionToolbar.browser.tsx', 'apps/web/src/components/chat/ComposerModelPicker.browser.tsx', 'apps/server/src/persistence/Migrations/IntegrationMigrationCompatibility.test.ts'], check=True)
actual = subprocess.check_output(['git', 'write-tree'], text=True).strip()
assert actual == '8178729d899f57c937ca5524dfbb692393a2b6b2', actual
print('REVIEWED_UNFORMATTED_TREE', actual)

# Only the new test needs formatter normalization; formatting is reviewed separately.
subprocess.run(['./node_modules/.bin/oxfmt', 'apps/web/src/components/SidebarSectionToolbar.browser.tsx', 'apps/server/src/persistence/Migrations/IntegrationMigrationCompatibility.test.ts'], check=True)
subprocess.run(['git', 'add', 'apps/web/src/components/SidebarSectionToolbar.browser.tsx', 'apps/server/src/persistence/Migrations/IntegrationMigrationCompatibility.test.ts'], check=True)
final_tree = subprocess.check_output(['git', 'write-tree'], text=True).strip()
subprocess.run(['git', 'diff', '--cached', '--check'], check=True)
subprocess.run(['git', 'diff', '--exit-code'], check=True)

def get(*args):
    return subprocess.check_output(['git', *args])

out = Path(os.environ['QA_OUT'])
out.mkdir(parents=True, exist_ok=True)
(out / 'source-parent.txt').write_text(source + '\n')
(out / 'final-tree.txt').write_text(final_tree + '\n')
(out / 'review.patch').write_bytes(get('diff', '--cached', '--binary', '--full-index'))
files = []
rows = get('diff', '--cached', '--no-renames', '--name-status').decode().splitlines()
assert len(rows) == 45, len(rows)
for row in rows:
    status, path = row.split('\t')
    if status == 'D':
        files.append({'path': path, 'status': status, 'sha': None})
        continue
    data = get('show', final_tree + ':' + path)
    dest = out / 'files' / path
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    files.append({'path': path, 'status': status, 'sha': get('rev-parse', final_tree + ':' + path).decode().strip(), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
(out / 'candidate-manifest.json').write_text(json.dumps({'source': source, 'baseTree': manifest['baseTree'], 'finalTree': final_tree, 'files': files}, indent=2) + '\n')
print('FORMATTED_CANDIDATE_TREE', final_tree)
