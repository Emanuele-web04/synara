from pathlib import Path
import re, shutil, subprocess

r = Path.cwd().resolve()
assert (r / '.git').exists()
base_tree = subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], text=True).strip()
assert base_tree == '4945ae38d1efa3fa387a51a00d276146132ed223', base_tree
subprocess.run(['git', 'diff', '--exit-code'], check=True)
subprocess.run(['git', 'diff', '--cached', '--exit-code'], check=True)
m = r / 'apps/server/src/persistence/Migrations'
driver = Path(__file__).resolve().parent
old = [(135, 'ExternalMcpOptionalConcurrency'), (136, 'ExternalMcpTaskFollowups'), (137, 'ExternalAgentProfiles'), (138, 'CapabilityEvidence'), (139, 'ExternalAgentLifecycle'), (140, 'CapabilityEvidenceWithdrawal'), (141, 'ExternalAgentRevisionMembership'), (142, 'ThreadTitleRefresh')]
released_ref = 'd4f4d4b6002d57acf7a76c24c576eacb04fd1e1e'
canonical = [(135, 'ProjectionMessageTurnActivityIndex'), (136, 'AccountUsageSync'), (137, 'AccountUsageSyncIdentity'), (138, 'RemoteDeviceTrust'), (139, 'RemoteConnectionPreferences'), (140, 'RemoteAccessControls')]
# Relocate only these eight unshipped modules. Their SQL bytes are unchanged.
for n, name in old:
    for suffix in ('.ts', '.test.ts'):
        p = m / f'{n}_{name}{suffix}'
        if not p.exists():
            continue
        dest = m / f'{n + 6}_{name}{suffix}'
        assert not dest.exists()
        if suffix == '.test.ts':
            s = p.read_text()
            for oid, oname in old:
                s = s.replace(f'{oid}_{oname}', f'{oid + 6}_{oname}')
            s = re.sub(r'\b(134|135|136|137|138|139|140|141|142)\b', lambda x: str(int(x[0]) + 6), s)
            dest.write_text(s)
            p.unlink()
        else:
            p.rename(dest)
for n, name in canonical:
    path = f'apps/server/src/persistence/Migrations/{n}_{name}.ts'
    (r / path).write_bytes(subprocess.check_output(['git', 'show', released_ref + ':' + path]))
registry = r / 'apps/server/src/persistence/Migrations.ts'
s = registry.read_text()
start = s.index('import Migration0135 ')
end = s.index('\n', s.index('import Migration0142 ')) + 1
imports = ''.join(f'import Migration{n:04d} from "./Migrations/{n}_{name}.ts";\n' for n, name in canonical + [(n + 6, name) for n, name in old])
s = s[:start] + imports + s[end:]
start = s.index('  [135, "ExternalMcpOptionalConcurrency"')
end = s.index('\n', s.index('  [142, "ThreadTitleRefresh"')) + 1
entries = ''.join(f'  [{n}, "{name}", Migration{n:04d}],\n' for n, name in canonical + [(n + 6, name) for n, name in old])
s = s[:start] + entries + s[end:]
registry.write_text(s)
test = r / 'apps/server/src/persistence/Migrations.test.ts'
s = test.read_text()
for n, name in old:
    s = s.replace(f'[{n}, "{name}"]', f'[{n + 6}, "{name}"]')
s, count = re.subn(r'^(\s*)\[141, "ExternalMcpOptionalConcurrency"\],', lambda x: ''.join(f'{x[1]}[{n}, "{name}"],\n' for n, name in canonical) + x[0], s, flags=re.M)
assert count == 6, count
test.write_text(s)
p = m / '099_InvalidateProjectionThreadsCursor.test.ts'
s = p.read_text()
for n, name in old:
    s = s.replace(f'{n}_{name}', f'{n + 6}_{name}')
p.write_text(s)

p = r / 'apps/web/src/index.css'
s = p.read_text()
for selector in ['.chat-markdown p:has(> strong:first-child) > strong:first-child {', '.chat-markdown li:has(> strong:first-child) > strong:first-child {']:
    before = selector + '\n  color: var(--chat-text-strong);'
    after = selector + '\n  color: var(--chat-bold-color, var(--chat-text-strong));'
    assert s.count(before) == 1
    s = s.replace(before, after)
p.write_text(s)
p = r / 'apps/web/src/components/OnboardingProvidersStep.browser.tsx'
s = p.read_text()
assert s.count('1 connected · 0 need sign-in · 9 not installed') == 2
s = s.replace('1 connected · 0 need sign-in · 9 not installed', '1 connected · 0 need sign-in · 10 not installed')
s = s.replace('  await renderStep();', '  await renderStep();\n  await expect.element(page.getByText("Cline", { exact: true })).toBeVisible();')
p.write_text(s)
p = r / 'apps/web/src/components/ThemePackEditor.browser.tsx'
s = p.read_text()
anchor = 'function textColor(selector: string): string {'
helper = '''function resolvedColor(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.append(probe);
  try {
    return getComputedStyle(probe).color;
  } finally {
    probe.remove();
  }
}

function defaultStrongColor(): string {
  // The integrated primary typography deliberately distinguishes 98% strong
  // text from body text. Resolve CSS rather than assume an RGB serialization.
  return resolvedColor("color-mix(in srgb, rgb(13, 13, 13) 98%, transparent)");
}

'''
assert s.count(anchor) == 1
s = s.replace(anchor, helper + anchor)
s = s.replace('  const regular = textColor("#chat-color-test p");', '  const regular = textColor("#chat-color-test p");\n  const strong = defaultStrongColor();')
s = s.replace('expect(textColor("#chat-color-test h2")).toBe(regular);', 'expect(textColor("#chat-color-test h2")).toBe(strong);')
s = s.replace('expect(textColor("#chat-color-test strong")).toBe(regular);', 'expect(textColor("#chat-color-test strong")).toBe(strong);')
s = s.replace('textColor("#chat-color-test h2 strong")).toBe(regular)', 'textColor("#chat-color-test h2 strong")).toBe(strong)')
s = s.replace('textColor("#chat-color-test p strong")).toBe(regular)', 'textColor("#chat-color-test p strong")).toBe(strong)')
s = s.replace('expect(getComputedStyle(preview.element().querySelector("h3")!).color).toBe("rgb(13, 13, 13)");', 'expect(getComputedStyle(preview.element().querySelector("h3")!).color).toBe(defaultStrongColor());')
s = s.replace('    "rgb(13, 13, 13)",', '    defaultStrongColor(),')
s += (driver / 'theme-lead-tests.txt').read_text()
p.write_text(s)
shutil.copyfile(driver / 'migration-compatibility.test.txt', m / 'IntegrationMigrationCompatibility.test.ts')
subprocess.run(['git', 'add', 'apps/server/src/persistence', 'apps/web/src/index.css', 'apps/web/src/components/OnboardingProvidersStep.browser.tsx', 'apps/web/src/components/ThemePackEditor.browser.tsx'], check=True)
tree = subprocess.check_output(['git', 'write-tree'], text=True).strip()
print('CANDIDATE_TREE', tree)
assert tree == '3e89bf1cf3af6c6c0e7d465c023825e6314e92ea', tree
