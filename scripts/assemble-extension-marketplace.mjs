// Temporary bounded integration script. Removed from the normalized candidate.
import { readFile, writeFile } from "node:fs/promises";
async function edit(file, before, after) {
  const content = await readFile(file, "utf8");
  if (content.split(before).length !== 2) throw new Error(`Expected one anchor in ${file}: ${before}`);
  await writeFile(file, content.replace(before, after));
}
const contract = "packages/contracts/src/editorExtensions.ts";
await edit(contract, '  description: Schema.optional(Schema.String),\n', `  description: Schema.optional(Schema.String),
  downloadCount: Schema.optional(NonNegativeInt),
  categories: Schema.optional(Schema.Array(Schema.String)),
  license: Schema.optional(Schema.String),
  apiRange: Schema.optional(Schema.String),
`);
await edit(contract, '    "search",', '    "search",\n    "catalog",\n    "details",');
await edit(contract, '  query: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),', `  query: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  category: Schema.optional(Schema.Literals(["Programming Languages", "Formatters", "Linters", "Debuggers"])),
  sortBy: Schema.optional(Schema.Literals(["relevance", "downloadCount", "timestamp"])),`);
await edit(contract, '  registryResults: Schema.Array(EditorRegistryExtension),', `  registryResults: Schema.Array(EditorRegistryExtension),
  registryTotal: Schema.optional(NonNegativeInt),
  registryNextOffset: Schema.optional(NonNegativeInt),
  registryDetails: Schema.optional(EditorRegistryExtension),`);
const registry = "apps/server/src/extensions/openVsx.ts";
await edit(registry, '  description: z.string().optional(),', `  description: z.string().max(16_384).optional(),
  downloadCount: z.number().int().nonnegative().safe().optional(),
  categories: z.array(z.string().max(128)).max(64).optional(),
  license: z.string().max(512).optional(),`);
await edit(registry, '  async metadata(id: string, version: string, signal?: AbortSignal): Promise<RegistryMetadata> {', `  /** Paged discovery is read-only and never grants execution approval. */
  async catalog(input: { query?: string | undefined; category?: string | undefined; sortBy?: string | undefined; offset?: number | undefined }, signal?: AbortSignal) {
    const query = input.query?.trim() ?? "";
    const offset = input.offset ?? 0;
    const category = input.category;
    const sortBy = input.sortBy ?? "downloadCount";
    if (query.length > 256 || !Number.isSafeInteger(offset) || offset < 0 || offset > 9_984 || offset % 24 !== 0 ||
      !["relevance", "downloadCount", "timestamp"].includes(sortBy) ||
      (category !== undefined && !["Programming Languages", "Formatters", "Linters", "Debuggers"].includes(category))) {
      throw new Error("Invalid extension catalog filters.");
    }
    let exactId;
    try { exactId = extensionId(query); } catch { /* Keywords use the registry index. */ }
    if (exactId) {
      const item = summarySchema.parse(await this.compatible(exactId, signal));
      const matches = !category || item.categories?.includes(category);
      return { registryResults: offset === 0 && matches ? [item] : [], registryTotal: matches ? 1 : 0 };
    }
    const params = new URLSearchParams({ query, size: "24", offset: String(offset), sortBy, sortOrder: "desc" });
    if (category) params.set("category", category);
    const response = z.object({ extensions: z.array(summarySchema).max(100), offset: z.number().int().nonnegative(), totalSize: z.number().int().nonnegative().safe() })
      .parse(await this.json('/api/-/search?' + params, signal));
    if (response.offset !== offset) throw new Error("The registry returned a different result page. Retry the search.");
    const ids = new Set<string>();
    const registryResults = response.extensions.filter((item) => {
      try {
        const id = extensionId(item.namespace + '.' + item.name);
        if (!semver.valid(item.version) || ids.has(id)) return false;
        ids.add(id); return true;
      } catch { return false; }
    });
    const next = offset + 24;
    return { registryResults, registryTotal: response.totalSize,
      ...(response.extensions.length === 24 && next < response.totalSize && next <= 9_984 ? { registryNextOffset: next } : {}) };
  }

  async details(id: string, signal?: AbortSignal) {
    const metadata = await this.compatible(id, signal);
    return { ...summarySchema.parse(metadata), apiRange: metadata.engines.vscode };
  }

  async metadata(id: string, version: string, signal?: AbortSignal): Promise<RegistryMetadata> {`);
