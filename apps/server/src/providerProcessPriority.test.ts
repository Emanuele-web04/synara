import { Effect, Logger } from "effect";
import { describe, expect, it } from "vitest";
import { providerProcessPriorityEnabled } from "./providerProcessPriority";
import { ServerSettingsService } from "./serverSettings";

describe("providerProcessPriorityEnabled", () => {
  it("logs the fallback when a standalone runtime has no settings service", async () => {
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => messages.push(String(message)));
    expect(
      await Effect.runPromise(
        providerProcessPriorityEnabled.pipe(
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        ),
      ),
    ).toBe(true);
    expect(messages).toEqual([expect.stringContaining("ServerSettingsService is missing")]);
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
