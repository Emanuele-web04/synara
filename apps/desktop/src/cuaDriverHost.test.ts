import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { CuaDriverHost } from "./cuaDriverHost";
import {
  cuaRequest as rawCuaRequest,
  CUA_DRIVER_VERSION,
  CUA_NATIVE_REVISION,
  type CuaReply,
} from "@synara/shared/cuaDriverProtocol";
const capability = "isolated-fixture-authority-00000000000000";
const cuaRequest: typeof rawCuaRequest = (path, request, options) =>
  rawCuaRequest(path, { ...(request as object), capability }, options);
const cleanups: Array<() => Promise<unknown>> = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
  authority = capability,
  options: {
    cleanup?: "incomplete" | "wrong-pid" | "missing-admission";
    unpatched?: boolean;
    nativeRevision?: number | null;
    failAction?: boolean;
    crash?: boolean;
    sessionDeathOnce?: boolean;
    sessionDeathTransport?: boolean;
    // Opt-in: logs `session:`/`open_session:` lines for the label each call
    // rides. Off by default so full-event-list assertions in older tests are
    // not polluted by the added instrumentation.
    logSessions?: boolean;
    browserRefusal?: boolean;
    delayObservation?: boolean;
    hangSession?: boolean;
    dropCancel?: boolean;
    startupTimeoutMs?: number;
    deathFlag?: string;
    ownPids?: () => ReadonlySet<number>;
    cursorStyle?: () => { fill?: string; rim?: string; shadow?: string } | null | undefined;
    checkPermissions?: () => Promise<{
      accessibility: boolean;
      screenRecording: boolean;
    }>;
    releaseHeldInput?: () => Promise<void>;
    frameTap?: {
      update: (target: unknown) => void;
      endTask: (task: unknown) => Promise<void>;
      stop: () => Promise<void>;
      dispose: () => Promise<void>;
    };
    shield?: {
      engage: (request: unknown, task?: unknown) => Promise<void>;
      release: (shieldId: string) => Promise<void>;
      releaseAll: () => Promise<number>;
      endTask: (task: unknown) => Promise<void>;
      stop: () => Promise<void>;
      dispose: () => Promise<void>;
    };
    listWindows?: Array<Record<string, unknown>>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "synara-cua-host-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "events.jsonl");
  const binary = join(directory, "driver");
  options = { ...options, deathFlag: join(directory, "session-died") };
  await writeFile(
    binary,
    `#!${process.execPath}
const net=require('node:net'),fs=require('node:fs');
const log=${JSON.stringify(log)}, options=${JSON.stringify(options)};
const write=event=>fs.appendFileSync(log,JSON.stringify({event,pid:process.pid,time:Date.now()})+'\\n');
write('start');
if(!options.unpatched){
  if(!process.argv.includes('--compact-cursor')) throw new Error('Missing compact cursor profile');
  if(process.argv[process.argv.indexOf('--idle-hide-ms')+1]!=='900') throw new Error('Missing cursor idle deadline');
}
if(options.unpatched&&(process.argv.includes('--compact-cursor')||process.argv.includes('--idle-hide-ms'))) throw new Error('Upstream driver cannot parse Synara cursor flags');
const socket=process.argv[process.argv.indexOf('--socket')+1];
let action, timer;
net.createServer(s=>{
  const reply=result=>s.end(JSON.stringify({ok:true,result})+'\\n');
  s.once('data',b=>{
    const r=JSON.parse(b.toString());
    if(options.logSessions&&r.method==='call'&&r.args&&typeof r.args.session==='string') write('session:'+r.args.session+':'+r.name);
    if(r.method==='metadata') reply({driver_version:${JSON.stringify(CUA_DRIVER_VERSION)},synara_native_revision:options.unpatched?undefined:${CUA_NATIVE_REVISION},embedded:true,pid:process.pid});
    else if(r.method==='cancel_input') {
      write('cancel');
      if(options.dropCancel) { s.destroy(); return; }
      if(r.args.expected_pid!==process.pid) throw new Error('Wrong generation');
      clearTimeout(timer);
      if(action) { write('release'); action.end(JSON.stringify({ok:false,error:'cancelled'})+'\\n'); action=undefined; }
      setTimeout(()=>{
        write('cleanup-ack');
        reply({pid:process.pid+(options.cleanup==='wrong-pid'?1:0),input_admission_closed:options.cleanup==='missing-admission'?undefined:true,cleanup_complete:options.cleanup!=='incomplete',pending_input:options.cleanup==='incomplete'?1:0});
      },30);
    }
    else if(options.sessionDeathOnce && r.method==='call' && r.args && r.args.session && r.name!=='start_session' && r.name!=='set_agent_cursor_motion' && r.name!=='set_agent_cursor_style' && !fs.existsSync(options.deathFlag)) { fs.writeFileSync(options.deathFlag, '1'); reply({isError:true, content:[{type:'text', text:"session '"+r.args.session+"' has ended; tool call '"+r.name+"' was rejected. Call start_session with this id to revive it before issuing further actions, or use a new session id."}], structuredContent:{effect:'not-dispatched'}}); }
    else if(options.sessionDeathTransport && r.method==='call' && r.args && r.args.session && r.name!=='start_session' && r.name!=='set_agent_cursor_motion' && r.name!=='set_agent_cursor_style' && !fs.existsSync(options.deathFlag)) { fs.writeFileSync(options.deathFlag, '1'); s.end(JSON.stringify({ok:false,error:"session '"+r.args.session+"' has ended; tool call '"+r.name+"' was rejected. Call start_session with this id to revive it before issuing further actions, or use a new session id.",effect:'not-dispatched'})+'\\n'); }
    else if(r.name==='type_text') {
      write('dispatch'); action=s;
      if(options.crash) { write('crash'); process.exit(1); }
      else if(options.failAction) s.destroy();
      else timer=setTimeout(()=>{write('effect');reply({});action=undefined},10000);
    }
    else if(options.hangSession && r.name==='start_session' && !fs.existsSync(options.deathFlag)) { fs.writeFileSync(options.deathFlag,'1'); write('session-hang'); }
    else if(r.name==='set_agent_cursor_motion') { write('motion-'+r.args.glide_duration_ms+'-'+r.args.dwell_after_click_ms); reply({}); }
    else if(r.name==='set_agent_cursor_style') { write('style:'+JSON.stringify(r.args)); reply({}); }
    else if(r.name==='press_key') { write('key'); write('observation-budget-'+process.env.SYNARA_CUA_FOREGROUND_OBSERVATION_MS); reply({}); }
    else if(r.name==='get_window_state' && !r.args?.empty) { write('observe'); setTimeout(()=>reply({structuredContent:{elements:[]}}),options.delayObservation?60:0); }
    else if(r.name==='get_desktop_state') reply({content:[{type:'image',data:'fixture-image'}]});
    else if(r.name==='list_windows') { write('list-windows'); reply({structuredContent:{windows:options.listWindows||[]}}); }
    // Browser family observability: the persistent control connection opens
    // with session_begin; lifecycle calls attributed to a transport session
    // are the browser path (the desktop start_session carries no session_id).
    // session_begin replies without s.end: the real driver holds the control
    // connection open — its lifetime is what the transport session rides on.
    else if(r.method==='session_begin') { write('session-begin:'+r.session_id); s.write(JSON.stringify({ok:true,result:{session_begin:true}})+'\\n'); }
    else if((r.name==='start_session'||r.name==='end_session')&&r.session_id) { write(r.name+':'+r.args.session+':'+r.session_id); reply({}); }
    // Lifecycle calls without a transport envelope: the generation's own
    // openSession start_session and a task-label revival. Distinct event name
    // keeps them out of the browser lifecycle assertions above.
    else if(options.logSessions&&(r.name==='start_session'||r.name==='end_session')) { write('open_session:'+r.name+':'+r.args.session); reply({}); }
    else if(r.name==='start_session'||r.name==='end_session') { reply({}); }
    else if(r.name&&(r.name.indexOf('browser_')===0||r.name==='get_browser_state')) { write('browser:'+r.name+':'+(r.args&&r.args.session)+':'+(r.session_id||'-')); reply(options.browserRefusal?{structuredContent:{status:'refused',refusal:{code:'browser_requires_setup'}},content:[{type:'text',text:'refused (browser_requires_setup)'}]}:{}); }
    else reply({});
  });
  s.on('error',()=>{});
}).listen(socket);
let retiring=false;
function retire(){if(retiring)return;retiring=true;write('retiring');setTimeout(()=>{write('exit');process.exit(0)},150)}
process.on('SIGTERM',retire);
process.stdin.resume(); process.stdin.on('end',retire);
`,
  );
  await chmod(binary, 0o755);
  const host = new CuaDriverHost({
    binaryPath: binary,
    bundleId: "fixture",
    capability: authority,
    setup: async () => {},
    ...(options.checkPermissions ? { checkPermissions: options.checkPermissions } : {}),
    ...(options.releaseHeldInput ? { releaseHeldInput: options.releaseHeldInput } : {}),
    ...(options.frameTap ? { frameTap: options.frameTap } : {}),
    ...(options.shield ? { shield: options.shield } : {}),
    ...(options.startupTimeoutMs ? { startupTimeoutMs: options.startupTimeoutMs } : {}),
    ...(options.nativeRevision !== undefined ? { nativeRevision: options.nativeRevision } : {}),
    ...(options.ownPids ? { ownPids: options.ownPids } : {}),
    ...(options.cursorStyle ? { cursorStyle: options.cursorStyle } : {}),
  });
  const events = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
  cleanups.push(async () => {
    try {
      await host.dispose();
    } catch (error) {
      if (!options.cleanup && !options.crash) throw error;
    }
    // These are fake executables created by this test, with no OS input API.
    // A deliberately invalid cleanup acknowledgement must leave them alive.
    for (const event of await events().catch(() => [])) {
      if (event.event === "start") {
        try {
          process.kill(event.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    }
  });
  const endpoint = await host.listen();
  return { host, endpoint, events };
}
describe("Cua GUI host retirement", () => {
  it("starts the compact cursor once per generation and owns the observation budget", async () => {
    const f = await fixture();
    for (let i = 0; i < 2; i++) {
      const reply = await cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter", _synara_foreground_observation_ms: 0 },
      });
      expect(reply.ok).toBe(true);
    }
    const events = (await f.events()).map((row) => row.event);
    expect(events.filter((event) => event === "motion-100-0")).toHaveLength(1);
    expect(events.filter((event) => event === "observation-budget-100")).toHaveLength(2);
  });

  it.each(["stop", "suspend", "pauseDesktop"] as const)(
    "%s does not wait for another feature's permission dialog",
    async (method) => {
      const entered = deferred<void>();
      const pending = deferred<{
        accessibility: boolean;
        screenRecording: boolean;
      }>();
      const f = await fixture(capability, {
        checkPermissions: () => {
          entered.resolve();
          return pending.promise;
        },
      });
      const check = cuaRequest(f.endpoint, {
        method: "call",
        name: "check_permissions",
      });
      await entered.promise;
      await f.host[method]("screen-lock");
      await expect(check).resolves.toMatchObject({
        ok: false,
        effect: "not-dispatched",
      });
      // Releasing this Computer wait does not cancel the shared request.
      pending.resolve({ accessibility: true, screenRecording: true });
      await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
    },
    2_000,
  );

  it("releases a disconnected permission check without retiring a later native session", async () => {
    const entered = deferred<void>();
    const pending = deferred<{
      accessibility: boolean;
      screenRecording: boolean;
    }>();
    const f = await fixture(capability, {
      checkPermissions: () => {
        entered.resolve();
        return pending.promise;
      },
    });
    const controller = new AbortController();
    const check = cuaRequest(
      f.endpoint,
      { method: "call", name: "check_permissions" },
      { signal: controller.signal },
    ).catch((error: unknown) => error);
    await entered.promise;
    controller.abort();
    await check;
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "get_screen_size" }, { timeoutMs: 2_000 }),
    ).resolves.toMatchObject({ ok: true });
    pending.resolve({ accessibility: true, screenRecording: true });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ ok: true });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
  });

  it("checks permissions through the fresh shared helper without starting Cua or requesting grants", async () => {
    let permissions = { accessibility: false, screenRecording: false };
    const f = await fixture(capability, {
      checkPermissions: async () => permissions,
    });
    const check = () =>
      cuaRequest(f.endpoint, {
        method: "call",
        name: "check_permissions",
        args: { prompt: true },
      });
    await expect(check()).resolves.toMatchObject({
      result: {
        structuredContent: {
          accessibility: false,
          screen_recording: false,
          source: {
            attribution: "host",
            host_bundle_id: "fixture",
            probe: "appsnap-permission-helper",
          },
        },
      },
    });
    permissions = { accessibility: true, screenRecording: true };
    await expect(check()).resolves.toMatchObject({
      result: {
        structuredContent: { accessibility: true, screen_recording: true },
      },
    });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retires a cached native process once when grants change, then requires fresh observation", async () => {
    let granted = true;
    const f = await fixture(capability, {
      checkPermissions: async () => ({
        accessibility: granted,
        screenRecording: granted,
      }),
    });
    const check = () => cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await check();
    await cuaRequest(f.endpoint, { method: "call", name: "get_screen_size" });
    granted = false;
    await expect(check()).resolves.toMatchObject({
      desktopEpoch: 1,
      result: { structuredContent: { accessibility: false } },
    });
    expect((await f.events()).filter((event) => event.event === "cleanup-ack")).toHaveLength(1);
    await check();
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
    granted = true;
    await check();
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ result: { isError: true } });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      modelObservation: true,
    });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ ok: true });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(2);
  });

  it("does not bypass failed cleanup when refreshed permissions change", async () => {
    let granted = true;
    const f = await fixture(capability, {
      cleanup: "incomplete",
      checkPermissions: async () => ({
        accessibility: granted,
        screenRecording: granted,
      }),
    });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await cuaRequest(f.endpoint, { method: "call", name: "get_screen_size" });
    // A dispatched action makes this generation's input state unprovable, so
    // the failed cleanup must keep the driver alive and admission closed.
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
    });
    granted = false;
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "get_window_state",
        modelObservation: true,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
  });
  it("does not start while locked and requires fresh state after all desktop pauses end", async () => {
    const f = await fixture();
    await f.host.pauseDesktop("screen-lock");
    await f.host.pauseDesktop("system-sleep");
    f.host.resume(); // A backend restart cannot unlock the desktop.
    const press = () => cuaRequest(f.endpoint, { method: "call", name: "press_key" });
    await expect(press()).resolves.toMatchObject({
      result: {
        isError: true,
        structuredContent: { code: "desktop_input_paused", effect: "refused" },
      },
    });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
    f.host.resumeDesktop("screen-lock");
    await expect(press()).resolves.toMatchObject({ result: { isError: true } });
    f.host.resumeDesktop("system-sleep");
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await expect(press()).resolves.toMatchObject({ result: { isError: true } });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      modelObservation: true,
      args: { pid: 1, window_id: 2 },
    });
    await expect(press()).resolves.toMatchObject({ ok: true });
    expect((await f.events()).filter((event) => event.event === "key")).toHaveLength(1);
  });

  it("piggybacks sorted pauses and the never-reset interruption count on every reply", async () => {
    const f = await fixture();
    const probe = () => cuaRequest<CuaReply>(f.endpoint, { method: "probe" });
    await expect(probe()).resolves.toMatchObject({
      desktopEpoch: 0,
      desktopPauses: [],
      desktopInterruptions: 0,
    });
    await f.host.pauseDesktop("system-sleep");
    await f.host.pauseDesktop("screen-lock");
    const paused = await probe();
    expect(paused.desktopPauses).toEqual(["screen-lock", "system-sleep"]);
    expect(paused.desktopInterruptions).toBe(2);
    // Refusals carry the same state: a paused action reports the reasons and
    // the count alongside its desktop_input_paused result.
    await expect(
      cuaRequest<CuaReply>(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({
      desktopPauses: ["screen-lock", "system-sleep"],
      desktopInterruptions: 2,
      result: { structuredContent: { code: "desktop_input_paused" } },
    });
    // The reasons net back to empty on resume while the count keeps the
    // proof that the interruption cycle ran.
    f.host.resumeDesktop("screen-lock");
    await expect(probe()).resolves.toMatchObject({
      desktopPauses: ["system-sleep"],
      desktopInterruptions: 2,
    });
    f.host.resumeDesktop("system-sleep");
    await expect(probe()).resolves.toMatchObject({
      desktopPauses: [],
      desktopInterruptions: 2,
    });
  });

  it("retires a driver-ended session and retries once with a fresh one", async () => {
    // The driver can end a session the host still holds (restart, timeout).
    // Without a heal, every later call fails the same way and no model-side
    // retry can recover. The driver confirms nothing dispatched, so one
    // retire-plus-retry is replay-safe.
    const f = await fixture(capability, { sessionDeathOnce: true });
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
    });
    expect(reply.ok).toBe(true);
    expect(reply.result?.isError).not.toBe(true);
    const events = await f.events();
    // The dead generation retired (new driver process) and the key reached
    // the fresh session exactly once.
    expect(events.filter((event) => event.event === "start")).toHaveLength(2);
    expect(events.filter((event) => event.event === "key")).toHaveLength(1);
  });

  it("retires a transport-reported session death and retries once fresh", async () => {
    // The live driver surfaced session death as an ok:false reply rather than
    // an isError result: undetected, every later call died on the same id.
    const f = await fixture(capability, { sessionDeathTransport: true });
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
    });
    expect(reply.ok).toBe(true);
    expect(reply.result?.isError).not.toBe(true);
    const events = await f.events();
    expect(events.filter((event) => event.event === "start")).toHaveLength(2);
    expect(events.filter((event) => event.event === "key")).toHaveLength(1);
  });

  it("locking cancels active native input and rejects waiting input before dispatch", async () => {
    const f = await fixture();
    const active = cuaRequest(f.endpoint, {
      method: "call",
      name: "type_text",
      args: { text: "fixture" },
    });
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await f.events().catch(() => [])).some((event) => event.event === "dispatch")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await f.events()).some((event) => event.event === "dispatch")).toBe(true);
    const queued = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "press_key",
    });
    await f.host.pauseDesktop("screen-lock");
    expect(await active).toMatchObject({ ok: false });
    const queuedReply = await queued;
    expect(queuedReply.ok === false || queuedReply.result?.isError === true).toBe(true);
    const events = await f.events();
    expect(events.some((event) => event.event === "cleanup-ack")).toBe(true);
    expect(events.some((event) => event.event === "effect" || event.event === "key")).toBe(false);
  });

  it("unlock does not bypass an unacknowledged cleanup barrier", async () => {
    const f = await fixture(capability, { cleanup: "incomplete" });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
    });
    await expect(f.host.pauseDesktop("screen-lock")).rejects.toThrow(
      "did not confirm native input cleanup",
    );
    f.host.resumeDesktop("screen-lock");
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "get_window_state" }),
    ).resolves.toMatchObject({ ok: false });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
  });

  it("preview and readiness reads cannot release the post-unlock model observation gate", async () => {
    const f = await fixture();
    await f.host.pauseDesktop("screen-lock");
    f.host.resumeDesktop("screen-lock");
    const press = () => cuaRequest(f.endpoint, { method: "call", name: "press_key" });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "get_desktop_state" }),
    ).resolves.toMatchObject({ ok: true, desktopEpoch: 1 });
    await cuaRequest(f.endpoint, { method: "call", name: "get_window_state" });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      modelObservation: true,
      args: { empty: true },
    });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_input_ready" }),
    ).resolves.toMatchObject({ result: { isError: true } });
    await expect(press()).resolves.toMatchObject({ result: { isError: true } });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      modelObservation: true,
    });
    await expect(press()).resolves.toMatchObject({ ok: true });
    expect((await f.events()).filter((event) => event.event === "key")).toHaveLength(1);
  });

  it("a disconnected observation cannot release the post-unlock gate", async () => {
    const f = await fixture(capability, { delayObservation: true });
    await f.host.pauseDesktop("screen-lock");
    f.host.resumeDesktop("screen-lock");
    const controller = new AbortController();
    const observation = cuaRequest(
      f.endpoint,
      {
        method: "call",
        name: "get_window_state",
        modelObservation: true,
      },
      { signal: controller.signal },
    ).catch((error: unknown) => error);
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await f.events().catch(() => [])).some((event) => event.event === "observe")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await f.events()).some((event) => event.event === "observe")).toBe(true);
    controller.abort();
    expect(await observation).toBeInstanceOf(Error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ result: { isError: true } });
    expect((await f.events()).some((event) => event.event === "key")).toBe(false);
  });

  it("ignores a permission probe that reverts on the confirming re-read", async () => {
    // The AppSnap helper can read TCC mid-transition and report a grant that
    // the next probe reverts. Arming the gate on that phantom read deadlocked
    // production: every action runs check_permissions first via refresh(), so
    // the helper re-armed the gate after each observation cleared it.
    let probes = 0;
    const f = await fixture(capability, {
      checkPermissions: async () => {
        probes += 1;
        return { accessibility: true, screenRecording: probes !== 2 };
      },
    });
    const check = () => cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await expect(check()).resolves.toMatchObject({ desktopEpoch: 0 });
    await expect(check()).resolves.toMatchObject({
      desktopEpoch: 0,
      result: { structuredContent: { screen_recording: true } },
    });
    expect(probes).toBe(3);
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("a flapping permission helper cannot deadlock input behind the observation gate", async () => {
    let probes = 0;
    const f = await fixture(capability, {
      checkPermissions: async () => {
        probes += 1;
        return { accessibility: true, screenRecording: probes % 2 === 1 };
      },
    });
    const check = () => cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    const observe = () =>
      cuaRequest(f.endpoint, {
        method: "call",
        name: "get_window_state",
        modelObservation: true,
        args: { pid: 1, window_id: 2 },
      });
    await check();
    await f.host.pauseDesktop("screen-lock");
    f.host.resumeDesktop("screen-lock");
    for (let i = 0; i < 3; i += 1) {
      await observe();
      await check();
      await expect(
        cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
      ).resolves.toMatchObject({ ok: true });
    }
  });

  it("refuses an observation a stop interrupted instead of silently voiding the clear", async () => {
    const f = await fixture(capability, { delayObservation: true });
    await f.host.pauseDesktop("screen-lock");
    f.host.resumeDesktop("screen-lock");
    const observe = () =>
      cuaRequest(f.endpoint, {
        method: "call",
        name: "get_window_state",
        modelObservation: true,
        args: { pid: 1, window_id: 2 },
      });
    const interrupted = observe();
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await f.events().catch(() => [])).some((event) => event.event === "observe")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // stopInput (turn Stop/revokeControl) used to bump only the input epoch:
    // the in-flight image still returned while its gate clear was skipped.
    await cuaRequest(f.endpoint, { method: "stop" });
    await expect(interrupted).resolves.toMatchObject({
      result: {
        isError: true,
        structuredContent: { code: "desktop_input_paused" },
      },
    });
    await observe();
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("preserves multibyte UTF-8 across incoming socket chunks", async () => {
    const authority = capability + "-è🧪";
    const f = await fixture(authority);
    const request = Buffer.from(JSON.stringify({ method: "probe", capability: authority }) + "\n");
    const split = request.indexOf(Buffer.from("🧪")) + 1;
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(f.endpoint);
      let result = "";
      socket.setTimeout(2_000, () => socket.destroy(new Error("Fixture socket timed out.")));
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        result += chunk.toString("utf8");
      });
      socket.once("end", () => resolve(result));
      socket.once("connect", () => {
        socket.write(request.subarray(0, split));
        setTimeout(() => socket.write(request.subarray(split)), 30);
      });
    });
    expect(JSON.parse(reply)).toMatchObject({ ok: true });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("requires GUI authority even when a provider discovers the socket", async () => {
    const f = await fixture();
    await expect(
      rawCuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("releases uncertain input before termination and waits for exit before replacement", async () => {
    const f = await fixture();
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "check_permissions",
      args: {},
    });
    await expect(
      cuaRequest(
        f.endpoint,
        { method: "call", name: "type_text", args: { text: "fixture" } },
        { timeoutMs: 120, mutation: true },
      ),
    ).rejects.toMatchObject({ effect: "dispatched-unknown" });
    await f.host.stop();
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "check_permissions",
        args: {},
      }),
    ).resolves.toMatchObject({ ok: true });
    const events = await f.events();
    const starts = events.filter((e) => e.event === "start");
    expect(starts).toHaveLength(2);
    const exit = events.find((e) => e.event === "exit" && e.pid === starts[0].pid);
    expect(exit).toBeDefined();
    expect(starts[1].time).toBeGreaterThanOrEqual(exit.time);
    expect(events.some((e) => e.event === "effect")).toBe(false);
    expect(events.filter((e) => e.event === "dispatch")).toHaveLength(1);
    const first = events.filter((e) => e.pid === starts[0].pid).map((e) => e.event);
    expect(first).toEqual([
      "start",
      "motion-100-0",
      "dispatch",
      "cancel",
      "release",
      "cleanup-ack",
      "retiring",
      "exit",
    ]);
  });
  it("releases held input through the helper when the driver dies mid-action", async () => {
    let releaseCalls = 0;
    const released = async () => {
      releaseCalls += 1;
    };
    const f = await fixture(capability, {
      crash: true,
      releaseHeldInput: released,
    });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    // The fake driver exits on dispatch, so the call's retire runs the
    // OS-level release before the request reports its failure.
    await expect(
      cuaRequest(
        f.endpoint,
        { method: "call", name: "type_text", args: { text: "fixture" } },
        { timeoutMs: 300, mutation: true },
      ),
    ).resolves.toMatchObject({ ok: false });
    expect(releaseCalls).toBe(1);
    // A confirmed release makes the desktop provably clean: the dead
    // generation clears, so the next request spawns a replacement instead of
    // poisoning admission for the host's lifetime.
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: true });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(2);
  });
  it("keeps admission closed for the host's lifetime when held-input release fails", async () => {
    const f = await fixture(capability, {
      crash: true,
      releaseHeldInput: () => Promise.reject(new Error("helper gone")),
    });
    await expect(
      cuaRequest(
        f.endpoint,
        { method: "call", name: "type_text", args: { text: "fixture" } },
        { timeoutMs: 1_000, mutation: true },
      ),
    ).resolves.toMatchObject({ ok: false });
    // Without a confirmed release the held state is unprovable — no
    // replacement generation may spawn over it, now or later.
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
    await expect(f.host.stop()).rejects.toThrow("admission is closed");
  });
  it("replaces a driver that wedges during startup instead of closing admission", async () => {
    const f = await fixture(capability, {
      hangSession: true,
      dropCancel: true,
      startupTimeoutMs: 150,
    });
    // The wedged startup call is bounded by the startup timeout; its
    // retirement cannot confirm cleanup (the socket drops mid-request), but
    // no action ever reached this generation so nothing can be held.
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter" },
      }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    // Terminating the provably input-free generation clears it, so the next
    // request spawns a fresh driver instead of failing closed forever.
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: true });
    const events = await f.events();
    const starts = events.filter((event) => event.event === "start");
    expect(starts).toHaveLength(2);
    expect(events.filter((e) => e.pid === starts[0].pid).map((e) => e.event)).toEqual([
      "start",
      "session-hang",
      "cancel",
      "retiring",
      "exit",
    ]);
  });
  it("rejects later backend requests throughout suspension and resumes only on explicit restart", async () => {
    const f = await fixture();
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    const stopping = f.host.suspend();
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "type_text",
        args: { text: "must not arrive" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      effect: "not-dispatched",
      error: expect.stringContaining("suspended"),
    });
    await stopping;
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
    expect((await f.events()).some((event) => event.event === "dispatch")).toBe(false);
    f.host.resume();
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: true });
    const events = await f.events();
    const starts = events.filter((event) => event.event === "start");
    expect(starts).toHaveLength(2);
    expect(starts[1].time).toBeGreaterThanOrEqual(
      events.find((event) => event.event === "exit" && event.pid === starts[0].pid).time,
    );
  });
  it("does not let resume bypass failed cleanup during backend suspension", async () => {
    const f = await fixture(capability, { cleanup: "incomplete" });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
    });
    await expect(f.host.suspend()).rejects.toThrow("did not confirm native input cleanup");
    f.host.resume();
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "type_text",
        args: { text: "must not arrive" },
      }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
    expect((await f.events()).some((event) => event.event === "dispatch")).toBe(false);
  });
  it.each(["incomplete", "wrong-pid", "missing-admission"] as const)(
    "keeps the process alive and blocks replacement after %s cleanup",
    async (cleanup) => {
      const f = await fixture(capability, { cleanup });
      await cuaRequest(f.endpoint, {
        method: "call",
        name: "check_permissions",
      });
      // An input-dispatched generation can hold OS state the acknowledgement
      // cannot account for, so the driver stays alive and unreplaced.
      await cuaRequest(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter" },
      });
      await expect(f.host.stop()).rejects.toThrow("did not confirm native input cleanup");
      await expect(
        cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
      ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
      const events = await f.events();
      expect(events.map((e) => e.event)).toEqual([
        "start",
        "motion-100-0",
        "key",
        "observation-budget-100",
        "cancel",
        "cleanup-ack",
      ]);
      expect(() => process.kill(events[0].pid, 0)).not.toThrow();
    },
  );
  it("preserves an uncertain action effect when cleanup also fails", async () => {
    const f = await fixture(capability, {
      cleanup: "incomplete",
      failAction: true,
    });
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "type_text",
        args: { text: "fixture" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      effect: "dispatched-unknown",
      error: expect.stringContaining("did not confirm native input cleanup"),
    });
    expect((await f.events()).some((e) => e.event === "retiring")).toBe(false);
  });
  it("blocks replacement when a driver crashes during input", async () => {
    const f = await fixture(capability, { crash: true });
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "type_text",
        args: { text: "fixture" },
      }),
    ).resolves.toMatchObject({ ok: false, effect: "dispatched-unknown" });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((e) => e.event === "start")).toHaveLength(1);
  });
  it("rejects an upstream binary before native input is admitted", async () => {
    const f = await fixture(capability, { unpatched: true });
    // The default host still expects the patched build, so it passes the
    // Synara cursor flags — a faithful upstream binary exits on arguments it
    // cannot parse, which refuses the call before any input is dispatched.
    // Even a binary that tolerated them would fail the revision handshake.
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "type_text",
        args: { text: "fixture" },
      }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).map((e) => e.event)).toEqual(["start"]);
  });
  it("drives an unpatched upstream binary when nativeRevision is null", async () => {
    const f = await fixture(capability, {
      unpatched: true,
      nativeRevision: null,
    });
    // The upstream spawn omits the Synara cursor flags (the fake would exit
    // on them), the handshake accepts the absent revision field, and replies
    // report the observed driver as unpatched — the backend's cue to narrow
    // advertised capabilities.
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "list_windows",
        args: {},
        capability,
      }),
    ).resolves.toMatchObject({ ok: true, driverNativeRevision: 0 });
    expect((await f.events()).map((e) => e.event)).toEqual([
      "start",
      "motion-100-0",
      "list-windows",
    ]);
  });
  it("refuses unlisted driver operations before starting a daemon", async () => {
    const f = await fixture();
    const response = await cuaRequest<{ ok: boolean }>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: { url: "https://example.com" },
    });
    expect(response.ok).toBe(false);
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("admits wait_for_settle as a read through the allowlist", async () => {
    const f = await fixture();
    // The fixture driver answers any listed name {}; the allowlist is what a
    // refused name would have failed inside the host before ever spawning.
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "wait_for_settle",
        args: { pid: 42, window_id: 10, timeout_ms: 5_000, quiet_ms: 1_000 },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect((await f.events()).some((event) => event.event === "start")).toBe(true);
  });
});

