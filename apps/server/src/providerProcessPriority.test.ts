import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { providerProcessPriorityEnabled } from "./providerProcessPriority";
import { ServerSettingsService } from "./serverSettings";

describe("providerProcessPriorityEnabled", () => {
  it("defaults on without a settings service", async () => {
    expect(await Effect.runPromise(providerProcessPriorityEnabled)).toBe(true);
  });

  it("reads the current server setting for each new launch", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const initial = yield* providerProcessPriorityEnabled;
        yield* settings.updateSettings({ lowerProviderProcessPriority: false });
        const disabled = yield* providerProcessPriorityEnabled;
        yield* settings.updateSettings({ lowerProviderProcessPriority: true });
        return [initial, disabled, yield* providerProcessPriorityEnabled];
      }).pipe(Effect.provide(ServerSettingsService.layerTest())),
    );
    expect(observed).toEqual([true, false, true]);
  });
});
