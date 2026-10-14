import { assertAdapterCapabilityConformance } from "../providerAdapterConformance.ts";
import { ProviderRuntimeEvent, ThreadId } from "@synara/contracts";
import { Schema } from "effect";
import { expect, it } from "vitest";
import {
  assertSessionTeardownConformance,
  assertTerminalOutcomeConformance,
} from "./adapterLifecycleConformance";

const base = {
  eventId: "event",
  provider: "codex",
  threadId: "thread",
  createdAt: "2026-10-11T10:00:00.000Z",
  lifecycleGeneration: "generation",
};
const completed = Schema.decodeUnknownSync(ProviderRuntimeEvent)({
  ...base,
  type: "turn.completed",
  turnId: "turn",
  payload: { state: "completed" },
});
const exited = Schema.decodeUnknownSync(ProviderRuntimeEvent)({
  ...base,
  type: "session.exited",
  payload: {},
});

it.each([
  ["supportsTurnSteering", "steerTurn"],
  ["supportsRuntimeModelList", "listModels"],
  ["supportsSkillDiscovery", "listSkills"],
  ["supportsNativeSlashCommandDiscovery", "listCommands"],
  ["supportsPluginDiscovery", "listPlugins"],
  ["supportsForkThroughTurn", "forkThread"],
] as const)("rejects %s without its optional %s method", (capability, method) => {
  expect(() =>
    assertAdapterCapabilityConformance({
      capabilities: { sessionModelSwitch: "unsupported", [capability]: true },
    }),
  ).toThrow(`${capability} requires ${method}`);
});

it("requires both plugin discovery entry points", () => {
  expect(() =>
    assertAdapterCapabilityConformance({
      capabilities: { sessionModelSwitch: "unsupported", supportsPluginDiscovery: true },
      listPlugins: () => {
        throw new Error("the checker must not call provider methods");
      },
    }),
  ).toThrow("supportsPluginDiscovery requires readPlugin");
});

it("does not infer enabled discovery from optional method presence", () => {
  expect(() =>
    assertAdapterCapabilityConformance({
      capabilities: { sessionModelSwitch: "unsupported", supportsRuntimeModelList: false },
      listModels: () => {
        throw new Error("disabled discovery must not be called");
      },
    }),
  ).not.toThrow();
});

it("rejects duplicate terminal outcomes for one generation and turn", () => {
  expect(() => assertTerminalOutcomeConformance([completed, completed])).toThrow(
    "duplicate terminal outcome",
  );
  expect(() =>
    assertTerminalOutcomeConformance([
      completed,
      { ...completed, lifecycleGeneration: "next-generation" },
    ]),
  ).not.toThrow();
});
it("rejects a terminal outcome without a turn identity", () => {
  const { turnId: _turnId, ...missingTurn } = completed;
  expect(() => assertTerminalOutcomeConformance([missingTurn])).toThrow("identify their turn");
});
it("rejects runtime output after teardown and an unfenced observation", () => {
  expect(() =>
    assertSessionTeardownConformance([exited, completed], ThreadId.makeUnsafe("thread")),
  ).toThrow("further runtime events");
  expect(() =>
    assertSessionTeardownConformance([completed], ThreadId.makeUnsafe("thread")),
  ).toThrow("exit fence");
});

it("allows a replacement generation and still rejects late events from the stopped owner", () => {
  const replacement = { ...completed, lifecycleGeneration: "replacement-generation" };
  expect(() =>
    assertSessionTeardownConformance([exited, replacement], ThreadId.makeUnsafe("thread")),
  ).not.toThrow();
  expect(() =>
    assertSessionTeardownConformance(
      [exited, replacement, completed],
      ThreadId.makeUnsafe("thread"),
    ),
  ).toThrow("further runtime events");
});
