import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPUTER_SELECT_TEXT_RANGE_MAX,
  COMPUTER_TEXT_MAX_LENGTH,
  COMPUTER_WAIT_MAX_MS,
  type ComputerPermission,
  type ComputerUiNode,
  type ProviderKind,
} from "@synara/contracts";

import {
  COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
  ComputerBackendError,
  DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
  MAX_COMPUTER_CLIPBOARD_BYTES,
} from "../computer/ComputerBackend.ts";
import { ComputerTargetError } from "../computer/uiTreeTargeting.ts";
import { ComputerManager } from "../computer/ComputerManager.ts";
import { CuaActionError } from "../computer/CuaComputerBackend.ts";
import { desktopDeliveryMode } from "../computer/DesktopOperationQueue.ts";
import { FakeComputerBackend } from "../computer/FakeComputerBackend.ts";
import { isModelDesktopObservationActive } from "../computer/modelDesktopObservation.ts";
import {
  COMPUTER_APPROVAL_REQUIRED_TOOLS,
  COMPUTER_CONTROL_FIRST_MUTATION_DISCLOSURE,
  computerToolInstructions,
  computerToolRequiresApproval,
  makeAgentGatewayComputerTools,
  PROVIDERS_WITHOUT_APPROVAL_GATE,
  type AgentGatewayComputerToolsOptions,
} from "./computerTools.ts";
import type { McpToolCallResult } from "./protocol.ts";
import { GatewayToolError, type ToolContext } from "./toolRuntime.ts";
import { makeAgentGatewayComputerBrowserTools } from "./computerBrowserTools.ts";

const THREAD = "thread-computer";

function resultJson(result: McpToolCallResult): unknown {
  const text = result.content.find((entry) => entry.type === "text");
  return text?.type === "text" ? JSON.parse(text.text) : undefined;
}

/** A backend that never implemented the optional clipboard methods. */
function withoutClipboard(backend: FakeComputerBackend): FakeComputerBackend {
  return new Proxy(backend, {
    get: (target, property, receiver) =>
      property === "readClipboard" || property === "writeClipboard"
        ? undefined
        : Reflect.get(target, property, receiver),
  });
}

function makeContext(
  provider: ProviderKind = "claudeAgent",
  threadId = THREAD,
  label: string | null = null,
): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "gateway-session:computer",
      threadId,
      provider,
      turnId: "turn-computer",
    },
    callerThreadId: threadId,
    callerThreadLabel: label,
    callerSessionKey: "gateway-session:computer",
    callerProvider: provider,
    callerCapabilities: new Set(["computer:control"]),
    callerTurnId: "turn-computer",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

async function setup(
  backend = new FakeComputerBackend(),
  authorizeAction?: AgentGatewayComputerToolsOptions["authorizeAction"],
  /**
   * The never-raise authorization resolver. Defaults to the user having asked
   * to see the screen: these suites exercise the raise/foreground mechanics,
   * and the gate itself has dedicated tests that pass an explicit refusal.
   */
  resolveForegroundAuthorization: AgentGatewayComputerToolsOptions["resolveForegroundAuthorization"] = async () => ({
    userRequestedVisibleUse: true,
  }),
) {
  // A zero settle delay: these tests assert on what the post-action capture
  // does, not on how long the desktop is given to repaint.
  const manager = new ComputerManager({ backend, actionSettleMs: 0 });
  const browserTools = manager.supportsBrowser
    ? makeAgentGatewayComputerBrowserTools({
        manager,
        ...(authorizeAction ? { authorizeAction } : {}),
        resolveForegroundAuthorization,
      })
    : [];
  const tools = makeAgentGatewayComputerTools({
    manager,
    ...(authorizeAction ? { authorizeAction } : {}),
    resolveForegroundAuthorization,
    relatedTools: browserTools,
  });
  const byName = new Map([...tools, ...browserTools].map((tool) => [tool.definition.name, tool]));
  const call = async (
    name: string,
    args: Record<string, unknown>,
    provider?: ProviderKind,
    threadId?: string,
    label?: string | null,
  ): Promise<McpToolCallResult> => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    return await Effect.runPromise(tool.handler(args, makeContext(provider, threadId, label)));
  };
  /**
   * Look at the desktop the way the model does before it points: a workspace
   * screenshot. The fake workspace is 1920×1080 and the perception budget caps
   * an image handed to a model at 1536 on its longest side, so this frame comes
   * back at 1536×864, scale 0.8, from (0, 0) — a screenshot pixel is 1.25
   * desktop points, and that conversion is exactly what the server does for the
   * model rather than asking it to.
   */
  const see = async (threadId = THREAD, label: string | null = null) => {
    const state = await call(
      "computer_get_state",
      { include_screenshot: true },
      undefined,
      threadId,
      label,
    );
    expect(state.isError).not.toBe(true);
    return (resultJson(state) as { screenshot: { screenshotId: string } }).screenshot;
  };
  return { backend, manager, tools, byName, call, see };
}

type ToolsByName = Map<string, { definition: { inputSchema: unknown } }>;

/** One property's `enum`, for the schemas whose vocabulary is backend-dependent. */
function schemaEnum(byName: ToolsByName, tool: string, property: string): readonly string[] {
  const schema = byName.get(tool)?.definition.inputSchema as
    | { properties?: Record<string, { enum?: readonly string[] }> }
    | undefined;
  return schema?.properties?.[property]?.enum ?? [];
}

/** One property's description, for the same reason. */
function schemaPropertyDescription(byName: ToolsByName, tool: string, property: string): string {
  const schema = byName.get(tool)?.definition.inputSchema as
    | { properties?: Record<string, { description?: string }> }
    | undefined;
  return schema?.properties?.[property]?.description ?? "";
}

/** The `window_id` blurb one tool advertises, which is backend-dependent prose. */
function windowIdDescription(byName: ToolsByName, tool: string): string {
  const schema = byName.get(tool)?.definition.inputSchema as
    | { properties?: { window_id?: { description?: string } } }
    | undefined;
  return schema?.properties?.window_id?.description ?? "";
}

