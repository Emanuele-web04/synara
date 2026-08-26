import { expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ executeInMainWorld: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: electron }));

import { installWebMcpBridgeInMainWorld } from "./guestBridge";

it("provides a document.modelContext compatibility bridge before native WebMCP exists", async () => {
  const fakeDocument = Object.assign(new EventTarget(), {
    querySelectorAll: () => [],
  });
  class FakeMutationObserver {
    observe(): void {}
  }
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("location", { origin: "https://app.example" });
  vi.stubGlobal("MutationObserver", FakeMutationObserver);

  installWebMcpBridgeInMainWorld();

  const modelContext = (
    fakeDocument as typeof fakeDocument & {
      readonly modelContext: {
        readonly registerTool: (tool: Record<string, unknown>) => Promise<void>;
        readonly getTools: () => Promise<ReadonlyArray<Record<string, unknown>>>;
        readonly executeTool: (
          tool: Record<string, unknown>,
          input: Record<string, unknown>,
        ) => Promise<string>;
      };
    }
  ).modelContext;
  await modelContext.registerTool({
    name: "addTodo",
    description: "Add one todo item.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    annotations: { readOnlyHint: false },
    execute: async (input: { readonly text: string }) => ({ created: input.text }),
  });
  const registeredTools = await modelContext.getTools();
  await expect(
    modelContext.executeTool(registeredTools[0]!, { text: "Spec-compatible" }),
  ).resolves.toBe(JSON.stringify({ created: "Spec-compatible" }));
  await expect(
    modelContext.registerTool({
      name: "addTodo",
      description: "Duplicate tool.",
      execute: async () => null,
    }),
  ).rejects.toMatchObject({ name: "InvalidStateError" });

  const bridge = (
    globalThis as typeof globalThis & {
      readonly __synaraWebMcpBridgeV1: {
        readonly list: () => Promise<{
          readonly implementation: string;
          readonly tools: ReadonlyArray<{
            readonly index: number;
            readonly signature: string;
            readonly name: string;
            readonly annotations: { readonly untrustedContentHint: boolean };
          }>;
        }>;
        readonly invoke: (
          index: number,
          signature: string,
          inputJson: string,
          invocationId: string,
        ) => Promise<unknown>;
      };
    }
  ).__synaraWebMcpBridgeV1;
  const listed = await bridge.list();

  expect(listed).toMatchObject({
    implementation: "compatibility",
    tools: [
      {
        index: 0,
        name: "addTodo",
        annotations: { untrustedContentHint: true },
      },
    ],
  });
  await expect(
    bridge.invoke(0, listed.tools[0]!.signature, JSON.stringify({ text: "Ship WebMCP" }), "i1"),
  ).resolves.toEqual({ status: "completed", result: { created: "Ship WebMCP" } });
});
