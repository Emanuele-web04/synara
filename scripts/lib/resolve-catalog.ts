export function resolveCatalogDependencies(
  dependencies: Record<string, unknown>,
  catalog: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, spec]) => {
      if (typeof spec !== "string" || !spec.startsWith("catalog:")) {
        return [name, spec];
      }

      const catalogKey = spec.slice("catalog:".length).trim();
      // Bun's scoped overrides use parent>dependency selectors. Keep the selector
      // in the staged manifest, but resolve the catalog for its dependency.
      const dependencyName = name.slice(name.lastIndexOf(">") + 1).trim();
      const lookupKey = catalogKey.length > 0 ? catalogKey : dependencyName;
      const resolved = catalog[lookupKey];

      if (typeof resolved !== "string" || resolved.length === 0) {
        throw new Error(
          `Unable to resolve '${spec}' for ${label} dependency '${name}'. Expected key '${lookupKey}' in root workspace catalog.`,
        );
      }

      return [name, resolved];
    }),
  );
}