const manager = "apps/server/src/extensions/extensionManager.ts";
await edit(manager, '    const operation = this.queue.then(async () => {', `    // Discovery does not own the mutation queue: a slow catalog request cannot
    // prevent an owner from revoking trust, cancelling uploads or removing code.
    if (input.operation === "catalog" || input.operation === "details") {
      return (async () => {
        const readSignal = AbortSignal.any([combined, AbortSignal.timeout(35_000)]);
        readSignal.throwIfAborted();
        await this.load();
        const result = input.operation === "catalog"
          ? await this.registry.catalog(input, readSignal)
          : { registryDetails: await this.registry.details(extensionId(required(input.id, "Extension identifier")), readSignal) };
        readSignal.throwIfAborted();
        return { ...await this.snapshot(), ...result };
      })();
    }
    const operation = this.queue.then(async () => {`);
const panel = "apps/web/src/components/settings/EditorExtensionsSettingsPanel.tsx";
let content = await readFile(panel, "utf8");
content = 'import { ExtensionMarketplace } from "./ExtensionMarketplace";\nimport { SegmentedPicker } from "~/components/SegmentedPicker";\nimport { EXTENSION_STATE_KEY as stateKey, requestEditorExtensions as request } from "./editorExtensionsApi";\n' + content;
content = content.replace('import { ensureNativeApi } from "~/nativeApi";\n', '');
const a = content.indexOf('const stateKey = ["editor-extensions"] as const;');
const b = content.indexOf('function consentClosure(', a);
if (a < 0 || b < a) throw new Error('Missing API extraction boundary');
content = content.slice(0, a) + 'const UPLOAD_CHUNK = 512 * 1_024;\n' + content.slice(b);
content = content.replace('  EditorExtensionsResult,\n', '');
content = content.replace('  const searchId = useId();\n', '');
content = content.replace('  const [search, setSearch] = useState("");\n  const [submittedSearch, setSubmittedSearch] = useState<string | null>(null);', '  const [view, setView] = useState<"marketplace" | "installed" | "permissions">("marketplace");\n  const [success, setSuccess] = useState<string | null>(null);');
const qa = content.indexOf('  const results = useQuery({');
const qb = content.indexOf('  const mutation = useMutation({', qa);
if (qa < 0 || qb < qa) throw new Error('Missing old search query boundary');
content = content.slice(0, qa) + content.slice(qb);
content = content.replace('    onSuccess: (result) => {', '    onSuccess: (result, input) => {');
content = content.replace('      if (live.current) {\n        setApproval(null);', '      if (live.current) {\n        if (("file" in input) || input.operation === "install") setSuccess("Package installed disabled. Review it in Installed before enabling.");\n        setApproval(null);');
content = content.replace('    setLocalError(null);\n    mutation.mutate(input);', '    setLocalError(null);\n    setSuccess(null);\n    mutation.mutate(input);');
const ca = content.indexOf('      <SettingsSectionShell\n        title="Find extensions"');
const cb = content.indexOf('      <SettingsSectionShell\n        title="Installed extensions"', ca);
if (ca < 0 || cb < ca) throw new Error('Missing old catalog presentation boundary');
content = content.slice(0, ca) + `      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedPicker value={view} onValueChange={setView} ariaLabel="Extension library view" className="w-full sm:w-80"
          options={[{ value: "marketplace", label: "Marketplace" }, { value: "installed", label: 'Installed (' + entries.length + ')' }, { value: "permissions", label: "Permissions" }]} />
        <Button size="sm" variant="outline" disabled={busy || !state.data} onClick={() => fileInput.current?.click()}>Install VSIX</Button>
      </div>
      <input ref={fileInput} type="file" accept=".vsix" className="hidden" aria-label="Choose VSIX package" onChange={(event) => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
        if (file) { setSuccess(null); mutation.mutate({ file }); }
      }} />
      {success ? <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 p-3 text-ui">
        <p>{success}</p><Button size="sm" variant="ghost" onClick={() => setView("installed")}>Manage installed</Button>
      </div> : null}
      <div hidden={view !== "marketplace"}>
        <ExtensionMarketplace active={view === "marketplace"} entries={entries} busy={busy} available={Boolean(state.data)}
          pendingId={mutation.variables && !("file" in mutation.variables) ? mutation.variables.id : undefined}
          onInstall={(id, version) => run({ operation: "install", id, ...(version ? { version } : {}) })} onManage={() => setView("installed")} />
      </div>
      <div hidden={view !== "installed"} className="space-y-5">
` + content.slice(cb);
content = content.replace('      <SettingsSectionShell title="Workspace trust">', '      </div>\n      <div hidden={view !== "permissions"}>\n      <SettingsSectionShell title="Workspace trust">');
content = content.replace('      <p role="status" className="text-ui-sm text-muted-foreground">', '      </div>\n      <p role="status" className="text-ui-sm text-muted-foreground">');
await writeFile(panel, content);
console.log('Integrated paged catalog, compatible details and native Marketplace / Installed / Permissions views.');
