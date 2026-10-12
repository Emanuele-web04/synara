import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { inlineVisualThreadDirectory, readInlineVisual } from "../inlineVisualStore.ts";
import {
  type AppendInlineVisualActivityInput,
  INLINE_VISUALS_PER_TURN_LIMIT,
  makeAgentGatewayInlineVisualTools,
} from "./inlineVisualTools.ts";
import type { McpToolCallResult } from "./protocol.ts";
import { GatewayToolError, type ToolContext } from "./toolRuntime.ts";

const THREAD_ID = "thread-visuals";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "gateway-session:visuals",
      threadId: THREAD_ID,
      provider: "codex",
      turnId: "turn-1",
    },
    callerThreadId: THREAD_ID,
    callerThreadLabel: "Visuals",
    callerSessionKey: "gateway-session:visuals",
    callerProvider: "codex",
    callerCapabilities: new Set(["thread:read", "thread:write"]),
    callerTurnId: "turn-1",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
    ...overrides,
  };
}

const text = (result: McpToolCallResult) =>
  result.content[0]?.type === "text" ? result.content[0].text : "";

const withTools = <A>(
  run: (input: {
    readonly attachmentsDir: string;
    readonly appended: AppendInlineVisualActivityInput[];
    readonly failAppend: { current: boolean };
    readonly call: (
      args: Record<string, unknown>,
      context?: ToolContext,
    ) => Effect.Effect<McpToolCallResult>;
    readonly storedFiles: () => Promise<string[]>;
  }) => Effect.Effect<A>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "synara-inline-visuals-"))),
    (attachmentsDir) => {
      const appended: AppendInlineVisualActivityInput[] = [];
      const failAppend = { current: false };
      const [tool] = makeAgentGatewayInlineVisualTools({
        attachmentsDir,
        appendVisualActivity: (input) =>
          failAppend.current
            ? Effect.fail(new Error("dispatch failed"))
            : Effect.sync(() => void appended.push(input)),
      });
      return run({
        attachmentsDir,
        appended,
        failAppend,
        call: (args, context = makeContext()) => tool!.handler(args, context),
        storedFiles: () =>
          readdir(inlineVisualThreadDirectory({ attachmentsDir, threadId: THREAD_ID })!).catch(
            () => [],
          ),
      });
    },
    (attachmentsDir) => Effect.promise(() => rm(attachmentsDir, { recursive: true, force: true })),
  );

const html = (label: string) =>
  `<!doctype html><svg width="200" height="80"><text x="4" y="40">${label}</text></svg>`;

