// FILE: parallel-transform.worker.mjs
// Purpose: Runs the React Compiler Babel plugin's own transform hook on a
//          worker thread. See parallel-transform.ts for the protocol.
// Layer: Web build config

import { parentPort } from "node:worker_threads";
import { createReactCompilerPlugin } from "./react-compiler-plugin.mjs";

if (!parentPort) throw new Error("parallel-transform.worker.mjs must run as a worker thread.");
const port = parentPort;
const send = (message) => port.postMessage(message);

const TRANSFORM_FAILURE = Symbol("transform failure");
const plugin = await createReactCompilerPlugin();
// Same lifecycle the bundler drives on the main thread. The preset declares no
// configResolved hook, so the resolved config itself is not consulted.
plugin.configResolved({});
const appliedEnvironments = new Map();

function appliesTo(environment) {
  let applies = appliedEnvironments.get(environment.name);
  if (applies === undefined) {
    applies = plugin.applyToEnvironment({
      name: environment.name,
      config: { consumer: environment.consumer },
    });
    appliedEnvironments.set(environment.name, applies);
  }
  return applies;
}

port.on("message", async ({ taskId, code, id, moduleType, environment }) => {
  try {
    // The main thread only receives calls for environments the plugin applies
    // to. A worker that disagrees would silently skip compilation, so fail.
    if (!appliesTo(environment))
      throw new Error(`Worker plugin does not apply to environment "${environment.name}".`);
    const value = await plugin.transform.handler.call(
      {
        environment: { name: environment.name },
        // The hook reports Babel failures through `this.error`, which throws.
        error(failure) {
          throw Object.assign(new Error(failure.message), { [TRANSFORM_FAILURE]: failure });
        },
      },
      code,
      id,
      moduleType === undefined ? undefined : { moduleType },
    );
    send({
      taskId,
      kind: "result",
      value: value ? { code: value.code, map: value.map } : null,
    });
  } catch (error) {
    const failure = error?.[TRANSFORM_FAILURE];
    send(
      failure
        ? {
            taskId,
            kind: "transform-error",
            error: {
              message: String(failure.message),
              loc: failure.loc ?? undefined,
              pos: failure.pos ?? undefined,
              pluginCode: failure.pluginCode ?? undefined,
              stack: failure.cause?.stack ? String(failure.cause.stack) : undefined,
            },
          }
        : { taskId, kind: "crash", message: String(error?.stack ?? error) },
    );
  }
});