/** The args of every `set_agent_cursor_style` call the fixture recorded. */
function stylePayloads(events: Array<{ event: string }>): Array<Record<string, unknown>> {
  return events
    .filter((row) => row.event.startsWith("style:"))
    .map((row) => JSON.parse(row.event.slice("style:".length)) as Record<string, unknown>);
}

describe("agent cursor style", () => {
  const pressKey = (endpoint: string) =>
    cuaRequest<CuaReply>(endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter", _synara_foreground_observation_ms: 0 },
    });

  it("pushes the custom colors once per generation, on the session open", async () => {
    const f = await fixture(capability, {
      cursorStyle: () => ({ fill: "#101010", rim: "#F0F0F0", shadow: "#000000" }),
    });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
    // A second action reuses the same generation and session: the style is
    // setup, not per-action traffic.
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });

    const events = await f.events();
    expect(events.filter((row) => row.event === "motion-100-0")).toHaveLength(1);
    const payloads = stylePayloads(events);
    expect(payloads).toHaveLength(1);
    expect(Object.keys(payloads[0]!).toSorted()).toEqual(["fill", "rim", "session", "shadow"]);
    expect(payloads[0]!.session).toMatch(/^synara-/);
    // Colors are normalized to lowercase before they reach the driver.
    expect(payloads[0]!.fill).toBe("#101010");
    expect(payloads[0]!.rim).toBe("#f0f0f0");
    expect(payloads[0]!.shadow).toBe("#000000");
  });

  it("sends only the channels that carry a usable color", async () => {
    const f = await fixture(capability, {
      cursorStyle: () => ({ fill: "#ABCDEF", rim: "not-a-color" }),
    });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
    const payloads = stylePayloads(await f.events());
    expect(payloads).toHaveLength(1);
    expect(Object.keys(payloads[0]!).toSorted()).toEqual(["fill", "session"]);
    expect(payloads[0]!.fill).toBe("#abcdef");
  });

  it("makes no style call for the stock default", async () => {
    // No cursorStyle option at all is the packaged default: the driver keeps
    // its stock monochrome cursor and hears nothing from the host.
    const f = await fixture();
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
    const events = await f.events();
    expect(events.some((row) => row.event === "motion-100-0")).toBe(true);
    expect(stylePayloads(events)).toHaveLength(0);
  });

  it("makes no style call for a stock-resolving option", async () => {
    const f = await fixture(capability, { cursorStyle: () => null });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
    expect(stylePayloads(await f.events())).toHaveLength(0);
  });

  it("keeps an unpatched upstream driver on its stock cursor", async () => {
    const f = await fixture(capability, {
      unpatched: true,
      nativeRevision: null,
      cursorStyle: () => ({ fill: "#101010" }),
    });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "list_windows", args: {} }),
    ).resolves.toMatchObject({ ok: true, driverNativeRevision: 0 });
    const events = await f.events();
    expect(events.some((row) => row.event === "motion-100-0")).toBe(true);
    expect(stylePayloads(events)).toHaveLength(0);
  });

  it("live-pushes a preference change to the warm session, once", async () => {
    let style: { fill?: string; rim?: string } | null = { fill: "#101010" };
    const f = await fixture(capability, { cursorStyle: () => style });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });

    style = { fill: "#101010", rim: "#f0f0f0" };
    await f.host.setCursorStyle(style);
    // An unchanged value is already applied: the second push is skipped.
    await f.host.setCursorStyle(style);

    const payloads = stylePayloads(await f.events());
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toMatchObject({ fill: "#101010", rim: "#f0f0f0" });
    expect(payloads[1]!.session).toBe(payloads[0]!.session);
  });

  it("resets a warm session to stock when the preference clears", async () => {
    let style: { fill?: string } | null = { fill: "#101010" };
    const f = await fixture(capability, { cursorStyle: () => style });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });

    style = null;
    await f.host.setCursorStyle(null);

    const payloads = stylePayloads(await f.events());
    expect(payloads).toHaveLength(2);
    // A stock change carries the session and no colors, so the driver's
    // omitted-channel stock treatment is what repaints the cursor.
    expect(Object.keys(payloads[1]!).toSorted()).toEqual(["session"]);
  });

  it("never spawns a driver just to apply a settings change", async () => {
    const f = await fixture(capability, { cursorStyle: () => ({ fill: "#101010" }) });
    await f.host.setCursorStyle({ fill: "#101010" });
    // No generation was ever spawned or warmed by the settings change; the
    // next real call opens its session with the preference from the getter.
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
    expect(stylePayloads(await f.events())).toHaveLength(1);
  });

  it("styles a task's own cursor session before its first action, once", async () => {
    const f = await fixture(capability, { cursorStyle: () => ({ fill: "#101010" }) });
    const task = { threadId: "thread", turnId: "turn" };
    const press = () =>
      cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter", _synara_foreground_observation_ms: 0 },
        task,
      });
    for (let i = 0; i < 2; i++) await expect(press()).resolves.toMatchObject({ ok: true });

    const payloads = stylePayloads(await f.events());
    // Two calls: the shared session at open, then the task cursor session the
    // action actually paints under. The second action reuses both.
    expect(payloads).toHaveLength(2);
    expect(payloads[1]!.session).toBe("agent·thread");
    expect(payloads[1]!.fill).toBe("#101010");
  });

  it("resets a task cursor session to stock on its next action", async () => {
    let style: { fill?: string } | null = { fill: "#101010" };
    const f = await fixture(capability, { cursorStyle: () => style });
    const task = { threadId: "thread", turnId: "turn" };
    const press = () =>
      cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter", _synara_foreground_observation_ms: 0 },
        task,
      });
    await expect(press()).resolves.toMatchObject({ ok: true });

    style = null;
    await f.host.setCursorStyle(null);
    // The live change resets the shared session and forgets what each task
    // session had, so the task's next action repaints it stock.
    await expect(press()).resolves.toMatchObject({ ok: true });
    // A third action has nothing left to reset.
    await expect(press()).resolves.toMatchObject({ ok: true });

    const payloads = stylePayloads(await f.events());
    expect(payloads).toHaveLength(4);
    expect(Object.keys(payloads[2]!).toSorted()).toEqual(["session"]); // shared session reset
    expect(payloads[3]!.session).toBe("agent·thread");
    expect(Object.keys(payloads[3]!).toSorted()).toEqual(["session"]);
  });

  it("sends no style call for a stock task session", async () => {
    const f = await fixture();
    await expect(
      cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter", _synara_foreground_observation_ms: 0 },
        task: { threadId: "thread", turnId: "turn" },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(stylePayloads(await f.events())).toHaveLength(0);
  });
});