describe("synara_show_visual", () => {
  it.effect("stores the page and records it on the caller's running turn", () =>
    withTools(({ attachmentsDir, appended, call }) =>
      Effect.gen(function* () {
        const page = html("Revenue by quarter — €");
        const result = yield* call({ title: "  Revenue\tby\nquarter ", html: page });

        assert.isNotTrue(result.isError, text(result));
        const { visualId } = JSON.parse(text(result)) as { visualId: string };
        assert.match(visualId, /^vis_[0-9a-f]{32}$/);
        assert.lengthOf(appended, 1);
        assert.deepEqual(appended[0], {
          threadId: THREAD_ID,
          turnId: "turn-1",
          digest: visualId.slice(4),
          payload: {
            visualId,
            format: "html",
            title: "Revenue by quarter",
            height: 320,
            byteLength: Buffer.byteLength(page, "utf8"),
            sha256: createHash("sha256").update(page, "utf8").digest("hex"),
          },
        });
        const stored = yield* Effect.promise(() =>
          readInlineVisual({ attachmentsDir, threadId: THREAD_ID, visualId }),
        );
        assert.equal(stored, page);
      }),
    ),
  );

  it.effect("refuses invalid input before storing anything", () =>
    withTools(({ appended, call, storedFiles }) =>
      Effect.gen(function* () {
        // 100k three-byte characters stay under a character limit but exceed 256 KiB.
        const oversized = `<p>${"€".repeat(100_000)}</p>`;
        for (const [args, message] of [
          [{ title: "Big", html: oversized }, "the limit is 256 KiB"],
          [{ title: " \n ", html: html("x") }, '"title" must be a non-empty string'],
          [{ title: "t".repeat(121), html: html("x") }, "at most 120 characters"],
          [{ title: "Blank", html: "   " }, '"html" must be a non-empty HTML document'],
          [{ title: "Height", html: html("x"), height: "tall" }, '"height" must be a number'],
        ] as const) {
          const result = yield* call(args);
          assert.isTrue(result.isError, JSON.stringify(args).slice(0, 80));
          assert.include(text(result), message);
        }
        assert.lengthOf(appended, 0);
        assert.deepEqual(yield* Effect.promise(storedFiles), []);
      }),
    ),
  );

  it.effect("stores a component spec as normalized JSON with an estimated height", () =>
    withTools(({ attachmentsDir, appended, call }) =>
      Effect.gen(function* () {
        const result = yield* call({
          title: "Latency",
          blocks: [
            { type: "stats", items: [{ label: "p95", value: " 120 ms ", trend: "down" }] },
            {
              type: "bar-chart",
              unit: "ms",
              items: [
                { label: "api", value: 120, highlight: true },
                { label: "db", value: 40 },
              ],
            },
          ],
        });
        assert.isNotTrue(result.isError, text(result));
        const { visualId } = JSON.parse(text(result)) as { visualId: string };
        const stored = yield* Effect.promise(() =>
          readInlineVisual({ attachmentsDir, threadId: THREAD_ID, visualId }),
        );
        assert.deepEqual(JSON.parse(stored ?? ""), {
          blocks: [
            { type: "stats", items: [{ label: "p95", value: "120 ms", trend: "down" }] },
            {
              type: "bar-chart",
              unit: "ms",
              items: [
                { label: "api", value: 120, highlight: true },
                { label: "db", value: 40 },
              ],
            },
          ],
        });
        assert.equal(appended[0]?.payload.format, "components");
        assert.equal(appended[0]?.payload.byteLength, Buffer.byteLength(stored ?? "", "utf8"));
        // Stats tile plus two bars and the gap between them.
        assert.equal(appended[0]?.payload.height, 88 + 16 + 56);
      }),
    ),
  );

  it.effect("refuses specs that would not render as meant, naming the block", () =>
    withTools(({ appended, call, storedFiles }) =>
      Effect.gen(function* () {
        const calculator = (formula: string) => ({
          type: "calculator",
          inputs: [{ id: "total", label: "Total", value: 100 }],
          outputs: [{ label: "Each", formula }],
        });
        for (const [args, message] of [
          [{ title: "Both", html: html("x"), blocks: [] }, 'exactly one of "blocks" or "html"'],
          [{ title: "None" }, 'exactly one of "blocks" or "html"'],
          [{ title: "Empty", blocks: [] }, "at least 1"],
          [{ title: "Unknown", blocks: [{ type: "pie" }] }, "Block types: markdown"],
          [
            {
              title: "Ragged",
              blocks: [{ type: "table", columns: [{ label: "A" }], rows: [[1, 2]] }],
            },
            "row 0 has 2 cells for 1 columns\n  at blocks[0]",
          ],
          [
            {
              title: "Series",
              blocks: [
                {
                  type: "line-chart",
                  labels: ["a", "b", "c"],
                  series: [{ name: "s", values: [1, 2] }],
                },
              ],
            },
            'series 0 "s" has 2 values for 3 labels',
          ],
          [
            { title: "Formula", blocks: [calculator("total / people")] },
            'formula of "Each": unknown input "people"',
          ],
          [
            {
              title: "Order",
              blocks: [
                {
                  type: "calculator",
                  inputs: [{ id: "total", label: "Total", value: 100 }],
                  outputs: [
                    { label: "Twice", formula: "half * 4" },
                    { id: "half", label: "Half", formula: "total / 2" },
                  ],
                },
              ],
            },
            'formula of "Twice": unknown input "half"',
          ],
          [
            {
              title: "Clash",
              blocks: [
                {
                  type: "calculator",
                  inputs: [{ id: "total", label: "Total", value: 100 }],
                  outputs: [{ id: "total", label: "Again", formula: "total" }],
                },
              ],
            },
            'id "total" is used twice',
          ],
          [
            {
              title: "Nested",
              blocks: [
                {
                  type: "tabs",
                  tabs: [
                    { label: "A", blocks: [{ type: "markdown", text: "a" }] },
                    { label: "B", blocks: [calculator("eval(total)")] },
                  ],
                },
              ],
            },
            "at blocks[0].tabs[1].blocks[0]",
          ],
        ] as const) {
          const result = yield* call(args);
          assert.isTrue(result.isError, JSON.stringify(args).slice(0, 80));
          assert.include(text(result), message);
        }
        assert.lengthOf(appended, 0);
        assert.deepEqual(yield* Effect.promise(storedFiles), []);
      }),
    ),
  );

  it.effect("clamps the reserved height to the frame bounds", () =>
    withTools(({ appended, call }) =>
      Effect.gen(function* () {
        yield* call({ title: "Short", html: html("a"), height: 10 });
        yield* call({ title: "Tall", html: html("b"), height: 9_000 });
        assert.deepEqual(
          appended.map((entry) => entry.payload.height),
          [80, 1600],
        );
      }),
    ),
  );

  it.effect("adds no row and keeps no file when the turn stopped while the page was saved", () =>
    withTools(({ appended, call, storedFiles }) =>
      Effect.gen(function* () {
        const result = yield* call(
          { title: "Late", html: html("late") },
          makeContext({
            assertCallerTurnActive: () =>
              Effect.fail(
                new GatewayToolError("caller_turn_inactive", "The turn is no longer active."),
              ),
          }),
        );
        assert.isTrue(result.isError);
        assert.include(text(result), "no longer active");
        assert.lengthOf(appended, 0);
        assert.deepEqual(yield* Effect.promise(storedFiles), []);
      }),
    ),
  );

  it.effect("removes a page whose row could not be recorded, but never a retried page", () =>
    withTools(({ appended, failAppend, call, storedFiles }) =>
      Effect.gen(function* () {
        failAppend.current = true;
        const failed = yield* call({ title: "Lost", html: html("lost") });
        assert.isTrue(failed.isError);
        assert.deepEqual(yield* Effect.promise(storedFiles), []);

        failAppend.current = false;
        const shown = yield* call({ title: "Kept", html: html("kept") });
        const { visualId } = JSON.parse(text(shown)) as { visualId: string };
        // An identical retry reuses the id; its failure must not delete the
        // page the first, successful call already shows.
        failAppend.current = true;
        const retry = yield* call({ title: "Kept", html: html("kept") });
        assert.isTrue(retry.isError);
        assert.deepEqual(yield* Effect.promise(storedFiles), [`${visualId}.html`]);
        assert.lengthOf(appended, 1);
      }),
    ),
  );

  it.effect("repeats an identical call as the same visual and caps distinct visuals per turn", () =>
    withTools(({ appended, call }) =>
      Effect.gen(function* () {
        const first = JSON.parse(text(yield* call({ title: "Same", html: html("same") })));
        const again = JSON.parse(text(yield* call({ title: "Same", html: html("same") })));
        assert.equal(again.visualId, first.visualId);
        assert.equal(appended[1]?.digest, appended[0]?.digest);

        for (let index = 1; index < INLINE_VISUALS_PER_TURN_LIMIT; index += 1) {
          const result = yield* call({ title: `Chart ${index}`, html: html(String(index)) });
          assert.isNotTrue(result.isError, text(result));
        }
        const overLimit = yield* call({ title: "One more", html: html("more") });
        assert.isTrue(overLimit.isError);
        assert.include(text(overLimit), `already shows ${INLINE_VISUALS_PER_TURN_LIMIT} visuals`);
        // A retry of an already shown visual is still answered at the cap.
        assert.isNotTrue((yield* call({ title: "Same", html: html("same") })).isError);
        // The cap is per turn.
        const nextTurn = yield* call(
          { title: "One more", html: html("more") },
          makeContext({ callerTurnId: "turn-2" }),
        );
        assert.isNotTrue(nextTurn.isError, text(nextTurn));
      }),
    ),
  );
});

it.effect("keeps a successful visual when an identical overlapping retry fails", () =>
  withTools(({ call, appended, attachmentsDir }) =>
    Effect.gen(function* () {
      const args = { title: "Shared", html: html("Shared") };
      const [success, failure] = yield* Effect.all(
        [
          call(args),
          call(
            args,
            makeContext({
              assertCallerTurnActive: () =>
                Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20))).pipe(
                  Effect.andThen(
                    Effect.fail(new GatewayToolError("caller_turn_inactive", "stopped")),
                  ),
                ),
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.isFalse(success.isError ?? false);
      assert.isTrue(failure.isError);
      assert.lengthOf(appended, 1);
      assert.equal(
        yield* Effect.promise(() =>
          readInlineVisual({
            attachmentsDir,
            threadId: THREAD_ID,
            visualId: appended[0]!.payload.visualId,
          }),
        ),
        args.html,
      );
    }),
  ),
);