describe("agent gateway computer tools", () => {
  it("bounds active tool context and directs deferred discovery to the next small set", async () => {
    const { tools, manager } = await setup(
      Object.assign(new FakeComputerBackend(), {
        agentDialect: "macos" as const,
      }),
    );
    const definitions = tools
      .filter((tool) => tool.discoveryOnly !== true)
      .map((tool) => tool.definition);
    const descriptorBytes = Buffer.byteLength(JSON.stringify(definitions), "utf8");
    // The macOS desktop catalog was 29,792 bytes before advertising run; it is
    // now 29,326 with the compact run and inspector routes. Keep both below
    // that baseline without serializing every step or specialist schema.
    // Browser tools, provider framing and images are separate costs.
    expect(descriptorBytes).toBeLessThanOrEqual(29_400);
    expect(
      Buffer.byteLength(
        JSON.stringify(definitions.find((tool) => tool.name === "computer_run")),
        "utf8",
      ),
    ).toBeLessThanOrEqual(2_000);
    expect(
      Buffer.byteLength(
        JSON.stringify(definitions.find((tool) => tool.name === "computer_inspect")),
        "utf8",
      ),
    ).toBeLessThanOrEqual(750);
    const notes = computerToolInstructions();
    // The injected block was 8,404 chars before the surface cut shrank it to
    // the every-turn core (~3.5k); the ceiling keeps the block from growing
    // back silently.
    expect(notes.length).toBeLessThanOrEqual(3_800);
    expect(descriptorBytes + Buffer.byteLength(notes, "utf8")).toBeLessThanOrEqual(33_200);
    expect(notes).toContain("never list the whole catalog");
    expect(notes).toContain("look them up by exact name");
    expect(notes).toContain("computer_launch_app");
    expect(notes).toContain("foreground_not_requested");
    // Unit-2/6 gate: the driver refusals real tasks hit must stay mapped to
    // their next step, or the agent retries blindly.
    expect(notes).toContain("same_pid_keyboard_ambiguity");
    expect(notes).toContain("element_outside_target_window");
    expect(notes).toContain("input_target_unavailable");
    expect(notes).toContain("repeated_unverified_action");
    // The hidden-launch choreography is deleted from the shared block.
    expect(notes).not.toContain("relaunch visible");
    expect(notes).not.toContain("unhide with computer_set_app_visibility");
    // Retired surface: the recording/replay names are gone from everywhere.
    expect(notes).not.toContain("computer_recording");
    expect(notes).not.toContain("computer_replay");
    await manager.dispose();
  });

  it("presents launch hidden as an explicit posture, not an invisible-workspace doctrine", async () => {
    const { byName, manager } = await setup();
    try {
      const hidden = schemaPropertyDescription(byName, "computer_launch_app", "hidden");
      expect(hidden).toContain("Explicitly hide");
      expect(hidden).toContain("never authorizes foreground input");
      expect(hidden).not.toContain("Defaults to true");
      expect(hidden).not.toContain("agent launches stay invisible");
      expect(hidden).not.toContain("invisible workspace");
    } finally {
      await manager.dispose();
    }
  });

  it("attaches list-windows guidance to a null-window launch result", async () => {
    // A launch that yields no window is where relaunch loops start: the
    // result itself must name the next step.
    const backend = new FakeComputerBackend();
    backend.launchApp = async (app: string) =>
      ({ computerId: "desktop", app, window: null }) as Awaited<
        ReturnType<FakeComputerBackend["launchApp"]>
      >;
    const { call, manager } = await setup(backend);
    try {
      const result = await call("computer_launch_app", {
        app: "Aside",
        wait_for_window: false,
      });
      expect(result.isError).not.toBe(true);
      const text = JSON.stringify(resultJson(result));
      expect(text).toContain("computer_list_windows");
      expect(text).toContain("never launch again");
      // The old relaunch-visible escape hatch is gone; the browser route is
      // the only alternative the result names.
      expect(text).not.toContain("relaunch visible");
      expect(text).toContain("computer_browser_prepare");
    } finally {
      await manager.dispose();
    }
  });

  it("returns the same no-relaunch guidance for batched launches", async () => {
    const backend = new FakeComputerBackend();
    backend.launchApp = async (app: string) => ({ computerId: "desktop", app, window: null });
    const { call, manager } = await setup(backend);
    try {
      const result = await call("computer_run", {
        steps: [{ type: "launch_app", app: "Helium", wait_for_window: false }],
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(resultJson(result))).toContain("never launch again automatically");
      expect(JSON.stringify(resultJson(result))).toContain("not_checked");
    } finally {
      await manager.dispose();
    }
  });

  it("stops a batch after a delivered launch with no usable window", async () => {
    const backend = new FakeComputerBackend();
    backend.launchApp = async (app: string) => ({
      computerId: "desktop",
      app,
      window: null,
      windowStatus: "no_usable_window",
      windowReason: "off_space",
    });
    const { call, manager } = await setup(backend);
    try {
      const result = resultJson(
        await call("computer_run", {
          steps: [
            { type: "launch_app", app: "Helium", wait_for_window: false, continue_on_error: true },
            { type: "press_key", key: "enter" },
          ],
        }),
      );
      expect(result).toMatchObject({
        stopped: true,
        stoppedReason: "no_usable_window",
        completed: 1,
      });
      expect(backend.callsFor("pressKey")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("reserves model observation authority for explicit perception tools", async () => {
    const { backend, manager, call } = await setup();
    const observations: boolean[] = [];
    const getState = backend.getState.bind(backend);
    const capture = backend.captureScreenshot.bind(backend);
    backend.getState = async (options) => {
      observations.push(isModelDesktopObservationActive());
      return getState(options);
    };
    backend.captureScreenshot = async (request) => {
      observations.push(isModelDesktopObservationActive());
      return capture(request);
    };
    try {
      for (const [name, args] of [
        ["computer_get_state", { window_id: "fake-calculator" }],
        ["computer_screenshot", { window_id: "fake-calculator" }],
        [
          "computer_wait",
          {
            window_id: "fake-calculator",
            label: "Display",
            duration_ms: 0,
            include_screenshot: false,
          },
        ],
      ] as const) {
        observations.length = 0;
        expect((await call(name, args)).isError).not.toBe(true);
        expect(observations.length).toBeGreaterThan(0);
        expect(observations.every(Boolean)).toBe(true);
        expect(isModelDesktopObservationActive()).toBe(false);
      }
      observations.length = 0;
      expect(
        (await call("computer_set_value", { label: "Display", value: "468" })).isError,
      ).not.toBe(true);
      expect(observations.length).toBeGreaterThan(0);
      expect(observations.every((active) => !active)).toBe(true);
    } finally {
      await manager.dispose();
    }
  });

  it("covers routine foreground delivery with the active task consent on macOS", async () => {
    const { byName } = await setup(
      Object.assign(new FakeComputerBackend(), {
        agentDialect: "macos" as const,
      }),
    );
    const notes = computerToolInstructions();
    expect(notes).toContain("the user's visible-use request or direct confirmation");
    expect(notes).not.toContain("without bringing it to the front");
    expect(windowIdDescription(byName, "computer_click")).toContain(
      "Exact window for label or x/y targeting",
    );
    expect(windowIdDescription(byName, "computer_type_text")).toContain("does not activate it");
    // The activate tool no longer promises consent-covered foreground: the
    // user's own task text is the authorization, and the description says so.
    expect(byName.get("computer_activate_window")?.definition.description).toContain(
      "only when the user's own task text asked to see the screen",
    );
    expect(byName.get("computer_list_windows")?.definition.description).not.toContain(
      "into view automatically",
    );
    expect(byName.get("computer_get_state")?.definition.description).toContain("primary display");
    expect(windowIdDescription(byName, "computer_get_state")).toContain("any requested screenshot");
    const capture = byName.get("computer_screenshot")?.definition;
    expect(capture?.description).toContain("Rectangular region capture is unavailable");
    const captureSchema = capture?.inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(captureSchema.properties).sort()).toEqual(["max_dimension", "window_id"]);
  });

  it("spells out all three delivery verdicts once, in the shared notes", async () => {
    // The three-way verdict lives in the injected block now — it was eleven
    // identical copies across the tool schemas — and each input tool carries
    // the short form: evidence, not retry permission.
    const { byName } = await setup();
    const notes = computerToolInstructions();
    expect(notes).toContain('"verified"');
    expect(notes).toContain('"dispatched-unknown"');
    expect(notes).toContain('"not-dispatched"');
    expect(notes).toContain("never replay it");
    for (const name of ["computer_type_text", "computer_press_key"]) {
      const description = byName.get(name)?.definition.description ?? "";
      expect(description).toContain("delivery.verified");
      expect(description).toContain("never replay an uncertain action");
    }
  });

  it("carries the caller's name to the backend that draws the agent cursor", async () => {
    // The tool layer is the only place that knows what a thread is called, and
    // the badge on the human's desktop is the only reason it has to say so.
    const names: Array<string | null> = [];
    const backend = Object.assign(new FakeComputerBackend(), {
      setDrivingAgent: async (name: string | null) => {
        names.push(name);
      },
    });
    const { call, see } = await setup(backend);
    await see(THREAD, "Luna");

    await call("computer_click", { x: 4, y: 4 }, "claudeAgent", THREAD, "Luna");
    expect(names).toEqual(["Luna"]);

    await call("computer_press_key", { key: "enter" }, "claudeAgent", THREAD, "Luna");
    expect(names).toEqual(["Luna"]);
  });

  it("exposes the native batch fast path behind computer:control, with 15 specialist tools hidden", async () => {
    const { byName, tools } = await setup();
    // 33 registered desktop tools: 18 advertised, including the batch fast
    // path, plus 15 specialists. The 7 recording/replay tools, the three click
    // variants and computer_hotkey are gone entirely — their behavior folded
    // into computer_click's count/button and computer_press_key's chord.
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "computer_spaces",
      "computer_list_windows",
      "computer_get_state",
      "computer_screenshot",
      "computer_get_screen_size",
      "computer_wait",
      "computer_read_clipboard",
      "computer_launch_app",
      "computer_list_apps",
      "computer_verify_state",
      "computer_zoom",
      "computer_get_accessibility_tree",
      "computer_get_cursor_position",
      "computer_inspect",
      "computer_help",
      "computer_set_window_frame",
      "computer_invoke_menu",
      "computer_kill_app",
      "computer_set_window_minimized",
      "computer_set_app_visibility",
      "computer_click",
      "computer_move_cursor",
      "computer_drag",
      "computer_scroll",
      "computer_type_text",
      "computer_press_key",
      "computer_write_clipboard",
      "computer_paste",
      "computer_activate_window",
      "computer_set_value",
      "computer_perform_action",
      "computer_select_text",
      "computer_run",
    ]);
    expect(
      tools.filter((tool) => tool.discoveryOnly !== true).map((tool) => tool.definition.name),
    ).toEqual([
      "computer_list_windows",
      "computer_get_state",
      "computer_screenshot",
      "computer_get_screen_size",
      "computer_wait",
      "computer_launch_app",
      "computer_list_apps",
      "computer_verify_state",
      "computer_inspect",
      "computer_help",
      "computer_click",
      "computer_scroll",
      "computer_type_text",
      "computer_press_key",
      "computer_paste",
      "computer_activate_window",
      "computer_set_value",
      "computer_run",
    ]);
    // Hidden mutations remain reachable through the advertised batch tool;
    // computer_help returns only the specific schema a model asks for.
    expect(
      tools.filter((tool) => tool.discoveryOnly === true).map((tool) => tool.definition.name),
    ).toEqual([
      "computer_spaces",
      "computer_read_clipboard",
      "computer_zoom",
      "computer_get_accessibility_tree",
      "computer_get_cursor_position",
      "computer_set_window_frame",
      "computer_invoke_menu",
      "computer_kill_app",
      "computer_set_window_minimized",
      "computer_set_app_visibility",
      "computer_move_cursor",
      "computer_drag",
      "computer_write_clipboard",
      "computer_perform_action",
      "computer_select_text",
    ]);
    expect(tools.every((tool) => tool.requiredCapability === "computer:control")).toBe(true);
    expect(tools.every((tool) => tool.requiresActiveTurn === true)).toBe(true);
    expect(COMPUTER_APPROVAL_REQUIRED_TOOLS).toEqual(
      new Set([
        "computer_read_clipboard",
        "computer_launch_app",
        "computer_click",
        "computer_move_cursor",
        "computer_drag",
        "computer_scroll",
        "computer_type_text",
        "computer_press_key",
        "computer_write_clipboard",
        "computer_set_value",
        "computer_perform_action",
        "computer_select_text",
        "computer_paste",
        "computer_run",
        "computer_activate_window",
        "computer_set_window_frame",
        "computer_invoke_menu",
        "computer_kill_app",
        "computer_set_window_minimized",
        "computer_set_app_visibility",
      ]),
    );
    // A hover posts no event, presses nothing, and no longer aims the keyboard,
    // so there is nothing for a human to approve and nothing destructive to
    // warn about. It was gated back when `move` still re-pointed the keyboard.
    expect(computerToolRequiresApproval("computer_move_cursor")).toBe(true);
    expect(
      (
        byName.get("computer_move_cursor")?.definition.annotations as
          | { destructiveHint?: boolean }
          | undefined
      )?.destructiveHint,
    ).toBe(false);
    // Waiting touches nothing at all.
    expect(computerToolRequiresApproval("computer_wait")).toBe(false);
    for (const name of COMPUTER_APPROVAL_REQUIRED_TOOLS) {
      expect(computerToolRequiresApproval(name)).toBe(true);
      expect(tools.some((tool) => tool.definition.name === name)).toBe(true);
    }
  });

  it("does not force provider preloading and keeps every computer tool capability-gated", async () => {
    const { tools, byName } = await setup();
    // Capability filtering controls exposure; vendor tool-search behavior varies.
    const preloaded = tools.filter(
      (tool) => tool.definition._meta?.["anthropic/alwaysLoad"] === true,
    );
    expect(preloaded).toEqual([]);
    // No `_meta` at all: no alwaysLoad marker, and no search hint (a hint would
    // replace the description a deferred tool advertises, and the shared
    // `computer` name segment already retrieves the whole set in one search).
    for (const tool of tools) {
      expect(tool.definition._meta).toBeUndefined();
    }
    // Deferring must not disturb what a tool already declares, nor its gate: the
    // whole family stays behind the computer:control capability and is present.
    expect(byName.get("computer_click")?.definition.annotations).toMatchObject({
      readOnlyHint: false,
    });
    expect(tools.every((tool) => tool.requiredCapability === "computer:control")).toBe(true);
  });

  it("filters discovery to the requested app without losing availability or choosing a window", async () => {
    const backend = new FakeComputerBackend();
    const windows = await backend.listWindows();
    backend.emitWindowsChanged([...windows, { ...windows[0]!, id: "same-app-second-window" }]);
    const { call, manager } = await setup(backend);
    try {
      const all = resultJson(await call("computer_list_windows", {})) as {
        windows: unknown[];
      };
      expect(all.windows).toHaveLength(windows.length + 1);
      const filtered = resultJson(
        await call("computer_list_windows", {
          app: windows[0]!.appName!.toUpperCase(),
        }),
      ) as { windows: { id: string }[]; availability: unknown };
      expect(filtered.windows.map((window) => window.id)).toEqual([
        windows[0]!.id,
        "same-app-second-window",
      ]);
      expect(filtered.availability).toBeDefined();
      expect(resultJson(await call("computer_list_windows", { app: "missing-app" }))).toMatchObject(
        { windows: [] },
      );
    } finally {
      await manager.dispose();
    }
  });

  it("refreshes Computer routing guidance per thread without repeating every call", async () => {
    const { call, manager } = await setup();
    try {
      const guided: boolean[] = [];
      for (let index = 0; index < 11; index += 1) {
        const result = resultJson(await call("computer_list_windows", {})) as {
          toolGuidance?: string;
        };
        guided.push(result.toolGuidance?.includes("Computer routing reminder") === true);
      }
      expect(guided).toEqual([
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        true,
      ]);
      expect(
        resultJson(await call("computer_list_windows", {}, undefined, "other-thread")),
      ).toMatchObject({
        toolGuidance: expect.stringContaining("Computer routing reminder"),
      });
    } finally {
      await manager.dispose();
    }
  });

  it("returns perception payloads and preserves screenshot image content", async () => {
    const { call } = await setup();
    const list = await call("computer_list_windows", {});
    expect(list.isError).not.toBe(true);
    const state = await call("computer_get_state", {
      include_screenshot: true,
      include_text: true,
    });
    expect(state.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    expect(state.content.find((entry) => entry.type === "image")).toMatchObject({
      mimeType: "image/png",
    });
    // The id is how the model names this picture later; the size is the space
    // its coordinates are in. Region and scale still travel for the pane and
    // for debugging, but the model is never asked to do arithmetic with them.
    const text = state.content.find((entry) => entry.type === "text");
    if (text?.type === "text") expect(text.text).toBe(JSON.stringify(JSON.parse(text.text)));
    expect(JSON.parse(text?.type === "text" ? text.text : "{}")).toMatchObject({
      screenshot: {
        screenshotId: "shot-1",
        // The 1920x1080 workspace comes back downscaled: no image handed to a
        // model may exceed the vision-API resize threshold, or the model reads
        // coordinates off a picture the server never produced.
        width: 1_536,
        height: 864,
        region: { x: 0, y: 0, width: 1_920, height: 1_080 },
        scale: 0.8,
      },
    });
  });

  /**
   * The elements digest is the parity lever with macOS visual understanding:
   * without it the model's only grounding is pixel estimation from a
   * downscaled screenshot, which is how forms turned into scroll-hunting.
   */
  it("lists actionable elements on every get_state without needing include_text", async () => {
    const { call } = await setup();
    const state = await call("computer_get_state", {});
    const payload = resultJson(state) as {
      elements: { role: string; label: string; windowId?: string | null }[];
      elementWindowId?: string;
      text?: string;
    };

    expect(Array.isArray(payload.elements)).toBe(true);
    const roles = payload.elements.map((element: { role: string }) => element.role);
    expect(roles).toContain("button"); // Calculate
    expect(roles).toContain("text-field"); // Display
    for (const element of payload.elements) {
      expect(typeof element.label).toBe("string");
      expect(element.label.length).toBeGreaterThan(0);
      // The fixture's elements are all in one window, so the id is hoisted
      // onto the listing instead of repeating on every entry.
      expect(element.windowId).toBeUndefined();
    }
    expect(payload.elementWindowId).toBe("fake-calculator");
    // The full text rendering stays opt-in; the digest always rides.
    expect(payload.text).toBeUndefined();

    const withText = await call("computer_get_state", { include_text: true });
    const textPayload = resultJson(withText) as { text?: string };
    expect(textPayload.text).toEqual(expect.stringContaining("button"));
  });

  it("reports an elements digest that omits nothing silently when truncated", async () => {
    const bigTree = {
      role: "desktop" as const,
      label: null,
      value: null,
      description: null,
      frame: { x: 0, y: 0, width: 1_920, height: 1_080 },
      activationPoint: null,
      onScreen: true,
      windowId: null,
      children: Array.from({ length: 90 }, (_unused, index) => ({
        role: "push button" as const,
        label: `Button ${index}`,
        value: null,
        description: null,
        frame: { x: 0, y: 0, width: 80, height: 30 },
        activationPoint: null,
        onScreen: true,
        windowId: "w1",
        children: [],
      })),
    };
    const { call } = await setup(new FakeComputerBackend({ root: bigTree }));

    const payload = resultJson(await call("computer_get_state", {})) as {
      elements: { windowId?: string }[];
      elementWindowId?: string;
      elementsTruncated?: boolean;
    };
    expect(payload.elements).toHaveLength(60);
    expect(payload.elementsTruncated).toBe(true);
    // One window: its id is hoisted once instead of riding all 60 entries.
    expect(payload.elementWindowId).toBe("w1");
    expect(payload.elements.every((element) => element.windowId === undefined)).toBe(true);
  });

  it("names label_contains when a truncated tree misses the label", async () => {
    const base = new FakeComputerBackend();
    const state = await base.getState({ includeTree: true });
    const truncatedRoot = { ...state.root!, truncated: true as const };
    const { call, manager } = await setup(new FakeComputerBackend({ root: truncatedRoot }));
    try {
      const result = await call("computer_click", { label: "Missing control" });
      expect(result.isError).toBe(true);
      const text = result.content.find((entry) => entry.type === "text");
      expect(text?.type === "text" ? text.text : "").toContain("label_contains");
    } finally {
      await manager.dispose();
    }
  });

  it("tells the model to point in screenshot pixels and never to convert them", async () => {
    const { byName } = await setup();
    // Both perception tools spell the same contract out, so the model carries
    // one skill from the workspace shot to the zoomed one.
    for (const name of ["computer_get_state", "computer_screenshot"]) {
      const description = byName.get(name)?.definition.description ?? "";
      expect(description).toContain("screenshotId");
      expect(description).toContain("pass x/y as pixel coordinates in that image");
      expect(description).not.toContain("region.x");
    }
    // Each pointer tool carries the coordinate rule self-contained now — the
    // compact injected block no longer spends a paragraph on it.
    for (const name of [
      "computer_click",
      "computer_move_cursor",
      "computer_drag",
      "computer_scroll",
    ]) {
      const description = byName.get(name)?.definition.description ?? "";
      expect(description).toContain("never desktop coordinates");
      expect(description).not.toContain("global desktop coordinates");
      // The optional id lives beside x/y on every pointer tool.
      expect(JSON.stringify(byName.get(name)?.definition.inputSchema)).toContain("screenshot_id");
    }
    expect(byName.get("computer_get_screen_size")?.definition.description).toContain(
      "Informational only",
    );
  });

  it("tells the model the cursor is overlay-only and no background hover exists", async () => {
    const { byName } = await setup();
    // Probing showed pid-routed synthetic mouseMoved posts only reach an AppKit
    // window while the user's real cursor is inside it, so move_cursor cannot
    // become a hover delivery path (docs/computer-use-cua/hover-verdict-2026-09-17.md).
    // The description must keep denying that effect plainly.
    const description = byName.get("computer_move_cursor")?.definition.description ?? "";
    expect(description).toContain("does not deliver hover events");
    expect(description).toContain("a real background hover is not available on this backend");
    expect(description).toContain("real system pointer never moves");
  });

  it("keeps a window-scoped state capture bound to its native target", async () => {
    const backend = new FakeComputerBackend();
    const originalState = backend.getState.bind(backend);
    backend.getState = async (options) => ({
      ...(await originalState(options)),
      screenshot: {
        ...(await backend.captureScreenshot({
          kind: "window",
          windowId: "fake-calculator",
        })),
        windowId: "fake-calculator",
      },
    });
    const { call } = await setup(backend);
    const observed = await call("computer_get_state", {
      window_id: "fake-calculator",
      include_screenshot: true,
    });
    expect(resultJson(observed)).toMatchObject({
      screenshot: { windowId: "fake-calculator" },
    });
    const mismatched = await call("computer_click", {
      window_id: "fake-editor",
      x: 5,
      y: 5,
      include_screenshot: false,
    });
    expect(mismatched.isError).toBe(true);
    expect(backend.callsFor("click")).toHaveLength(0);
    const clicked = await call("computer_click", {
      x: 5,
      y: 5,
      include_screenshot: false,
    });
    expect(clicked.isError).not.toBe(true);
    expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({
      x: 1_055,
      y: 125,
    });
  });

  it("zooms into a window and reads the next coordinates in that window's pixels", async () => {
    const { backend, call, see } = await setup();
    const result = await call("computer_screenshot", {
      window_id: "fake-calculator",
    });

    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    expect(result.content.find((entry) => entry.type === "image")).toMatchObject({
      mimeType: "image/png",
    });
    // The calculator window sits at (1050, 120) and is 420x620 logical pixels,
    // which fits the default budget, so the capture is not downscaled.
    const text = result.content.find((entry) => entry.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "{}")).toMatchObject({
      screenshot: {
        screenshotId: "shot-1",
        windowId: "fake-calculator",
        mimeType: "image/png",
        width: 420,
        height: 620,
        region: { x: 1_050, y: 120, width: 420, height: 620 },
        scale: 1,
      },
    });
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-calculator",
    });

    // Pixel (5, 5) of that picture is the calculator's top-left corner plus
    // five: the server adds the window offset, the model never does. (The
    // clicks here skip their observation so the zoom stays the frame; an
    // observation would become the next frame, as the observation test pins.)
    await call("computer_click", { x: 5, y: 5, include_screenshot: false });
    expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({
      x: 1_055,
      y: 125,
    });

    // A point past the picture's edge is refused rather than landing on
    // whatever the desktop has next to the window.
    const outside = await call("computer_click", {
      x: 500,
      y: 10,
      include_screenshot: false,
    });
    expect(outside.isError).toBe(true);
    expect(resultJson(outside)).toMatchObject({
      error: {
        code: "computer_target_offscreen",
        message: expect.stringContaining("420x620 screenshot shot-1"),
      },
    });
    expect(backend.callsFor("click")).toHaveLength(1);

    // Naming an earlier screenshot reads the coordinates in that one instead.
    const workspace = await see();
    expect(workspace.screenshotId).toBe("shot-2");
    await call("computer_click", {
      x: 5,
      y: 5,
      screenshot_id: "shot-1",
      include_screenshot: false,
    });
    expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({
      x: 1_055,
      y: 125,
    });
    // Use a different point so the generic uncertain-action loop guard does
    // not preempt this coordinate-frame assertion.
    await call("computer_click", { x: 8, y: 8, include_screenshot: false });
    // Back in the workspace frame: eight screenshot pixels cover ten desktop points.
    expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 10, y: 10 });

    // An id this conversation was never given is refused, naming the ones it
    // has. Fresh coordinates keep the repeat guard — which strips
    // screenshot_id from its key — from preempting the frame lookup.
    const unknown = await call("computer_click", {
      x: 7,
      y: 9,
      screenshot_id: "shot-9",
    });
    expect(resultJson(unknown)).toMatchObject({
      error: {
        code: "computer_target_not_found",
        message: expect.stringContaining("shot-1, shot-2"),
      },
    });
  });

  it("refuses to point before the conversation has seen a screenshot", async () => {
    const { backend, call } = await setup();

    const blind = await call("computer_click", { x: 4, y: 4 });
    expect(blind.isError).toBe(true);
    expect(resultJson(blind)).toMatchObject({
      error: {
        code: "computer_target_invalid",
        message: expect.stringContaining("computer_screenshot"),
      },
    });
    // A scroll distance is in screenshot pixels too, so it needs a frame even
    // without a point.
    const scroll = await call("computer_scroll", { delta_x: 0, delta_y: 100 });
    expect(scroll.isError).toBe(true);
    expect(backend.callsFor("click")).toHaveLength(0);
    expect(backend.callsFor("scroll")).toHaveLength(0);

    // A label needs no picture: it is resolved from the accessibility tree.
    const byLabel = await call("computer_click", {
      label: "Calculate",
      role: "button",
    });
    expect(byLabel.isError).not.toBe(true);
    expect(backend.callsFor("click")).toHaveLength(1);
  });

  it("keeps each conversation's screenshots apart", async () => {
    const { call, see } = await setup();
    await see("thread-a");

    // Thread B never looked, so thread A's picture is not its frame.
    const blind = await call("computer_click", { x: 1, y: 1 }, undefined, "thread-b");
    expect(resultJson(blind)).toMatchObject({
      error: { code: "computer_target_invalid" },
    });
  });

  it("zooms into a region and maps points and scroll distances through its scale", async () => {
    const { backend, call, see } = await setup();
    await see();
    // The rect is in the workspace screenshot's pixels, and that picture is the
    // 1920-wide desktop downscaled to 1536, so each of its pixels is 1.25
    // desktop points: this asks for the desktop rect (1050, 120) 400x800.
    const result = await call("computer_screenshot", {
      x: 840,
      y: 96,
      width: 320,
      height: 640,
      max_dimension: 400,
    });

    expect(result.isError).not.toBe(true);
    const text = result.content.find((entry) => entry.type === "text");
    const payload = JSON.parse(text?.type === "text" ? text.text : "{}");
    // 800 logical pixels squeezed into 400 screenshot pixels halves the scale,
    // so screenshot pixel (100, 100) is desktop point (1250, 320).
    expect(payload).toMatchObject({
      screenshot: {
        width: 200,
        height: 400,
        region: { x: 1_050, y: 120, width: 400, height: 800 },
        scale: 0.5,
      },
    });
    expect(payload.windowId).toBeUndefined();
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "region",
      region: { x: 1_050, y: 120, width: 400, height: 800 },
      maxDimension: 400,
    });

    // The server owns the arithmetic the model used to be asked for. (Each
    // action skips its observation so the zoom stays the frame under test.)
    const skip = { include_screenshot: false };
    await call("computer_click", { x: 100, y: 100, ...skip });
    expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({
      x: 1_250,
      y: 320,
    });
    // A scroll distance is in the same pixels as the point, so 40 pixels of a
    // half-scale picture is 80 pixels of content.
    await call("computer_scroll", {
      x: 100,
      y: 100,
      delta_x: 0,
      delta_y: 40,
      ...skip,
    });
    expect(backend.callsFor("scroll").at(-1)?.args).toEqual([{ x: 1_250, y: 320 }, 0, 80]);
    await call("computer_drag", {
      from: { x: 0, y: 0 },
      to: { x: 100, y: 100 },
      ...skip,
    });
    expect(backend.callsFor("drag").at(-1)?.args.slice(0, 2)).toEqual([
      { x: 1_050, y: 120 },
      { x: 1_250, y: 320 },
    ]);
    // Zooming again is measured in the zoomed picture, and clipped to it.
    await call("computer_screenshot", {
      x: 100,
      y: 300,
      width: 200,
      height: 200,
    });
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "region",
      region: { x: 1_250, y: 720, width: 200, height: 200 },
    });
  });

  it("refuses an ambiguous or incomplete screenshot request without capturing", async () => {
    const { backend, call } = await setup();

    const both = await call("computer_screenshot", {
      window_id: "fake-calculator",
      x: 0,
    });
    expect(both.isError).toBe(true);
    expect(both.content[0]).toMatchObject({
      text: expect.stringContaining("never both"),
    });

    const partial = await call("computer_screenshot", {
      x: 10,
      y: 20,
      width: 30,
    });
    expect(partial.isError).toBe(true);
    expect(partial.content[0]).toMatchObject({
      text: expect.stringContaining("height"),
    });

    const empty = await call("computer_screenshot", {
      x: 10,
      y: 20,
      width: 0,
      height: 30,
    });
    expect(empty.isError).toBe(true);
    expect(empty.content[0]).toMatchObject({
      text: expect.stringContaining("greater than zero"),
    });

    expect(backend.callsFor("captureScreenshot")).toHaveLength(0);
  });

  it("captures the focused window when called without a target", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_screenshot", {});

    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    // The fake terminal is the focused window, so an untargeted zoom lands on
    // it and says so, mapping the same way an explicit window capture does.
    const text = result.content.find((entry) => entry.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "{}")).toMatchObject({
      screenshot: {
        screenshotId: "shot-1",
        windowId: "fake-terminal",
        region: { x: 40, y: 40, width: 960, height: 720 },
      },
    });
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-terminal",
    });
  });

  it("surfaces a compositor capture failure as a readable error result", async () => {
    const { backend, call } = await setup();
    backend.failNext(
      "captureScreenshot",
      new Error("org.synara.ComputerUse.Error.CaptureFailed: window not visible"),
    );

    const result = await call("computer_screenshot", {
      window_id: "fake-calculator",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("window not visible"),
    });
  });

  it("keeps the zoom tool read-only and free of an approval gate", async () => {
    const { backend, byName, call } = await setup();
    expect(computerToolRequiresApproval("computer_screenshot")).toBe(false);
    expect(byName.get("computer_screenshot")?.definition.annotations).toMatchObject({
      readOnlyHint: true,
    });
    // Antigravity has no approval gate, so a read-only tool must still run.
    const result = await call(
      "computer_screenshot",
      { window_id: "fake-calculator" },
      "antigravity",
    );
    expect(result.isError).not.toBe(true);
    expect(backend.callsFor("captureScreenshot")).toHaveLength(1);
  });

  it("passes a clamped pointer landing point back to the caller", async () => {
    const backend = new FakeComputerBackend();
    backend.click = async (point) => ({
      point,
      clampedTo: { x: point.x, y: 1_080 },
    });
    const { call, see } = await setup(backend);
    await see();

    // Screenshot pixel 44 of the downscaled workspace frame is desktop point 55.
    const result = await call("computer_click", { x: 44, y: 44 });
    expect(result.isError).not.toBe(true);
    const entry = result.content[0];
    expect(JSON.parse(entry?.type === "text" ? entry.text : "{}")).toMatchObject({
      point: { x: 55, y: 55 },
      clampedTo: { x: 55, y: 1_080 },
    });
  });

  it("attaches a post-action screenshot of the focused window to action results", async () => {
    const { backend, call, see } = await setup();
    await see();
    const result = await call("computer_click", { x: 100, y: 100 });

    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    // A bare coordinate names no window, so the capture goes to the window the
    // compositor routed the click to — the topmost one at the point — and the
    // metadata says which window the pixels cover. (An untargeted action also
    // clears the pinned focus, so the focused-window fallback cannot answer
    // here; the action point is what identifies the window.)
    const text = result.content.find((entry) => entry.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "{}")).toMatchObject({
      action: "computer_click",
      point: { x: 125, y: 125 },
      screenshot: {
        screenshotId: "shot-2",
        windowId: "fake-terminal",
        region: { x: 40, y: 40, width: 960, height: 720 },
        scale: 1,
      },
    });
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-terminal",
      // Action observations spend a smaller pixel budget than perception ones.
      maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
    });

    // The observation is the picture the model reads next, so it is also the
    // one its next coordinates are in: (5, 5) of the terminal is desktop (45, 45).
    await call("computer_click", { x: 5, y: 5 });
    expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 45, y: 45 });
    // The identical capture comes back as screenshotUnchanged, and the model is
    // told to keep reading the previous picture — so that stays the frame.
    const repeat = await call("computer_click", { x: 5, y: 5 });
    expect(resultJson(repeat)).toMatchObject({ screenshotUnchanged: true });
    await call("computer_click", { x: 6, y: 6 });
    expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 46, y: 46 });
  });

  it("captures the window a scoped action named rather than the focused one", async () => {
    const { backend, call, see } = await setup();
    await see();
    const result = await call("computer_click", {
      x: 1_100,
      y: 200,
      window_id: "fake-calculator",
    });

    expect(result.isError).not.toBe(true);
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-calculator",
      // Action observations spend a smaller pixel budget than perception ones.
      maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
    });
  });

  it("reports a closed target instead of photographing another window", async () => {
    const backend = new FakeComputerBackend();
    const originalClick = backend.click.bind(backend);
    backend.click = async (target) => {
      const result = await originalClick(target);
      // The click closed every window: by observation time the target is gone,
      // and the one thing the result must not contain is a screenshot of
      // whatever window remains focused — on a live desktop, the human's.
      backend.emitWindowsChanged([]);
      return result;
    };
    const { call, see } = await setup(backend);
    await see();

    const result = await call("computer_click", {
      x: 1_100,
      y: 200,
      window_id: "fake-calculator",
    });
    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text"]);
    const text = result.content.find((entry) => entry.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "{}")).toMatchObject({
      action: "computer_click",
      targetWindowClosed: true,
    });
  });

  it("skips the post-action screenshot when the model opts out", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_type_text", {
      text: "hi",
      include_screenshot: false,
    });

    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text"]);
    expect(backend.callsFor("captureScreenshot")).toHaveLength(0);
  });

  it("focuses a named window before keyboard input and zooms the result to it", async () => {
    const { backend, call } = await setup();

    const hotkey = await call("computer_press_key", {
      key: "ctrl+t",
      window_id: "fake-calculator",
    });
    expect(hotkey.isError).not.toBe(true);
    expect(backend.callsFor("raiseWindow").at(-1)?.args).toEqual(["fake-calculator"]);
    expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-calculator"]);
    expect(resultJson(hotkey)).toMatchObject({ windowId: "fake-calculator" });
    // The screenshot follows the keys, so the model sees the window it typed
    // into rather than whatever happened to be focused.
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-calculator",
      // Action observations spend a smaller pixel budget than perception ones.
      maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
    });

    // The camel-case spelling works here for the same reason it does on targets.
    const typed = await call("computer_type_text", {
      text: "hi",
      windowId: "fake-terminal",
    });
    expect(typed.isError).not.toBe(true);
    expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-terminal"]);
    expect(backend.callsFor("typeText").at(-1)?.args).toEqual(["hi"]);

    const pressed = await call("computer_press_key", {
      key: "enter",
      window_id: "gone",
    });
    expect(pressed.isError).toBe(true);
    expect(resultJson(pressed)).toMatchObject({
      error: { code: "computer_target_not_found" },
    });
    expect(backend.callsFor("pressKey")).toHaveLength(0);
  });

  it("uses exact semantic text input without focusing the target window", async () => {
    const backend = Object.assign(new FakeComputerBackend(), {
      focusNeutralSemanticText: true,
    });
    const { call, manager } = await setup(backend);
    const semanticText = vi.spyOn(manager, "typeTextAt");
    try {
      const typed = await call("computer_type_text", {
        text: "42",
        label: "Display",
        role: "text-field",
        window_id: "fake-calculator",
        include_screenshot: false,
      });

      expect(typed.isError).not.toBe(true);
      expect(semanticText).toHaveBeenCalledWith(
        THREAD,
        "42",
        expect.objectContaining({
          label: "Display",
          role: "text-field",
          windowId: "fake-calculator",
        }),
      );
      expect(backend.callsFor("focusWindow")).toHaveLength(0);
      expect(backend.callsFor("raiseWindow")).toHaveLength(0);
      expect(backend.callsFor("typeText").at(-1)?.args[0]).toBe("42");
    } finally {
      await manager.dispose();
    }
  });

  it("uses the sole writable control for exact-window text without a label", async () => {
    const backend = Object.assign(new FakeComputerBackend(), {
      focusNeutralSemanticText: true,
    });
    const { call, manager } = await setup(backend);
    const semanticText = vi.spyOn(manager, "typeTextAt");
    try {
      const typed = await call("computer_type_text", {
        text: "42",
        window_id: "fake-calculator",
        include_screenshot: false,
      });

      expect(typed.isError).not.toBe(true);
      expect(semanticText).toHaveBeenCalledWith(THREAD, "42", {
        windowId: "fake-calculator",
      });
      expect(backend.callsFor("focusWindow")).toHaveLength(0);
      expect(backend.callsFor("raiseWindow")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("zooms the post-action screenshot to the window under an untargeted action's point", async () => {
    const { backend, call, see } = await setup();
    await see();

    // The regression this pins: an untargeted scroll used to come back with a
    // workspace-wide downscale too small to read, and the model scroll-hunted
    // blind. The window under the scroll's own coordinates is the picture.
    const result = await call("computer_scroll", {
      x: 1_100,
      y: 200,
      delta_x: 0,
      delta_y: 300,
    });
    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    expect(resultJson(result)).toMatchObject({
      action: "computer_scroll",
      screenshot: { windowId: "fake-calculator" },
    });
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-calculator",
      maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
    });
  });

  it("tells the model where keyboard input lands and when not to skip a screenshot", async () => {
    const { byName } = await setup();
    for (const name of ["computer_type_text", "computer_press_key", "computer_paste"]) {
      const tool = byName.get(name);
      expect(tool?.definition.description).toContain("Pass window_id or use the last aimed window");
      expect(JSON.stringify(tool?.definition.inputSchema)).toContain("window_id");
    }
    // A final text observation can replace an image when it verifies the result.
    const schema = JSON.stringify(byName.get("computer_click")?.definition.inputSchema);
    expect(schema).toContain("verify with fresh state or a final screenshot");
  });

  it("reports an unchanged screen instead of resending the identical image", async () => {
    const { backend, call } = await setup();

    const first = await call("computer_press_key", { key: "enter" });
    expect(first.content.map((entry) => entry.type)).toEqual(["text", "image"]);

    // The fake returns the same PNG for the same window, which is the live case
    // this exists for: an action the desktop did not visibly react to. Sending
    // the identical picture again costs a second copy of the same image tokens
    // and tells the model nothing it is not already looking at.
    const repeat = await call("computer_press_key", { key: "enter" });
    expect(repeat.isError).not.toBe(true);
    expect(repeat.content.map((entry) => entry.type)).toEqual(["text"]);
    expect(resultJson(repeat)).toMatchObject({
      action: "computer_press_key",
      screenshotUnchanged: true,
      note: expect.stringContaining("byte-for-byte what your previous screenshot showed"),
    });
    expect(backend.callsFor("captureScreenshot")).toHaveLength(2);

    // A different window is a different picture, however identical its pixels.
    const other = await call("computer_press_key", {
      key: "enter",
      window_id: "fake-calculator",
    });
    expect(other.content.map((entry) => entry.type)).toEqual(["text", "image"]);
  });

  it("refuses a fourth consecutive unchanged scroll on the same window", async () => {
    const { backend, call, see } = await setup();
    await see();
    // Alternating distances keep each call's loop-guard key distinct — the
    // generic repeated-action refusal fires on three identical calls, and this
    // test exercises the scroll-specific streak instead.
    const args = { window_id: "fake-calculator", delta_x: 0, delta_y: 20 };
    const otherArgs = { window_id: "fake-calculator", delta_x: 0, delta_y: 40 };

    const first = await call("computer_scroll", args);
    expect(first.isError).not.toBe(true);
    expect(resultJson(first)).toMatchObject({
      action: "computer_scroll",
      scroll: { traveledY: 0 },
      scrollObservation: {
        status: "no-visible-movement",
        code: "scroll_noop",
        measuredDeltaY: 0,
        message: expect.stringContaining("dropped delivery"),
      },
    });

    const second = await call("computer_scroll", otherArgs);
    expect(second.isError).not.toBe(true);
    expect(resultJson(second)).toMatchObject({ screenshotUnchanged: true });

    const third = await call("computer_scroll", args);
    expect(third.isError).not.toBe(true);
    expect(backend.callsFor("scroll")).toHaveLength(3);

    const fourth = await call("computer_scroll", otherArgs);
    expect(fourth.isError).toBe(true);
    const failure = fourth.content.find((entry) => entry.type === "text");
    expect(failure?.type === "text" ? failure.text : "").toContain("computer_get_state");
    expect(failure?.type === "text" ? failure.text : "").toContain("label_contains");
    expect(backend.callsFor("scroll")).toHaveLength(3);

    // The recovery the refusal names breaks the streak.
    await call("computer_get_state", { include_screenshot: false });
    backend.queueScreenshots(["changed-before", "changed-after"]);
    const changed = await call("computer_scroll", args);
    expect(changed.isError).not.toBe(true);
    expect(changed.content.map((entry) => entry.type)).toEqual(["text", "image"]);

    // Counter restarted: the next scroll is allowed, not refused.
    const after = await call("computer_scroll", otherArgs);
    expect(after.isError).not.toBe(true);
    expect(backend.callsFor("scroll").length).toBeGreaterThan(3);
  });

  it("still refuses a fourth unchanged scroll with SYNARA_CUA_CONDITIONAL_SETTLE set", async () => {
    // The conditional-settle flag lets a scroll leg skip its wait only when
    // measured travel proves arrival; an unchanged scroll proves nothing, so
    // the zero-travel signal — and the refusal it feeds — must survive it.
    vi.stubEnv("SYNARA_CUA_CONDITIONAL_SETTLE", "1");
    try {
      const { backend, call, see } = await setup();
      await see();
      // Distinct distances keep the generic repeated-action guard out of the
      // way so the scroll-specific streak is what refuses.
      const args = { window_id: "fake-calculator", delta_x: 0, delta_y: 20 };
      const otherArgs = { window_id: "fake-calculator", delta_x: 0, delta_y: 40 };

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await call("computer_scroll", attempt % 2 === 0 ? args : otherArgs);
        expect(result.isError).not.toBe(true);
      }

      const fourth = await call("computer_scroll", args);
      expect(fourth.isError).toBe(true);
      const failure = fourth.content.find((entry) => entry.type === "text");
      expect(failure?.type === "text" ? failure.text : "").toContain("no visible movement");
      expect(backend.callsFor("scroll")).toHaveLength(3);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses the third identical mutating call that observed nothing", async () => {
    const { backend, call } = await setup();
    // A keypress on the fake backend reports no delivery verdict, so its
    // effect is dispatched-unknown — the unverified repeat this guard exists
    // for. Two are ordinary retries; the third is a loop.
    const args = { key: "enter", include_screenshot: false };
    const first = await call("computer_press_key", args);
    expect(first.isError).not.toBe(true);
    const second = await call("computer_press_key", args);
    expect(second.isError).not.toBe(true);
    const third = await call("computer_press_key", args);
    expect(third.isError).toBe(true);
    expect(resultJson(third)).toMatchObject({
      error: { code: "repeated_unverified_action" },
    });
    expect(backend.callsFor("pressKey")).toHaveLength(2);
  });
  it("does not turn lease refusals into repeated input or block a later corrected call", async () => {
    const { backend, manager, call } = await setup();
    try {
      await manager.pressKey("owner", "tab");
      const args = { key: "enter", include_screenshot: false };
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const refused = await call("computer_press_key", args);
        expect(resultJson(refused)).toMatchObject({
          error: { code: "computer_controlled_by_other_thread" },
        });
      }
      expect(backend.callsFor("pressKey")).toHaveLength(1);
      await manager.releaseDesktopControl("owner");
      expect((await call("computer_press_key", args)).isError).not.toBe(true);
      expect(backend.callsFor("pressKey")).toHaveLength(2);
    } finally {
      await manager.dispose();
    }
  });
  it("bounds repeated native refusals without claiming any input was dispatched", async () => {
    const { backend, manager, call } = await setup();
    const key = vi
      .spyOn(backend, "pressKey")
      .mockRejectedValue(
        new CuaActionError("No input was sent.", "not-dispatched", "same_pid_keyboard_ambiguity"),
      );
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(
          resultJson(await call("computer_press_key", { key: "enter", include_screenshot: false })),
        ).toMatchObject({
          error: "same_pid_keyboard_ambiguity",
          effect: "not-dispatched",
        });
      }
      expect(
        resultJson(await call("computer_press_key", { key: "enter", include_screenshot: false })),
      ).toMatchObject({
        error: {
          code: "repeated_computer_refusal",
          effect: "not-dispatched",
          previousInputMayHaveTakenEffect: false,
        },
      });
      expect(key).toHaveBeenCalledTimes(3);
    } finally {
      key.mockRestore();
      await manager.dispose();
    }
  });
  it("bounds batches that repeatedly stop at the same refused first action", async () => {
    const { backend, manager, call } = await setup();
    const key = vi
      .spyOn(backend, "pressKey")
      .mockRejectedValue(
        new CuaActionError("No input was sent.", "not-dispatched", "same_pid_keyboard_ambiguity"),
      );
    const args = {
      steps: [{ type: "press_key", key: "enter", window_id: "fake-calculator" }],
      include_screenshot: false,
    };
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(resultJson(await call("computer_run", args))).toMatchObject({ completed: 0 });
      }
      expect(resultJson(await call("computer_run", args))).toMatchObject({
        error: { code: "repeated_computer_refusal", previousInputMayHaveTakenEffect: false },
      });
      expect(key).toHaveBeenCalledTimes(3);
    } finally {
      key.mockRestore();
      await manager.dispose();
    }
  });
  it("preserves verified delivery and window identity when the result includes an image", async () => {
    const { backend, manager, call } = await setup();
    const key = vi.spyOn(backend, "pressKey").mockResolvedValue({
      effect: "verified",
      verified: "confirmed",
      deliveryPath: "semantic",
      windowId: "fake-calculator",
    });
    const audit = vi.spyOn(manager, "recordComputerAudit");
    try {
      const result = await call("computer_press_key", {
        key: "enter",
        window_id: "fake-calculator",
      });
      expect(result.content.some((part) => part.type === "image")).toBe(true);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          effect: "verified",
          target: expect.objectContaining({ windowId: "fake-calculator" }),
          diagnostics: { observation: "fresh-frame" },
        }),
      );
    } finally {
      key.mockRestore();
      await manager.dispose();
    }
  });
  it("retains uncertain native errors and their diagnostics in the audit", async () => {
    const { backend, manager, call } = await setup();
    const diagnostics = {
      delivery_path: "ax" as const,
      actuator: "ax_press" as const,
      ax_error: -25202,
    };
    const key = vi
      .spyOn(backend, "pressKey")
      .mockRejectedValue(
        new CuaActionError(
          "Native action failed.",
          "dispatched-unknown",
          "cua_action_failed",
          undefined,
          diagnostics,
        ),
      );
    const audit = vi.spyOn(manager, "recordComputerAudit");
    try {
      const args = { key: "enter", include_screenshot: false };
      expect(resultJson(await call("computer_press_key", args))).toMatchObject({
        error: "cua_action_failed",
        effect: "dispatched-unknown",
        diagnostics,
      });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          effect: "dispatched-unknown",
          code: "cua_action_failed",
          diagnostics,
        }),
      );
      await call("computer_press_key", args);
      expect(resultJson(await call("computer_press_key", args))).toMatchObject({
        error: { code: "repeated_unverified_action" },
      });
      expect(key).toHaveBeenCalledTimes(2);
    } finally {
      key.mockRestore();
      await manager.dispose();
    }
  });
  it("does not mistake an uncertain first batch step for a pre-dispatch refusal", async () => {
    const { backend, manager, call } = await setup();
    const key = vi
      .spyOn(backend, "pressKey")
      .mockRejectedValue(
        new CuaActionError("Input may have been sent.", "dispatched-unknown", "cua_action_failed"),
      );
    const audit = vi.spyOn(manager, "recordComputerAudit");
    const args = { steps: [{ type: "press_key", key: "enter", window_id: "fake-calculator" }] };
    try {
      expect(resultJson(await call("computer_run", args))).toMatchObject({
        completed: 0,
        steps: [{ ok: false, error: { effect: "dispatched-unknown" } }],
      });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ tool: "computer_run", effect: "dispatched-unknown" }),
      );
      await call("computer_run", args);
      expect(resultJson(await call("computer_run", args))).toMatchObject({
        error: { code: "repeated_unverified_action" },
      });
      expect(key).toHaveBeenCalledTimes(2);
    } finally {
      key.mockRestore();
      await manager.dispose();
    }
  });

  it("refuses the repeat before the approval prompt and before dispatch", async () => {
    // The guard fires ahead of consent: a refused loop must not spend an
    // approval prompt on an action that will not run.
    let approvals = 0;
    const { backend, call } = await setup(new FakeComputerBackend(), async () => {
      approvals += 1;
      return true;
    });
    const args = { key: "enter", include_screenshot: false };
    await call("computer_press_key", args);
    await call("computer_press_key", args);
    const refused = await call("computer_press_key", args);
    expect(refused.isError).toBe(true);
    expect(resultJson(refused)).toMatchObject({
      error: { code: "repeated_unverified_action" },
    });
    expect(approvals).toBe(2);
    expect(backend.callsFor("pressKey")).toHaveLength(2);
  });

  it("treats screenshot-only argument changes as the same action", async () => {
    const { backend, call } = await setup();
    // A fresh frame must not disguise a repeat: include_screenshot and
    // screenshot_id are stripped from the key the ring compares.
    const first = await call("computer_press_key", {
      key: "enter",
      include_screenshot: false,
    });
    const second = await call("computer_press_key", {
      key: "enter",
      include_screenshot: true,
    });
    const third = await call("computer_press_key", {
      key: "enter",
      include_screenshot: false,
    });
    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    expect(third.isError).toBe(true);
    expect(resultJson(third)).toMatchObject({
      error: { code: "repeated_unverified_action" },
    });
    expect(backend.callsFor("pressKey")).toHaveLength(2);
  });

  it("clears the streak when a call reports verified, so the refusal comes later", async () => {
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend);
    // set_window_frame is the fake's read-back action: frameApplies false is
    // the dispatched-unverified shape, true the confirmed one — same key, so
    // only the verified effect explains why the refusal waits for a fresh
    // pair of unverified repeats.
    const args = { window_id: "fake-calculator", x: 10, y: 10, width: 400, height: 300 };
    backend.setFrameApplies(false);
    expect((await call("computer_set_window_frame", args)).isError).not.toBe(true);
    backend.setFrameApplies(true);
    // Verified on the second send: the ring empties instead of arming.
    expect((await call("computer_set_window_frame", args)).isError).not.toBe(true);
    backend.setFrameApplies(false);
    // Two more unverified repeats are ordinary retries again; the one after
    // them — the third in a row — is the refusal.
    expect((await call("computer_set_window_frame", args)).isError).not.toBe(true);
    expect((await call("computer_set_window_frame", args)).isError).not.toBe(true);
    const refused = await call("computer_set_window_frame", args);
    expect(refused.isError).toBe(true);
    expect(resultJson(refused)).toMatchObject({
      error: { code: "repeated_unverified_action" },
    });
    expect(backend.callsFor("setWindowFrame")).toHaveLength(4);
  });

  it("clears the streak when a different action intervenes", async () => {
    const { backend, call } = await setup();
    const args = { key: "enter", include_screenshot: false };
    await call("computer_press_key", args);
    await call("computer_press_key", args);
    // Even another press_key with a different key breaks the repeat — the
    // model changed what it was doing.
    const other = await call("computer_press_key", {
      key: "tab",
      include_screenshot: false,
    });
    expect(other.isError).not.toBe(true);
    const resumed = await call("computer_press_key", args);
    expect(resumed.isError).not.toBe(true);
    expect(backend.callsFor("pressKey")).toHaveLength(4);
  });

  it("does not guard reads — repeated get_state calls still answer", async () => {
    const { backend, call } = await setup();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await call("computer_get_state", { include_screenshot: false });
      expect(result.isError).not.toBe(true);
    }
    // computer_read_clipboard sits in the approval set for privacy, but a
    // re-read is not a mutating loop: it is deliberately out of the guard.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await call("computer_read_clipboard", {});
      expect(result.isError).not.toBe(true);
    }
    expect(backend.callsFor("readClipboard")).toHaveLength(4);
  });

  it("keeps a discovery-only tool callable by exact name", async () => {
    const { backend, call, tools } = await setup();
    expect(tools.find((tool) => tool.definition.name === "computer_drag")?.discoveryOnly).toBe(
      true,
    );
    const dragged = await call("computer_drag", {
      from: { label: "Calculate", role: "button" },
      to: { label: "Display", role: "text-field" },
    });
    expect(dragged.isError).not.toBe(true);
    expect(backend.callsFor("drag")).toHaveLength(1);
  });

  it("keeps a successful action result when the post-action capture fails", async () => {
    const { backend, call } = await setup();
    backend.failNext("captureScreenshot");
    const result = await call("computer_press_key", { key: "enter" });

    // The key press happened; losing the screenshot must not report failure.
    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text"]);
    expect(resultJson(result)).toMatchObject({ action: "computer_press_key" });
  });

  it("resolves semantic actions from a fresh snapshot and reports backend calls", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_click", {
      label: "Calculate",
      role: "button",
    });
    expect(result.isError).not.toBe(true);
    expect(backend.callsFor("click")).toHaveLength(1);
    expect(backend.callsFor("click")[0]?.args[0]).toEqual({ x: 1_180, y: 228 });

    const setValue = await call("computer_set_value", {
      label: "Display",
      value: "468",
    });
    expect(setValue.isError).not.toBe(true);
    expect(backend.callsFor("setValue")).toHaveLength(1);

    const selectText = await call("computer_select_text", {
      label: "Display",
      start: 0,
      length: 2,
    });
    expect(selectText.isError).not.toBe(true);
    const selectCalls = backend.callsFor("selectText");
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0]?.args[0]).toMatchObject({
      node: expect.objectContaining({ label: "Display" }),
    });
    expect(selectCalls[0]?.args[1]).toEqual({ start: 0, length: 2 });
    // The fake's read-back is the substring the range covers: "468"[0..2].
    expect(resultJson(selectText)).toMatchObject({
      action: "computer_select_text",
      value: "46",
    });
  });

  it("preserves raw text values, including whitespace and an empty value", async () => {
    const { backend, call } = await setup();

    for (const text of ["  hello  ", " ", "\n"]) {
      const result = await call("computer_type_text", { text });
      expect(result.isError).not.toBe(true);
      expect(backend.callsFor("typeText").at(-1)?.args).toEqual([text]);
    }

    const emptyValue = await call("computer_set_value", {
      label: "Display",
      value: "",
    });
    expect(emptyValue.isError).not.toBe(true);
    expect(backend.callsFor("setValue").at(-1)?.args.at(-1)).toBe("");
  });

  it("fills a form field whose visible label contains a non-breaking space", async () => {
    const backend = new FakeComputerBackend({
      root: {
        role: "AXTextField",
        label: "First name\u00a0*",
        value: "",
        description: null,
        frame: { x: 100, y: 200, width: 300, height: 40 },
        activationPoint: null,
        onScreen: true,
        windowId: "w1",
        editable: true,
        children: [],
      },
    });
    const { call } = await setup(backend);
    const result = await call("computer_set_value", {
      window_id: "w1",
      label: "First name *",
      value: "Ada",
      include_screenshot: false,
    });
    expect(result.isError).not.toBe(true);
    expect(backend.callsFor("setValue")).toHaveLength(1);
    expect(backend.callsFor("setValue")[0]?.args.at(-1)).toBe("Ada");
    expect(backend.callsFor("typeText")).toHaveLength(0);
  });

  it("treats a camel-case windowId as a scroll target", async () => {
    const backend = new FakeComputerBackend({
      root: {
        role: "window",
        label: "Calculator",
        value: null,
        description: null,
        frame: { x: 100, y: 200, width: 300, height: 400 },
        activationPoint: { x: 250, y: 400 },
        onScreen: true,
        windowId: "w1",
        children: [],
      },
    });
    const { call, see } = await setup(backend);
    await see();

    const result = await call("computer_scroll", {
      windowId: "w1",
      delta_x: 10,
      delta_y: -20,
    });

    expect(result.isError).not.toBe(true);
    expect(backend.callsFor("scroll").at(-1)?.args[0]).toEqual({
      x: 250,
      y: 400,
    });
  });

  it("refuses invalid targets with structured candidate data", async () => {
    const { call } = await setup();
    const result = await call("computer_click", { label: "does not exist" });
    expect(result.isError).toBe(true);
    const text = result.content.find((entry) => entry.type === "text");
    const structured = text && text.type === "text" ? JSON.parse(text.text) : null;
    expect(structured.error.code).toBe("computer_target_not_found");
    expect(structured.error.candidates.length).toBeGreaterThan(0);
  });

  it("round-trips the shared clipboard and starts from an empty one", async () => {
    const { backend, call } = await setup();

    const empty = await call("computer_read_clipboard", {});
    expect(resultJson(empty)).toMatchObject({
      action: "computer_read_clipboard",
      value: "",
    });

    const write = await call("computer_write_clipboard", {
      text: "  copied\ntext  ",
    });
    expect(write.isError).not.toBe(true);
    expect(backend.callsFor("writeClipboard").at(-1)?.args).toEqual(["  copied\ntext  "]);

    const read = await call("computer_read_clipboard", {});
    expect(resultJson(read)).toMatchObject({ value: "  copied\ntext  " });
  });

  it("tells the model the clipboard belongs to the user too", async () => {
    const { byName } = await setup();
    for (const name of ["computer_read_clipboard", "computer_write_clipboard"]) {
      expect(byName.get(name)?.definition.description).toContain("shared with the human user");
    }
  });

  it("refuses clipboard text past the byte limit before it reaches the backend", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_write_clipboard", {
      text: "x".repeat(MAX_COMPUTER_CLIPBOARD_BYTES + 1),
    });
    expect(result.isError).toBe(true);
    expect(backend.callsFor("writeClipboard")).toHaveLength(0);
  });

  /**
   * MCP tool arguments are never validated against their JSON Schemas, so
   * these bounds are enforced at the tool layer: an oversized set_value that
   * fell back to typed keystrokes would hold the exclusive desktop lease and
   * the turn for hours, and thousands of hotkey keys would hold the seat
   * indefinitely as press/release pairs.
   */
  it("refuses a set_value past the text bound before it reaches the backend", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_set_value", {
      label: "Display",
      role: "text-field",
      value: "x".repeat(COMPUTER_TEXT_MAX_LENGTH + 1),
    });
    expect(result.isError).toBe(true);
    expect(backend.callsFor("setValue")).toHaveLength(0);

    const within = await call("computer_set_value", {
      label: "Display",
      role: "text-field",
      value: "x".repeat(COMPUTER_TEXT_MAX_LENGTH),
    });
    expect(within.isError).not.toBe(true);
    expect(backend.callsFor("setValue")).toHaveLength(1);
  });

  it("refuses a press_key chord past the contract's shape before dispatch", async () => {
    const { backend, call } = await setup();

    const tooMany = await call("computer_press_key", {
      key: Array.from({ length: 17 }, (_, index) => `Key${index}`).join("+"),
    });
    expect(tooMany.isError).toBe(true);
    expect(backend.callsFor("hotkey")).toHaveLength(0);

    const longKey = await call("computer_press_key", {
      key: `ctrl+${"k".repeat(129)}`,
    });
    expect(longKey.isError).toBe(true);
    expect(backend.callsFor("hotkey")).toHaveLength(0);

    const within = await call("computer_press_key", { key: "Control+L" });
    expect(within.isError).not.toBe(true);
    expect(backend.callsFor("hotkey")).toHaveLength(1);
    expect(backend.callsFor("hotkey")[0]?.args[0]).toEqual(["Control", "L"]);
  });

  it("passes xdotool-style key spellings through to the backend unchanged", async () => {
    const { backend, call } = await setup();

    // The tool layer validates shape only; name mapping and refusal belong to
    // the backend (cuaKey) and the driver keymap, so an xdotool spelling and a
    // not-yet-native name must arrive verbatim.
    const pressed = await call("computer_press_key", { key: "Page_Up" });
    expect(pressed.isError).not.toBe(true);
    expect(backend.callsFor("pressKey").map((entry) => entry.args)).toEqual([["Page_Up"]]);

    const chord = await call("computer_press_key", { key: "meta+KP_Enter" });
    expect(chord.isError).not.toBe(true);
    expect(backend.callsFor("hotkey").map((entry) => entry.args)).toEqual([[["meta", "KP_Enter"]]]);
  });

  it("refuses control-off mutations even for a gated provider without touching the backend", async () => {
    const { backend, manager, call } = await setup();
    try {
      await manager.setControlEnabled(THREAD, false);
      const refused = await call("computer_click", { x: 10, y: 10 });
      expect(refused.isError).toBe(true);
      expect(backend.callsFor("click")).toHaveLength(0);
    } finally {
      await manager.setControlEnabled(THREAD, true);
      await manager.dispose();
    }
  });

  it("includes the control disclosure on the first mutation payload of a turn", async () => {
    const { manager, call } = await setup();
    try {
      expect(COMPUTER_CONTROL_FIRST_MUTATION_DISCLOSURE).toContain("Computer control ON");
      const first = await call("computer_press_key", { key: "enter" });
      expect(first.isError).not.toBe(true);
      const firstText =
        first.content.find((entry) => entry.type === "text")?.type === "text"
          ? (
              first.content.find((entry) => entry.type === "text") as {
                text: string;
              }
            ).text
          : "";
      expect(firstText).toContain("Computer control ON");
      const second = await call("computer_press_key", { key: "enter" });
      expect(second.isError).not.toBe(true);
      const secondText =
        second.content.find((entry) => entry.type === "text")?.type === "text"
          ? (
              second.content.find((entry) => entry.type === "text") as {
                text: string;
              }
            ).text
          : "";
      expect(secondText).not.toContain("Computer control ON");
    } finally {
      await manager.dispose();
    }
  });

  it("refuses a semantic action name past the contract's bound", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_perform_action", {
      label: "Display",
      action: "a".repeat(257),
    });
    expect(result.isError).toBe(true);
    expect(backend.callsFor("performAction")).toHaveLength(0);
  });

  it("passes the macOS secondary action names through to the backend verbatim", async () => {
    const { backend, call } = await setup(
      Object.assign(new FakeComputerBackend(), {
        agentDialect: "macos" as const,
      }),
    );
    for (const action of [
      "AXPress",
      "press",
      "open",
      "show_menu",
      "menu",
      "pick",
      "confirm",
      "cancel",
    ]) {
      const result = await call("computer_perform_action", {
        label: "Calculate",
        action,
      });
      expect(result.isError).not.toBe(true);
    }
    expect(backend.callsFor("performAction").map((call) => call.args[1])).toEqual([
      "AXPress",
      "press",
      "open",
      "show_menu",
      "menu",
      "pick",
      "confirm",
      "cancel",
    ]);
  });

  it("refuses malformed select_text ranges and x/y targets before the backend", async () => {
    const { backend, call } = await setup();

    for (const args of [
      { label: "Display" },
      { label: "Display", start: 0 },
      { label: "Display", start: -1, length: 1 },
      { label: "Display", start: 0, length: -1 },
      { label: "Display", start: 0.5, length: 1 },
      { label: "Display", start: 0, length: COMPUTER_SELECT_TEXT_RANGE_MAX + 1 },
      // A coordinate cannot name which characters a range covers — refused
      // outright rather than resolving the window's first writable field.
      { x: 100, y: 200, start: 0, length: 1 },
    ]) {
      const result = await call("computer_select_text", args);
      expect(result.isError).toBe(true);
    }
    expect(backend.callsFor("selectText")).toHaveLength(0);
    expect(backend.callsFor("getState")).toHaveLength(0);

    const caret = await call("computer_select_text", {
      label: "Display",
      start: 1,
      length: 0,
    });
    expect(caret.isError).not.toBe(true);
    expect(backend.callsFor("selectText")).toHaveLength(1);
  });

  it("reports clipboard tools as unsupported on a backend without them", async () => {
    const { call } = await setup(withoutClipboard(new FakeComputerBackend()));

    for (const [name, args] of [
      ["computer_read_clipboard", {}],
      ["computer_write_clipboard", { text: "nope" }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      const text = result.content.find((entry) => entry.type === "text");
      expect(text?.type === "text" ? text.text : "").toContain("does not support clipboard access");
    }
  });

  it("refuses action tools for providers without an approval gate", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_click", { x: 10, y: 10 }, "antigravity");
    expect(result.isError).toBe(true);
    expect(backend.callsFor("click")).toHaveLength(0);
  });

  /**
   * A provider added to this set skips the approval card entirely, so a name
   * drifting in silently would ship an unreviewable input path. Pinned so the
   * set only ever changes deliberately.
   */
  it("pins the gate-less provider set", async () => {
    expect(PROVIDERS_WITHOUT_APPROVAL_GATE).toEqual(new Set(["antigravity", "pi"]));
  });

  it("keeps the clipboard read behind approval instead of the perception set", async () => {
    const { backend, byName, call } = await setup();

    // Approval-gated on purpose: the clipboard can hold something the human
    // copied privately, so providers must not auto-approve it as read-only.
    expect(byName.get("computer_read_clipboard")?.definition.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });

    const refused = await call("computer_read_clipboard", {}, "antigravity");
    expect(refused.isError).toBe(true);
    expect(backend.callsFor("readClipboard")).toHaveLength(0);
  });

  it("refuses a second thread's actions without encouraging retry loops and keeps its perception", async () => {
    const { backend, call, manager, see } = await setup();
    await see("thread-a");

    // The first action to land owns the desktop; nothing asks for it explicitly.
    const owned = await call("computer_click", { x: 10, y: 10 }, undefined, "thread-a");
    expect(owned.isError).not.toBe(true);

    const blocked = await call("computer_type_text", { text: "hello" }, undefined, "thread-b");
    expect(blocked.isError).toBe(true);
    expect(resultJson(blocked)).toMatchObject({
      error: {
        code: "computer_controlled_by_other_thread",
        retryable: false,
        message: expect.stringContaining("another conversation"),
      },
    });
    // The refusal happens before the backend, so the loser never moves anything.
    expect(backend.callsFor("typeText")).toHaveLength(0);

    // Reading the desktop is never arbitrated: the blocked thread can keep
    // watching, which is what makes "try again later" actionable advice. (The
    // state call gives the zoom that follows it a screenshot to point into.)
    for (const [name, args] of [
      ["computer_list_windows", {}],
      ["computer_get_state", { include_screenshot: true }],
      ["computer_get_screen_size", {}],
      ["computer_screenshot", { x: 0, y: 0, width: 100, height: 100 }],
    ] as const) {
      const perception = await call(name, args, undefined, "thread-b");
      expect(perception.isError).not.toBe(true);
    }

    // Turn end hands the desktop over; the roles then swap.
    await manager.releaseDesktopControl("thread-a");
    const handover = await call("computer_type_text", { text: "hello" }, undefined, "thread-b");
    expect(handover.isError).not.toBe(true);
    const nowBlocked = await call("computer_click", { x: 1, y: 1 }, undefined, "thread-a");
    expect(resultJson(nowBlocked)).toMatchObject({
      error: { code: "computer_controlled_by_other_thread" },
    });
  });

  /**
   * Models spell an omitted optional field as an explicit `null` all the time.
   * Deciding "this scroll has a target" from which keys are present read that
   * as a target, built an empty one, and had it refused as
   * computer_target_invalid — a hard failure for a request that meant "scroll
   * wherever the pointer is".
   */
  it("reads an explicitly null scroll target as no target", async () => {
    const { backend, call, see } = await setup();
    await see();

    const result = await call("computer_scroll", {
      x: null,
      y: null,
      label: null,
      window_id: null,
      delta_x: 0,
      delta_y: 120,
    });

    expect(result.isError).not.toBe(true);
    // Probe plus remainder, both untargeted: the null target survives into
    // every leg rather than becoming an empty target object.
    // 120 screenshot pixels of the downscaled workspace frame is 150 desktop
    // pixels: the probe takes 48 of them and the remainder carries 102.
    expect(backend.callsFor("scroll").map((entry) => entry.args)).toEqual([[null, 0, 150]]);
  });

  it("reports scroll travel and spends no extra capture doing it", async () => {
    const { backend, call, see } = await setup();
    await see();
    const seen = backend.callsFor("captureScreenshot").length;

    const result = await call("computer_scroll", {
      x: 1_100,
      y: 200,
      delta_x: 0,
      delta_y: 300,
    });

    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    expect(resultJson(result)).toMatchObject({
      action: "computer_scroll",
      scroll: {
        // Screenshot pixels converted to desktop pixels by the frame's 0.8
        // scale before anything is injected.
        requested: { deltaX: 0, deltaY: 375 },
        injected: { deltaX: 0, deltaY: 375 },
        gearing: 1,
      },
    });
    // Exactly three on a first, probing scroll: before, after the probe leg,
    // and after the remainder — the last of which is also the screenshot the
    // result carries. A fourth would mean the generic observation path had
    // photographed the window again.
    expect(backend.callsFor("captureScreenshot")).toHaveLength(seen + 3);
  });

  it("opts out of the captures with the screenshot, keeping the request telemetry", async () => {
    const { backend, call, see } = await setup();
    await see();
    const seen = backend.callsFor("captureScreenshot").length;

    const result = await call("computer_scroll", {
      x: 1_100,
      y: 200,
      delta_x: 0,
      delta_y: 300,
      include_screenshot: false,
    });

    expect(result.content.map((entry) => entry.type)).toEqual(["text"]);
    expect(backend.callsFor("captureScreenshot")).toHaveLength(seen);
    const payload = resultJson(result) as {
      scroll?: { requested?: unknown; injected?: unknown; traveledY?: number };
    };
    expect(payload.scroll?.requested).toEqual({ deltaX: 0, deltaY: 375 });
    expect(payload.scroll?.injected).toEqual({ deltaX: 0, deltaY: 375 });
    expect(payload.scroll?.traveledY).toBeUndefined();
  });

  it.each([
    [{ delta_y: 80 }, [0, 100]],
    [{ delta_x: -40 }, [-50, 0]],
  ])(
    "defaults the omitted scroll axis to zero in direct and batch calls",
    async (axes, expected) => {
      const { backend, call, see, byName, manager } = await setup();
      try {
        await see();
        const schema = byName.get("computer_scroll")!.definition.inputSchema;
        expect(schema.required ?? []).not.toContain("delta_x");
        expect(schema.required ?? []).not.toContain("delta_y");
        const result = await call("computer_scroll", { ...axes, include_screenshot: false });
        expect(result.isError).not.toBe(true);
        expect(backend.callsFor("scroll").at(-1)?.args.slice(1)).toEqual(expected);
        const batch = await call("computer_run", { steps: [{ type: "scroll", ...axes }] });
        expect(resultJson(batch)).toMatchObject({ completed: 1, stopped: false });
        expect(backend.callsFor("scroll").at(-1)?.args.slice(1)).toEqual(expected);
      } finally {
        await manager.dispose();
      }
    },
  );

  it("refuses an empty or zero scroll before dispatch", async () => {
    const { backend, call, see, manager } = await setup();
    try {
      await see();
      for (const axes of [{}, { delta_x: 0, delta_y: 0 }]) {
        const result = await call("computer_scroll", axes);
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("nonzero");
      }
      expect(backend.callsFor("scroll")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("still resolves a scroll target when one is actually given", async () => {
    const { backend, call, see } = await setup();
    await see();

    await call("computer_scroll", { x: 100, y: 100, delta_x: 0, delta_y: -50 });

    // Probe plus remainder — the resolved point rides into both legs. The
    // point sits inside a window so the probe has something to measure against;
    // a point over bare desktop would skip calibration and send one leg.
    expect(backend.callsFor("scroll").map((entry) => entry.args)).toEqual([
      [{ x: 125, y: 125 }, 0, -48],
      [{ x: 125, y: 125 }, 0, -14.5],
    ]);
  });

  /**
   * The JSON Schema bound is advisory: nothing validates MCP tool arguments
   * against it before dispatch. Unclamped, a duration of 1e9 held the pointer
   * button — and the exclusive desktop lease — for eleven days.
   */
  it("refuses mutating computer tools for Pi, whose sessions have no approval gate", async () => {
    // Pi re-exposes every gateway tool as a native custom tool whose execute
    // posts tools/call directly: no permission hook, no request/respond. It was
    // in neither family's gate-less set, so computer_click ran on the real
    // desktop with nobody asked.
    const { backend, call } = await setup();
    for (const name of [
      "computer_click",
      "computer_type_text",
      "computer_write_clipboard",
      "computer_activate_window",
      "computer_press_key",
      "computer_drag",
    ]) {
      const refused = await call(
        name,
        {
          x: 1,
          y: 1,
          text: "x",
          window_id: "fake-terminal",
          key: "enter",
          from: { x: 1, y: 1 },
          to: { x: 2, y: 2 },
        },
        "pi",
      );
      expect(refused.isError).toBe(true);
      expect(resultJson(refused)).toMatchObject({
        error: { code: "ComputerApprovalRequired" },
      });
    }
    expect(backend.callsFor("click")).toHaveLength(0);
    expect(backend.callsFor("typeText")).toHaveLength(0);
    expect(backend.callsFor("pressKey")).toHaveLength(0);
    expect(backend.callsFor("drag")).toHaveLength(0);
    // Perception is untouched: refusing to read the screen protects nobody.
    const seen = await call("computer_list_windows", {}, "pi");
    expect(seen.isError).not.toBe(true);
  });

  it("never hands the model an image larger than it will actually be shown", async () => {
    // Above roughly 1568 px on the long edge a vision API downscales the picture
    // before the model sees it, so the model reads coordinates off an image the
    // server never produced and the mapping is wrong by that ratio.
    const { backend, byName, call } = await setup();
    const schema = byName.get("computer_screenshot")?.definition.inputSchema as {
      properties: { max_dimension: { maximum: number } };
    };
    expect(schema.properties.max_dimension.maximum).toBe(DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION);
    expect(DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION).toBe(1_536);

    // The schema bound is advisory — nothing validates MCP arguments against it
    // — so the request is clamped here too.
    await call("computer_screenshot", {
      window_id: "fake-terminal",
      max_dimension: 8_000,
    });
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-terminal",
      maxDimension: DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
    });
  });

  it(
    "waits without touching the desktop, and never for longer than its bound",
    async () => {
      const { backend, call } = await setup();
      const started = Date.now();
      const result = await call("computer_wait", { duration_ms: 5 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(4);
      expect(result.isError).not.toBe(true);
      expect(resultJson(result)).toMatchObject({ waitedMs: 5 });
      // No pointer, no keys, no capture: a wait that photographed the desktop
      // would be a screenshot with a delay, which is not what it is for.
      expect(backend.callsFor("captureScreenshot")).toHaveLength(0);
      expect(backend.callsFor("click")).toHaveLength(0);

      // Clamped rather than refused: the intent is clear and only the scale is
      // wrong, and an unclamped wait stalls the whole turn behind a sleep.
      const clamped = await call("computer_wait", {
        duration_ms: 60 * 60 * 1_000,
      });
      expect(resultJson(clamped)).toMatchObject({
        waitedMs: COMPUTER_WAIT_MAX_MS,
      });
      const negative = await call("computer_wait", { duration_ms: -5 });
      expect(resultJson(negative)).toMatchObject({ waitedMs: 0 });
    },
    COMPUTER_WAIT_MAX_MS + 5_000,
  );

  it("holds modifiers across a click and a scroll, and refuses a name it cannot press", async () => {
    // Not expressible as a press_key chord, which releases its keys before the
    // gesture happens — so shift-click and ctrl-scroll need the pointer tools'
    // own modifiers field.
    const { backend, call, see } = await setup();
    await see();

    await call("computer_click", {
      x: 40,
      y: 40,
      modifiers: ["shift"],
      include_screenshot: false,
    });
    expect(backend.callsFor("click").at(-1)?.args).toEqual([{ x: 50, y: 50 }, ["shift"]]);

    await call("computer_scroll", {
      x: 40,
      y: 40,
      delta_x: 0,
      delta_y: 8,
      modifiers: ["ctrl", "ctrl"],
      include_screenshot: false,
    });
    expect(backend.callsFor("scroll").at(-1)?.args).toEqual([{ x: 50, y: 50 }, 0, 10, ["ctrl"]]);

    const refused = await call("computer_click", {
      x: 40,
      y: 40,
      modifiers: ["hyper"],
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]).toMatchObject({
      text: expect.stringContaining("hyper"),
    });
  });

  it("sends a triple click as one gesture, and refuses where it cannot be one", async () => {
    const { backend, call, see } = await setup();
    await see();
    const tripled = await call("computer_click", {
      x: 40,
      y: 40,
      count: 3,
      include_screenshot: false,
    });
    expect(tripled.isError).not.toBe(true);
    expect(resultJson(tripled)).toMatchObject({ action: "computer_click" });
    expect(backend.callsFor("tripleClick")).toHaveLength(1);
    expect(backend.callsFor("click")).toHaveLength(0);

    // Three separate clicks are three carets, not a line selection, so a
    // backend that cannot express the gesture says so rather than approximating.
    const without = new Proxy(new FakeComputerBackend(), {
      get: (target, property, receiver) =>
        property === "tripleClick" ? undefined : Reflect.get(target, property, receiver),
    }) as FakeComputerBackend;
    const limited = await setup(without);
    await limited.see();
    const refused = await limited.call("computer_click", {
      x: 40,
      y: 40,
      count: 3,
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]).toMatchObject({
      text: expect.stringContaining("cannot send a triple click"),
    });
  });

  it("photographs a window the action opened instead of reporting nothing changed", async () => {
    // The observer captures exactly one window, so a key press that opens a
    // dialog photographs the old window — very often byte-identical — and the
    // model was told its action had not landed at the moment it had landed
    // hardest.
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend);

    // Establishes the terminal's capture as what this thread has already seen.
    const first = await call("computer_press_key", {
      key: "enter",
      window_id: "fake-terminal",
    });
    expect(first.content.map((entry) => entry.type)).toEqual(["text", "image"]);

    const before = await backend.listWindows();
    backend.pressKey = async () => {
      backend.emitWindowsChanged([
        ...before,
        {
          id: "fake-dialog",
          title: "Save changes?",
          appName: "org.kde.konsole",
          // A dialog shares its owning app's pid — the same-process test the
          // observer applies once windows carry one.
          pid: before.find((window) => window.id === "fake-terminal")?.pid,
          bounds: { x: 200, y: 200, width: 300, height: 200 },
          focused: false,
          minimized: false,
          visible: true,
        },
      ]);
      return {};
    };

    const opened = await call("computer_press_key", {
      key: "enter",
      window_id: "fake-terminal",
    });
    expect(opened.isError).not.toBe(true);
    expect(resultJson(opened)).toMatchObject({
      screenshot: { windowId: "fake-dialog" },
    });
    expect(opened.content.map((entry) => entry.type)).toEqual(["text", "image"]);
  });

  it("says an unchanged frame is unsettled rather than asserting the action missed", async () => {
    const { call } = await setup();
    await call("computer_press_key", {
      key: "enter",
      window_id: "fake-terminal",
    });
    // Nothing opened, so there is no new window to photograph instead and the
    // identical picture is genuinely all there is to report.
    const quiet = await call("computer_press_key", {
      key: "enter",
      window_id: "fake-terminal",
    });
    expect(resultJson(quiet)).toMatchObject({
      screenshotUnchanged: true,
      note: expect.stringContaining("does not prove the action missed"),
    });
  });

  it("scopes the elements digest by window and by label, and counts what it drops", async () => {
    const { call } = await setup();
    const all = resultJson(await call("computer_get_state", {})) as {
      elements: { label: string; windowId?: string }[];
      elementWindowId?: string;
      elementsTruncated?: boolean;
      elementsOmitted?: number;
    };
    // The default tree's elements are all in one window: the id is hoisted.
    const windowId = all.elementWindowId!;
    expect(windowId).toBe("fake-calculator");

    const scoped = resultJson(await call("computer_get_state", { window_id: windowId })) as {
      elements: { windowId?: string }[];
      elementWindowId?: string;
    };
    expect(scoped.elements.length).toBeGreaterThan(0);
    expect(scoped.elementWindowId).toBe(windowId);
    expect(scoped.elements.every((element) => element.windowId === undefined)).toBe(true);

    const label = all.elements[0]!.label;
    const filtered = resultJson(
      await call("computer_get_state", { label_contains: label.toUpperCase() }),
    ) as { elements: { label: string }[] };
    expect(filtered.elements.length).toBeGreaterThan(0);
    expect(
      filtered.elements.every((element) =>
        element.label.toLocaleLowerCase().includes(label.toLocaleLowerCase()),
      ),
    ).toBe(true);

    const none = resultJson(
      await call("computer_get_state", {
        label_contains: "no control is called this",
      }),
    ) as { elements: unknown[]; elementsTruncated?: boolean };
    expect(none.elements).toEqual([]);
    expect(none.elementsTruncated).toBeUndefined();
  });

  it("keeps per-element window ids when one listing spans windows", async () => {
    // An unscoped read over a desktop with two windows must keep each entry's
    // window id: that is what tells the model which window an action addresses,
    // so the hoist applies only to a one-window listing.
    const entry = (windowId: string, label: string): ComputerUiNode => ({
      role: "button",
      label,
      value: null,
      description: null,
      frame: { x: 0, y: 0, width: 80, height: 30 },
      activationPoint: null,
      onScreen: true,
      windowId,
      children: [],
    });
    const root: ComputerUiNode = {
      role: "desktop",
      label: null,
      value: null,
      description: null,
      frame: { x: 0, y: 0, width: 1_920, height: 1_080 },
      activationPoint: null,
      onScreen: true,
      windowId: null,
      children: [
        {
          role: "window",
          label: "Terminal",
          value: null,
          description: null,
          frame: { x: 40, y: 40, width: 960, height: 720 },
          activationPoint: null,
          onScreen: true,
          windowId: "fake-terminal",
          children: [entry("fake-terminal", "Run")],
        },
        {
          role: "window",
          label: "Calculator",
          value: null,
          description: null,
          frame: { x: 1_050, y: 120, width: 420, height: 620 },
          activationPoint: null,
          onScreen: true,
          windowId: "fake-calculator",
          children: [entry("fake-calculator", "Calculate")],
        },
      ],
    };
    const { call, manager } = await setup(new FakeComputerBackend({ root }));
    try {
      const payload = resultJson(await call("computer_get_state", {})) as {
        elements: { label: string; windowId?: string }[];
        elementWindowId?: string;
      };
      expect(payload.elementWindowId).toBeUndefined();
      expect(payload.elements.map((element) => [element.label, element.windowId])).toEqual([
        ["Run", "fake-terminal"],
        ["Calculate", "fake-calculator"],
      ]);
    } finally {
      await manager.dispose();
    }
  });

  it("brings a window forward only through the explicit tool, and refuses where it cannot", async () => {
    const raised: string[] = [];
    const backend = Object.assign(new FakeComputerBackend(), {
      raiseWindow: (windowId: string) => {
        raised.push(windowId);
        return Promise.resolve();
      },
    });
    const approval = vi.fn(async () => true);
    const { call } = await setup(backend, approval);

    const result = await call("computer_activate_window", {
      window_id: "fake-terminal",
    });
    expect(approval).toHaveBeenCalledWith(
      "computer_activate_window",
      expect.objectContaining({ delivery_mode: "foreground" }),
      expect.anything(),
      expect.anything(),
    );
    expect(result.isError).not.toBe(true);
    expect(raised).toEqual(["fake-terminal"]);
    expect(resultJson(result)).toMatchObject({
      action: "computer_activate_window",
      windowId: "fake-terminal",
    });

    const missing = await call("computer_activate_window", {
      window_id: "no-such-window",
    });
    expect(missing.isError).toBe(true);

    // A desktop with no stacking control says so rather than reporting a move
    // that never happened.
    const without = new Proxy(new FakeComputerBackend(), {
      get: (target, property, receiver) =>
        property === "raiseWindow" ? undefined : Reflect.get(target, property, receiver),
    }) as FakeComputerBackend;
    const plain = await setup(without, approval);
    const refused = await plain.call("computer_activate_window", {
      window_id: "fake-terminal",
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]).toMatchObject({
      text: expect.stringContaining("cannot bring a window forward"),
    });

    // And it is approval-gated, being the one tool whose whole effect is on
    // what the person at the machine sees.
    expect(computerToolRequiresApproval("computer_activate_window")).toBe(true);
  });

  it("describes the shortcut form and the semantic actions this desktop actually accepts", async () => {
    const linux = await setup();
    const hotkey = linux.byName.get("computer_press_key")?.definition.description ?? "";
    expect(hotkey).toContain("A chord");
    expect(hotkey).not.toContain("ordered key sequence");
    expect(hotkey).toContain("releases in reverse");
    const linuxActions = schemaEnum(linux.byName, "computer_perform_action", "action");
    expect(linuxActions).toEqual(["activate", "click"]);
    expect(linux.byName.get("computer_launch_app")?.definition.description).toContain(
      "executable on PATH",
    );

    const mac = await setup(
      Object.assign(new FakeComputerBackend(), {
        agentDialect: "macos" as const,
      }),
    );
    const macHotkey = mac.byName.get("computer_press_key")?.definition.description ?? "";
    expect(macHotkey).toContain("exactly one other key");
    expect(macHotkey).toContain("More than one non-modifier key is refused");
    const macActions = schemaEnum(mac.byName, "computer_perform_action", "action");
    expect(macActions).toEqual([
      "AXPress",
      "press",
      "open",
      "show_menu",
      "menu",
      "pick",
      "confirm",
      "cancel",
    ]);
    expect(schemaPropertyDescription(mac.byName, "computer_perform_action", "action")).toContain(
      "does not advertise",
    );
    const macLaunchAppDescription =
      mac.byName.get("computer_launch_app")?.definition.description ?? "";
    expect(macLaunchAppDescription).toContain("the way macOS does");
    // Launch posture is a request, not proof that the resulting window is usable.
    expect(macLaunchAppDescription).toContain("requests no foreground activation");
    expect(macLaunchAppDescription).toContain("may create no usable window");
    const macLaunchApp = schemaPropertyDescription(mac.byName, "computer_launch_app", "app");
    expect(macLaunchApp).toContain("com.apple.Safari");
    expect(macLaunchApp).not.toContain("/Applications/Safari.app");
  });

  it("matches a label exactly as written, spaces included", async () => {
    // The desktop targeters compare labels verbatim on purpose, so trimming the
    // argument retargeted a caller that named "Save " at a control called "Save".
    const { call } = await setup();
    const refused = await call("computer_click", { label: "Calculate " });
    expect(refused.isError).toBe(true);
    expect(resultJson(refused)).toMatchObject({
      error: { code: "computer_target_not_found" },
    });
    const found = await call("computer_click", { label: "Calculate" });
    expect(found.isError).not.toBe(true);
  });

  it("clamps a drag duration to the bound its schema advertises", async () => {
    const { backend, byName, call, see } = await setup();
    await see();

    await call("computer_drag", {
      from: { x: 1, y: 1 },
      to: { x: 2, y: 2 },
      duration_ms: 1e9,
    });
    await call("computer_drag", {
      from: { x: 1, y: 1 },
      to: { x: 2, y: 2 },
      duration_ms: -5,
    });

    const durations = backend.callsFor("drag").map((entry) => entry.args[2]);
    expect(durations).toEqual([30_000, 0]);
    const schema = byName.get("computer_drag")?.definition.inputSchema as {
      properties: { duration_ms: { maximum: number; minimum: number } };
    };
    // The clamp is the schema's own bound, not a second opinion about it.
    expect(schema.properties.duration_ms).toMatchObject({
      maximum: 30_000,
      minimum: 0,
    });
  });
});

describe("agent gateway computer setup prompts", () => {
  /** One tool call against a backend whose window read fails the given way. */
  async function readFailingWith(error: unknown) {
    const backend = Object.assign(new FakeComputerBackend(), {
      listWindows: () => Promise.reject(error),
    });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const setupPrompts: string[] = [];
    const tools = makeAgentGatewayComputerTools({
      manager,
      onSetupRequired: ({ toolName }) => Effect.sync(() => void setupPrompts.push(toolName)),
    });
    const tool = tools.find((entry) => entry.definition.name === "computer_list_windows")!;
    const result = await Effect.runPromise(tool.handler({}, makeContext()));
    return { result, setupPrompts };
  }

  it("prompts for setup when the desktop withheld an OS permission", async () => {
    const { result, setupPrompts } = await readFailingWith(
      new ComputerBackendError("Screen Recording is not granted.", {
        setupRequired: true,
      }),
    );
    expect(result.isError).toBe(true);
    expect(setupPrompts).toEqual(["computer_list_windows"]);
  });

  it("prompts for setup when the permission failure arrived wrapped", async () => {
    const wrapped = new Error("the desktop refused", {
      cause: new ComputerBackendError("Accessibility is not granted.", {
        setupRequired: true,
      }),
    });
    const { setupPrompts } = await readFailingWith(wrapped);
    expect(setupPrompts).toEqual(["computer_list_windows"]);
  });

  it.each([
    [
      "a target that is no longer there",
      new ComputerTargetError({
        code: "computer_target_not_found",
        message: "No control matches that label.",
      }),
    ],
    ["an ordinary backend fault", new ComputerBackendError("The click was not delivered.")],
  ])("does not prompt for setup after %s", async (_name, error) => {
    const { result, setupPrompts } = await readFailingWith(error);
    expect(result.isError).toBe(true);
    expect(setupPrompts).toEqual([]);
  });

  /** One `computer_list_windows` against a backend that succeeds but is blocked. */
  async function readWith(overrides: Partial<FakeComputerBackend>) {
    const backend = Object.assign(new FakeComputerBackend(), overrides);
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const prompts: {
      toolName: string;
      missing: readonly string[];
      buildSignature?: string;
    }[] = [];
    const tools = makeAgentGatewayComputerTools({
      manager,
      onSetupRequired: ({ toolName, missing, buildSignature }) =>
        Effect.sync(
          () =>
            void prompts.push({
              toolName,
              missing,
              ...(buildSignature ? { buildSignature } : {}),
            }),
        ),
    });
    const tool = tools.find((entry) => entry.definition.name === "computer_list_windows")!;
    const result = await Effect.runPromise(tool.handler({}, makeContext()));
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    return { result, prompts, text };
  }

  it("prompts for setup when a successful result reports a permission state", async () => {
    // The shape that slipped through before this funnel: the call succeeded, the
    // payload said "Synara needs Accessibility", and nothing put a card on
    // screen — so the model explained macOS privacy in prose instead.
    const { result, prompts, text } = await readWith({
      availability: () =>
        Promise.resolve({
          kind: "permission-required",
          missing: ["accessibility"],
          message: "Synara needs Accessibility to control this Mac. Turn Synara on in…",
          buildSignature: "signed",
        }),
      missingPermissions: () => Promise.resolve(["accessibility"]),
    });

    expect(result.isError).not.toBe(true);
    expect(prompts).toEqual([
      {
        toolName: "computer_list_windows",
        missing: ["accessibility"],
        buildSignature: "signed",
      },
    ]);
    // The model is told a setup card is in front of the user — not how macOS
    // privacy works, and not to walk them through System Settings over the top
    // of a card that is already on screen.
    expect(text).toContain("Synara needs Accessibility and has shown the user a setup card");
    expect(text).toContain("waiting for the user to grant it");
    expect(text).not.toContain("Turn Synara on in");
  });

  it("prompts for setup for a grant that only blinds the desktop", async () => {
    // Screen Recording alone leaves availability `available` on purpose, so the
    // only thing that can raise the card is the backend saying what it lacks.
    const { result, prompts } = await readWith({
      missingPermissions: () => Promise.resolve(["screenRecording"]),
    });

    expect(result.isError).not.toBe(true);
    expect(prompts).toEqual([{ toolName: "computer_list_windows", missing: ["screenRecording"] }]);
  });

  it("reads the missing grants fresh on every call, never from the previous answer", async () => {
    // The live failure this signature exists to prevent: the user granted Screen
    // Recording between two tool calls, the second call re-read a cached
    // "missing", and the card and the model's refusal stayed on screen over a
    // desktop that already worked.
    let granted = false;
    const { prompts } = await readWith({
      missingPermissions: () => {
        const answer = granted ? [] : ["screenRecording"];
        granted = true;
        return Promise.resolve(answer as readonly ComputerPermission[]);
      },
    });
    expect(prompts).toEqual([{ toolName: "computer_list_windows", missing: ["screenRecording"] }]);

    const second = await readWith({
      missingPermissions: () => Promise.resolve([]),
    });
    expect(second.prompts).toEqual([]);
  });

  it("carries an ad-hoc build signature to the card, so it can explain a stale grant", async () => {
    // On a locally built copy System Settings can show Synara switched on while
    // the grant is pinned to a binary a rebuild replaced; without this the card
    // tells the user to flip a switch that is already flipped.
    const { prompts } = await readWith({
      missingPermissions: () => Promise.resolve(["screenRecording"]),
      buildSignature: () => "adhoc",
    });

    expect(prompts).toEqual([
      {
        toolName: "computer_list_windows",
        missing: ["screenRecording"],
        buildSignature: "adhoc",
      },
    ]);
  });

  it("carries the named grants through a thrown refusal", async () => {
    const backend = Object.assign(new FakeComputerBackend(), {
      listWindows: () =>
        Promise.reject(
          new ComputerBackendError("The helper refused: -32000.", {
            setupRequired: true,
          }),
        ),
      missingPermissions: () => Promise.resolve(["screenRecording"] as const),
    });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const prompts: { toolName: string; missing: readonly string[] }[] = [];
    const tools = makeAgentGatewayComputerTools({
      manager,
      onSetupRequired: ({ toolName, missing }) =>
        Effect.sync(() => void prompts.push({ toolName, missing })),
    });
    const tool = tools.find((entry) => entry.definition.name === "computer_list_windows")!;
    await Effect.runPromise(tool.handler({}, makeContext()));

    expect(prompts).toEqual([{ toolName: "computer_list_windows", missing: ["screenRecording"] }]);
  });

  it("tells the model to stop for a blocking grant and to carry on for a degrading one", async () => {
    // Screen Recording declined leaves the desktop perfectly driveable and only
    // unseeable, and the note used to say "Stop desktop automation… do not
    // retry" on every successful call for the rest of the session.
    const degrading = await readWith({
      missingPermissions: () => Promise.resolve(["screenRecording"]),
    });
    expect(degrading.text).toContain("does not block desktop control");
    expect(degrading.text).toContain("Do not stop");
    expect(degrading.text).not.toContain("Stop desktop automation");

    const blocking = await readWith({
      missingPermissions: () => Promise.resolve(["accessibility"]),
    });
    expect(blocking.text).toContain("Nothing on the desktop can be driven without it");
    expect(blocking.text).toContain("Stop desktop automation");
  });

  it("puts the setup note on the error path and on a screenshot-bearing result", async () => {
    // Both were unreachable: the catch branch returned the backend's raw
    // message, and every screenshot-bearing result is already a built tool
    // result, which the note only knew how to add to a plain object.
    const backend = Object.assign(new FakeComputerBackend(), {
      missingPermissions: () => Promise.resolve(["accessibility"] as const),
    });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const tools = makeAgentGatewayComputerTools({ manager });
    const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
    const run = async (name: string, args: Record<string, unknown>) =>
      await Effect.runPromise(byName.get(name)!.handler(args, makeContext()));

    // A perception read with an image: the note lands in the JSON text part
    // beside the picture.
    const state = await run("computer_get_state", { include_screenshot: true });
    expect(state.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    expect((resultJson(state) as { setupRequired?: string }).setupRequired).toContain(
      "Synara needs Accessibility and has shown the user a setup card",
    );

    // And a failure, which used to hand back the backend's sentence alone.
    backend.failNext("captureScreenshot");
    const failed = await run("computer_screenshot", {
      window_id: "fake-terminal",
    });
    expect(failed.isError).toBe(true);
    const text = failed.content.find((entry) => entry.type === "text");
    expect(text?.type === "text" ? text.text : "").toContain("setup card");
  });

  it("raises the card from a state read that reports a blocking permission", async () => {
    // The primary perception tool carried no availability at all, so the
    // permission-required branch could not fire for the call an agent makes
    // first.
    const backend = Object.assign(new FakeComputerBackend(), {
      availability: () =>
        Promise.resolve({
          kind: "permission-required" as const,
          missing: ["accessibility" as const],
          message: "Synara needs Accessibility to control this Mac.",
          buildSignature: "signed" as const,
        }),
    });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const prompts: string[] = [];
    const tools = makeAgentGatewayComputerTools({
      manager,
      onSetupRequired: ({ toolName }) => Effect.sync(() => void prompts.push(toolName)),
    });
    const tool = tools.find((entry) => entry.definition.name === "computer_get_state")!;
    const result = await Effect.runPromise(tool.handler({}, makeContext()));

    expect(prompts).toEqual(["computer_get_state"]);
    expect(resultJson(result)).toMatchObject({
      availability: { kind: "permission-required", missing: ["accessibility"] },
    });
  });
});

describe("screenshot delivery consistency", () => {
  it("refreshes screenshot coordinates when an unchanged window moves", async () => {
    const { backend, manager, call } = await setup();
    try {
      await call("computer_press_key", {
        key: "enter",
        window_id: "fake-calculator",
      });
      const windows = await backend.listWindows();
      backend.emitWindowsChanged(
        windows.map((w) =>
          w.id === "fake-calculator" ? { ...w, bounds: { ...w.bounds!, x: 600 } } : w,
        ),
      );
      await call("computer_press_key", {
        key: "enter",
        window_id: "fake-calculator",
      });
      await call("computer_click", { x: 5, y: 5, include_screenshot: false });
      expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({
        x: 605,
        y: 125,
      });
    } finally {
      await manager.dispose();
    }
  });
  it("returns the action window after an intervening workspace screenshot", async () => {
    const { manager, call, see } = await setup();
    try {
      await call("computer_press_key", {
        key: "enter",
        window_id: "fake-calculator",
      });
      await see();
      const repeat = await call("computer_press_key", {
        key: "enter",
        window_id: "fake-calculator",
      });
      expect(repeat.content.some((c) => c.type === "image")).toBe(true);
    } finally {
      await manager.dispose();
    }
  });
});

describe("computer operation ordering", () => {
  it("keeps pane input after the action observation and refuses a queued call from an ended turn", async () => {
    const { backend, manager, byName, call } = await setup();
    let finish = () => {};
    let entered = () => {};
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pressKey = backend.pressKey.bind(backend);
    backend.pressKey = async (key) => {
      const result = await pressKey(key);
      entered();
      await held;
      return result;
    };
    const events: string[] = [];
    const capture = backend.captureScreenshot.bind(backend);
    backend.captureScreenshot = async (request) => {
      events.push("capture");
      return capture(request);
    };
    const type = backend.typeText.bind(backend);
    backend.typeText = async (text) => {
      events.push("pane input");
      return type(text);
    };
    let active = true;
    try {
      const first = call("computer_press_key", { key: "enter" });
      await started;
      const paneInput = manager.typeText(undefined, "human");
      const context = {
        ...makeContext(),
        assertCallerTurnActive: () =>
          active
            ? Effect.void
            : Effect.fail(
                new GatewayToolError("caller_turn_inactive", "The requesting turn ended."),
              ),
      };
      const next = Effect.runPromise(
        byName.get("computer_press_key")!.handler({ key: "escape" }, context),
      );
      active = false;
      expect(events).toEqual([]);
      finish();
      await first;
      await paneInput;
      expect((await next).isError).toBe(true);
      expect(events).toEqual(["capture", "pane input"]);
      expect(backend.callsFor("pressKey")).toHaveLength(1);
    } finally {
      finish();
      await manager.dispose();
    }
  });

  it("refuses a queued mutation flipped off mid-queue without new backend calls", async () => {
    const { backend, manager, call } = await setup();
    let finish = () => {};
    let entered = () => {};
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pressKey = backend.pressKey.bind(backend);
    backend.pressKey = async (...args: Parameters<typeof pressKey>) => {
      const result = await pressKey(...args);
      entered();
      await held;
      return result;
    };
    try {
      const first = call("computer_press_key", { key: "enter" });
      await started;
      const queued = call("computer_press_key", { key: "escape" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const disabling = manager.setControlEnabled(THREAD, false);
      finish();
      await disabling;
      await first;
      const queuedResult = await queued;
      expect(queuedResult.isError).toBe(true);
      expect(backend.callsFor("pressKey")).toHaveLength(1);
      await manager.setControlEnabled(THREAD, true);
    } finally {
      finish();
      await manager.dispose();
    }
  });
});

it("waits for a live label and returns its window screenshot in the same call", async () => {
  const { backend, call } = await setup();
  const result = await call("computer_wait", {
    duration_ms: 5_000,
    label: "Display",
    window_id: "fake-calculator",
  });
  expect(result.isError).not.toBe(true);
  expect(resultJson(result)).toMatchObject({
    status: "ready",
    screenshot: { windowId: "fake-calculator" },
  });
  expect(backend.callsFor("getState")).toHaveLength(1);
  expect(backend.callsFor("click")).toHaveLength(0);
  expect(backend.callsFor("raiseWindow")).toHaveLength(0);
  const invalid = await call("computer_wait", {
    duration_ms: 0,
    label: "Display",
  });
  expect(invalid.isError).toBe(true);
});

it("waits for a window's surface to go quiet when settle is requested", async () => {
  const { backend, call } = await setup(new FakeComputerBackend({ waitForSettle: true }));
  const result = await call("computer_wait", {
    duration_ms: 5_000,
    window_id: "fake-terminal",
    settle: true,
  });
  expect(result.isError).not.toBe(true);
  expect(resultJson(result)).toMatchObject({
    settled: true,
    mode: "observer",
  });
  expect(backend.callsFor("waitForSettle")).toHaveLength(1);
  expect(backend.callsFor("waitForSettle")[0]?.args[0]).toMatchObject({
    windowId: "fake-terminal",
  });
  // Watching is not touching: no input, no raise, no capture rode along.
  expect(backend.callsFor("click")).toHaveLength(0);
  expect(backend.callsFor("raiseWindow")).toHaveLength(0);
  expect(backend.callsFor("captureScreenshot")).toHaveLength(0);
});

it("reports the fixed fallback when the backend cannot observe a settle", async () => {
  const { backend, call } = await setup();
  const result = await call("computer_wait", {
    duration_ms: 5_000,
    window_id: "fake-terminal",
    settle: true,
  });
  expect(result.isError).not.toBe(true);
  // No observer exists on this backend, so the honest answer is a fixed
  // pause — mode reports which kind of wait actually happened.
  expect(resultJson(result)).toMatchObject({ settled: true, mode: "fixed", waitedMs: 0 });
  expect(backend.callsFor("waitForSettle")).toHaveLength(0);
});

it("requires a window for a settle wait and refuses an unknown one", async () => {
  const { call } = await setup(new FakeComputerBackend({ waitForSettle: true }));
  const missing = await call("computer_wait", { duration_ms: 5_000, settle: true });
  expect(missing.isError).toBe(true);
  const unknown = await call("computer_wait", {
    duration_ms: 5_000,
    window_id: "no-such-window",
    settle: true,
  });
  expect(unknown.isError).toBe(true);
  // settle and label are different observation modes; combining them is
  // refused rather than silently preferring one.
  const combined = await call("computer_wait", {
    duration_ms: 5_000,
    window_id: "fake-terminal",
    label: "OK",
    settle: true,
  });
  expect(combined.isError).toBe(true);
});

it("can wait for the next label on an action without replaying input", async () => {
  const { backend, call } = await setup();
  const result = await call("computer_click", {
    label: "Display",
    window_id: "fake-calculator",
    wait_for_label: "Display",
  });
  expect(result.isError).not.toBe(true);
  expect(resultJson(result)).toMatchObject({ readiness: { status: "ready" } });
  expect(backend.callsFor("click")).toHaveLength(1);
  const invalid = await call("computer_click", {
    label: "Display",
    wait_for_label: "",
  });
  expect(invalid.isError).toBe(true);
  expect(backend.callsFor("click")).toHaveLength(1);
});

it("does not substitute a new window from another process for the target screenshot", async () => {
  const backend = new FakeComputerBackend();
  const before = (await backend.listWindows()).map((window) => ({
    ...window,
    pid: 10,
  }));
  backend.emitWindowsChanged(before);
  const { call } = await setup(backend);
  backend.pressKey = async () => {
    backend.emitWindowsChanged([
      ...before,
      { ...before[0]!, id: "unrelated-popup", pid: 20, stackingIndex: 0 },
    ]);
    return {};
  };
  const result = await call("computer_press_key", {
    key: "enter",
    window_id: "fake-terminal",
  });
  expect(resultJson(result)).toMatchObject({
    screenshot: { windowId: "fake-terminal" },
  });
});

it("limits large scrolls to overlapping views across screenshot scale changes", async () => {
  const { backend, call } = await setup();
  const first = resultJson(await call("computer_screenshot", { window_id: "fake-terminal" })) as {
    screenshot: {
      region: { width: number; height: number };
      width: number;
      height: number;
    };
  };
  for (const distance of [1500, 700, -1400]) {
    const result = resultJson(
      await call("computer_scroll", {
        window_id: "fake-terminal",
        delta_x: 0,
        delta_y: distance,
      }),
    ) as {
      scroll: { requested: { deltaY: number }; limitedTo: { deltaY: number } };
    };
    expect(result.scroll.limitedTo.deltaY).toBe(
      (Math.sign(distance) * first.screenshot.region.height) / 2,
    );
    expect(Math.abs(result.scroll.requested.deltaY)).toBeGreaterThan(
      Math.abs(result.scroll.limitedTo.deltaY),
    );
    expect(Math.abs(backend.callsFor("scroll").at(-1)!.args[2] as number)).toBeLessThanOrEqual(
      first.screenshot.region.height / 2,
    );
  }
});

it("keeps a completed input successful when conditional observation fails", async () => {
  const { backend, manager, call } = await setup();
  const click = backend.click.bind(backend);
  backend.click = async (...args: Parameters<typeof click>) => {
    const result = await click(...args);
    backend.failNext("getState");
    return result;
  };
  try {
    const result = await call("computer_click", {
      label: "Calculate",
      window_id: "fake-calculator",
      wait_for_label: "Display",
    });
    expect(result.isError).not.toBe(true);
    expect(resultJson(result)).toMatchObject({
      action: "computer_click",
      readiness: { status: "unavailable" },
    });
    expect(backend.callsFor("click")).toHaveLength(1);
  } finally {
    await manager.dispose();
  }
});

it("inherits an omitted scroll target from the screenshot rather than the old keyboard target", async () => {
  const { backend, manager, call } = await setup();
  try {
    await manager.typeText(undefined, "human", "fake-terminal");
    const shot = await call("computer_screenshot", {
      window_id: "fake-calculator",
    });
    expect(shot.isError).not.toBe(true);
    const result = await call("computer_scroll", {
      delta_x: 0,
      delta_y: 30,
      include_screenshot: false,
    });
    expect(result.isError).not.toBe(true);
    expect(resultJson(result)).toMatchObject({ windowId: "fake-calculator" });
    expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-calculator"]);
  } finally {
    await manager.dispose();
  }
});

it("allows human input between conditional wait observations and stops polling when control is revoked", async () => {
  const { backend, manager, call } = await setup();
  const reading = Promise.withResolvers<void>();
  const getState = backend.getState.bind(backend);
  backend.getState = async (...args: Parameters<typeof getState>) => {
    const state = await getState(...args);
    reading.resolve();
    return state;
  };
  try {
    const waiting = call("computer_wait", {
      duration_ms: 1000,
      label: "Never exists",
      window_id: "fake-calculator",
      include_screenshot: false,
    });
    await reading.promise;
    await manager.typeText(undefined, "human input");
    expect(backend.callsFor("typeText")).toHaveLength(1);
    await manager.setControlEnabled(THREAD, false);
    const reads = backend.callsFor("getState").length;
    expect((await waiting).isError).toBe(true);
    expect(backend.callsFor("getState")).toHaveLength(reads);
    expect(backend.callsFor("click")).toHaveLength(0);
  } finally {
    await manager.dispose();
  }
});

describe("computer never-raise gate", () => {
  const refusing = async () => ({ userRequestedVisibleUse: false });

  it("gates exact-window and app menu calls and batched menu steps as foreground", async () => {
    const backend = new FakeComputerBackend();
    const approval = vi.fn(async () => true);
    const { call, manager } = await setup(backend, approval, refusing);
    try {
      for (const target of [{ window_id: "fake-calculator" }, { pid: 1_002 }]) {
        expect(
          resultJson(await call("computer_invoke_menu", { ...target, path: ["File"] })),
        ).toMatchObject({
          error: "foreground_not_requested",
          effect: "not-dispatched",
        });
      }
      expect(approval).toHaveBeenCalledWith(
        "computer_invoke_menu",
        expect.objectContaining({ delivery_mode: "foreground" }),
        expect.anything(),
        expect.anything(),
      );
      const batch = resultJson(
        await call("computer_run", {
          steps: [{ type: "invoke_menu", app: "Calculator", path: ["File"] }],
        }),
      );
      expect(batch).toMatchObject({
        completed: 0,
        stopped: true,
        steps: [
          { ok: false, error: { code: "foreground_not_requested", effect: "not-dispatched" } },
        ],
      });
      expect(backend.callsFor("invokeMenu")).toHaveLength(0);
      expect(backend.callsFor("raiseWindow")).toHaveLength(0);
      expect(backend.callsFor("focusWindow")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("refuses activate without the user's task-text authorization, and raises nothing", async () => {
    const backend = new FakeComputerBackend();
    const approval = vi.fn(async () => true);
    const { call, manager } = await setup(backend, approval, refusing);
    try {
      const refused = await call("computer_activate_window", { window_id: "fake-calculator" });
      expect(refused.isError).toBe(true);
      const payload = resultJson(refused) as { error: string; effect: string; message: string };
      expect(payload.error).toBe("foreground_not_requested");
      expect(payload.effect).toBe("not-dispatched");
      expect(payload.message).toContain("did not ask");
      expect(backend.callsFor("raiseWindow")).toEqual([]);
      expect(backend.callsFor("focusWindow")).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it("refuses an absent resolver too — never-raise is the default", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const tools = makeAgentGatewayComputerTools({
      manager,
      authorizeAction: async () => true,
    });
    const tool = tools.find((entry) => entry.definition.name === "computer_activate_window")!;
    try {
      const refused = await Effect.runPromise(
        tool.handler({ window_id: "fake-calculator" }, makeContext()),
      );
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(resultJson(refused))).toContain("foreground_not_requested");
      expect(backend.callsFor("raiseWindow")).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it("refuses foreground delivery without authorization and dispatches nothing", async () => {
    const backend = new FakeComputerBackend();
    const approval = vi.fn(async () => true);
    const { call, manager } = await setup(backend, approval, refusing);
    try {
      const refused = await call("computer_press_key", {
        key: "enter",
        window_id: "fake-calculator",
        delivery_mode: "foreground",
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(resultJson(refused))).toContain("foreground_not_requested");
      expect(backend.callsFor("pressKey")).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it("refuses a run's activate step without authorization, and the run reports it", async () => {
    const backend = new FakeComputerBackend();
    const approval = vi.fn(async () => true);
    const { call, manager } = await setup(backend, approval, refusing);
    try {
      const result = await call("computer_run", {
        steps: [{ type: "activate_window", window_id: "fake-calculator" }],
      });
      const payload = resultJson(result) as {
        completed: number;
        stopped: boolean;
        steps: { ok: boolean; error?: { code?: string } }[];
      };
      expect(payload.stopped).toBe(true);
      expect(payload.steps[0]).toMatchObject({
        ok: false,
        error: { code: "foreground_not_requested", effect: "not-dispatched" },
      });
      expect(backend.callsFor("raiseWindow")).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it("launches macOS apps in the background without hiding or raising them", async () => {
    const backend = new FakeComputerBackend({ agentDialect: "macos" });
    const { call, manager } = await setup(
      backend,
      vi.fn(async () => true),
      refusing,
    );
    try {
      const result = await call("computer_launch_app", {
        app: "TextEdit",
        hidden: false,
        wait_for_window: false,
      });
      expect(result.isError).not.toBe(true);
      const batched = await call("computer_run", {
        steps: [{ type: "launch_app", app: "TextEdit", wait_for_window: false }],
      });
      expect(resultJson(batched)).toMatchObject({ steps: [{ ok: true }] });
      expect(backend.callsFor("launchApp").map((call) => call.args)).toEqual([
        ["TextEdit", [], { hidden: false }],
        ["TextEdit", []],
      ]);
      expect(backend.callsFor("raiseWindow")).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it("allows the authorized raise, and the resolver is read per call", async () => {
    const backend = new FakeComputerBackend();
    const approval = vi.fn(async () => true);
    let authorized = false;
    const { call, manager } = await setup(backend, approval, async () => ({
      userRequestedVisibleUse: authorized,
    }));
    try {
      expect(
        (await call("computer_activate_window", { window_id: "fake-calculator" })).isError,
      ).toBe(true);
      expect(backend.callsFor("raiseWindow")).toEqual([]);
      // The user replies "yes, show me": the next read authorizes.
      authorized = true;
      const allowed = await call("computer_activate_window", { window_id: "fake-calculator" });
      expect(allowed.isError).not.toBe(true);
      expect(backend.callsFor("raiseWindow").map((entry) => entry.args[0])).toEqual([
        "fake-calculator",
        "fake-terminal",
      ]);
    } finally {
      await manager.dispose();
    }
  });
});

describe("computer_activate_window foreground restore", () => {
  it("runs a default-background activate in foreground scope and restores when approved", async () => {
    const backend = new FakeComputerBackend();
    const deliveryModes: string[] = [];
    const raise = backend.raiseWindow.bind(backend);
    backend.raiseWindow = async (windowId: string) => {
      deliveryModes.push(desktopDeliveryMode());
      return raise(windowId);
    };
    const approval = vi.fn(async () => true);
    const { call, manager } = await setup(backend, approval);
    try {
      // No delivery_mode arg: the call defaults to background, yet activation
      // is a foreground excursion within the task's approval.
      const result = await call("computer_activate_window", {
        window_id: "fake-calculator",
      });
      expect(result.isError).not.toBe(true);
      expect(approval).toHaveBeenCalledWith(
        "computer_activate_window",
        expect.objectContaining({ delivery_mode: "foreground" }),
        expect.anything(),
        expect.anything(),
      );
      // The whole excursion — raise plus restore — runs in foreground scope.
      expect(deliveryModes).toEqual(["foreground", "foreground"]);
      expect(backend.callsFor("raiseWindow").map((entry) => entry.args[0])).toEqual([
        "fake-calculator",
        "fake-terminal",
      ]);
      expect(resultJson(result)).toMatchObject({
        action: "computer_activate_window",
        windowId: "fake-calculator",
      });
    } finally {
      await manager.dispose();
    }
  });

  it("touches nothing when approval refuses the activate", async () => {
    const backend = new FakeComputerBackend();
    const approval = vi.fn(async () => false);
    const { call, manager } = await setup(backend, approval);
    try {
      const refused = await call("computer_activate_window", {
        window_id: "fake-calculator",
      });
      expect(refused.isError).toBe(true);
      expect(backend.callsFor("raiseWindow")).toHaveLength(0);
      expect(backend.callsFor("focusWindow")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });
});

describe("computer_inspect", () => {
  // The route is provider-agnostic; one gated and one gate-less provider cover
  // both approval branches.
  it.each(["claudeAgent", "pi"] as const)(
    "preserves specialist reads and image results for %s",
    async (provider) => {
      const authorize = vi.fn<NonNullable<AgentGatewayComputerToolsOptions["authorizeAction"]>>(
        async () => true,
      );
      const { backend, manager, byName, call } = await setup(new FakeComputerBackend(), authorize);
      try {
        const inspector = byName.get("computer_inspect")!;
        expect(inspector.discoveryOnly).not.toBe(true);
        expect(inspector.requiredCapability).toBe("computer:control");
        expect(inspector.requiresActiveTurn).toBe(true);
        expect(inspector.definition.annotations?.readOnlyHint).toBe(false);
        for (const [tool, args] of [
          ["computer_read_clipboard", {}],
          ["computer_get_accessibility_tree", { window_id: "fake-calculator" }],
          ["computer_get_cursor_position", { window_id: "fake-calculator" }],
          ["computer_zoom", { window_id: "fake-calculator", x: 0, y: 0, width: 40, height: 40 }],
        ] as const) {
          const help = resultJson(await call("computer_help", { tool }, provider)) as {
            inspection: { name: string; tool: string };
          };
          const result = await call(
            help.inspection.name,
            { tool: help.inspection.tool, arguments: args },
            provider,
          );
          expect(result.isError, tool).not.toBe(true);
          if (tool === "computer_zoom") {
            expect(
              result.content.some(
                (item) => item.type === "image" && item.mimeType === "image/jpeg",
              ),
            ).toBe(true);
            const payload = resultJson(result) as { zoom: unknown };
            expect(payload.zoom).toMatchObject({ windowId: "fake-calculator" });
            expect(JSON.stringify(payload)).not.toContain("bytesBase64");
            expect(JSON.stringify(payload)).not.toContain("screenshotId");
          }
        }
        expect(authorize).toHaveBeenCalledTimes(1);
        expect(authorize.mock.calls[0]?.[0]).toBe("computer_read_clipboard");
        for (const method of [
          "readClipboard",
          "getAccessibilityTree",
          "getCursorPosition",
          "zoomWindow",
        ]) {
          expect(backend.callsFor(method), method).toHaveLength(1);
        }
        expect(backend.callsFor("captureScreenshot")).toHaveLength(0);
      } finally {
        await manager.dispose();
      }
    },
  );

  it("refuses unknown routes, invalid schemas and extra fields before any backend call", async () => {
    const authorize = vi.fn(async () => true);
    const { backend, manager, call } = await setup(new FakeComputerBackend(), authorize);
    try {
      for (const args of [
        { tool: "computer_click", arguments: { x: 2, y: 3 } },
        { tool: "computer_inspect", arguments: { tool: "computer_read_clipboard" } },
        { tool: "computer_future" },
        { tool: "mcp__synara__computer_read_clipboard" },
        { tool: "computer_read_clipboard", arguments: { text: "private" } },
        { tool: "computer_read_clipboard", arguments: [] },
        { tool: "computer_read_clipboard", arguments: null },
        { tool: "computer_get_cursor_position", arguments: { window_id: 42 } },
        { tool: "computer_zoom", arguments: { window_id: "fake-calculator" } },
        {
          tool: "computer_zoom",
          arguments: { window_id: "fake-calculator", x: "1", y: 0, width: 4, height: 4 },
        },
        {
          tool: "computer_zoom",
          arguments: { window_id: "fake-calculator", x: 1, y: 0, width: Infinity, height: 4 },
        },
        { tool: "computer_get_accessibility_tree", delivery_mode: "foreground" },
      ]) {
        expect((await call("computer_inspect", args)).isError).toBe(true);
      }
      expect(backend.calls).toHaveLength(0);
      expect(authorize).not.toHaveBeenCalled();
    } finally {
      await manager.dispose();
    }
  });

  it("retains clipboard refusal and dead-turn checks before dispatch", async () => {
    const authorize = vi.fn(async () => false);
    const { backend, manager, byName, call } = await setup(new FakeComputerBackend(), authorize);
    try {
      expect((await call("computer_inspect", { tool: "computer_read_clipboard" })).isError).toBe(
        true,
      );
      expect(authorize).toHaveBeenCalledTimes(1);
      const inactive = {
        ...makeContext(),
        assertCallerTurnActive: () =>
          Effect.fail(new GatewayToolError("caller_turn_inactive", "The requesting turn ended.")),
      };
      const result = await Effect.runPromise(
        byName.get("computer_inspect")!.handler({ tool: "computer_get_cursor_position" }, inactive),
      );
      expect(result.isError).toBe(true);
      expect(backend.callsFor("readClipboard")).toHaveLength(0);
      expect(backend.callsFor("getCursorPosition")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("passes cancellation to a pending canonical clipboard approval", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let approvalSignal: AbortSignal | undefined;
    const authorize: NonNullable<AgentGatewayComputerToolsOptions["authorizeAction"]> = async (
      _name,
      _args,
      _context,
      signal,
    ) => {
      approvalSignal = signal;
      entered();
      return new Promise<boolean>((resolve) =>
        signal.addEventListener("abort", () => resolve(false), { once: true }),
      );
    };
    const { backend, manager, byName } = await setup(new FakeComputerBackend(), authorize);
    const controller = new AbortController();
    try {
      const pending = Effect.runPromise(
        byName.get("computer_inspect")!.handler({ tool: "computer_read_clipboard" }, makeContext()),
        { signal: controller.signal },
      );
      const outcome = pending.catch(() => "cancelled");
      await started;
      controller.abort();
      expect(await outcome).toBe("cancelled");
      expect(approvalSignal?.aborted).toBe(true);
      expect(backend.callsFor("readClipboard")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });
});

describe("computer_run", () => {
  it("reports the active step instead of one generic batch label", async () => {
    const { manager, call } = await setup();
    const activity = vi.spyOn(manager.cursorActivity, "during");
    try {
      const result = await call("computer_run", {
        steps: [
          { type: "click", label: "Display", window_id: "fake-calculator" },
          { type: "type_text", text: "468", window_id: "fake-calculator" },
          { type: "write_clipboard", text: "copied value" },
        ],
      });
      expect(result.isError).not.toBe(true);
      expect(activity.mock.calls.map((call) => call[1])).toEqual([
        "Running sequence",
        "Clicking",
        "Typing",
        "Writing clipboard",
      ]);
    } finally {
      await manager.dispose();
    }
  });

  it("runs steps in order through the same manager calls and closes with fresh state", async () => {
    const { backend, manager, call } = await setup();
    try {
      const result = await call("computer_run", {
        steps: [
          { type: "click", label: "Display", window_id: "fake-calculator" },
          { type: "type_text", text: "468", window_id: "fake-calculator" },
          { type: "select_text", label: "Display", start: 0, length: 2 },
          { type: "press_key", key: "enter", window_id: "fake-calculator" },
        ],
      });
      expect(result.isError).not.toBe(true);
      const payload = resultJson(result) as {
        steps: {
          step: number;
          type: string;
          ok: boolean;
          result?: Record<string, unknown>;
        }[];
        completed: number;
        stopped: boolean;
        state: { elements: { label: string }[]; elementWindowId?: string };
      };
      expect(payload.completed).toBe(4);
      expect(payload.stopped).toBe(false);
      expect(payload.steps.map((entry) => [entry.step, entry.type, entry.ok])).toEqual([
        [0, "click", true],
        [1, "type_text", true],
        [2, "select_text", true],
        [3, "press_key", true],
      ]);
      // computerId rides once on the envelope, not on every step.
      for (const entry of payload.steps) expect(entry.result).not.toHaveProperty("computerId");
      expect(payload.state.elements.map((element) => element.label)).toContain("Display");
      // The closing state's listing is one window: id hoisted, as in get_state.
      expect(payload.state.elementWindowId).toBe("fake-calculator");
      expect(backend.callsFor("click")).toHaveLength(1);
      expect(backend.callsFor("typeText").map((entry) => entry.args[0])).toEqual(["468"]);
      expect(backend.callsFor("selectText").map((entry) => entry.args[1])).toEqual([
        { start: 0, length: 2 },
      ]);
      expect(backend.callsFor("pressKey")).toHaveLength(1);
    } finally {
      await manager.dispose();
    }
  });

  it("stops at the first failure and reports which step and why", async () => {
    const { backend, manager, call } = await setup();
    backend.failNext("typeText", new ComputerBackendError("seat unavailable"));
    try {
      const result = await call("computer_run", {
        steps: [
          { type: "click", label: "Display", window_id: "fake-calculator" },
          { type: "type_text", text: "1" },
          { type: "press_key", key: "enter" },
        ],
      });
      expect(result.isError).not.toBe(true);
      const payload = resultJson(result) as {
        steps: { step: number; ok: boolean; error?: { message?: string } }[];
        completed: number;
        stopped: boolean;
      };
      expect(payload.stopped).toBe(true);
      expect(payload.completed).toBe(1);
      expect(payload.steps).toHaveLength(2);
      expect(payload.steps[1]).toMatchObject({
        step: 1,
        type: "type_text",
        ok: false,
        error: { message: "seat unavailable" },
      });
      // The third step never dispatched.
      expect(backend.callsFor("pressKey")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("refuses a malformed batch whole, before anything dispatches", async () => {
    const { backend, manager, call } = await setup();
    try {
      for (const steps of [
        [{ type: "click", label: "Display" }, { type: "levitate" }],
        [{ type: "type_text", text: "hi", bogus: true }],
        [{ type: "type_text" }],
        [{ type: "click", label: "Display" }, 42],
      ]) {
        const result = await call("computer_run", { steps });
        expect(result.isError).toBe(true);
      }
      expect(backend.callsFor("click")).toHaveLength(0);
      expect(backend.callsFor("typeText")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("caps the step count", async () => {
    const { backend, manager, call } = await setup();
    try {
      const result = await call("computer_run", {
        steps: Array.from({ length: 26 }, () => ({
          type: "press_key",
          key: "enter",
        })),
      });
      expect(result.isError).toBe(true);
      expect(backend.callsFor("pressKey")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("asks approval once for the declared list and dispatches nothing when refused", async () => {
    const backend = new FakeComputerBackend();
    const approval = vi.fn(async (_name: string) => false);
    const { call, manager } = await setup(backend, approval);
    try {
      const refused = await call("computer_run", {
        steps: [{ type: "click", label: "Display", window_id: "fake-calculator" }],
      });
      expect(refused.isError).toBe(true);
      expect(approval).toHaveBeenCalledTimes(1);
      expect(approval.mock.calls[0]?.[0]).toBe("computer_run");
      expect(backend.callsFor("click")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("scopes only the activate_window step to foreground delivery", async () => {
    const backend = new FakeComputerBackend();
    const modes: string[] = [];
    const raise = backend.raiseWindow.bind(backend);
    backend.raiseWindow = async (windowId: string) => {
      modes.push(desktopDeliveryMode());
      return raise(windowId);
    };
    const click = backend.click.bind(backend);
    backend.click = async (point) => {
      modes.push(desktopDeliveryMode());
      return click(point);
    };
    const { call, manager } = await setup(backend);
    try {
      const result = await call("computer_run", {
        steps: [
          { type: "activate_window", window_id: "fake-calculator" },
          { type: "click", label: "Display", window_id: "fake-calculator" },
        ],
      });
      expect(result.isError).not.toBe(true);
      // raise + restore are foreground; everything the click path touches —
      // its own window aim included — stays in the batch's background mode.
      expect(modes.slice(0, 2)).toEqual(["foreground", "foreground"]);
      expect(modes.slice(2).every((mode) => mode === "background")).toBe(true);
      expect(modes.length).toBeGreaterThan(2);
      // The restore re-covered the calculator, so the click restacks its own
      // target — required on a compositing backend for the point to route.
      expect(backend.callsFor("raiseWindow").map((entry) => entry.args[0])).toEqual([
        "fake-calculator",
        "fake-terminal",
        "fake-calculator",
      ]);
    } finally {
      await manager.dispose();
    }
  });

  it("waits for a label mid-run and resolves fresh targets per step", async () => {
    const { backend, manager, call } = await setup();
    try {
      const result = await call("computer_run", {
        steps: [
          {
            type: "wait",
            duration_ms: 5_000,
            label: "Display",
            window_id: "fake-calculator",
          },
          {
            type: "set_value",
            label: "Display",
            window_id: "fake-calculator",
            value: "42",
          },
        ],
      });
      expect(result.isError).not.toBe(true);
      const payload = resultJson(result) as {
        steps: { ok: boolean; result?: unknown }[];
      };
      expect(payload.steps[0]).toMatchObject({
        ok: true,
        result: { status: "ready" },
      });
      expect(payload.steps[1]).toMatchObject({ ok: true });
      expect(backend.callsFor("setValue")).toHaveLength(1);
    } finally {
      await manager.dispose();
    }
  });

  it("carries model-observation authority on its internal reads", async () => {
    const backend = new FakeComputerBackend();
    const observed: boolean[] = [];
    const getState = backend.getState.bind(backend);
    backend.getState = async (options) => {
      observed.push(isModelDesktopObservationActive());
      return getState(options);
    };
    const { call, manager } = await setup(backend);
    try {
      const result = await call("computer_run", {
        steps: [
          {
            type: "wait",
            duration_ms: 2_000,
            label: "Display",
            window_id: "fake-calculator",
          },
        ],
      });
      expect(result.isError).not.toBe(true);
      // The wait-step poll and the closing state read both ran as model
      // observations — they satisfy a pending post-resume observation gate.
      expect(observed.length).toBeGreaterThanOrEqual(2);
      expect(observed.every(Boolean)).toBe(true);
    } finally {
      await manager.dispose();
    }
  });

  it("propagates a dead turn instead of reporting a half-run as data", async () => {
    const { backend, manager, byName } = await setup();
    let checks = 0;
    const context = {
      ...makeContext(),
      assertCallerTurnActive: () => {
        checks += 1;
        return checks <= 2
          ? Effect.void
          : Effect.fail(new GatewayToolError("caller_turn_inactive", "The requesting turn ended."));
      },
    };
    try {
      const result = await Effect.runPromise(
        byName.get("computer_run")!.handler(
          {
            steps: [
              { type: "click", label: "Display", window_id: "fake-calculator" },
              { type: "type_text", text: "1" },
            ],
          },
          context,
        ),
      );
      expect(result.isError).toBe(true);
      // The turn died before step two: one click dispatched, nothing typed.
      expect(backend.callsFor("click")).toHaveLength(1);
      expect(backend.callsFor("typeText")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("attaches a final screenshot of the affected window when asked", async () => {
    const { backend, manager, call } = await setup();
    try {
      const result = await call("computer_run", {
        steps: [{ type: "click", label: "Display", window_id: "fake-calculator" }],
        include_screenshot: true,
      });
      expect(result.isError).not.toBe(true);
      expect(result.content.some((entry) => entry.type === "image")).toBe(true);
      expect(resultJson(result)).toMatchObject({
        screenshot: { windowId: "fake-calculator" },
      });
    } finally {
      await manager.dispose();
    }
  });
});

describe("computer_paste", () => {
  it("saves, pastes, and restores the shared clipboard", async () => {
    const { backend, manager, call } = await setup();
    try {
      await call("computer_write_clipboard", { text: "keep me" });
      const result = await call("computer_paste", {
        text: "pasted text",
        window_id: "fake-calculator",
      });
      expect(result.isError).not.toBe(true);
      expect(resultJson(result)).toMatchObject({
        action: "computer_paste",
        clipboardRestored: true,
      });
      expect(backend.callsFor("hotkey").map((entry) => entry.args[0])).toEqual([["ctrl", "v"]]);
      const clipboard = resultJson(await call("computer_read_clipboard", {})) as {
        value: string;
      };
      expect(clipboard.value).toBe("keep me");
    } finally {
      await manager.dispose();
    }
  });

  it("uses the Command chord on a macOS backend", async () => {
    const backend = Object.assign(new FakeComputerBackend(), {
      agentDialect: "macos" as const,
    });
    const { call, manager } = await setup(backend);
    try {
      const result = await call("computer_paste", {
        text: "payload",
        window_id: "fake-calculator",
      });
      expect(result.isError).not.toBe(true);
      expect(backend.callsFor("hotkey").map((entry) => entry.args[0])).toEqual([["meta", "v"]]);
    } finally {
      await manager.dispose();
    }
  });

  it("still restores the clipboard when the paste dispatch fails", async () => {
    const { backend, manager, call } = await setup();
    try {
      await call("computer_write_clipboard", { text: "user text" });
      backend.failNext("hotkey");
      const result = await call("computer_paste", {
        text: "agent text",
        window_id: "fake-calculator",
      });
      expect(result.isError).toBe(true);
      expect(backend.callsFor("writeClipboard").map((entry) => entry.args[0])).toEqual([
        "user text",
        "agent text",
        "user text",
      ]);
    } finally {
      await manager.dispose();
    }
  });
});

describe("computer_get_state diff", () => {
  it("reports the first scoped read as all-added, then only the value that moved", async () => {
    const { manager, call } = await setup();
    try {
      const baseline = resultJson(
        await call("computer_get_state", {
          window_id: "fake-calculator",
          diff: true,
        }),
      ) as {
        elementChanges: {
          added: { label: string }[];
          removed: unknown[];
          changed: unknown[];
        };
      };
      expect(baseline.elementChanges.added.map((item) => item.label).sort()).toEqual([
        "Calculate",
        "Display",
      ]);
      expect(baseline.elementChanges.removed).toEqual([]);
      expect(baseline.elementChanges.changed).toEqual([]);

      // Change outside the tool surface so its automatic diff does not move this baseline.
      await manager.setValue(THREAD, { label: "Display", windowId: "fake-calculator" }, "468");
      const diff = resultJson(
        await call("computer_get_state", {
          window_id: "fake-calculator",
          diff: true,
        }),
      ) as {
        elements?: unknown;
        elementWindowId?: string;
        elementChanges: {
          added: unknown[];
          removed: unknown[];
          changed: unknown[];
        };
      };
      expect(diff.elements).toBeUndefined();
      // The changed entries all belong to one window, so its id is reported
      // once instead of on every entry.
      expect(diff.elementWindowId).toBe("fake-calculator");
      expect(diff.elementChanges).toEqual({
        added: [],
        removed: [],
        changed: [
          {
            ref: 1,
            role: "text-field",
            label: "Display",
            was: "0",
            value: "468",
          },
        ],
      });
      // And a steady third read reports nothing at all.
      const steady = resultJson(
        await call("computer_get_state", {
          window_id: "fake-calculator",
          diff: true,
        }),
      ) as {
        elementChanges: {
          added: unknown[];
          removed: unknown[];
          changed: unknown[];
        };
      };
      expect(steady.elementChanges).toEqual({
        added: [],
        removed: [],
        changed: [],
      });
    } finally {
      await manager.dispose();
    }
  });

  it("keeps scopes apart so a windowed read does not diff the desktop digest", async () => {
    const { manager, call } = await setup();
    try {
      await call("computer_get_state", { window_id: "fake-calculator" });
      // A different scope has its own baseline: this is a first read, not a diff.
      const other = resultJson(await call("computer_get_state", { diff: true })) as {
        elementChanges: { added: unknown[] };
      };
      expect(other.elementChanges.added.length).toBeGreaterThan(0);
    } finally {
      await manager.dispose();
    }
  });
});

describe("computer action element diffs", () => {
  const windowId = "fake-calculator";
  const tree = (
    labels: readonly string[],
    value = "before",
    truncated = false,
  ): ComputerUiNode => ({
    role: "window",
    label: null,
    value: null,
    description: null,
    frame: { x: 100, y: 100, width: 900, height: 700 },
    activationPoint: null,
    onScreen: true,
    windowId,
    truncated,
    children: labels.map((label) => ({
      role: "text-field",
      label,
      value,
      description: null,
      frame: { x: 120, y: 120, width: 100, height: 30 },
      activationPoint: null,
      onScreen: true,
      windowId,
      children: [],
    })),
  });

  it("attaches a click diff, preserves delivery, and advances the baseline without a screenshot", async () => {
    const { backend, manager, call } = await setup(
      new FakeComputerBackend({ root: tree(["Field"]) }),
    );
    try {
      await call("computer_get_state", { window_id: windowId });
      const read = vi.spyOn(backend, "getState");
      const click = vi.spyOn(manager, "click");
      const originalClick = backend.click.bind(backend);
      vi.spyOn(backend, "click").mockImplementation(async (...args) => {
        const result = await originalClick(...args);
        const state = await backend.getState({ includeTree: true });
        read.mockResolvedValue({ ...state, root: tree(["Field"], "after") });
        return {
          ...result,
          deliveryPath: "ax",
          verified: "unverifiable",
          effect: "dispatched-unknown",
        };
      });
      const response = await call("computer_click", {
        window_id: windowId,
        label: "Field",
        include_screenshot: false,
      });
      const result = resultJson(response);
      expect(result).toMatchObject({
        elementWindowId: windowId,
        elementChanges: {
          added: [],
          removed: [],
          changed: [{ label: "Field", was: "before", value: "after", ref: 0 }],
        },
        delivery: (await click.mock.results[0]!.value).delivery,
      });
      expect(response.content.every((part) => part.type === "text")).toBe(true);
      expect(read).toHaveBeenLastCalledWith(
        expect.objectContaining({ includeTree: true, includeScreenshot: false, windowId }),
      );
      expect(backend.calls.filter((entry) => entry.method === "captureScreenshot")).toHaveLength(0);
      expect(
        resultJson(await call("computer_get_state", { window_id: windowId, diff: true })),
      ).toMatchObject({
        elementChanges: { added: [], removed: [], changed: [] },
      });
    } finally {
      await manager.dispose();
    }
  });

  it.each(["none", "filtered", "other-window", "other-thread"])(
    "attaches nothing with a %s baseline",
    async (scope) => {
      const { manager, call } = await setup();
      try {
        if (scope !== "none")
          await call(
            "computer_get_state",
            {
              window_id: scope === "other-window" ? "fake-editor" : windowId,
              ...(scope === "filtered" ? { label_contains: "Display" } : {}),
            },
            undefined,
            scope === "other-thread" ? "other-thread" : THREAD,
          );
        const read = vi.spyOn(manager, "getState");
        const result = resultJson(
          await call("computer_set_value", {
            window_id: windowId,
            label: "Display",
            value: "123",
            include_screenshot: false,
          }),
        );
        expect(result).not.toHaveProperty("elementChanges");
        expect(read).not.toHaveBeenCalled();
      } finally {
        await manager.dispose();
      }
    },
  );

  it.each([
    ["computer_type_text", { text: "hello there" }],
    ["computer_invoke_menu", { path: ["File", "Save"] }],
  ])("attaches a scoped diff for %s", async (tool, args) => {
    const { manager, call } = await setup(new FakeComputerBackend(), async () => true);
    try {
      await call("computer_get_state", { window_id: windowId });
      const result = await call(tool, { ...args, window_id: windowId, include_screenshot: false });
      expect(result.isError).not.toBe(true);
      expect(resultJson(result)).toHaveProperty("elementChanges");
    } finally {
      await manager.dispose();
    }
  });

  it("propagates cancellation during the action tree read", async () => {
    const { manager, call, byName } = await setup();
    const controller = new AbortController();
    try {
      await call("computer_get_state", { window_id: windowId });
      const state = await manager.getState({ windowId, includeTree: true });
      vi.spyOn(manager, "getState").mockImplementation(async () => {
        controller.abort();
        return state;
      });
      await expect(
        Effect.runPromise(
          byName.get("computer_click")!.handler(
            {
              window_id: windowId,
              label: "Calculate",
              include_screenshot: false,
            },
            makeContext(),
          ),
          { signal: controller.signal },
        ),
      ).rejects.toThrow();
    } finally {
      await manager.dispose();
    }
  });

  it("caps added, removed and changed entries together and counts omissions", async () => {
    const labels = Array.from({ length: 40 }, (_, i) => `Field ${i}`);
    const { backend, manager, call } = await setup(new FakeComputerBackend({ root: tree(labels) }));
    try {
      await call("computer_get_state", { window_id: windowId });
      const original = backend.getState.bind(backend);
      vi.spyOn(backend, "getState").mockImplementation(async (args) => ({
        ...(await original(args)),
        root: tree(
          [...labels.slice(0, 20), ...Array.from({ length: 25 }, (_, i) => `New ${i}`)],
          "after",
        ),
      }));
      const result = resultJson(
        await call("computer_press_key", {
          window_id: windowId,
          key: "tab",
          include_screenshot: false,
        }),
      ) as {
        elementChanges: { added: unknown[]; removed: { ref?: number }[]; changed: unknown[] };
        elementChangesOmitted: number;
      };
      expect(Object.values(result.elementChanges).flat()).toHaveLength(40);
      expect(result.elementChangesOmitted).toBe(25);
      expect(result.elementChanges.removed.every((entry) => entry.ref === undefined)).toBe(true);
    } finally {
      await manager.dispose();
    }
  });

  it.each(["before", "after"])("marks a truncated %s tree as incomplete", async (side) => {
    const { backend, manager, call } = await setup(
      new FakeComputerBackend({ root: tree(["Field"], "before", side === "before") }),
    );
    try {
      await call("computer_get_state", { window_id: windowId });
      const state = await backend.getState({});
      vi.spyOn(backend, "getState").mockResolvedValue({
        ...state,
        root: tree(["Field"], "after", side === "after"),
      });
      expect(
        resultJson(
          await call("computer_press_key", {
            window_id: windowId,
            key: "tab",
            include_screenshot: false,
          }),
        ),
      ).toHaveProperty("elementChangesIncomplete", true);
    } finally {
      await manager.dispose();
    }
  });

  it("returns the unchanged action result if the tree read fails", async () => {
    const { manager, call } = await setup();
    try {
      await call("computer_get_state", { window_id: windowId });
      const action = vi.spyOn(manager, "click");
      vi.spyOn(manager, "getState").mockRejectedValue(new Error("tree unavailable"));
      const result = resultJson(
        await call("computer_click", {
          window_id: windowId,
          label: "Calculate",
          include_screenshot: false,
        }),
      ) as Record<string, unknown>;
      const { disclosure: _disclosure, ...payload } = result;
      expect(payload).toEqual(await action.mock.results[0]!.value);
    } finally {
      await manager.dispose();
    }
  });

  it("attaches one final batch diff without per-step observations", async () => {
    const { manager, call } = await setup();
    try {
      await call("computer_get_state", { window_id: windowId });
      const read = vi.spyOn(manager, "getState");
      const result = resultJson(
        await call("computer_run", {
          steps: [
            { type: "set_value", window_id: windowId, label: "Display", value: "1" },
            { type: "set_value", window_id: windowId, label: "Display", value: "12" },
          ],
        }),
      ) as { steps: { result: unknown }[] };
      expect(result).toMatchObject({
        elementChanges: {
          added: [],
          removed: [],
          changed: [{ label: "Display", was: "0", value: "12" }],
        },
      });
      expect(result.steps).toHaveLength(2);
      for (const step of result.steps) expect(step.result).not.toHaveProperty("elementChanges");
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      await manager.dispose();
    }
  });
});

describe("computer_get_state app hint", () => {
  it("attaches a verified note once per thread for a scoped app read", async () => {
    const backend = new FakeComputerBackend({
      windows: [
        {
          id: "slack-window",
          title: "general - Slack",
          appName: "Slack",
          bounds: { x: 10, y: 10, width: 900, height: 700 },
          focused: true,
          minimized: false,
          visible: true,
        },
      ],
    });
    const { call, manager } = await setup(backend);
    try {
      const first = resultJson(await call("computer_get_state", { window_id: "slack-window" })) as {
        appHint?: string;
      };
      expect(first.appHint).toContain("set_value");
      const second = resultJson(
        await call("computer_get_state", { window_id: "slack-window" }),
      ) as { appHint?: string };
      expect(second.appHint).toBeUndefined();
      // A second thread has not seen it.
      const other = resultJson(
        await call("computer_get_state", { window_id: "slack-window" }, undefined, "other-thread"),
      ) as { appHint?: string };
      expect(other.appHint).toContain("set_value");
    } finally {
      await manager.dispose();
    }
  });
});

describe("multi-app driving", () => {
  describe("native driver parity tools", () => {
    it("lists apps, verifies state, and zooms without approval or dispatch", async () => {
      const { backend, manager, call } = await setup();
      try {
        const apps = await call("computer_list_apps", {});
        expect(apps.isError).not.toBe(true);
        const appList = resultJson(apps) as { apps: { pid: number; name: string }[] };
        expect(appList.apps.map((app) => app.pid)).toContain(1002);

        const verified = await call("computer_verify_state", {
          window_id: "fake-calculator",
          expect: [{ window: { bounds: { x: 1050, y: 120, tolerance_px: 4 } } }],
        });
        expect(verified.isError).not.toBe(true);
        expect(resultJson(verified)).toMatchObject({ status: "satisfied" });
        expect(backend.callsFor("verifyState").map((entry) => entry.args[0])).toEqual([
          "fake-calculator",
        ]);

        backend.setVerifySatisfied(false);
        const unsatisfied = await call("computer_verify_state", {
          window_id: "fake-calculator",
          expect: [{ element: { selector: { role: "AXButton" }, exists: true } }],
        });
        expect(resultJson(unsatisfied)).toMatchObject({ status: "unsatisfied" });

        const zoomed = await call("computer_zoom", {
          window_id: "fake-calculator",
          x: 10,
          y: 10,
          width: 100,
          height: 80,
        });
        expect(zoomed.isError).not.toBe(true);
        expect(zoomed.content.map((entry) => entry.type)).toEqual(["text", "image"]);
        expect(zoomed.content[1]).toMatchObject({ mimeType: "image/jpeg" });
        // The magnified frame must not become a coordinate frame: a click aimed
        // from it would land off-target.
        expect(resultJson(zoomed)).not.toHaveProperty("screenshot.screenshotId");

        const outOfBounds = await call("computer_zoom", {
          window_id: "fake-calculator",
          x: 400,
          y: 0,
          width: 100,
          height: 80,
        });
        expect(outOfBounds.isError).toBe(true);
      } finally {
        await manager.dispose();
      }
    });

    it("asks approval before invoking menus and force-quitting, dispatching nothing when refused", async () => {
      const backend = new FakeComputerBackend();
      const approval = vi.fn(async () => false);
      const { call, manager } = await setup(backend, approval);
      try {
        for (const [name, args] of [
          ["computer_invoke_menu", { window_id: "fake-calculator", path: ["File", "Save"] }],
          ["computer_kill_app", { window_id: "fake-calculator" }],
        ] as const) {
          const refused = await call(name, args);
          expect(refused.isError).toBe(true);
        }
        expect(backend.callsFor("invokeMenu")).toHaveLength(0);
        expect(backend.callsFor("killApp")).toHaveLength(0);
        expect(approval.mock.calls.map((entry) => (entry as unknown[])[0])).toEqual([
          "computer_invoke_menu",
          "computer_kill_app",
        ]);
      } finally {
        await manager.dispose();
      }
    });

    it("resolves kill_app's window to its owning pid before dispatch", async () => {
      const backend = new FakeComputerBackend();
      const { call, manager } = await setup(
        backend,
        vi.fn(async () => true),
      );
      try {
        const killed = await call("computer_kill_app", { window_id: "fake-calculator" });
        expect(killed.isError).not.toBe(true);
        expect(backend.callsFor("killApp").map((entry) => entry.args[0])).toEqual([1002]);
        // The closed window leaves the list: the next call names the miss.
        const gone = await call("computer_kill_app", { window_id: "fake-calculator" });
        expect(gone.isError).toBe(true);
        expect(backend.callsFor("killApp")).toHaveLength(1);
      } finally {
        await manager.dispose();
      }
    });

    it("runs the window-management steps through computer_run in order", async () => {
      const backend = new FakeComputerBackend();
      const { call, manager } = await setup(
        backend,
        vi.fn(async () => true),
      );
      try {
        const result = await call("computer_run", {
          steps: [
            {
              type: "set_window_frame",
              window_id: "fake-calculator",
              x: 50,
              y: 60,
              width: 500,
              height: 400,
            },
            { type: "invoke_menu", window_id: "fake-calculator", path: ["File", "Save"] },
            { type: "kill_app", window_id: "fake-calculator" },
          ],
        });
        expect(result.isError).not.toBe(true);
        const payload = resultJson(result) as {
          steps: { step: number; type: string; ok: boolean }[];
          completed: number;
        };
        expect(payload.steps.map((entry) => [entry.step, entry.type, entry.ok])).toEqual([
          [0, "set_window_frame", true],
          [1, "invoke_menu", true],
          [2, "kill_app", true],
        ]);
        expect(payload.completed).toBe(3);
        expect(backend.callsFor("setWindowFrame").map((entry) => entry.args[0])).toEqual([
          "fake-calculator",
        ]);
        expect(backend.callsFor("invokeMenu").map((entry) => entry.args[1])).toEqual([
          ["File", "Save"],
        ]);
        expect(backend.callsFor("killApp").map((entry) => entry.args[0])).toEqual([1002]);
      } finally {
        await manager.dispose();
      }
    });

    it("invokes a windowless app's menu from its live pid, attributed to the app", async () => {
      const backend = new FakeComputerBackend({
        apps: [
          {
            pid: 6_001,
            name: "Helium",
            bundleId: "net.imput.helium",
            running: true,
            active: false,
          },
          {
            pid: 1_001,
            name: "Terminal",
            bundleId: "org.kde.konsole",
            running: true,
            active: true,
          },
          {
            pid: 1_002,
            name: "Calculator",
            bundleId: "org.kde.kcalc",
            running: true,
            active: false,
          },
        ],
      });
      const approval = vi.fn(
        async (
          _name: string,
          _args: Record<string, unknown>,
          _context: unknown,
          _signal: unknown,
        ) => true,
      );
      const { call, manager } = await setup(backend, approval);
      try {
        const result = await call("computer_invoke_menu", {
          app: "Helium",
          path: ["File", "New Window"],
        });
        expect(result.isError).not.toBe(true);
        // The app name resolved to its live pid, and no window id rides the
        // dispatch — the driver's windowless contract, exactly.
        const dispatched = backend.callsFor("invokeMenu").at(-1)?.args[0] as Record<
          string,
          unknown
        >;
        expect(dispatched).toEqual({ pid: 6_001 });
        expect(dispatched).not.toHaveProperty("window_id");
        expect(resultJson(result)).not.toHaveProperty("windowId");
        expect(approval).toHaveBeenCalledOnce();
      } finally {
        await manager.dispose();
      }
    });

    it("refuses a menu call that names no target or two different routes", async () => {
      const backend = new FakeComputerBackend();
      const { call, manager } = await setup(
        backend,
        vi.fn(async () => true),
      );
      const textOf = (result: McpToolCallResult) => {
        const text = result.content.find((entry) => entry.type === "text");
        return text?.type === "text" ? text.text : "";
      };
      try {
        const none = await call("computer_invoke_menu", { path: ["File"] });
        expect(none.isError).toBe(true);
        expect(textOf(none)).toContain("Name the target one way");
        const two = await call("computer_invoke_menu", {
          window_id: "fake-terminal",
          app: "Terminal",
          path: ["File"],
        });
        expect(two.isError).toBe(true);
        expect(textOf(two)).toContain("exactly one");
        expect(backend.callsFor("invokeMenu")).toHaveLength(0);
      } finally {
        await manager.dispose();
      }
    });

    it("runs a windowless app menu step through computer_run", async () => {
      const backend = new FakeComputerBackend({
        apps: [
          {
            pid: 6_001,
            name: "Helium",
            bundleId: "net.imput.helium",
            running: true,
            active: false,
          },
          {
            pid: 1_001,
            name: "Terminal",
            bundleId: "org.kde.konsole",
            running: true,
            active: true,
          },
        ],
      });
      const { call, manager } = await setup(
        backend,
        vi.fn(async () => true),
      );
      try {
        const result = await call("computer_run", {
          steps: [{ type: "invoke_menu", app: "Helium", path: ["File", "New Window"] }],
        });
        expect(result.isError).not.toBe(true);
        const payload = resultJson(result) as { completed: number };
        expect(payload.completed).toBe(1);
        expect(backend.callsFor("invokeMenu").at(-1)?.args).toEqual([
          { pid: 6_001 },
          ["File", "New Window"],
        ]);
      } finally {
        await manager.dispose();
      }
    });

    it("refuses run steps with missing or oversized arguments whole", async () => {
      const backend = new FakeComputerBackend();
      const { call, manager } = await setup(
        backend,
        vi.fn(async () => true),
      );
      try {
        for (const steps of [
          [
            {
              type: "set_window_frame",
              window_id: "fake-calculator",
              x: 0,
              y: 0,
              width: 0,
              height: 5,
            },
          ],
          [{ type: "set_window_frame", x: 0, y: 0, width: 5, height: 5 }],
          [{ type: "invoke_menu", window_id: "fake-calculator", path: [] }],
          [{ type: "invoke_menu", window_id: "fake-calculator" }],
          [{ type: "kill_app" }],
        ]) {
          const result = await call("computer_run", { steps });
          expect(result.isError).toBe(true);
        }
        expect(backend.callsFor("setWindowFrame")).toHaveLength(0);
        expect(backend.callsFor("invokeMenu")).toHaveLength(0);
        expect(backend.callsFor("killApp")).toHaveLength(0);
      } finally {
        await manager.dispose();
      }
    });
  });

  describe("SYNARA_CUA_CAPTURE_REUSE", () => {
    const FLAG = "SYNARA_CUA_CAPTURE_REUSE";
    let savedFlag: string | undefined;

    const setFlag = (value: string | undefined) => {
      if (savedFlag === undefined) savedFlag = process.env[FLAG];
      if (value === undefined) delete process.env[FLAG];
      else process.env[FLAG] = value;
    };

    afterEach(() => {
      if (savedFlag !== undefined) process.env[FLAG] = savedFlag;
      else delete process.env[FLAG];
      savedFlag = undefined;
    });

    const imageParts = (result: McpToolCallResult) =>
      result.content.filter((entry) => entry.type === "image").length;

    it("ships a fresh image for every read under the kill switch, even a byte-identical one", async () => {
      setFlag("0");
      const { call, see, manager } = await setup();
      try {
        const first = await see();
        const second = await call("computer_get_state", { include_screenshot: true });
        const payload = resultJson(second) as { screenshot: { screenshotId: string } };
        expect(payload.screenshot.screenshotId).not.toBe(first.screenshotId);
        expect(payload).not.toHaveProperty("screenshotUnchanged");
        expect(imageParts(second)).toBe(1);
      } finally {
        await manager.dispose();
      }
    });

    it("names the earlier frame by default — reuse no longer needs the flag", async () => {
      setFlag(undefined);
      const backend = new FakeComputerBackend();
      const { call, see, manager } = await setup(backend);
      try {
        const first = await see();
        const second = await call("computer_get_state", { include_screenshot: true });
        const payload = resultJson(second) as {
          screenshotUnchanged?: boolean;
          screenshot: { screenshotId: string };
        };
        // The pixels still cost a capture — only their delivery is deduplicated.
        expect(backend.callsFor("getState")).toHaveLength(2);
        expect(payload.screenshotUnchanged).toBe(true);
        expect(payload.screenshot.screenshotId).toBe(first.screenshotId);
        expect(imageParts(second)).toBe(0);
      } finally {
        await manager.dispose();
      }
    });

    it("delivers normally when the bytes differ or the coordinate frame moved", async () => {
      setFlag("1");
      const backend = new FakeComputerBackend();
      const { call, see, manager } = await setup(backend);
      try {
        await see();
        // Same window, new pixels: byte identity is the only proof nothing
        // changed, so a different capture ships as a new frame.
        backend.queueScreenshots([
          Buffer.from("a-different-desktop").toString("base64"),
          Buffer.from("a-different-desktop").toString("base64"),
        ]);
        const changed = await call("computer_screenshot", { window_id: "fake-calculator" });
        const changedPayload = resultJson(changed) as {
          screenshotUnchanged?: boolean;
          screenshot: { screenshotId: string; windowId: string };
        };
        expect(changedPayload.screenshotUnchanged).toBeUndefined();
        expect(imageParts(changed)).toBe(1);

        // Identical bytes on the same window dedupe from then on — and the
        // capture itself still ran.
        const captures = backend.callsFor("captureScreenshot").length;
        const again = await call("computer_screenshot", { window_id: "fake-calculator" });
        const againPayload = resultJson(again) as {
          screenshotUnchanged?: boolean;
          screenshot: { screenshotId: string };
        };
        expect(backend.callsFor("captureScreenshot")).toHaveLength(captures + 1);
        expect(againPayload.screenshotUnchanged).toBe(true);
        expect(againPayload.screenshot.screenshotId).toBe(changedPayload.screenshot.screenshotId);
        expect(imageParts(again)).toBe(0);

        // Another window is a different coordinate frame even with identical
        // bytes: pointing into shot-N must never read pixels it was not shown.
        const other = await call("computer_screenshot", { window_id: "fake-terminal" });
        const otherPayload = resultJson(other) as {
          screenshotUnchanged?: boolean;
          screenshot: { screenshotId: string; windowId: string };
        };
        expect(otherPayload.screenshotUnchanged).toBeUndefined();
        expect(otherPayload.screenshot.screenshotId).not.toBe(
          changedPayload.screenshot.screenshotId,
        );
        expect(otherPayload.screenshot.windowId).toBe("fake-terminal");
        expect(imageParts(other)).toBe(1);
      } finally {
        await manager.dispose();
      }
    });

    it("never lets one thread's picture stand in for another's", async () => {
      setFlag("1");
      const { call, manager } = await setup();
      try {
        const first = resultJson(
          await call("computer_screenshot", { window_id: "fake-calculator" }),
        ) as { screenshot: { screenshotId: string } };
        const second = resultJson(
          await call(
            "computer_screenshot",
            { window_id: "fake-calculator" },
            undefined,
            "other-thread",
          ),
        ) as { screenshot: { screenshotId: string }; screenshotUnchanged?: boolean };
        expect(second.screenshot.screenshotId).not.toBe(first.screenshot.screenshotId);
        expect(second.screenshotUnchanged).toBeUndefined();
      } finally {
        await manager.dispose();
      }
    });
  });
});

describe("element refs", () => {
  type ListedElement = {
    ref: number;
    role: string;
    label: string;
    windowId: string | null;
    value?: string;
  };
  const elementsOf = (result: McpToolCallResult): ListedElement[] =>
    (resultJson(result) as { elements?: ListedElement[] }).elements ?? [];

  it("keeps a ref bound to the same element across listings", async () => {
    const { backend, call, manager } = await setup();
    try {
      const first = elementsOf(await call("computer_get_state", {}));
      const calculate = first.find((element) => element.label === "Calculate")!;

      // A scoped second listing still shows the same number for it — refs do
      // not re-seat when the model narrows or widens its view.
      const second = elementsOf(await call("computer_get_state", { window_id: "fake-calculator" }));
      expect(second.find((element) => element.label === "Calculate")?.ref).toBe(calculate.ref);

      const result = await call("computer_click", { ref: calculate.ref });
      expect(result.isError).not.toBe(true);
      expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 1180, y: 228 });
    } finally {
      await manager.dispose();
    }
  });

  it("mints different refs for duplicate labels and clicks the right one", async () => {
    const button = (x: number): ComputerUiNode => ({
      role: "button",
      label: "Save",
      value: null,
      description: null,
      frame: { x, y: 100, width: 60, height: 30 },
      activationPoint: null,
      onScreen: true,
      windowId: "w1",
      children: [],
    });
    const root: ComputerUiNode = {
      role: "desktop",
      label: null,
      value: null,
      description: null,
      frame: { x: 0, y: 0, width: 1920, height: 1080 },
      activationPoint: null,
      onScreen: true,
      windowId: null,
      children: [
        {
          role: "window",
          label: "Editor",
          value: null,
          description: null,
          frame: { x: 0, y: 0, width: 800, height: 600 },
          activationPoint: null,
          onScreen: true,
          windowId: "w1",
          children: [button(20), button(200)],
        },
      ],
    };
    const { backend, call, manager } = await setup(new FakeComputerBackend({ root }));
    try {
      const saves = elementsOf(await call("computer_get_state", {})).filter(
        (element) => element.label === "Save",
      );
      expect(saves).toHaveLength(2);
      expect(saves[0]!.ref).not.toBe(saves[1]!.ref);

      const result = await call("computer_click", { ref: saves[1]!.ref });
      expect(result.isError).not.toBe(true);
      // The second Save's centre: ordinal 1, not the first match a label search finds.
      expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 230, y: 115 });
    } finally {
      await manager.dispose();
    }
  });

  it("targets a duplicate by ref_ordinal without a ref", async () => {
    const button = (x: number): ComputerUiNode => ({
      role: "button",
      label: "Save",
      value: null,
      description: null,
      frame: { x, y: 100, width: 60, height: 30 },
      activationPoint: null,
      onScreen: true,
      windowId: "w1",
      children: [],
    });
    const root: ComputerUiNode = {
      role: "desktop",
      label: null,
      value: null,
      description: null,
      frame: { x: 0, y: 0, width: 1920, height: 1080 },
      activationPoint: null,
      onScreen: true,
      windowId: null,
      children: [
        {
          role: "window",
          label: "Editor",
          value: null,
          description: null,
          frame: { x: 0, y: 0, width: 800, height: 600 },
          activationPoint: null,
          onScreen: true,
          windowId: "w1",
          children: [button(20), button(200)],
        },
      ],
    };
    const { backend, call, manager } = await setup(new FakeComputerBackend({ root }));
    try {
      await call("computer_get_state", {});
      const result = await call("computer_click", { label: "Save", ref_ordinal: 1 });
      expect(result.isError).not.toBe(true);
      expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 230, y: 115 });
    } finally {
      await manager.dispose();
    }
  });

  it("refuses a ref no listing ever minted, and a ref mixed with coordinates", async () => {
    const { call, manager } = await setup();
    try {
      const before = await call("computer_click", { ref: 0 });
      expect(before.isError).toBe(true);
      const beforeText = before.content.find((entry) => entry.type === "text");
      expect(beforeText?.type === "text" ? beforeText.text : "").toContain("computer_get_state");

      await call("computer_get_state", {});
      const outOfRange = await call("computer_click", { ref: 999 });
      expect(outOfRange.isError).toBe(true);
      const outText = outOfRange.content.find((entry) => entry.type === "text");
      expect(outText?.type === "text" ? outText.text : "").toContain("999");

      const mixed = await call("computer_click", { ref: 0, x: 10, y: 10 });
      expect(mixed.isError).toBe(true);
      const mixedText = mixed.content.find((entry) => entry.type === "text");
      expect(mixedText?.type === "text" ? mixedText.text : "").toContain("x/y");
    } finally {
      await manager.dispose();
    }
  });

  it("refuses when a claim beside the ref names a different element", async () => {
    const { call, manager } = await setup();
    try {
      const elements = elementsOf(await call("computer_get_state", {}));
      const calculate = elements.find((element) => element.label === "Calculate")!;

      const wrongLabel = await call("computer_click", {
        ref: calculate.ref,
        label: "Definitely not this",
      });
      expect(wrongLabel.isError).toBe(true);
      const labelText = wrongLabel.content.find((entry) => entry.type === "text");
      expect(labelText?.type === "text" ? labelText.text : "").toContain("Calculate");

      const wrongRole = await call("computer_click", {
        ref: calculate.ref,
        role: "text-field",
      });
      expect(wrongRole.isError).toBe(true);

      // A claim that agrees with the listing is accepted.
      const right = await call("computer_click", {
        ref: calculate.ref,
        label: "Calculate",
      });
      expect(right.isError).not.toBe(true);
    } finally {
      await manager.dispose();
    }
  });

  it("keeps refs thread-scoped", async () => {
    const { call, manager } = await setup();
    try {
      const elements = elementsOf(await call("computer_get_state", {}));
      const ref = elements[0]!.ref;
      const other = await call("computer_click", { ref }, undefined, "other-thread");
      expect(other.isError).toBe(true);
      const text = other.content.find((entry) => entry.type === "text");
      expect(text?.type === "text" ? text.text : "").toContain("computer_get_state");
    } finally {
      await manager.dispose();
    }
  });

  it("targets text and run steps by ref", async () => {
    const { backend, call, manager } = await setup();
    try {
      const elements = elementsOf(await call("computer_get_state", {}));
      const display = elements.find((element) => element.label === "Display")!;

      const selected = await call("computer_select_text", {
        ref: display.ref,
        start: 0,
        length: 1,
      });
      expect(selected.isError).not.toBe(true);
      expect(backend.callsFor("selectText").at(-1)?.args[1]).toEqual({ start: 0, length: 1 });

      const calculate = elements.find((element) => element.label === "Calculate")!;
      const run = await call("computer_run", {
        steps: [{ type: "click", ref: calculate.ref }],
      });
      expect(run.isError).not.toBe(true);
      expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 1180, y: 228 });
    } finally {
      await manager.dispose();
    }
  });
});

describe("computer_run observation steps", () => {
  it("lists elements mid-run with get_state and mints refs the model can use after", async () => {
    const { backend, call, manager } = await setup();
    try {
      const run = resultJson(
        await call("computer_run", {
          steps: [
            { type: "get_state", window_id: "fake-calculator" },
            { type: "click", label: "Calculate", window_id: "fake-calculator" },
          ],
        }),
      ) as {
        steps: {
          type: string;
          result?: { elements?: { ref: number; label: string }[]; elementWindowId?: string };
        }[];
      };
      const listed = run.steps[0]!.result?.elements ?? [];
      expect(listed.map((element) => element.label)).toContain("Calculate");
      expect(run.steps[0]!.result?.elementWindowId).toBe("fake-calculator");
      // The listing's refs are real bindings: citing one right after the run resolves it.
      const calculate = listed.find((element) => element.label === "Calculate")!;
      const followup = await call("computer_click", { ref: calculate.ref });
      expect(followup.isError).not.toBe(true);
      expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 1180, y: 228 });
    } finally {
      await manager.dispose();
    }
  });

  it("runs verify_state predicates mid-run", async () => {
    const { backend, call, manager } = await setup();
    try {
      await call("computer_get_state", {});
      const run = resultJson(
        await call("computer_run", {
          steps: [
            {
              type: "verify_state",
              window_id: "fake-calculator",
              expect: [{ label: "Display", value: "0" }],
            },
          ],
        }),
      ) as { steps: { ok: boolean }[] };
      expect(run.steps[0]!.ok).toBe(true);
      expect(backend.callsFor("verifyState").at(-1)?.args).toEqual([
        "fake-calculator",
        [{ label: "Display", value: "0" }],
      ]);
    } finally {
      await manager.dispose();
    }
  });
});

describe("computer_run flow control", () => {
  it("skips a step whose if_element is absent and runs it when present", async () => {
    const { backend, call, manager } = await setup();
    try {
      await call("computer_get_state", {});
      const run = resultJson(
        await call("computer_run", {
          steps: [
            {
              type: "click",
              label: "Calculate",
              window_id: "fake-calculator",
              if_element: { label: "Does not exist" },
            },
            {
              type: "click",
              label: "Calculate",
              window_id: "fake-calculator",
              if_element: { label: "Calculate", window_id: "fake-calculator" },
            },
          ],
        }),
      ) as {
        steps: { ok: boolean; skipped?: boolean; skippedReason?: string }[];
        skipped: number;
        completed: number;
      };
      expect(run.steps[0]).toMatchObject({
        ok: true,
        skipped: true,
        skippedReason: "if_element_absent",
      });
      expect(run.steps[1]).toMatchObject({ ok: true });
      expect(run.steps[1]!.skipped).toBeUndefined();
      expect(run.skipped).toBe(1);
      // Only the second click dispatched — a skipped step touches nothing.
      expect(backend.callsFor("click")).toHaveLength(1);
    } finally {
      await manager.dispose();
    }
  });

  it("skips a step whose unless_element is present", async () => {
    const { backend, call, manager } = await setup();
    try {
      await call("computer_get_state", {});
      const run = resultJson(
        await call("computer_run", {
          steps: [
            {
              type: "click",
              label: "Calculate",
              window_id: "fake-calculator",
              unless_element: { label: "Calculate", window_id: "fake-calculator" },
            },
            {
              type: "click",
              label: "Calculate",
              window_id: "fake-calculator",
              unless_element: { label: "Not there" },
            },
          ],
        }),
      ) as { steps: { skipped?: boolean; skippedReason?: string }[] };
      expect(run.steps[0]!.skippedReason).toBe("unless_element_present");
      expect(run.steps[1]!.skipped).toBeUndefined();
      expect(backend.callsFor("click")).toHaveLength(1);
    } finally {
      await manager.dispose();
    }
  });

  it("evaluates an if_element ref against the element it was minted for", async () => {
    const { backend, call, manager } = await setup();
    try {
      const elements = (
        resultJson(await call("computer_get_state", {})) as {
          elements: { ref: number; label: string }[];
        }
      ).elements;
      const calculate = elements.find((element) => element.label === "Calculate")!;
      const run = resultJson(
        await call("computer_run", {
          steps: [
            {
              type: "click",
              label: "Calculate",
              window_id: "fake-calculator",
              if_element: { ref: calculate.ref },
            },
          ],
        }),
      ) as { steps: { ok: boolean; skipped?: boolean }[] };
      expect(run.steps[0]!.skipped).toBeUndefined();
      expect(run.steps[0]!.ok).toBe(true);
      expect(backend.callsFor("click")).toHaveLength(1);
    } finally {
      await manager.dispose();
    }
  });

  it("continues past a failed step with continue_on_error", async () => {
    const { backend, call, manager } = await setup();
    try {
      await call("computer_get_state", {});
      const run = resultJson(
        await call("computer_run", {
          steps: [
            {
              type: "click",
              label: "Missing control",
              window_id: "fake-calculator",
              continue_on_error: true,
            },
            { type: "click", label: "Calculate", window_id: "fake-calculator" },
          ],
        }),
      ) as {
        steps: { ok: boolean }[];
        stopped: boolean;
        completed: number;
      };
      expect(run.steps[0]!.ok).toBe(false);
      expect(run.steps[1]!.ok).toBe(true);
      expect(run.stopped).toBe(false);
      expect(run.completed).toBe(1);
      expect(backend.callsFor("click")).toHaveLength(1);
    } finally {
      await manager.dispose();
    }
  });

  it("still stops the run on a failure without continue_on_error", async () => {
    const { backend, call, manager } = await setup();
    try {
      await call("computer_get_state", {});
      const run = resultJson(
        await call("computer_run", {
          steps: [
            { type: "click", label: "Missing control", window_id: "fake-calculator" },
            { type: "click", label: "Calculate", window_id: "fake-calculator" },
          ],
        }),
      ) as { steps: { ok: boolean }[]; stopped: boolean };
      expect(run.steps).toHaveLength(1);
      expect(run.stopped).toBe(true);
      expect(backend.callsFor("click")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("waits for an element to be absent with absent:true", async () => {
    const { call, manager } = await setup();
    try {
      await call("computer_get_state", {});
      const run = resultJson(
        await call("computer_run", {
          steps: [
            {
              type: "wait",
              duration_ms: 500,
              absent: true,
              label: "Never present",
              window_id: "fake-calculator",
            },
          ],
        }),
      ) as { steps: { ok: boolean; result?: { status?: string } }[] };
      expect(run.steps[0]!.ok).toBe(true);
      expect(run.steps[0]!.result?.status).toBe("ready");
    } finally {
      await manager.dispose();
    }
  });

  it("refuses a condition with no label-carrying target", async () => {
    const { call, manager } = await setup();
    try {
      const run = await call("computer_run", {
        steps: [
          {
            type: "click",
            label: "Calculate",
            window_id: "fake-calculator",
            if_element: { window_id: "fake-calculator" },
          },
        ],
      });
      expect(run.isError).toBe(true);
      const text = run.content.find((entry) => entry.type === "text");
      expect(text?.type === "text" ? text.text : "").toContain("if_element");
    } finally {
      await manager.dispose();
    }
  });
});

describe("computer_help", () => {
  it("looks up the registered browser catalog and the returned prepare tool is callable", async () => {
    const backend = new FakeComputerBackend({ browser: true });
    const { call, byName, manager } = await setup(backend, async () => true);
    try {
      const help = resultJson(await call("computer_help", { tool: "computer_browser_prepare" }));
      expect(help).toMatchObject({
        definition: byName.get("computer_browser_prepare")!.definition,
        advertised: true,
      });
      const index = resultJson(await call("computer_help", { topic: "tools" })) as { text: string };
      expect(index.text).toContain("computer_browser_prepare");
      expect(index.text).toContain("computer_browser_navigate");
      const prepared = await call("computer_browser_prepare", {
        allow_launch: true,
        profile: { mode: "isolated_new" },
      });
      expect(prepared.isError).not.toBe(true);
      expect(backend.callsFor("browser.browser_prepare")).toHaveLength(1);
    } finally {
      await manager.dispose();
    }
  });

  it("does not invent browser entries for a desktop-only backend", async () => {
    const { call, manager } = await setup();
    try {
      const help = await call("computer_help", { tool: "computer_browser_prepare" });
      expect(help.isError).toBe(true);
      const index = resultJson(await call("computer_help", { topic: "tools" })) as { text: string };
      expect(index.text).not.toContain("computer_browser_prepare");
    } finally {
      await manager.dispose();
    }
  });

  it("indexes the chapters when called bare", async () => {
    const { call, manager } = await setup();
    try {
      const result = await call("computer_help", {});
      expect(result.isError).not.toBe(true);
      const json = resultJson(result) as { topics: string };
      for (const topic of ["browser", "menus", "hidden", "foreground", "forms", "tools"]) {
        expect(json.topics).toContain(topic);
      }
      expect(json.topics).not.toContain("recording");
    } finally {
      await manager.dispose();
    }
  });

  it("returns one canonical schema and routes hidden actions through the advertised batch tool", async () => {
    const { byName, tools, call, manager, backend } = await setup();
    try {
      expect(
        tools.filter((tool) => tool.discoveryOnly !== true).map((tool) => tool.definition.name),
      ).toContain("computer_run");
      const help = resultJson(await call("computer_help", { tool: "computer_select_text" })) as {
        definition: { name: string; inputSchema: unknown };
        advertised: boolean;
        batchStep: { type: string; fields: string[] };
      };
      expect(help.definition).toEqual(byName.get("computer_select_text")!.definition);
      expect(help.advertised).toBe(false);
      expect(help.batchStep).toMatchObject({ type: "select_text" });
      expect(help.batchStep.fields).toEqual(
        expect.arrayContaining(["label", "start", "length", "if_element", "continue_on_error"]),
      );
      expect(help.batchStep.fields).not.toContain("include_screenshot");
      expect(JSON.stringify(help)).not.toContain("computer_drag");
      // Form a supported hidden step from the returned route; no direct call
      // to an unadvertised tool is needed at the provider boundary.
      const run = await call("computer_run", {
        steps: [
          { type: "set_value", window_id: "fake-calculator", label: "Display", value: "12345" },
          {
            type: help.batchStep.type,
            window_id: "fake-calculator",
            label: "Display",
            start: 1,
            length: 2,
          },
        ],
      });
      expect(run.isError).not.toBe(true);
      expect(resultJson(run)).toMatchObject({ completed: 2, stopped: false });
      expect(backend.callsFor("selectText")).toHaveLength(1);
    } finally {
      await manager.dispose();
    }
  });

  it("exposes an image-preserving inspection route for hidden specialists", async () => {
    const { call, manager } = await setup();
    try {
      const help = resultJson(await call("computer_help", { tool: "computer_zoom" }));
      expect(help).toMatchObject({
        advertised: false,
        inspection: { name: "computer_inspect", tool: "computer_zoom" },
      });
      expect(help).not.toHaveProperty("batchStep");
      for (const args of [
        { tool: "computer_future" },
        { tool: "computer_select_text", topic: "tools" },
      ]) {
        expect((await call("computer_help", args)).isError).toBe(true);
      }
    } finally {
      await manager.dispose();
    }
  });

  it("gives every hidden desktop tool a currently advertised canonical route", async () => {
    const { call, tools, manager } = await setup();
    try {
      const advertised = new Set(
        tools.filter((tool) => tool.discoveryOnly !== true).map((tool) => tool.definition.name),
      );
      const inspectionNames = schemaEnum(
        new Map(tools.map((tool) => [tool.definition.name, tool])),
        "computer_inspect",
        "tool",
      );
      for (const tool of tools.filter((entry) => entry.discoveryOnly === true)) {
        const name = tool.definition.name;
        const help = resultJson(await call("computer_help", { tool: name })) as {
          advertised: boolean;
          batchStep?: { type: string };
          inspection?: { name: string; tool: string };
        };
        expect(help.advertised, name).toBe(false);
        if (help.batchStep) {
          expect(advertised.has("computer_run"), name).toBe(true);
          expect(name).toBe(`computer_${help.batchStep.type}`);
        } else {
          expect(help.inspection, name).toEqual({
            name: "computer_inspect",
            tool: name,
            instruction: "Pass this schema's arguments in the arguments object.",
          });
          expect(advertised.has(help.inspection!.name), name).toBe(true);
          expect(inspectionNames, name).toContain(name);
        }
      }
    } finally {
      await manager.dispose();
    }
  });

  it("serves every chapter under all", async () => {
    const { call, manager } = await setup();
    try {
      const result = await call("computer_help", { topic: "all" });
      expect(result.isError).not.toBe(true);
      const json = resultJson(result) as { chapters: string };
      expect(json.chapters).toContain("computer_browser_prepare");
      expect(json.chapters).toContain("computer_invoke_menu");
      expect(json.chapters).toContain("set_window_minimized");
      // The generated index is part of the "all" read: a discovery-only name
      // that no chapter's prose names proves the catalog joined the chapters.
      expect(json.chapters).toContain("computer_write_clipboard");
      expect(json.chapters).toContain("Available as computer_run steps");
      expect(json.chapters).not.toContain("computer_recording");
      expect(json.chapters).not.toContain("computer_replay");
    } finally {
      await manager.dispose();
    }
  });

  it("refuses an unknown topic and names the valid ones", async () => {
    const { call, manager } = await setup();
    try {
      const result = await call("computer_help", { topic: "unknown_chapter" });
      expect(result.isError).toBe(true);
      const text = result.content.find((entry) => entry.type === "text");
      expect(text?.type === "text" ? text.text : "").toContain("browser");
    } finally {
      await manager.dispose();
    }
  });
});