describe("task-owned user stop", () => {
  const task = { threadId: "thread", turnId: "turn" };
  it("end_task succeeds without a native preview", async () => {
    const f = await fixture();
    await expect(cuaRequest(f.endpoint, { method: "end_task", task })).resolves.toMatchObject({
      ok: true,
    });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("user Stop refuses subsequent calls from the same turn", async () => {
    const f = await fixture();
    await f.host.stopTaskByUser(task);
    const blocked = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "press_key",
      task,
      args: { key: "enter", pid: 42, window_id: 10 },
    });
    expect(blocked).toMatchObject({ ok: false, effect: "not-dispatched" });
    expect(blocked.error).toContain("user stopped");
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
    const next = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "get_window_state",
      task: { ...task, turnId: "next" },
      modelObservation: true,
      args: { pid: 42, window_id: 10 },
    });
    expect(next.ok).toBe(true);
  });
});

describe("frame tap launch prime", () => {
  const task = { threadId: "thread", turnId: "turn" };
  const calculator = {
    pid: 101,
    window_id: 202,
    app_name: "Calculator",
    title: "Calculator",
    bounds: { x: 0, y: 0, width: 400, height: 600 },
    is_on_screen: true,
  };
  function tapDouble() {
    const updates: Array<unknown> = [];
    return {
      updates,
      host: {
        update: (target: unknown) => {
          updates.push(target);
        },
        endTask: async () => {},
        stop: async () => {},
        dispose: async () => {},
      },
    };
  }
  it("points the tap at the launched app's main window", async () => {
    const tap = tapDouble();
    const f = await fixture(capability, {
      frameTap: tap.host,
      listWindows: [calculator],
    });
    const launched = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "launch_app",
      task,
      args: { name: "Calculator" },
    });
    expect(launched.ok).toBe(true);
    await vi.waitFor(() => expect(tap.updates).toHaveLength(1));
    expect(tap.updates[0]).toMatchObject({ pid: 101, windowId: 202 });
  });
  it("matches bundle ids by their tail component", async () => {
    const tap = tapDouble();
    const f = await fixture(capability, {
      frameTap: tap.host,
      listWindows: [calculator],
    });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "launch_app",
      task,
      args: { bundle_id: "com.apple.Calculator" },
    });
    await vi.waitFor(() => expect(tap.updates).toHaveLength(1));
    expect(tap.updates[0]).toMatchObject({ pid: 101, windowId: 202 });
  });
  it("stays quiet when no on-screen window matches", async () => {
    const tap = tapDouble();
    const f = await fixture(capability, {
      frameTap: tap.host,
      listWindows: [calculator],
    });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "launch_app",
      task,
      args: { name: "TextEdit" },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tap.updates).toEqual([]);
  });
  it("skips the prime for ended tasks", async () => {
    const tap = tapDouble();
    const f = await fixture(capability, {
      frameTap: tap.host,
      listWindows: [calculator],
    });
    await cuaRequest(f.endpoint, { method: "end_task", task });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "launch_app",
      task,
      args: { name: "Calculator" },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tap.updates).toEqual([]);
  });
});

