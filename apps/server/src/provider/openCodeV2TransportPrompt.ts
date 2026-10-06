import type { OpenCodeClient } from "./openCodeClient.ts";
import {
  requestOpenCodeV2,
  sessionPath,
  type OpenCodeV2HttpContext,
} from "./openCodeV2TransportHttp.ts";

export function createOpenCodeV2PromptAsync(
  http: OpenCodeV2HttpContext,
): OpenCodeClient["session"]["promptAsync"] {
  return async (input, options) => {
    if (input.noReply || input.format || input.tools)
      throw new Error(
        "OpenCode v2 does not support legacy noReply, format, or per-prompt tools options.",
      );
    if (input.model)
      await requestOpenCodeV2(
        http,
        sessionPath(input.sessionID, "/model"),
        "POST",
        {
          model: {
            providerID: input.model.providerID,
            id: input.model.modelID,
            ...(input.variant ? { variant: input.variant } : {}),
          },
        },
        options?.signal,
        input.directory,
      );
    else if (input.variant) throw new Error("OpenCode v2 variant selection requires a model.");
    if (input.agent)
      await requestOpenCodeV2(
        http,
        sessionPath(input.sessionID, "/agent"),
        "POST",
        { agent: input.agent },
        options?.signal,
        input.directory,
      );
    const text: string[] = [];
    const files: { uri: string; name?: string }[] = [];
    const agents: { name: string }[] = [];
    for (const part of input.parts ?? []) {
      if (part.type === "text") text.push(part.text);
      else if (part.type === "file")
        files.push({ uri: part.url, ...(part.filename ? { name: part.filename } : {}) });
      else if (part.type === "agent") agents.push({ name: part.name });
      else throw new Error(`OpenCode v2 does not support legacy prompt part '${part.type}'.`);
    }
    // Harness instructions remain part of the submitted user input; never silently drop them.
    if (input.system) text.unshift(input.system);
    await requestOpenCodeV2(
      http,
      sessionPath(input.sessionID, "/prompt"),
      "POST",
      {
        text: text.join("\n\n"),
        ...(input.messageID ? { id: input.messageID } : {}),
        ...(files.length ? { files } : {}),
        ...(agents.length ? { agents } : {}),
      },
      options?.signal,
      input.directory,
    );
    return {};
  };
}
