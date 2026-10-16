import { Schema } from "effect";
import {
  EditorDebugActionResult,
  EditorDebugSnapshot,
  EditorDebugStartResult,
} from "@synara/contracts";
import type { EditorDebugBackend } from "./editorDebugStore";

export interface ExtensionDebugTransport {
  debug(params: Record<string, unknown>): Promise<unknown>;
  stop(): Promise<void>;
}

/** Reuses the native debugger store/panel; no second debugger UI or terminal. */
export function extensionDebugBackend(
  bridge: ExtensionDebugTransport,
  configurationId: string,
  relativePath: string,
): EditorDebugBackend {
  return {
    start: async (input, options) => {
      options?.signal?.throwIfAborted();
      try {
        const result = await bridge.debug({
          operation: "start",
          configurationId,
          relativePath,
          breakpoints: input.breakpoints,
        });
        options?.signal?.throwIfAborted();
        return Schema.decodeUnknownSync(EditorDebugStartResult)(result);
      } catch (error) {
        // Capture the whole sandbox before asking the adapter to disconnect.
        // Its debuggee may outlive or be reparented by adapter shutdown.
        try {
          await bridge.stop();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], "Extension debug launch and cleanup failed.");
        }
        throw error;
      }
    },
    action: async (input) => {
      if (input.action === "disconnect") {
        await bridge.stop();
        return {};
      }
      return Schema.decodeUnknownSync(EditorDebugActionResult)(
        await bridge.debug({ operation: "action", ...input }),
      );
    },
    poll: async (input) =>
      Schema.decodeUnknownSync(EditorDebugSnapshot)(
        await bridge.debug({ operation: "poll", ...input }),
      ),
  };
}