describe("frame tap browser targeting", () => {
  const task = { threadId: "thread", turnId: "turn" };
  function tapDouble() {
    const updates: Array<unknown> = [];
    return {
      updates,
      host: {
        update: (target: unknown) => {
          updates.push(target);
        },
        endTask: async () => {},
        stop: async () => {},
        dispose: async () => {},
      },
    };
  }
  it("points the tap at the window a browser bind call names", async () => {
    const tap = tapDouble();
    const f = await fixture(capability, { frameTap: tap.host });
    const bound = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "get_browser_state",
      task,
      args: { pid: 101, window_id: 202 },
    });
    expect(bound.ok).toBe(true);
    await vi.waitFor(() => expect(tap.updates).toHaveLength(1));
    expect(tap.updates[0]).toMatchObject({ pid: 101, windowId: 202 });
  });
  it("keeps the tap parked on target-id-only browser calls", async () => {
    const tap = tapDouble();
    const f = await fixture(capability, { frameTap: tap.host });
    const navigated = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      task,
      args: { target_id: "cua:1:2", tab_id: "tab-1", url: "https://example.test" },
    });
    expect(navigated.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tap.updates).toEqual([]);
  });
  it("a refused bind call proves nothing and leaves the tap parked", async () => {
    const tap = tapDouble();
    const f = await fixture(capability, { frameTap: tap.host, browserRefusal: true });
    const refused = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "get_browser_state",
      task,
      args: { pid: 101, window_id: 202 },
    });
    expect(refused.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tap.updates).toEqual([]);
  });
});

