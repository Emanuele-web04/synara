// FILE: centralIconAssets.ts
// Purpose: Conservative build-time reachability for both Central icon variants.
// Layer: Web build utility; runtime icon names and rendering remain unchanged.

export const CENTRAL_ICON_DIRECTORIES = ["central-icons-reversed", "central-icons-fill"] as const;

export function collectReferencedCentralIcons(
  sources: ReadonlyArray<string>,
  availableIcons: ReadonlySet<string>,
): Set<string> {
  const required = new Set<string>();
  // Keep both variants for every literal name: the variant can be selected at
  // runtime. Accept the same optional .svg suffix as getCentralIconUrl, plus
  // direct public URLs in CSS/JS. False positives are safer than missing icons.
  const references =
    /["'`]([a-z0-9][a-z0-9-]*)(?:\.svg)?["'`]|\/central-icons-(?:reversed|fill)\/([a-z0-9][a-z0-9-]*)\.svg/g;
  for (const source of sources) {
    for (const match of source.matchAll(references)) {
      const name = match[1] ?? match[2];
      if (name && availableIcons.has(name)) required.add(name);
    }
  }
  return required;
}
