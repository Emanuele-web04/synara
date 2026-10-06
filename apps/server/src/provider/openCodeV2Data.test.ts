import { describe, expect, it } from "vitest";
import {
  normalizeOpenCodeV2Agents,
  normalizeOpenCodeV2Commands,
  normalizeOpenCodeV2Path,
  normalizeOpenCodeV2ProviderList,
} from "./openCodeV2Data.ts";

const model = {
  id: "chat-model",
  modelID: "wire-model",
  providerID: "provider-a",
  name: "Chat Model",
  capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  variants: [{ id: "high", settings: { effort: "high" } }],
  limit: { context: 128_000, output: 8192 },
  cost: [{ input: 1, output: 4, cache: { read: 0.1, write: 1.2 } }],
  enabled: true,
};

describe("OpenCode v2 inventory adaptation", () => {
  it("groups enabled models without losing wire IDs, limits, capabilities, cost or variants", () => {
    const result = normalizeOpenCodeV2ProviderList(
      { data: [model, { ...model, id: "disabled", enabled: false }] },
      { data: [{ id: "provider-a", name: "Provider A", activation: "auto" }] },
    );
    expect(result.connected).toEqual(["provider-a"]);
    expect(result.all[0]?.name).toBe("Provider A");
    expect(Object.keys(result.all[0]?.models ?? {})).toEqual(["chat-model"]);
    expect(result.all[0]?.models["chat-model"]).toMatchObject({
      api: { id: "wire-model" },
      limit: model.limit,
      cost: model.cost[0],
      capabilities: { toolcall: true, attachment: true, input: { image: true, text: true } },
      variants: { high: { effort: "high" } },
    });
  });

  it("does not expose models belonging to explicitly disabled providers", () => {
    expect(
      normalizeOpenCodeV2ProviderList([model], [{ id: "provider-a", activation: "disabled" }]).all,
    ).toEqual([]);
  });

  it("preserves model IDs that collide with object prototype properties", () => {
    const result = normalizeOpenCodeV2ProviderList([{ ...model, id: "__proto__" }]);
    expect(Object.hasOwn(result.all[0]?.models ?? {}, "__proto__")).toBe(true);
  });

  it("uses agent IDs as selectors and maps documented permission rules", () => {
    expect(
      normalizeOpenCodeV2Agents({
        data: [
          {
            id: "build",
            name: "Build agent",
            mode: "primary",
            hidden: false,
            request: {},
            permissions: [{ action: "bash", resource: "*", effect: "ask" }],
            model: { id: "chat-model", providerID: "provider-a" },
          },
        ],
      }),
    ).toMatchObject([
      {
        name: "build",
        mode: "primary",
        permission: [{ permission: "bash", pattern: "*", action: "ask" }],
        model: { modelID: "chat-model", providerID: "provider-a" },
      },
    ]);
    expect(
      normalizeOpenCodeV2Commands({ data: [{ name: "review", description: "Review changes" }] }),
    ).toEqual([{ name: "review", description: "Review changes", template: "", hints: [] }]);
    expect(
      normalizeOpenCodeV2Path({ directory: "/repo/child", project: { directory: "/repo" } }),
    ).toMatchObject({ directory: "/repo/child", worktree: "/repo" });
  });

  it("rejects malformed required catalog fields", () => {
    expect(() => normalizeOpenCodeV2ProviderList([{ ...model, providerID: null }])).toThrow(
      "model.providerID",
    );
    expect(() =>
      normalizeOpenCodeV2ProviderList([{ ...model, limit: { context: "huge" } }]),
    ).toThrow("model.limit.context");
  });
});