describe("driver warm-up on first touch", () => {
  const FLAG = "SYNARA_CUA_WARM_ON_FIRST_TOUCH";
  let savedFlag: string | undefined;
  let captured = false;

  const setFlag = (value: string | undefined) => {
    if (!captured) {
      captured = true;
      savedFlag = process.env[FLAG];
    }
    if (value === undefined) delete process.env[FLAG];
    else process.env[FLAG] = value;
  };

  afterEach(() => {
    if (captured) {
      if (savedFlag === undefined) delete process.env[FLAG];
      else process.env[FLAG] = savedFlag;
      captured = false;
      savedFlag = undefined;
    }
    vi.restoreAllMocks();
  });

  /** Poll the driver's event log until `event` appears or ~3 s elapse. */
  const waitForEvent = async (
    f: Awaited<ReturnType<typeof fixture>>,
    event: string,
  ): Promise<Array<{ event: string; pid: number; time: number }>> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const events = await f
        .events()
        .catch(() => [] as Array<{ event: string; pid: number; time: number }>);
      if (events.some((row) => row.event === event)) return events;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return f.events().catch(() => [] as Array<{ event: string; pid: number; time: number }>);
  };

  it.each([undefined, "0", "off"])("leaves the driver cold when the flag is %s", async (value) => {
    setFlag(value);
    const f = await fixture(capability, {
      checkPermissions: async () => ({
        accessibility: true,
        screenRecording: true,
      }),
    });
    await expect(cuaRequest(f.endpoint, { method: "probe" })).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("warms spawn and handshake on the first probe without opening a session", async () => {
    setFlag("1");
    const f = await fixture();
    await expect(cuaRequest(f.endpoint, { method: "probe" })).resolves.toMatchObject({
      ok: true,
    });
    const warmed = await waitForEvent(f, "start");
    expect(warmed.filter((event) => event.event === "start")).toHaveLength(1);
    // Warm stops at the validated handshake on purpose: session setup — the
    // fixture's motion event — never reaches the driver before real work.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await f.events()).some((event) => event.event === "motion-100-0")).toBe(false);
    // The first real call reuses the warmed generation: no second spawn, and
    // the once-per-generation cursor setup runs exactly once now.
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter" },
      }),
    ).resolves.toMatchObject({ ok: true });
    const events = await f.events();
    expect(events.filter((event) => event.event === "start")).toHaveLength(1);
    expect(events.filter((event) => event.event === "motion-100-0")).toHaveLength(1);
    expect(events.filter((event) => event.event === "key")).toHaveLength(1);
  });

  it("warms on a permission check too, and only once per host lifetime", async () => {
    setFlag("yes");
    const f = await fixture(capability, {
      checkPermissions: async () => ({
        accessibility: true,
        screenRecording: true,
      }),
    });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await waitForEvent(f, "start");
    // Later first-touch requests do not spawn again — warm is once-only even
    // while it is still in flight.
    await cuaRequest(f.endpoint, { method: "probe" });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
    // A stop retires the warmed generation; the next probe must not conjure a
    // replacement — warm ran its once.
    await f.host.stop();
    await cuaRequest(f.endpoint, { method: "probe" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
    // Real work still starts a driver on demand, paying the cold start then.
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ ok: true });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(2);
  });

  it("does not treat housekeeping requests as first touches", async () => {
    setFlag("1");
    const f = await fixture();
    await cuaRequest(f.endpoint, {
      method: "end_task",
      task: { threadId: "thread", turnId: "turn" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("logs a failed warm and leaves the first real call's own startup intact", async () => {
    setFlag("1");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const f = await fixture(capability, { unpatched: true });
    await expect(cuaRequest(f.endpoint, { method: "probe" })).resolves.toMatchObject({
      ok: true,
    });
    await waitForEvent(f, "exit");
    await vi.waitFor(() =>
      expect(
        info.mock.calls.some((call) => String(call[0]).includes("driver warm-up failed")),
      ).toBe(true),
    );
    // The warm failure retired its generation cleanly; the real call spawns
    // again and fails on the same handshake, not on anything warm poisoned.
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter" },
      }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(2);
  });
});

describe("per-agent cursor identity", () => {
  const press = (endpoint: string, task?: Record<string, unknown>) =>
    cuaRequest<CuaReply>(endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
      ...(task ? { task } : {}),
    });

  it("dispatches each task's calls under its own cursor session label", async () => {
    const f = await fixture(capability, { logSessions: true });
    await expect(
      press(f.endpoint, { threadId: "t-1", label: "Research run" }),
    ).resolves.toMatchObject({
      ok: true,
    });
    await expect(press(f.endpoint, { threadId: "t-2", label: "Docs pass" })).resolves.toMatchObject(
      {
        ok: true,
      },
    );
    await expect(
      press(f.endpoint, { threadId: "t-1", label: "Research run" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(press(f.endpoint)).resolves.toMatchObject({ ok: true });
    const names = (await f.events()).map((row) => row.event);
    // Each thread's actions ride — and badge — its own session cursor.
    expect(names).toContain("session:agent·Research run·t-1:press_key");
    expect(names).toContain("session:agent·Docs pass·t-2:press_key");
    // The shared generation session still backs unattributed calls.
    expect(
      names.some((event) => event.startsWith("session:synara-") && event.endsWith(":press_key")),
    ).toBe(true);
    // Task sessions mint lazily on dispatch: the only explicit start_session
    // is the generation's own bootstrap one — no extra round trip per label.
    expect(names.filter((event) => event.startsWith("open_session:start_session:"))).toEqual([
      expect.stringMatching(/^open_session:start_session:synara-[0-9a-f-]+$/),
    ]);
  });

  it("keeps cursors distinct when two threads share one display label", async () => {
    // The badge text is the session string itself, so the label alone cannot
    // key the cursor — two agents named "Research run" must still get their
    // own cursors and badge tints via the embedded thread id.
    const f = await fixture(capability, { logSessions: true });
    await expect(
      press(f.endpoint, { threadId: "t-1", label: "Research run" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      press(f.endpoint, { threadId: "t-2", label: "Research run" }),
    ).resolves.toMatchObject({ ok: true });
    const names = (await f.events()).map((row) => row.event);
    expect(names).toContain("session:agent·Research run·t-1:press_key");
    expect(names).toContain("session:agent·Research run·t-2:press_key");
  });

  it("falls back to the thread id when a task carries no display label", async () => {
    const f = await fixture(capability, { logSessions: true });
    await expect(press(f.endpoint, { threadId: "t-9" })).resolves.toMatchObject({ ok: true });
    expect((await f.events()).map((row) => row.event)).toContain("session:agent·t-9:press_key");
  });

  it("sanitizes badge-breaking characters out of the minted label", async () => {
    const f = await fixture(capability, { logSessions: true });
    await expect(
      press(f.endpoint, {
        threadId: "t-1",
        label: "Res\u0000earch\nrun\u200B",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect((await f.events()).map((row) => row.event)).toContain(
      "session:agent·Researchrun·t-1:press_key",
    );
  });

  it("a caller session arg can never override the minted agent label", async () => {
    const f = await fixture(capability, { logSessions: true });
    await expect(
      cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "press_key",
        task: { threadId: "t-1", label: "Research run" },
        args: { key: "enter", session: "forged" },
      }),
    ).resolves.toMatchObject({ ok: true });
    const names = (await f.events()).map((row) => row.event);
    expect(names.some((event) => event.startsWith("session:forged"))).toBe(false);
    expect(names).toContain("session:agent·Research run·t-1:press_key");
  });

  it("revives an ended task session in place instead of retiring the generation", async () => {
    // A task-scoped label can die on driver idle expiry while the generation
    // stays healthy: the heal is a start_session revival on the same label,
    // not a new driver process the way a shared-session death forces.
    const f = await fixture(capability, {
      sessionDeathOnce: true,
      logSessions: true,
    });
    const task = { threadId: "t-1", label: "Research run" };
    const reply = await press(f.endpoint, task);
    expect(reply.ok).toBe(true);
    expect(reply.result?.isError).not.toBe(true);
    const events = (await f.events()).map((row) => row.event);
    expect(events.filter((event) => event === "start")).toHaveLength(1);
    expect(events).toContain("open_session:start_session:agent·Research run·t-1");
    expect(events.filter((event) => event === "key")).toHaveLength(1);
    expect(events).toContain("session:agent·Research run·t-1:press_key");
  });
});

describe("browser surface", () => {
  const task = { threadId: "thread", turnId: "turn" };
  it("attributes browser calls to a per-thread lifecycle session under the control transport", async () => {
    const f = await fixture();
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      task,
      args: { url: "https://example.com" },
    });
    expect(reply.ok).toBe(true);
    const events = (await f.events()).map((row) => row.event);
    // The first browser call opened the persistent control connection; the
    // dispatch then rode the thread's lifecycle label under that transport id.
    expect(events.some((event) => event.startsWith("session-begin:synara-transport-"))).toBe(true);
    expect(
      events.some((event) =>
        event.startsWith("browser:browser_navigate:synara-browser-thread:synara-transport-"),
      ),
    ).toBe(true);
    // A caller-supplied session can never override the minted label.
    const forged = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_click",
      task,
      args: { target_id: "t", tab_id: "tab", ref: "p1:0", session: "forged" },
    });
    expect(forged.ok).toBe(true);
    expect(
      (await f.events()).some((row) =>
        String(row.event).startsWith("browser:browser_click:forged"),
      ),
    ).toBe(false);
    expect(
      (await f.events()).some((row) =>
        String(row.event).startsWith(
          "browser:browser_click:synara-browser-thread:synara-transport-",
        ),
      ),
    ).toBe(true);
  });
  it("refuses browser calls without task attribution before starting a daemon", async () => {
    const f = await fixture();
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: { url: "https://example.com" },
    });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("task attribution");
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("ends the thread's browser session on end_browser_thread and revives it on the next call", async () => {
    const f = await fixture();
    const click = () =>
      cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "browser_click",
        task,
        args: { target_id: "t", tab_id: "tab", ref: "p1:0" },
      });
    await expect(click()).resolves.toMatchObject({ ok: true });
    await expect(
      cuaRequest(f.endpoint, { method: "end_browser_thread", task }),
    ).resolves.toMatchObject({ ok: true });
    await expect(click()).resolves.toMatchObject({ ok: true });
    const lifecycle = (await f.events())
      .map((row) => row.event)
      .filter(
        (event) =>
          event.startsWith("browser:") ||
          event.startsWith("start_session:") ||
          event.startsWith("end_session:"),
      );
    expect(lifecycle).toEqual([
      expect.stringMatching(/^browser:browser_click:synara-browser-thread:/),
      expect.stringMatching(/^end_session:synara-browser-thread:synara-transport-/),
      expect.stringMatching(/^start_session:synara-browser-thread:synara-transport-/),
      expect.stringMatching(/^browser:browser_click:synara-browser-thread:/),
    ]);
  });
  it("keeps end_browser_thread a no-op for a thread that never used the browser", async () => {
    const f = await fixture();
    await expect(
      cuaRequest(f.endpoint, { method: "end_browser_thread", task }),
    ).resolves.toMatchObject({ ok: true });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses a browser bind that names one of this app's own pids", async () => {
    const f = await fixture(capability, { ownPids: () => new Set([424242]) });
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "get_browser_state",
      task,
      args: { pid: 424242, window_id: 20 },
    });
    expect(reply.ok).toBe(true);
    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.structuredContent).toMatchObject({
      effect: "refused",
      code: "browser_self_target",
    });
    // The refusal is decided at admission: no daemon ever started.
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
    // An unrelated pid still dispatches normally.
    const other = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "get_browser_state",
      task,
      args: { pid: 777, window_id: 20 },
    });
    expect(other.ok).toBe(true);
    expect(
      (await f.events()).some((row) => String(row.event).startsWith("browser:get_browser_state:")),
    ).toBe(true);
  });
});

