// Electron 43 bundles Undici 7.29, whose HTTP/1 writer can throw outside the
// fetch promise when macOS rejects setTypeOfService. Use the maintained
// dispatcher (including its Node-fetch compatibility adapter) before any
// desktop requests. Keep Node's fetch/Headers/Response globals and error policy.
// Upstream fix: https://github.com/nodejs/undici/pull/5547
import { Agent, setGlobalDispatcher } from "undici";

setGlobalDispatcher(new Agent());
