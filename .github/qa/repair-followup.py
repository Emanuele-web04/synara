from pathlib import Path
import subprocess
r = Path.cwd()
p = r / 'apps/server/src/persistence/Migrations.test.ts'
s = p.read_text()
old = [(135, 'ExternalMcpOptionalConcurrency'), (136, 'ExternalMcpTaskFollowups'), (137, 'ExternalAgentProfiles'), (138, 'CapabilityEvidence'), (139, 'ExternalAgentLifecycle'), (140, 'CapabilityEvidenceWithdrawal'), (141, 'ExternalAgentRevisionMembership'), (142, 'ThreadTitleRefresh')]
canonical = [(135, 'ProjectionMessageTurnActivityIndex'), (136, 'AccountUsageSync'), (137, 'AccountUsageSyncIdentity'), (138, 'RemoteDeviceTrust'), (139, 'RemoteConnectionPreferences'), (140, 'RemoteAccessControls')]
before = ''.join(f'          {{ migration_id: {n}, name: "{name}" }},\n' for n, name in old)
after = ''.join(f'          {{ migration_id: {n}, name: "{name}" }},\n' for n, name in canonical + [(n + 6, name) for n, name in old])
assert s.count(before) == 1
p.write_text(s.replace(before, after))
p = r / 'apps/server/src/persistence/Migrations/IntegrationMigrationCompatibility.test.ts'
s = p.read_text()
old = '  [140, "RemoteAccessControls"],\n];'
assert s.count(old) == 1
p.write_text(s.replace(old, '  [140, "RemoteAccessControls"],\n] as const;'))
p = r / 'apps/web/src/components/ThemePackEditor.browser.tsx'
s = p.read_text()
old = '''    if (import.meta.env.VITE_PR1878_CAPTURE === "1") {
      await page.screenshot({ path: `__screenshots__/pr1878-lead-${tone}.png` });
    }'''
new = '''    if (import.meta.env.VITE_PR1878_CAPTURE === "1") {
      const sample = container.querySelector<HTMLDivElement>("#custom-lead-colors")!;
      sample.scrollIntoView({ block: "start" });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(sample.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
      expect(sample.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
      await page.screenshot({ path: `__screenshots__/pr1878-lead-${tone}.png` });
    }'''
assert s.count(old) == 1
p.write_text(s.replace(old, new))
subprocess.run(['git', 'add', str(p.relative_to(r)), 'apps/server/src/persistence/Migrations.test.ts', 'apps/server/src/persistence/Migrations/IntegrationMigrationCompatibility.test.ts'], check=True)
tree = subprocess.check_output(['git', 'write-tree'], text=True).strip()
print('FOLLOWUP_TREE', tree)
assert tree == '415299b623a549bf66ebf27363fcb9eedc065be3', tree