describe("physical Escape interrupt", () => {
  const pressKey = (endpoint: string) =>
    cuaRequest<CuaReply>(endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
    });
  /** Poll the driver's event log until `event` appears or ~3 s elapse. */
  const waitForEvent = async (
    f: Awaited<ReturnType<typeof fixture>>,
    event: string,
  ): Promise<Array<{ event: string; pid: number; time: number }>> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const events = await f
        .events()
        .catch(() => [] as Array<{ event: string; pid: number; time: number }>);
      if (events.some((row) => row.event === event)) return events;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return f.events().catch(() => [] as Array<{ event: string; pid: number; time: number }>);
  };

  it("ignores the press when nothing is driving, so Escape stays an ordinary key", async () => {
    const f = await fixture();
    // No live or spawning generation and no held latch: the host reports the
    // press did not engage, and mutating admission still works afterwards.
    expect(f.host.emergencyStopInput()).toBe(false);
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
  });

  it("aborts the in-flight action and admits the next action without any re-arm", async () => {
    let releaseCalls = 0;
    const f = await fixture(capability, {
      releaseHeldInput: async () => {
        releaseCalls += 1;
      },
    });
    // Prime a live generation.
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });

    // The fake driver holds a type_text reply for 10s — the wedged-provider
    // shape the interrupt exists for. The press must not wait on it.
    const hung = cuaRequest(
      f.endpoint,
      { method: "call", name: "type_text", args: { text: "fixture" } },
      { timeoutMs: 5_000, mutation: true },
    );
    await waitForEvent(f, "dispatch");
    expect(f.host.emergencyStopInput()).toBe(true);
    // The in-flight call is cancelled through the driver cancel path and the
    // OS-level release posts beside it — neither waits on the held reply.
    await expect(hung).resolves.toMatchObject({ ok: false });
    expect(releaseCalls).toBeGreaterThanOrEqual(1);
    await waitForEvent(f, "cancel");
    const events = await f.events();
    expect(events.some((event) => event.event === "release")).toBe(true);
    expect(events.some((event) => event.event === "effect")).toBe(false);

    // Momentary: the next mutating admission is not refused by any latch. It
    // waits for the stop's own retirement, spawns a fresh generation, and
    // dispatches — there is no re-arm step to perform.
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
    const after = await f.events();
    expect(after.filter((event) => event.event === "retiring")).toHaveLength(1);
    expect(after.filter((event) => event.event === "start")).toHaveLength(2);
    expect(after.filter((event) => event.event === "key")).toHaveLength(2);
  });

  it("keeps admission closed after a driver crash until the held-input release is confirmed", async () => {
    const release = deferred<void>();
    const f = await fixture(capability, {
      crash: true,
      releaseHeldInput: async () => {
        await release.promise;
      },
    });
    // The fake driver exits on dispatch. The call's own retirement stays
    // pending on the release gate, so the crashed generation is still the
    // host's live reference when Escape lands — and the request's reply is
    // legitimately blocked on that cleanup, which is why it is not awaited yet.
    const crashing = cuaRequest(
      f.endpoint,
      { method: "call", name: "type_text", args: { text: "fixture" } },
      { timeoutMs: 5_000, mutation: true },
    );
    await waitForEvent(f, "crash");
    expect(f.host.emergencyStopInput()).toBe(true);
    // Let the crash retirement finish: with the release confirmed the dead
    // generation clears, and nothing else holds admission.
    release.resolve();
    await expect(crashing).resolves.toMatchObject({ ok: false });
    // stop() joins the pending retirement chain, so its return proves the
    // generation cleared rather than merely having had time to.
    await f.host.stop();
    // The interrupt left no latch behind: the next action spawns a fresh
    // generation and dispatches, with no re-arm and no observation gate.
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
  });

  it("stays fail-closed when the crash cleanup is unconfirmed, with no Escape latch involved", async () => {
    const f = await fixture(capability, {
      crash: true,
      releaseHeldInput: () => Promise.reject(new Error("helper gone")),
    });
    await expect(
      cuaRequest(
        f.endpoint,
        { method: "call", name: "type_text", args: { text: "fixture" } },
        { timeoutMs: 1_000, mutation: true },
      ),
    ).resolves.toMatchObject({ ok: false });
    // The driver died mid-input and nothing confirmed the OS-level release:
    // the generation stays referenced, and the interrupt cannot reopen what
    // the unprovable held-input state is closing.
    expect(f.host.emergencyStopInput()).toBe(true);
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
  });

  it("has no rearm method left on the host protocol", async () => {
    const f = await fixture();
    const reply = await cuaRequest<CuaReply>(f.endpoint, { method: "rearm" });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("Unsupported computer host request.");
  });
});

