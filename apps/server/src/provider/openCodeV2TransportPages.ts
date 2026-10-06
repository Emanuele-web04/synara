import {
  openCodeV2Object,
  requestOpenCodeV2,
  unwrapOpenCodeV2Data,
  type OpenCodeV2HttpContext,
} from "./openCodeV2TransportHttp.ts";

/** Paged v2 endpoints must not silently truncate durable imported histories or child trees. */
export async function listOpenCodeV2Pages(
  http: OpenCodeV2HttpContext,
  path: string,
  signal?: AbortSignal | null,
  directory?: string,
  limit?: number,
): Promise<unknown[]> {
  const values: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams(cursor ? { cursor } : { order: "asc" });
    if (limit !== undefined) query.set("limit", String(Math.max(1, limit - values.length)));
    const envelope = await requestOpenCodeV2(
      http,
      `${path}${path.includes("?") ? "&" : "?"}${query}`,
      "GET",
      undefined,
      signal,
      directory,
      true,
    );
    const data = unwrapOpenCodeV2Data(envelope);
    if (!Array.isArray(data)) throw new Error("OpenCode v2 paged endpoint returned no item list.");
    values.push(...data);
    const next = openCodeV2Object(openCodeV2Object(envelope).cursor).next;
    cursor = typeof next === "string" && next.length > 0 ? next : undefined;
    if (cursor && seen.has(cursor))
      throw new Error("OpenCode v2 returned a repeated pagination cursor.");
    if (cursor) seen.add(cursor);
  } while (cursor && (limit === undefined || values.length < limit));
  return values;
}
