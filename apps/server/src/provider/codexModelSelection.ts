/**
 * codexModelSelection - choose a model slug that the running codex actually
 * offers, so a mismatch never wedges `initialize`/turn-start.
 *
 * A remote sandbox runs whatever codex its snapshot shipped, whose model catalog
 * can differ from the host's. Sending a slug that codex does not recognize wedges
 * the turn. {@link selectAvailableCodexModel} resolves the requested slug against
 * the sandbox's advertised `model/list`, falling back to the product default (or
 * the first advertised slug) when the request is absent, so provisioning degrades
 * to a working model instead of an opaque failure.
 *
 * Pure and provider-agnostic: the caller passes the requested slug and the slugs
 * the sandbox advertised. An empty catalog (codex did not answer `model/list`)
 * means "trust the request" — better to let codex reject it with its own error
 * than to second-guess a catalog we never received.
 *
 * @module provider/codexModelSelection
 */

export interface CodexModelSelection {
  /** The slug to send; `null` when neither request nor catalog yields one. */
  readonly model: string | null;
  /** True when the requested slug was replaced because the catalog lacked it. */
  readonly fellBack: boolean;
}

/**
 * Resolve a model slug the running codex offers.
 *
 * - No requested slug -> the request stays unset (`null`), unchanged.
 * - Empty catalog -> trust the request (codex did not advertise a catalog).
 * - Requested slug present in the catalog -> keep it.
 * - Requested slug absent -> fall back to `preferredFallback` when the catalog
 *   advertises it, else the first advertised slug.
 */
export const selectAvailableCodexModel = (input: {
  readonly requested: string | null | undefined;
  readonly available: ReadonlyArray<string>;
  readonly preferredFallback?: string | undefined;
}): CodexModelSelection => {
  const requested = input.requested?.trim() ? input.requested.trim() : null;
  const available = input.available.map((slug) => slug.trim()).filter((slug) => slug.length > 0);

  if (requested === null || available.length === 0) {
    return { model: requested, fellBack: false };
  }
  if (available.includes(requested)) {
    return { model: requested, fellBack: false };
  }

  const fallback =
    input.preferredFallback !== undefined && available.includes(input.preferredFallback)
      ? input.preferredFallback
      : available[0];
  return { model: fallback ?? requested, fellBack: true };
};