describe("activation shield host method", () => {
  const task = { threadId: "thread", turnId: "turn" };
  const engageArgs = {
    action: "engage",
    shield_id: "shield-abc123",
    frame: { x: 100, y: 50, width: 400, height: 300 },
    window_id: 4242,
    pid: 777,
    label: "Synara activating Calculator",
  };
  const recordingShield = () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    return {
      calls,
      engage: async (request: unknown, shieldTask?: unknown) => {
        calls.push({ method: "engage", args: [request, shieldTask] });
      },
      release: async (shieldId: string) => {
        calls.push({ method: "release", args: [shieldId] });
      },
      releaseAll: async () => {
        calls.push({ method: "releaseAll", args: [] });
        return calls.filter((call) => call.method === "engage").length;
      },
      endTask: async (ended: unknown) => {
        calls.push({ method: "endTask", args: [ended] });
      },
      stop: async () => {
        calls.push({ method: "stop", args: [] });
      },
      dispose: async () => {
        calls.push({ method: "dispose", args: [] });
      },
    };
  };

  it("routes engage to the shield host with parsed args and task attribution", async () => {
    const shield = recordingShield();
    const f = await fixture(capability, { shield });
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "shield",
      task,
      args: engageArgs,
    });
    expect(reply.ok).toBe(true);
    expect(reply.result).toMatchObject({
      engaged: true,
      shield_id: "shield-abc123",
    });
    expect(shield.calls).toHaveLength(1);
    const call = shield.calls[0]!;
    expect(call.method).toBe("engage");
    expect(call.args[0]).toEqual({
      shieldId: "shield-abc123",
      frame: { x: 100, y: 50, width: 400, height: 300 },
      windowId: 4242,
      pid: 777,
      label: "Synara activating Calculator",
    });
    expect(call.args[1]).toEqual(task);
    // A shield engage is host-local: no driver generation was ever started.
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses engage when no shield surface is configured", async () => {
    const f = await fixture();
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "shield",
      task,
      args: engageArgs,
    });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("not available");
    expect(reply.effect).toBe("not-dispatched");
  });

  it("refuses engage while the desktop is paused but still accepts release", async () => {
    const shield = recordingShield();
    const f = await fixture(capability, { shield });
    await f.host.pauseDesktop("screen-lock");
    try {
      const reply = await cuaRequest<CuaReply>(f.endpoint, {
        method: "shield",
        task,
        args: engageArgs,
      });
      expect(reply.ok).toBe(false);
      expect(reply.error).toContain("paused");
      // Teardown is never gated on the pause.
      await expect(
        cuaRequest<CuaReply>(f.endpoint, {
          method: "shield",
          args: { action: "release", shield_id: "shield-abc123" },
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(shield.calls.map((call) => call.method)).toEqual(["stop", "release"]);
    } finally {
      f.host.resumeDesktop("screen-lock");
    }
  });

  it("rejects malformed shield args before touching the surface", async () => {
    const shield = recordingShield();
    const f = await fixture(capability, { shield });
    for (const args of [
      { action: "engage", shield_id: "bad id with spaces" },
      {
        action: "engage",
        shield_id: "shield-1",
        frame: { x: 0, y: 0, width: -4, height: 4 },
        window_id: 1,
        pid: 1,
      },
      {
        action: "engage",
        shield_id: "shield-1",
        frame: { x: 0, y: 0, width: 4, height: 4 },
        window_id: 0,
        pid: 1,
      },
      { action: "release" },
      { action: "detonate" },
      "engage",
    ]) {
      const reply = await cuaRequest<CuaReply>(f.endpoint, {
        method: "shield",
        task,
        args,
      });
      expect(reply.ok).toBe(false);
      expect(reply.effect).toBe("not-dispatched");
    }
    expect(shield.calls).toHaveLength(0);
  });

  it("release_all is the forced-release path and reports the live count", async () => {
    const shield = recordingShield();
    const f = await fixture(capability, { shield });
    await cuaRequest<CuaReply>(f.endpoint, {
      method: "shield",
      task,
      args: engageArgs,
    });
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "shield",
      args: { action: "release_all" },
    });
    expect(reply.ok).toBe(true);
    expect(reply.result).toMatchObject({ released: 1 });
    expect(shield.calls.map((call) => call.method)).toEqual(["engage", "releaseAll"]);
  });

  it("end_task releases the task's shields", async () => {
    const shield = recordingShield();
    const f = await fixture(capability, { shield });
    await cuaRequest<CuaReply>(f.endpoint, {
      method: "end_task",
      task,
    });
    expect(shield.calls.map((call) => call.method)).toEqual(["endTask"]);
    expect(shield.calls[0]!.args[0]).toEqual(task);
  });

  it("stop and dispose release the whole shield surface", async () => {
    const shield = recordingShield();
    const f = await fixture(capability, { shield });
    await f.host.stop();
    expect(shield.calls.map((call) => call.method)).toContain("stop");
  });

  it("shield requests still require host authority", async () => {
    const f = await fixture();
    const socket = createConnection(f.endpoint);
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once("connect", () => {
        socket.write(
          JSON.stringify({
            method: "shield",
            args: { action: "release_all" },
          }) + "\n",
        );
      });
      socket.once("data", (chunk) => {
        try {
          resolve(JSON.parse(chunk.toString()));
        } catch (error) {
          reject(error);
        }
      });
      socket.once("error", reject);
    });
    socket.destroy();
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toContain("authority");
  });
});
