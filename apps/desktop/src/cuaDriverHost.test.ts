import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { CuaDriverHost, ESCAPE_INPUT_COOLDOWN_MS } from "./cuaDriverHost";
import { cuaHostProcessIsAlive } from "./cuaRuntimeOwnership";
import type { ComputerInputMonitorState } from "./escapeKillSwitchMonitor";
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
    platform?: "darwin" | "linux";
    cleanup?: "incomplete" | "wrong-pid" | "missing-admission";
    interruptCleanup?: "incomplete" | "wrong-pid" | "missing-admission" | "once-incomplete";
    inputMonitorState?: (() => ComputerInputMonitorState) | undefined;
    activateInputMonitor?: () => Promise<void>;
    onInputMonitorArmedChange?: (armed: boolean) => void;
    unpatched?: boolean;
    nativeRevision?: number | null;
    reportedRevision?: number;
    browserInputControl?: unknown;
    metadataPidOffset?: number;
    metadataDelayMs?: number;
    failAction?: boolean;
    actionResult?: Record<string, unknown>;
    cursorUnavailable?: boolean;
    logCursorState?: boolean;
    cursorEnableFailures?: number;
    cursorHideFailures?: number;
    crash?: boolean;
    sessionDeathOnce?: boolean;
    sessionDeathTransport?: boolean;
    // Opt-in: logs `session:`/`open_session:` lines for the label each call
    // rides. Off by default so full-event-list assertions in older tests are
    // not polluted by the added instrumentation.
    logSessions?: boolean;
    browserRefusal?: boolean;
    browserHang?: boolean;
    browserCleanupUnconfirmed?: boolean;
    browserObservations?: boolean;
    inputDelayMs?: number;
    delayBrowserObservation?: boolean;
    delayObservation?: boolean;
    delayListWindowsMs?: number;
    hangSession?: boolean;
    dropCancel?: boolean;
    startupTimeoutMs?: number;
    deathFlag?: string;
    ownPids?: () => ReadonlySet<number>;
    cursorStyle?: () => { fill?: string; rim?: string; shadow?: string } | null | undefined;
    checkPermissions?: (options?: { readonly force: boolean }) => Promise<{
      accessibility: boolean;
      screenRecording: boolean;
      inputMonitoring?: boolean;
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
  // Model the driver's platform explicitly, independently of the CI runner.
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: options.platform ?? "darwin" });
  cleanups.push(async () => {
    Object.defineProperty(process, "platform", platformDescriptor);
  });
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
  if(process.argv[process.argv.indexOf('--idle-hide-ms')+1]!=='60000') throw new Error('Missing cursor idle deadline');
}
if(options.unpatched&&(process.argv.includes('--compact-cursor')||process.argv.includes('--idle-hide-ms'))) throw new Error('Upstream driver cannot parse Synara cursor flags');
const socket=process.argv[process.argv.indexOf('--socket')+1];
let action, timer, inputEpoch=0, interruptions=0, browserCleanupPending=false, cursorEnables=0, cursorHides=0;
net.createServer(s=>{
  const reply=result=>s.end(JSON.stringify({ok:true,result})+'\\n');
  s.once('data',b=>{
    const r=JSON.parse(b.toString());
    if(options.logSessions&&r.method==='call'&&r.args&&typeof r.args.session==='string') write('session:'+r.args.session+':'+r.name);
    if(r.method==='metadata') setTimeout(()=>reply({driver_version:${JSON.stringify(CUA_DRIVER_VERSION)},synara_native_revision:options.reportedRevision??(options.unpatched?undefined:${CUA_NATIVE_REVISION}),synara_browser_input_control:options.browserInputControl,embedded:true,pid:process.pid+(options.metadataPidOffset??0)}),options.metadataDelayMs??0);
    else if(r.method==='interrupt_input') {
      write('interrupt');
      if(r.args.expected_pid!==process.pid) throw new Error('Wrong interrupt generation');
      inputEpoch++; interruptions++;
      clearTimeout(timer);
      if(action) { write('release'); action.end(JSON.stringify({ok:false,error:'interrupted'})+'\\n'); action=undefined; }
      const incomplete=browserCleanupPending||options.interruptCleanup==='incomplete'||(options.interruptCleanup==='once-incomplete'&&interruptions===1);
      setTimeout(()=>{
        write('interrupt-ack');
        reply({pid:process.pid+(options.interruptCleanup==='wrong-pid'?1:0),input_interrupted:true,input_admission_open:options.interruptCleanup==='missing-admission'?undefined:!incomplete,cleanup_complete:!incomplete,pending_input:incomplete?1:0,input_epoch:inputEpoch});
      },30);
    }
    else if(r.method==='cancel_input') {
      write('cancel');
      if(options.dropCancel) { s.destroy(); return; }
      if(r.args.expected_pid!==process.pid) throw new Error('Wrong generation');
      clearTimeout(timer);
      if(action) { write('release'); action.end(JSON.stringify({ok:false,error:'cancelled'})+'\\n'); action=undefined; }
      setTimeout(()=>{
        write('cleanup-ack');
        reply({pid:process.pid+(options.cleanup==='wrong-pid'?1:0),input_admission_closed:options.cleanup==='missing-admission'?undefined:true,cleanup_complete:!browserCleanupPending&&options.cleanup!=='incomplete',pending_input:browserCleanupPending||options.cleanup==='incomplete'?1:0});
      },30);
    }
    else if(options.sessionDeathOnce && r.method==='call' && r.args && r.args.session && r.name!=='start_session' && r.name!=='set_agent_cursor_motion' && r.name!=='set_agent_cursor_style' && r.name!=='set_agent_cursor_enabled' && r.name!=='get_agent_cursor_state' && !fs.existsSync(options.deathFlag)) { fs.writeFileSync(options.deathFlag, '1'); reply({isError:true, content:[{type:'text', text:"session '"+r.args.session+"' has ended; tool call '"+r.name+"' was rejected. Call start_session with this id to revive it before issuing further actions, or use a new session id."}], structuredContent:{effect:'not-dispatched'}}); }
    else if(options.sessionDeathTransport && r.method==='call' && r.args && r.args.session && r.name!=='start_session' && r.name!=='set_agent_cursor_motion' && r.name!=='set_agent_cursor_style' && r.name!=='set_agent_cursor_enabled' && r.name!=='get_agent_cursor_state' && !fs.existsSync(options.deathFlag)) { fs.writeFileSync(options.deathFlag, '1'); s.end(JSON.stringify({ok:false,error:"session '"+r.args.session+"' has ended; tool call '"+r.name+"' was rejected. Call start_session with this id to revive it before issuing further actions, or use a new session id.",effect:'not-dispatched'})+'\\n'); }
    else if(r.name==='type_text') {
      if(!options.unpatched&&r.expected_input_epoch!==inputEpoch) { reply({isError:true,structuredContent:{effect:'refused',code:'input_admission_closed'}}); return; }
      write('dispatch'); action=s;
      if(options.crash) { write('crash'); process.exit(1); }
      else if(options.failAction) s.destroy();
      else timer=setTimeout(()=>{write('effect');reply({});action=undefined},options.inputDelayMs??10000);
    }
    else if(options.hangSession && r.name==='start_session' && !fs.existsSync(options.deathFlag)) { fs.writeFileSync(options.deathFlag,'1'); write('session-hang'); }
    else if(r.name==='set_agent_cursor_motion') { write('motion-'+r.args.glide_duration_ms+'-'+r.args.dwell_after_click_ms); reply({}); }
    else if(r.name==='set_agent_cursor_style') { write('style:'+JSON.stringify(r.args)); reply({}); }
    else if(r.name==='set_agent_cursor_enabled') {
      if(options.logCursorState) write('cursor-enabled:'+r.args.enabled+':'+r.args.session);
      const failed=r.args.enabled?cursorEnables++<(options.cursorEnableFailures??0):cursorHides++<(options.cursorHideFailures??0);
      reply(failed?{isError:true}:{});
    }
    else if(r.name==='get_agent_cursor_state') {
      if(options.logCursorState) write('cursor-state:'+r.args.session);
      reply(options.cursorUnavailable?{isError:true,content:[{type:'text',text:'private overlay error'}]}:{structuredContent:{session:r.args.session,enabled:true,position:{x:10,y:20},motion:{idle_hide_ms:60000},overlay_ready:true,render_visible:true,overlay_scope:'main_display'}});
    }
    else if(options.browserInputControl===1&&['clipboard_read','clipboard_write','kill_app','move_cursor'].includes(r.name)) {
      if(r.expected_input_epoch!==inputEpoch) { reply({isError:true,structuredContent:{effect:'refused',code:'input_admission_closed'}}); return; }
      write('permitted-native:'+r.name); reply({});
    }
    else if(r.name==='press_key') { if(!options.unpatched&&r.expected_input_epoch!==inputEpoch) { reply({isError:true,structuredContent:{effect:'refused',code:'input_admission_closed'}}); return; } write('key'); write('observation-budget-'+process.env.SYNARA_CUA_FOREGROUND_OBSERVATION_MS); reply(options.actionResult??{}); }
    else if(r.name==='get_window_state' && !r.args?.empty) { write('observe'); setTimeout(()=>reply({structuredContent:{elements:r.args?.fixture_usable?[{role:"AXWindow"}]:[],window_is_on_screen:r.args?.fixture_usable===true,window_on_current_space:r.args?.fixture_usable===true,degraded:r.args?.fixture_degraded,screenshot_frame_valid:r.args?.fixture_stale!==true,pid:r.args?.pid,window_id:r.args?.fixture_wrong_window?99999:r.args?.window_id}}),options.delayObservation?60:0); }
    else if(r.name==='get_desktop_state') reply({content:[{type:'image',data:'fixture-image'}]});
    else if(r.name==='list_windows') { write('list-windows'); setTimeout(()=>{reply({structuredContent:{windows:options.listWindows||[]}});if(options.delayListWindowsMs) write('list-windows-replied');},options.delayListWindowsMs??0); }
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
    else if(r.name&&(r.name.indexOf('browser_')===0||r.name==='get_browser_state')) {
      write('browser:'+r.name+':'+(r.args&&r.args.session)+':'+(r.session_id||'-'));
      if(r.name.indexOf('browser_')===0&&(!options.unpatched||options.browserInputControl===1)&&r.expected_input_epoch!==inputEpoch) { reply({isError:true,structuredContent:{effect:'refused',code:'input_admission_closed'}}); return; }
      if(options.browserObservations&&r.name==='get_browser_state') {
        if(r.args?.target_id) {
          write('browser-observe');
          const data={status:'ok',mode:r.args.fixture_bind_only?'bind':'snapshot',target_id:r.args.fixture_wrong_target?'wrong-target':r.args.target_id,tab_id:r.args.tab_id,refs:[]};
          if(r.args.snapshot_format==='semantic_v2') data.snapshot={id:'p1'}; else data.snapshot_id='p1';
          setTimeout(()=>reply({structuredContent:data}),options.delayBrowserObservation?60:0);
        } else reply({structuredContent:{status:'ok',mode:'bind',binding_quality:'exact',mutation_allowed:true,target_id:r.args.fixture_target_id||'target-'+r.args.pid+'-'+r.args.window_id,tabs:[]}});
      }
      else if(options.browserHang&&r.name==='browser_type') { write('browser-dispatch'); action=s; timer=setTimeout(()=>{write('browser-effect'); reply({}); action=undefined},options.inputDelayMs??10000); }
      else if(options.browserCleanupUnconfirmed&&r.name==='browser_type') { browserCleanupPending=true; reply({isError:true,structuredContent:{input_cleanup_unconfirmed:true,effect:'unverifiable'}}); }
      else reply(options.browserRefusal?{structuredContent:{status:'refused',refusal:{code:'browser_requires_setup'}},content:[{type:'text',text:'refused (browser_requires_setup)'}]}:{});
    }
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
    ...(options.inputMonitorState ? { inputMonitorState: options.inputMonitorState } : {}),
    ...(options.activateInputMonitor ? { activateInputMonitor: options.activateInputMonitor } : {}),
    ...(options.onInputMonitorArmedChange
      ? { onInputMonitorArmedChange: options.onInputMonitorArmedChange }
      : {}),
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
      if (!options.cleanup && !options.crash && !options.browserCleanupUnconfirmed) throw error;
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
/** Wait for a real driver event; a missed barrier must fail the test. */
async function waitForEvent(
  f: Awaited<ReturnType<typeof fixture>>,
  event: string,
): Promise<Array<{ event: string; pid: number; time: number }>> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const events = await f
      .events()
      .catch(() => [] as Array<{ event: string; pid: number; time: number }>);
    if (events.some((row) => row.event === event)) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const events = await f.events().catch(() => []);
  throw new Error(
    `Timed out waiting for driver event ${event}; saw ${events.map((row) => row.event).join(", ")}`,
  );
}

describe("Cua macOS host retirement", () => {
  it("starts the compact cursor once per generation and owns the observation budget", async () => {
    const f = await fixture();
    for (let i = 0; i < 2; i++) {
      const reply = await cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter", _synara_foreground_observation_ms: 0 },
      });
      expect(reply.ok).toBe(true);
      expect(reply.hostPlatform).toBe("darwin");
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

  it("requires an uncached confirming read before accepting a changed permission snapshot", async () => {
    let granted = false;
    const checks: boolean[] = [];
    const f = await fixture(capability, {
      checkPermissions: async (options) => {
        checks.push(options?.force === true);
        return { accessibility: granted, screenRecording: granted };
      },
    });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    granted = true;
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    expect(checks).toEqual([false, false, true]);
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
        structuredContent: { code: "computer_input_paused", effect: "refused" },
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
    // the count alongside its computer_input_paused result.
    await expect(
      cuaRequest<CuaReply>(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({
      desktopPauses: ["screen-lock", "system-sleep"],
      desktopInterruptions: 2,
      result: { structuredContent: { code: "computer_input_paused" } },
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
        structuredContent: { code: "computer_input_paused" },
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

  it.each([
    { threadId: "other-thread", turnId: "turn" },
    { threadId: "thread", turnId: "new-turn" },
  ])(
    "stopping queued $threadId/$turnId's sibling preserves its native input",
    async (activeTask) => {
      const f = await fixture(capability, { inputDelayMs: 300, logSessions: true });
      const active = cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "type_text",
        task: activeTask,
        args: { text: "fixture" },
      });
      await waitForEvent(f, "dispatch");
      const queued = cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "press_key",
        task,
        args: { key: "enter" },
      });
      await expect(cuaRequest(f.endpoint, { method: "stop", task })).resolves.toMatchObject({
        ok: true,
        result: { stop_scope: "task" },
      });
      await expect(queued).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
      await expect(active).resolves.toMatchObject({ ok: true });
      await expect(
        cuaRequest(f.endpoint, {
          method: "call",
          name: "press_key",
          task: activeTask,
          args: { key: "enter" },
        }),
      ).resolves.toMatchObject({ ok: true });
      const events = (await f.events()).map((row) => row.event);
      expect(events.filter((event) => event === "start")).toHaveLength(1);
      expect(events.filter((event) => event === "key")).toHaveLength(1);
      expect(events).toContain("effect");
      expect(events).not.toContain("interrupt");
      expect(events).not.toContain("retiring");
    },
  );

  it("drains matching native input and reports that queued siblings share the generation fence", async () => {
    const f = await fixture();
    const active = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "type_text",
      task,
      args: { text: "fixture" },
    });
    await waitForEvent(f, "dispatch");
    const sibling = { threadId: "other-thread", turnId: "turn" };
    const queued = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "press_key",
      task: sibling,
      args: { key: "enter" },
    });
    await expect(cuaRequest(f.endpoint, { method: "stop", task })).resolves.toMatchObject({
      ok: true,
      result: { stop_scope: "generation" },
    });
    await expect(active).resolves.toMatchObject({ ok: false, effect: "dispatched-unknown" });
    await expect(queued).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "press_key",
        task: sibling,
        args: { key: "enter" },
      }),
    ).resolves.toMatchObject({ ok: true });
    const events = (await f.events()).map((row) => row.event);
    expect(events.indexOf("interrupt-ack")).toBeLessThan(events.indexOf("key"));
    expect(events.filter((event) => event === "start")).toHaveLength(1);
    expect(events).not.toContain("effect");
    expect(events).not.toContain("cancel");
    expect(events).not.toContain("retiring");
  });

  it("cancels only the matching observation without interrupting queued sibling input", async () => {
    const f = await fixture(capability, { delayObservation: true });
    const observation = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "get_window_state",
      task,
      modelObservation: true,
      args: { pid: 42, window_id: 10 },
    });
    await waitForEvent(f, "observe");
    const sibling = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "press_key",
      task: { threadId: "other-thread", turnId: "turn" },
      args: { key: "enter" },
    });
    await expect(cuaRequest(f.endpoint, { method: "stop", task })).resolves.toMatchObject({
      ok: true,
      result: { stop_scope: "task" },
    });
    await expect(observation).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    await expect(sibling).resolves.toMatchObject({ ok: true });
    expect((await f.events()).some((row) => row.event === "interrupt")).toBe(false);
  });

  it("releases a matching permission wait without cancelling AppSnap's shared check", async () => {
    const entered = deferred<void>();
    const pending = deferred<{ accessibility: boolean; screenRecording: boolean }>();
    const f = await fixture(capability, {
      checkPermissions: () => {
        entered.resolve();
        return pending.promise;
      },
    });
    const check = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "check_permissions",
      task,
    });
    await entered.promise;
    await f.host.stopTaskByUser(task);
    await expect(check).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key", args: { key: "enter" } }),
    ).resolves.toMatchObject({ ok: true });
    pending.resolve({ accessibility: true, screenRecording: true });
    expect((await f.events()).some((row) => row.event === "interrupt")).toBe(false);
  });

  it("revokes a task during native startup without retiring the sibling's shared generation", async () => {
    const f = await fixture(capability, { metadataDelayMs: 100 });
    const starting = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "press_key",
      task,
      args: { key: "enter" },
    });
    await waitForEvent(f, "start");
    await expect(cuaRequest(f.endpoint, { method: "stop", task })).resolves.toMatchObject({
      ok: true,
      result: { stop_scope: "task" },
    });
    await expect(starting).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key", args: { key: "enter" } }),
    ).resolves.toMatchObject({ ok: true });
    const events = (await f.events()).map((row) => row.event);
    expect(events.filter((event) => event === "key")).toHaveLength(1);
    expect(events.filter((event) => event === "start")).toHaveLength(1);
    expect(events).not.toContain("interrupt");
    expect(events).not.toContain("retiring");
  });

  it("keeps native input ownership when a detached launch-preview read finishes", async () => {
    const f = await fixture(capability, {
      delayListWindowsMs: 100,
      frameTap: {
        update: () => {},
        endTask: async () => {},
        stop: async () => {},
        dispose: async () => {},
      },
    });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "launch_app",
      task: { threadId: "launching-thread", turnId: "turn" },
      args: { name: "Calculator" },
    });
    await waitForEvent(f, "list-windows");
    const active = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "type_text",
      task,
      args: { text: "fixture" },
    });
    await waitForEvent(f, "dispatch");
    await waitForEvent(f, "list-windows-replied");
    await expect(cuaRequest(f.endpoint, { method: "stop", task })).resolves.toMatchObject({
      ok: true,
      result: { stop_scope: "generation" },
    });
    await expect(active).resolves.toMatchObject({ ok: false, effect: "dispatched-unknown" });
    const events = (await f.events()).map((row) => row.event);
    expect(events).toContain("interrupt-ack");
    expect(events).not.toContain("effect");
    expect(events).not.toContain("retiring");
  });

  it("drains its thread's active native input when Stop omits a turn identity", async () => {
    const f = await fixture();
    const active = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "type_text",
      task,
      args: { text: "fixture" },
    });
    await waitForEvent(f, "dispatch");
    await expect(
      cuaRequest(f.endpoint, { method: "stop", task: { threadId: task.threadId } }),
    ).resolves.toMatchObject({ ok: true, result: { stop_scope: "generation" } });
    await expect(active).resolves.toMatchObject({ ok: false, effect: "dispatched-unknown" });
    const events = (await f.events()).map((row) => row.event);
    expect(events).toContain("interrupt-ack");
    expect(events).not.toContain("effect");
    expect(events).not.toContain("retiring");
  });

  it.each(["idle", "queued"] as const)(
    "thread-wide Stop preserves a sibling when its own work is %s",
    async (state) => {
      let activations = 0;
      const f = await fixture(capability, {
        inputDelayMs: 500,
        activateInputMonitor: async () => {
          activations += 1;
        },
      });
      await cuaRequest(f.endpoint, {
        method: "call",
        name: "get_window_state",
        task,
        args: { pid: 42, window_id: 10 },
      });
      const sibling = cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "type_text",
        task: { threadId: "other-thread", turnId: "turn" },
        args: { text: "fixture" },
      });
      await waitForEvent(f, "dispatch");
      const queued =
        state === "queued"
          ? ["queued-turn", "other-queued-turn"].map((turnId) =>
              cuaRequest<CuaReply>(f.endpoint, {
                method: "call",
                name: "press_key",
                task: { threadId: task.threadId, turnId },
                args: { key: "enter" },
              }),
            )
          : [];
      if (state === "queued") await vi.waitFor(() => expect(activations).toBe(3));
      await expect(
        cuaRequest(f.endpoint, { method: "stop", task: { threadId: task.threadId } }),
      ).resolves.toMatchObject({ ok: true, result: { stop_scope: "task" } });
      for (const call of queued)
        await expect(call).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
      await expect(sibling).resolves.toMatchObject({ ok: true });
      await expect(
        cuaRequest(f.endpoint, {
          method: "call",
          name: "press_key",
          task,
          args: { key: "enter" },
        }),
      ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
      await expect(
        cuaRequest(f.endpoint, {
          method: "call",
          name: "press_key",
          task: { threadId: task.threadId, turnId: "new-turn-after-stop" },
          args: { key: "enter" },
        }),
      ).resolves.toMatchObject({ ok: true });
      const events = (await f.events()).map((row) => row.event);
      expect(events.filter((event) => event === "key")).toHaveLength(1);
      expect(events).toContain("effect");
      expect(events).not.toContain("interrupt");
      expect(events).not.toContain("retiring");
    },
  );
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

  it("does not prewarm a macOS driver before the first real permission grants", async () => {
    setFlag("1");
    let granted = false;
    const f = await fixture(capability, {
      checkPermissions: async () => ({ accessibility: granted, screenRecording: granted }),
    });
    await cuaRequest(f.endpoint, { method: "probe" });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
    granted = true;
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    expect(
      (await waitForEvent(f, "start")).filter((event) => event.event === "start"),
    ).toHaveLength(1);
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
    const events = await waitForEvent(f, "start");
    const pid = events.find((event) => event.event === "start")!.pid;
    // This deliberately incompatible fixture exits before installing its
    // graceful-exit logger. Verify process death instead of waiting for a
    // log event that can never be emitted on this startup-failure path.
    await vi.waitFor(() => expect(cuaHostProcessIsAlive(pid)).toBe(false));
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

  it("parks between actions, hides only the completed turn and preserves its session", async () => {
    const f = await fixture(capability, { logSessions: true, logCursorState: true });
    const first = { threadId: "cursor-thread", turnId: "turn-1" };
    const next = { threadId: "cursor-thread", turnId: "turn-2" };
    await press(f.endpoint, first);
    await press(f.endpoint, next);
    await cuaRequest(f.endpoint, { method: "end_task", task: first });
    expect((await f.events()).map((e) => e.event)).not.toContain(
      "cursor-enabled:false:agent·cursor-thread",
    );
    await cuaRequest(f.endpoint, { method: "end_task", task: next });
    let events = (await f.events()).map((e) => e.event);
    expect(events).toContain("cursor-enabled:false:agent·cursor-thread");
    expect(events.some((e) => e.includes("end_session"))).toBe(false);
    await press(f.endpoint, { ...next, turnId: "turn-3" });
    events = (await f.events()).map((e) => e.event);
    expect(events.filter((e) => e === "cursor-enabled:true:agent·cursor-thread")).toHaveLength(2);
    expect(events.filter((e) => e === "start")).toHaveLength(1);
  });

  it("reads cursor state only on mint/first action and logs no labels or content", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const f = await fixture(capability, { logCursorState: true });
      const task = { threadId: "cursor-thread", turnId: "turn-1", label: "PRIVATE LABEL" };
      await cuaRequest(f.endpoint, { method: "call", name: "get_window_state", args: {}, task });
      await press(f.endpoint, task);
      await press(f.endpoint, task);
      expect((await f.events()).filter((e) => e.event.startsWith("cursor-state:"))).toHaveLength(2);
      const logs = info.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logs).toContain('"stage":"session-created"');
      expect(logs).toContain('"stage":"first-action"');
      expect(logs).toContain('"overlay_scope":"main_display"');
      expect(logs).not.toContain("PRIVATE LABEL");
      expect(logs).not.toContain('"x":10');
    } finally {
      info.mockRestore();
    }
  });

  it("retries unacknowledged cursor visibility without retrying input", async () => {
    const f = await fixture(capability, {
      logCursorState: true,
      cursorEnableFailures: 1,
      cursorHideFailures: 1,
    });
    const task = { threadId: "cursor-retry", turnId: "turn-1" };
    await press(f.endpoint, task);
    await press(f.endpoint, task);
    await cuaRequest(f.endpoint, { method: "end_task", task });
    await cuaRequest(f.endpoint, { method: "end_task", task });
    await cuaRequest(f.endpoint, { method: "end_task", task });
    const events = (await f.events()).map((e) => e.event);
    expect(events.filter((e) => e === "cursor-enabled:true:agent·cursor-retry")).toHaveLength(2);
    expect(events.filter((e) => e === "cursor-enabled:false:agent·cursor-retry")).toHaveLength(2);
    expect(events.filter((e) => e === "key")).toHaveLength(2);
  });

  it("starts preview and shield cleanup before waiting for the cursor queue", async () => {
    const frameEnded = deferred<void>();
    const shieldEnded = deferred<void>();
    const task = { threadId: "queued-cleanup", turnId: "turn-1" };
    const f = await fixture(capability, {
      inputDelayMs: 300,
      frameTap: {
        update: () => {},
        endTask: async () => {
          frameEnded.resolve();
        },
        stop: async () => {},
        dispose: async () => {},
      },
      shield: {
        engage: async () => {},
        release: async () => {},
        releaseAll: async () => 0,
        endTask: async () => {
          shieldEnded.resolve();
        },
        stop: async () => {},
        dispose: async () => {},
      },
    });
    const action = cuaRequest(f.endpoint, {
      method: "call",
      name: "type_text",
      args: { text: "fixture" },
      task,
    });
    await waitForEvent(f, "dispatch");
    const end = cuaRequest(f.endpoint, { method: "end_task", task });
    await Promise.all([frameEnded.promise, shieldEnded.promise]);
    expect((await f.events()).some((e) => e.event === "effect")).toBe(false);
    await Promise.all([action, end]);
  });

  it("reports a failed cursor query without replaying input or retiring the driver", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const f = await fixture(capability, { cursorUnavailable: true });
      await expect(press(f.endpoint, { threadId: "cursor-thread" })).resolves.toMatchObject({
        ok: true,
      });
      await expect(press(f.endpoint, { threadId: "cursor-thread" })).resolves.toMatchObject({
        ok: true,
      });
      const events = (await f.events()).map((e) => e.event);
      expect(events.filter((e) => e === "key")).toHaveLength(2);
      expect(events.filter((e) => e === "start")).toHaveLength(1);
      const logs = info.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logs).toContain('"status":"unavailable"');
      expect(logs).not.toContain("private overlay error");
    } finally {
      info.mockRestore();
    }
  });

  it("logs structured actuator failures with attribution but no raw native message", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const f = await fixture(capability, {
        actionResult: {
          isError: true,
          content: [{ type: "text", text: "PRIVATE FIELD VALUE" }],
          structuredContent: {
            effect: "dispatched-unknown",
            diagnostics: {
              delivery_path: "ax",
              actuator: "ax_press",
              error_code: "ax_dispatch_failed",
              ax_error: -25204,
              message: "PRIVATE FIELD VALUE",
              title: "PRIVATE WINDOW",
            },
          },
        },
      });
      await press(f.endpoint, { threadId: "failure-thread", turnId: "failure-turn" });
      const logs = info.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logs).toContain('"event":"computer_action"');
      expect(logs).toContain('"turn":"failure-turn"');
      expect(logs).toContain('"ax_error":-25204');
      expect(logs).toContain("The accessibility actuator reported a native error.");
      expect(logs).not.toContain("PRIVATE FIELD VALUE");
      expect(logs).not.toContain("PRIVATE WINDOW");
    } finally {
      info.mockRestore();
    }
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

  it("ignores the press when nothing is driving, so Escape stays an ordinary key", async () => {
    const f = await fixture();
    // No live or spawning generation and no held latch: the host reports the
    // press did not engage, and mutating admission still works afterwards.
    expect(f.host.emergencyStopInput()).toBe(false);
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
  });

  it("drains native input, keeps the generation, and requires fresh observation after Escape", async () => {
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
    // A socket abort returns promptly, while the separate native interrupt
    // drains the old operation and releases its own held input.
    await expect(hung).resolves.toMatchObject({ ok: false });
    await waitForEvent(f, "interrupt-ack");
    expect(releaseCalls).toBe(0);
    const mid = await f.events();
    expect(mid.some((event) => event.event === "interrupt")).toBe(true);
    expect(mid.filter((event) => event.event === "release")).toHaveLength(1);
    expect(mid.some((event) => event.event === "effect")).toBe(false);
    expect(mid.some((event) => event.event === "cancel")).toBe(false);
    expect(mid.some((event) => event.event === "retiring")).toBe(false);
    expect(mid.filter((event) => event.event === "start")).toHaveLength(1);

    // Inside the cooldown a mutating call is refused with the paused
    // dialect, while reads keep dispatching on the same generation.
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({
      ok: true,
      result: {
        isError: true,
        structuredContent: { effect: "refused", code: "computer_input_paused" },
      },
    });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "list_windows" }),
    ).resolves.toMatchObject({ ok: true });

    // Time alone cannot make the model's old target state fresh. A preview
    // or target-readiness probe cannot clear the model-observation gate.
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_INPUT_COOLDOWN_MS + 50));
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({
      result: { structuredContent: { code: "computer_input_paused" } },
      desktopInterruptions: 0,
    });
    await cuaRequest(f.endpoint, { method: "call", name: "get_window_state" });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_input_ready" }),
    ).resolves.toMatchObject({ result: { isError: true } });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      modelObservation: true,
    });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true, result: {} });
    const after = await f.events();
    expect(after.filter((event) => event.event === "start")).toHaveLength(1);
    expect(after.filter((event) => event.event === "key")).toHaveLength(2);
    expect(after.some((event) => event.event === "retiring")).toBe(false);
  });

  it("interrupts the in-flight action on the backend stop verb without retiring", async () => {
    let releaseCalls = 0;
    const f = await fixture(capability, {
      releaseHeldInput: async () => {
        releaseCalls += 1;
      },
    });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
    const hung = cuaRequest(
      f.endpoint,
      { method: "call", name: "type_text", args: { text: "fixture" } },
      { timeoutMs: 5_000, mutation: true },
    );
    await waitForEvent(f, "dispatch");
    // The same socket verb the backend's stopInput sends on turn Stop,
    // control revoke, and the relayed physical-Escape notice.
    await expect(cuaRequest(f.endpoint, { method: "stop" })).resolves.toMatchObject({
      ok: true,
    });
    await expect(hung).resolves.toMatchObject({ ok: false });
    expect(releaseCalls).toBe(0);
    // Native interrupt is reusable; cancel_input still belongs to retirement.
    const mid = await f.events();
    expect(mid.some((event) => event.event === "interrupt-ack")).toBe(true);
    expect(mid.some((event) => event.event === "effect")).toBe(false);
    expect(mid.some((event) => event.event === "cancel")).toBe(false);
    expect(mid.some((event) => event.event === "retiring")).toBe(false);
    expect(mid.filter((event) => event.event === "start")).toHaveLength(1);
    // A bare stop arms no cooldown — the cooldown belongs to the physical
    // press — so the next action dispatches immediately on the live driver.
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
    const after = await f.events();
    expect(after.filter((event) => event.event === "key")).toHaveLength(2);
    expect(after.filter((event) => event.event === "start")).toHaveLength(1);
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
    // pending on the release gate (or the interrupt's abort lands first —
    // either way the crashed generation is still the host's live reference
    // when Escape lands) — and the request's reply is legitimately blocked
    // on that cleanup, which is why it is not awaited yet.
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
    // The replacement generation still needs a fresh model observation;
    // successful crash cleanup does not validate the interrupted model state.
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_INPUT_COOLDOWN_MS + 50));
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      modelObservation: true,
    });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true, result: {} });
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

  it("keeps input closed after an incomplete native interrupt and rechecks the drain before dispatch", async () => {
    const releaseHeldInput = vi.fn(async () => {});
    const f = await fixture(capability, { interruptCleanup: "once-incomplete", releaseHeldInput });
    await pressKey(f.endpoint);
    await expect(cuaRequest(f.endpoint, { method: "stop" })).resolves.toMatchObject({ ok: false });
    expect(releaseHeldInput).toHaveBeenCalledTimes(1);
    expect((await f.events()).filter((event) => event.event === "key")).toHaveLength(1);
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true, result: {} });
    const events = (await f.events()).map((event) => event.event);
    expect(events.filter((event) => event === "interrupt")).toHaveLength(2);
    expect(events.filter((event) => event === "key")).toHaveLength(2);
    expect(events.lastIndexOf("interrupt-ack")).toBeLessThan(events.lastIndexOf("key"));
    expect(events.filter((event) => event === "start")).toHaveLength(1);
  });

  it.each(["wrong-pid", "missing-admission", "incomplete"] as const)(
    "never resumes input on a %s interruption acknowledgement",
    async (interruptCleanup) => {
      const f = await fixture(capability, { interruptCleanup });
      await pressKey(f.endpoint);
      await expect(cuaRequest(f.endpoint, { method: "stop" })).resolves.toMatchObject({
        ok: false,
      });
      await expect(pressKey(f.endpoint)).resolves.toMatchObject({
        ok: false,
        effect: "not-dispatched",
      });
      expect((await f.events()).filter((event) => event.event === "key")).toHaveLength(1);
    },
  );

  it("pauses only the human's controlled target and coalesces repeated physical input", async () => {
    const f = await fixture(capability, { delayObservation: true });
    const task = { threadId: "takeover", turnId: "turn" };
    const args = { pid: 700, window_id: 900, key: "enter" };
    await cuaRequest(f.endpoint, { method: "call", name: "press_key", args, task });
    expect(f.host.physicalInput({ type: "physical-input", kind: "keyboard", pid: 701 })).toBe(
      false,
    );
    expect(
      f.host.physicalInput({ type: "physical-input", kind: "pointer", pid: 700, windowId: 901 }),
    ).toBe(false);
    expect(
      f.host.physicalInput({ type: "physical-input", kind: "pointer", pid: 700, windowId: 900 }),
    ).toBe(true);
    expect(f.host.physicalInput({ type: "physical-input", kind: "keyboard", pid: 700 })).toBe(true);
    await waitForEvent(f, "interrupt-ack");
    expect((await f.events()).filter((event) => event.event === "interrupt")).toHaveLength(1);
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({
      result: { structuredContent: { code: "computer_input_paused" } },
      desktopInterruptions: 0,
    });
    const observation = cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      args,
      modelObservation: true,
      task,
    });
    await waitForEvent(f, "observe");
    expect(f.host.physicalInput({ type: "physical-input", kind: "keyboard", pid: 700 })).toBe(true);
    await expect(observation).resolves.toMatchObject({
      result: { isError: true },
      desktopInterruptions: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_INPUT_COOLDOWN_MS + 50));
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ result: { isError: true } });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      args,
      modelObservation: true,
      task,
    });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({
      ok: true,
      result: {},
      desktopInterruptions: 0,
    });
    await cuaRequest(f.endpoint, { method: "end_task", task });
    expect(f.host.physicalInput({ type: "physical-input", kind: "keyboard", pid: 700 })).toBe(
      false,
    );
  });

  it("interrupts foreground input even when the physical event belongs to a different app", async () => {
    const f = await fixture();
    const hung = cuaRequest(
      f.endpoint,
      {
        method: "call",
        name: "type_text",
        args: { pid: 700, window_id: 900, delivery_mode: "foreground", text: "fixture" },
      },
      { mutation: true },
    );
    await waitForEvent(f, "dispatch");
    expect(f.host.physicalInput({ type: "physical-input", kind: "keyboard", pid: 701 })).toBe(true);
    await expect(hung).resolves.toMatchObject({ ok: false, effect: "dispatched-unknown" });
    await waitForEvent(f, "interrupt-ack");
    expect((await f.events()).filter((event) => event.event === "release")).toHaveLength(1);
  });

  it("starts listener activation only on use and disarms it when the last task ends", async () => {
    let state: ComputerInputMonitorState = { ready: false, error: "input_monitor_idle" };
    const activateInputMonitor = vi.fn(async () => {
      state = { ready: true };
    });
    const onInputMonitorArmedChange = vi.fn((armed: boolean) => {
      if (!armed) state = { ready: false, error: "input_monitor_idle" };
    });
    const f = await fixture(capability, {
      activateInputMonitor,
      onInputMonitorArmedChange,
      inputMonitorState: () => state,
    });
    expect(activateInputMonitor).not.toHaveBeenCalled();
    const task = { threadId: "activation", turnId: "turn" };
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
      task,
    });
    expect(activateInputMonitor).toHaveBeenCalledTimes(1);
    await cuaRequest(f.endpoint, { method: "end_task", task });
    expect(onInputMonitorArmedChange).toHaveBeenLastCalledWith(false);
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
      task: { ...task, turnId: "next" },
    });
    expect(activateInputMonitor).toHaveBeenCalledTimes(2);
    expect((await f.events()).filter((event) => event.event === "key")).toHaveLength(2);
  });

  it("keeps passive status checks and previews idle until actual model Computer work starts", async () => {
    let state: ComputerInputMonitorState = { ready: false, error: "input_monitor_idle" };
    const activateInputMonitor = vi.fn(async () => {
      state = { ready: true };
    });
    const onInputMonitorArmedChange = vi.fn((armed: boolean) => {
      if (!armed) state = { ready: false, error: "input_monitor_idle" };
    });
    const f = await fixture(capability, {
      activateInputMonitor,
      onInputMonitorArmedChange,
      inputMonitorState: () => state,
      checkPermissions: async () => ({
        accessibility: true,
        screenRecording: true,
        inputMonitoring: true,
      }),
    });
    for (let i = 0; i < 3; i += 1) {
      await cuaRequest(f.endpoint, { method: "probe" });
      const status = await cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "check_permissions",
      });
      expect(status.result?.structuredContent).not.toHaveProperty("input_monitor_ready");
      expect(status.result?.structuredContent).not.toHaveProperty("input_monitor_error");
    }
    const task = { threadId: "passive-preview", turnId: "turn" };
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      args: { pid: 700, window_id: 900 },
      task,
      modelObservation: false,
    });
    expect(activateInputMonitor).not.toHaveBeenCalled();
    expect(onInputMonitorArmedChange).not.toHaveBeenCalled();
    expect(f.host.isInputMonitorRequested).toBe(false);
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      args: { pid: 700, window_id: 900 },
      task,
      modelObservation: true,
    });
    expect(activateInputMonitor).toHaveBeenCalledTimes(1);
    expect(f.host.isInputMonitorRequested).toBe(true);
    await cuaRequest(f.endpoint, { method: "end_task", task });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    expect(activateInputMonitor).toHaveBeenCalledTimes(1);
    expect(f.host.isInputMonitorRequested).toBe(false);
    expect(onInputMonitorArmedChange).toHaveBeenLastCalledWith(false);
  });

  it("exposes granted-but-unavailable monitoring and requires recovery before input", async () => {
    let state: ComputerInputMonitorState = { ready: false, error: "event_tap_unavailable" };
    const f = await fixture(capability, {
      inputMonitorState: () => state,
      checkPermissions: async () => ({
        accessibility: true,
        screenRecording: true,
        inputMonitoring: true,
      }),
    });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({
      result: { structuredContent: { effect: "refused", code: "input_monitor_unavailable" } },
    });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({
      result: {
        structuredContent: {
          input_monitoring: true,
          input_monitor_ready: false,
          input_monitor_error: "event_tap_unavailable",
        },
      },
    });
    state = { ready: true };
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true, result: {} });
    state = { ready: false, error: "input_monitor_unavailable" };
    f.host.inputMonitorStateChanged(state);
    await waitForEvent(f, "interrupt-ack");
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({
      result: { structuredContent: { code: "input_monitor_unavailable" } },
      desktopInterruptions: 0,
    });
    state = { ready: true };
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({
      result: { structuredContent: { code: "computer_input_paused" } },
    });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      modelObservation: true,
    });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true, result: {} });
  });

  it("drains an interrupted browser mutation and uses the new epoch without retiring its binding", async () => {
    const f = await fixture(capability, { browserHang: true });
    const task = { threadId: "browser-stop", turnId: "turn" };
    const hung = cuaRequest(
      f.endpoint,
      { method: "call", name: "browser_type", args: { text: "fixture" }, task },
      { mutation: true },
    );
    await waitForEvent(f, "browser-dispatch");
    await expect(cuaRequest(f.endpoint, { method: "stop" })).resolves.toMatchObject({ ok: true });
    await expect(hung).resolves.toMatchObject({ ok: false, effect: "dispatched-unknown" });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "browser_navigate", args: {}, task }),
    ).resolves.toMatchObject({ ok: true, result: {} });
    const events = (await f.events()).map((event) => event.event);
    expect(events.filter((event) => event === "release")).toHaveLength(1);
    expect(events.filter((event) => event === "start")).toHaveLength(1);
    expect(events).not.toContain("browser-effect");
  });

  it.each(["type_text", "browser_type"])(
    "drains already-dispatched %s when its caller disconnects, without replay or replacement",
    async (name) => {
      const f = await fixture(capability, { browserHang: true, inputDelayMs: 150 });
      const controller = new AbortController();
      const call = cuaRequest(
        f.endpoint,
        {
          method: "call",
          name,
          args: { text: "fixture" },
          task: { threadId: "disconnect", turnId: "turn" },
        },
        { mutation: true, signal: controller.signal },
      ).catch((error: unknown) => error);
      await waitForEvent(f, name === "browser_type" ? "browser-dispatch" : "dispatch");
      controller.abort();
      expect(await call).toMatchObject({ effect: "dispatched-unknown" });
      await waitForEvent(f, "interrupt");
      // The next call is admitted behind the matching native cleanup ACK.
      await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true, result: {} });
      await new Promise((resolve) => setTimeout(resolve, 180));
      const events = (await f.events()).map((event) => event.event);
      expect(events.filter((event) => event === "release")).toHaveLength(1);
      expect(events.filter((event) => event === "start")).toHaveLength(1);
      expect(events.indexOf("key")).toBeGreaterThan(events.indexOf("interrupt-ack"));
      expect(events).not.toContain("effect");
      expect(events).not.toContain("browser-effect");
    },
  );

  it("requires a live Escape listener for browser mutations but keeps browser reads available", async () => {
    let state: ComputerInputMonitorState = { ready: false, error: "event_tap_unavailable" };
    const f = await fixture(capability, { inputMonitorState: () => state });
    const task = { threadId: "listener-browser", turnId: "turn" };
    const action = () =>
      cuaRequest(f.endpoint, { method: "call", name: "browser_navigate", args: {}, task });
    await expect(action()).resolves.toMatchObject({
      result: { structuredContent: { code: "input_monitor_unavailable" } },
    });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "get_browser_state", args: {}, task }),
    ).resolves.toMatchObject({ ok: true, result: {} });
    state = { ready: true };
    await expect(action()).resolves.toMatchObject({ ok: true, result: {} });
    expect(
      (await f.events()).filter((event) => event.event.startsWith("browser:browser_navigate:")),
    ).toHaveLength(1);
  });

  it("rechecks browser listener readiness after asynchronous session setup", async () => {
    let checks = 0;
    const f = await fixture(capability, {
      inputMonitorState: () =>
        ++checks === 1 ? { ready: true } : { ready: false, error: "event_tap_unavailable" },
    });
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "browser_navigate",
        args: {},
        task: { threadId: "late-listener-failure", turnId: "turn" },
      }),
    ).resolves.toMatchObject({
      result: { structuredContent: { code: "input_monitor_unavailable" } },
    });
    expect(
      (await f.events()).some((event) => event.event.startsWith("browser:browser_navigate:")),
    ).toBe(false);
  });

  it("does not mistake OS releases or later reads for an unconfirmed browser release", async () => {
    const releaseHeldInput = vi.fn(async () => {});
    const f = await fixture(capability, { browserCleanupUnconfirmed: true, releaseHeldInput });
    const task = { threadId: "browser-cleanup", turnId: "turn" };
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "browser_type", args: {}, task }),
    ).resolves.toMatchObject({
      result: { isError: true, structuredContent: { input_cleanup_unconfirmed: true } },
    });
    await cuaRequest(f.endpoint, { method: "call", name: "get_browser_state", args: {}, task });
    await expect(cuaRequest(f.endpoint, { method: "stop" })).resolves.toMatchObject({ ok: false });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({
      ok: false,
      effect: "not-dispatched",
    });
    expect(releaseHeldInput).not.toHaveBeenCalled();
    expect((await f.events()).some((event) => event.event === "key")).toBe(false);
  });

  it("does not let another task, window, preview, or mismatched read clear native takeover", async () => {
    const f = await fixture();
    const taskA = { threadId: "task-a", turnId: "turn" };
    const taskB = { threadId: "task-b", turnId: "turn" };
    const windowA = { pid: 701, window_id: 901 };
    const windowB = { pid: 700, window_id: 900 };
    const observe = (task: typeof taskA, args: Record<string, unknown>, modelObservation = true) =>
      cuaRequest(f.endpoint, {
        method: "call",
        name: "get_window_state",
        args,
        modelObservation,
        task,
      });
    const click = (task: typeof taskA, args: Record<string, unknown>) =>
      cuaRequest(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { ...args, key: "enter" },
        task,
      });
    await observe(taskA, windowA);
    await observe(taskB, windowB);
    expect(
      f.host.physicalInput({ type: "physical-input", kind: "pointer", pid: 700, windowId: 900 }),
    ).toBe(true);
    await waitForEvent(f, "interrupt-ack");
    await observe(taskA, windowB);
    await observe(taskB, windowA);
    await observe(taskB, windowB, false);
    await observe(taskB, { ...windowB, fixture_wrong_window: true });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_desktop_state",
      modelObservation: true,
      task: taskB,
    });
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_INPUT_COOLDOWN_MS + 50));
    await expect(click(taskA, windowA)).resolves.toMatchObject({ ok: true, result: {} });
    await expect(click(taskB, windowB)).resolves.toMatchObject({
      result: { structuredContent: { code: "computer_input_paused" } },
      desktopInterruptions: 0,
    });
    await observe(taskB, windowB);
    await expect(click(taskB, windowB)).resolves.toMatchObject({ ok: true, result: {} });
  });

  it("fences input after uncertain focus restoration until a fresh model observation", async () => {
    const result = {
      isError: true,
      structuredContent: { effect: "unverifiable", code: "focus_restore_failed" },
    };
    const f = await fixture(capability, { actionResult: result });
    const task = { threadId: "restore-failure", turnId: "turn" };
    const target = { pid: 700, window_id: 900 };
    const act = () =>
      cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { ...target, key: "enter" },
        task,
      });
    const read = (modelObservation: boolean) =>
      cuaRequest(f.endpoint, {
        method: "call",
        name: "get_window_state",
        args: target,
        modelObservation,
        task,
      });
    expect((await act()).result).toEqual(result);
    await read(false);
    expect((await act()).result?.structuredContent?.code).toBe("computer_input_paused");
    expect((await f.events()).filter((e) => e.event === "key")).toHaveLength(1);
    await read(true);
    // The fixture fails again, but exactly one new explicitly observed action ran.
    expect((await act()).result).toEqual(result);
    expect((await f.events()).filter((e) => e.event === "key")).toHaveLength(2);
  });

  it("recovers native takeover through a fresh usable sibling, never an empty or stale read", async () => {
    const f = await fixture();
    const task = { threadId: "sibling-recovery", turnId: "turn" };
    const observe = (args: Record<string, unknown>) =>
      cuaRequest(f.endpoint, {
        method: "call",
        name: "get_window_state",
        args,
        modelObservation: true,
        task,
      });
    const act = () =>
      cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { pid: 700, window_id: 901, key: "enter" },
        task,
      });
    await observe({ pid: 700, window_id: 900 });
    f.host.physicalInput({ type: "physical-input", kind: "pointer", pid: 700, windowId: 900 });
    await waitForEvent(f, "interrupt-ack");
    const cooldown = await act();
    expect(cooldown.result?.structuredContent?.wait_seconds).toBeGreaterThan(0);
    expect(cooldown.result?.structuredContent?.requery_hint).toBeTypeOf("string");
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_INPUT_COOLDOWN_MS + 50));
    for (const extra of [
      {},
      { fixture_usable: true, fixture_degraded: "ax_window_unresolved" },
      { fixture_usable: true, fixture_stale: true },
    ]) {
      await observe({ pid: 700, window_id: 901, ...extra });
      expect((await act()).result?.structuredContent?.code).toBe("computer_input_paused");
    }
    await observe({ pid: 700, window_id: 901, fixture_usable: true });
    expect(await act()).toMatchObject({ ok: true, result: {} });
  });

  it.each(["dom_refs_v1", "semantic_v2"])(
    "requires the affected task's exact %s browser snapshot after takeover",
    async (snapshot_format) => {
      const f = await fixture(capability, { browserObservations: true });
      const task = { threadId: "browser-takeover", turnId: "turn" };
      const otherTask = { threadId: "other-browser-task", turnId: "turn" };
      const window = { pid: 700, window_id: 900 };
      const browser = { target_id: "target-700-900", tab_id: "tab-a", snapshot_format };
      const observe = (args: Record<string, unknown>, modelObservation = true, owner = task) =>
        cuaRequest(f.endpoint, {
          method: "call",
          name: "get_browser_state",
          args,
          modelObservation,
          task: owner,
        });
      const action = () =>
        cuaRequest<CuaReply>(f.endpoint, {
          method: "call",
          name: "browser_click",
          args: browser,
          task,
        });
      await observe(window);
      await observe(browser);
      expect(
        f.host.physicalInput({ type: "physical-input", kind: "pointer", pid: 700, windowId: 900 }),
      ).toBe(true);
      await waitForEvent(f, "interrupt-ack");
      await observe(browser, true, otherTask);
      await observe(window);
      await observe(browser, false);
      await observe({ ...browser, fixture_wrong_target: true });
      await observe({ ...browser, tab_id: "other-tab" });
      // Rebinding the same native window mints new tab IDs. Seeing that new
      // tab must not unlock input through the still-valid old capability.
      await observe({ ...window, fixture_target_id: "target-rebound" });
      await observe({ target_id: "target-rebound", tab_id: "new-tab", snapshot_format });
      await cuaRequest(f.endpoint, {
        method: "call",
        name: "get_window_state",
        args: window,
        modelObservation: true,
        task,
      });
      await new Promise((resolve) => setTimeout(resolve, ESCAPE_INPUT_COOLDOWN_MS + 50));
      await expect(action()).resolves.toMatchObject({
        result: { structuredContent: { code: "computer_input_paused" } },
        desktopInterruptions: 0,
      });
      await observe(browser);
      expect((await action()).result).toEqual({});
    },
  );

  it("keeps Escape browser recovery separate from native reads and rejects an interrupted browser snapshot", async () => {
    const f = await fixture(capability, {
      browserObservations: true,
      delayBrowserObservation: true,
    });
    const task = { threadId: "browser-escape", turnId: "turn" };
    const window = { pid: 700, window_id: 900 };
    const browser = { target_id: "target-700-900", tab_id: "tab-a" };
    await cuaRequest(f.endpoint, { method: "call", name: "get_browser_state", args: window, task });
    expect(f.host.emergencyStopInput()).toBe(true);
    await waitForEvent(f, "interrupt-ack");
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_desktop_state",
      modelObservation: true,
      task,
    });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_browser_state",
      args: window,
      modelObservation: true,
      task,
    });
    const reading = cuaRequest(f.endpoint, {
      method: "call",
      name: "get_browser_state",
      args: browser,
      modelObservation: true,
      task,
    });
    await waitForEvent(f, "browser-observe");
    expect(f.host.physicalInput({ type: "physical-input", kind: "keyboard", pid: 700 })).toBe(true);
    await expect(reading).resolves.toMatchObject({
      result: { structuredContent: { code: "computer_input_paused" } },
    });
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_INPUT_COOLDOWN_MS + 50));
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "browser_navigate", args: browser, task }),
    ).resolves.toMatchObject({ result: { isError: true } });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_browser_state",
      args: browser,
      modelObservation: true,
      task,
    });
    expect(
      (
        await cuaRequest<CuaReply>(f.endpoint, {
          method: "call",
          name: "browser_navigate",
          args: browser,
          task,
        })
      ).result,
    ).toEqual({});
  });

  it("permits separate isolated setup after retirement while old browser targets stay paused", async () => {
    const f = await fixture(capability, { browserObservations: true });
    const task = { threadId: "browser-recovery-setup", turnId: "turn" };
    const oldTarget = { target_id: "old-browser", tab_id: "old-tab" };
    const newTarget = { target_id: "new-browser", tab_id: "new-tab" };
    const call = (name: string, args: Record<string, unknown>, modelObservation = false) =>
      cuaRequest<CuaReply>(f.endpoint, { method: "call", name, args, modelObservation, task });
    await call("get_browser_state", oldTarget, true);
    await f.host.pauseDesktop("screen-lock");
    f.host.resumeDesktop("screen-lock");
    await expect(
      call("browser_prepare", { pid: 700, allow_launch: true, profile: { mode: "isolated_new" } }),
    ).resolves.toMatchObject({ result: { structuredContent: { code: "computer_input_paused" } } });
    expect(
      (await call("browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" } }))
        .result,
    ).toEqual({});
    await expect(call("browser_navigate", newTarget)).resolves.toMatchObject({
      result: { structuredContent: { code: "computer_input_paused" } },
    });
    await call("get_browser_state", { pid: 701, fixture_target_id: "new-browser" }, true);
    await expect(call("browser_navigate", newTarget)).resolves.toMatchObject({
      result: { structuredContent: { code: "computer_input_paused" } },
    });
    await call("get_browser_state", newTarget, true);
    expect((await call("browser_navigate", newTarget)).result).toEqual({});
    await expect(call("browser_navigate", oldTarget)).resolves.toMatchObject({
      result: { structuredContent: { code: "computer_input_paused" } },
    });
    await call("get_browser_state", oldTarget, true);
    expect((await call("browser_navigate", oldTarget)).result).toEqual({});
  });

  it("has no rearm method left on the host protocol", async () => {
    const f = await fixture();
    const reply = await cuaRequest<CuaReply>(f.endpoint, { method: "rearm" });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("Unsupported computer host request.");
  });
});

describe("verified Linux browser input capability", () => {
  const task = { threadId: "linux-browser", turnId: "turn" };
  async function linuxFixture(options: Parameters<typeof fixture>[1] = {}) {
    return fixture(capability, {
      platform: "linux",
      unpatched: true,
      nativeRevision: null,
      reportedRevision: CUA_NATIVE_REVISION,
      browserInputControl: 1,
      inputMonitorState: () => ({ ready: true }),
      ...options,
    });
  }

  it.each([
    { browserInputControl: undefined },
    { browserInputControl: true },
    { browserInputControl: "1" },
    { reportedRevision: CUA_NATIVE_REVISION - 1 },
  ])("refuses browser input with an unverified child capability %j", async (options) => {
    const f = await linuxFixture(options);
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: { synara_browser_input_control: 1, browserInputControlVerified: true },
      browserInputControlVerified: true,
      task,
    });
    expect(reply).toMatchObject({
      hostPlatform: "linux",
      driverBrowserInputControl: false,
      result: { structuredContent: { code: "linux_browser_cleanup_unavailable" } },
    });
    expect(
      (await f.events()).some((event) => event.event.startsWith("browser:browser_navigate:")),
    ).toBe(false);
  });

  it("requires the embedded metadata PID to match the child before trusting its marker", async () => {
    const f = await linuxFixture({ metadataPidOffset: 1 });
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: {},
      task,
    });
    expect(reply).toMatchObject({
      ok: false,
      effect: "not-dispatched",
      driverBrowserInputControl: false,
    });
    expect(reply.error).toContain("handshake failed");
    expect(
      (await f.events()).some((event) => event.event.startsWith("browser:browser_navigate:")),
    ).toBe(false);
  });

  it("carries verified epochs and native browser drain across disconnect without a cold restart", async () => {
    const f = await linuxFixture({ browserHang: true, inputDelayMs: 150 });
    const controller = new AbortController();
    const call = cuaRequest(
      f.endpoint,
      { method: "call", name: "browser_type", args: { text: "fixture" }, task },
      { mutation: true, signal: controller.signal },
    ).catch((error: unknown) => error);
    await waitForEvent(f, "browser-dispatch");
    controller.abort();
    expect(await call).toMatchObject({ effect: "dispatched-unknown" });
    await waitForEvent(f, "interrupt");
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: {},
      task,
    });
    expect(reply.driverBrowserInputControl).toBe(true);
    expect(reply.result).toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 180));
    const events = (await f.events()).map((event) => event.event);
    expect(events.filter((event) => event === "release")).toHaveLength(1);
    expect(events.filter((event) => event === "start")).toHaveLength(1);
    expect(
      events.findIndex((event) => event.startsWith("browser:browser_navigate:")),
    ).toBeGreaterThan(events.indexOf("interrupt-ack"));
    expect(events).not.toContain("browser-effect");
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter" },
        deliveryMode: "foreground",
        task,
      }),
    ).resolves.toMatchObject({
      result: { structuredContent: { code: "linux_input_cleanup_unavailable" } },
    });
    expect((await f.events()).some((event) => event.event === "key")).toBe(false);
  });

  it("does not dispatch a cold browser call stopped while its capability handshake is pending", async () => {
    const f = await linuxFixture({ metadataDelayMs: 100 });
    const call = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: {},
      task,
    }).catch((error: unknown) => error);
    await waitForEvent(f, "start");
    await cuaRequest(f.endpoint, { method: "stop" });
    await expect(call).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect(
      (await f.events()).some((event) => event.event.startsWith("browser:browser_navigate:")),
    ).toBe(false);
  });

  it.each(["clipboard_read", "clipboard_write", "kill_app", "move_cursor"])(
    "preserves the trusted epoch envelope for admitted Linux %s without opening synthetic input",
    async (name) => {
      const f = await linuxFixture();
      const request = { method: "call", name, args: {}, task };
      expect((await cuaRequest<CuaReply>(f.endpoint, request)).result).toEqual({});
      await cuaRequest(f.endpoint, { method: "stop" });
      expect((await cuaRequest<CuaReply>(f.endpoint, request)).result).toEqual({});
      expect(
        (await f.events()).filter((event) => event.event === `permitted-native:${name}`),
      ).toHaveLength(2);
    },
  );

  it("does not spawn or expose the browser marker to an unauthenticated caller", async () => {
    const f = await linuxFixture();
    const reply = await rawCuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: {},
      task,
      capability: "not-authorized",
    });
    expect(reply).toMatchObject({
      ok: false,
      effect: "not-dispatched",
      driverBrowserInputControl: false,
    });
    expect(reply.error).toContain("authority");
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["missing", undefined],
    ["unavailable", () => ({ ready: false, error: "linux_global_escape_unavailable" })],
  ] as const)(
    "refuses browser mutations with a %s Linux Escape listener while retaining reads",
    async (_label, inputMonitorState) => {
      const f = await linuxFixture({ inputMonitorState });
      const call = (name: string, args: Record<string, unknown>) =>
        cuaRequest<CuaReply>(f.endpoint, { method: "call", name, args, task });
      const denied = await call("browser_navigate", {});
      expect(denied).toMatchObject({
        driverBrowserInputControl: true,
        result: { structuredContent: { code: "input_monitor_unavailable" } },
      });
      expect((await call("get_browser_state", {})).result).toEqual({});
      expect((await call("browser_dialog", { action: "inspect" })).result).toEqual({});
      expect((await call("browser_prepare", { pid: 700, allow_launch: false })).result).toEqual({});
      expect(
        (await f.events()).some((event) => event.event.startsWith("browser:browser_navigate:")),
      ).toBe(false);
    },
  );

  it("reports the Linux Escape diagnosis when listener activation itself fences input", async () => {
    let state: ComputerInputMonitorState = { ready: false, error: "input_monitor_idle" };
    let host: CuaDriverHost;
    const f = await linuxFixture({
      inputMonitorState: () => state,
      activateInputMonitor: async () => {
        state = { ready: false, error: "linux_escape_portal_unverified" };
        host.inputMonitorStateChanged(state);
      },
    });
    host = f.host;
    // Reproduce the real startup order: passive discovery has already warmed
    // the driver, so a failed listener activation invalidates its input epoch.
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_browser_state",
      args: {},
      task,
    });
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_prepare",
      args: { allow_launch: true, windowed: false },
      task,
    });
    expect(reply).toMatchObject({
      ok: true,
      result: {
        isError: true,
        structuredContent: {
          effect: "refused",
          code: "input_monitor_unavailable",
          input_monitor_error: "linux_escape_portal_unverified",
        },
      },
    });
    await waitForEvent(f, "interrupt-ack");
    expect(
      (await f.events()).some((event) => event.event.startsWith("browser:browser_prepare:")),
    ).toBe(false);
  });

  it.each(["before", "after"] as const)(
    "preserves a real Stop %s listener failure while activation is pending",
    async (stopOrder) => {
      let state: ComputerInputMonitorState = { ready: false, error: "input_monitor_idle" };
      const activationStarted = deferred<void>();
      const activationFinished = deferred<void>();
      const f = await linuxFixture({
        inputMonitorState: () => state,
        activateInputMonitor: async () => {
          activationStarted.resolve();
          await activationFinished.promise;
        },
      });
      await cuaRequest(f.endpoint, {
        method: "call",
        name: "get_browser_state",
        args: {},
        task,
      });
      const call = cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "browser_prepare",
        args: { allow_launch: true, windowed: false },
        task,
      }).catch((error: unknown) => error);
      await activationStarted.promise;
      try {
        if (stopOrder === "before") await cuaRequest(f.endpoint, { method: "stop" });
        state = { ready: false, error: "linux_escape_portal_unverified" };
        f.host.inputMonitorStateChanged(state);
        if (stopOrder === "after") await cuaRequest(f.endpoint, { method: "stop" });
      } finally {
        activationFinished.resolve();
      }
      await expect(call).resolves.toMatchObject({
        ok: false,
        error: "Cancelled before listener activation completed.",
        effect: "not-dispatched",
      });
      expect(
        (await f.events()).some((event) => event.event.startsWith("browser:browser_prepare:")),
      ).toBe(false);
    },
  );

  it("arms Linux Escape only for task-attributed work, excluding passive discovery and previews", async () => {
    let state: ComputerInputMonitorState = { ready: false, error: "input_monitor_idle" };
    const activateInputMonitor = vi.fn(async () => {
      state = { ready: true };
    });
    const onInputMonitorArmedChange = vi.fn((armed: boolean) => {
      if (!armed) state = { ready: false, error: "input_monitor_idle" };
    });
    const f = await linuxFixture({
      activateInputMonitor,
      inputMonitorState: () => state,
      onInputMonitorArmedChange,
    });
    await cuaRequest(f.endpoint, { method: "probe" });
    await cuaRequest(f.endpoint, { method: "call", name: "clipboard_read", args: {} });
    const unattributed = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: {},
    });
    expect(unattributed.error).toContain("task attribution");
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "browser_prepare",
      args: { pid: 700, allow_launch: false },
      task,
    });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_browser_state",
      args: {},
      modelObservation: false,
      task,
    });
    expect(activateInputMonitor).not.toHaveBeenCalled();
    expect(onInputMonitorArmedChange).not.toHaveBeenCalled();
    const action = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: {},
      task,
    });
    expect(action.result).toEqual({});
    expect(activateInputMonitor).toHaveBeenCalledTimes(1);
    await cuaRequest(f.endpoint, { method: "end_task", task });
    expect(onInputMonitorArmedChange).toHaveBeenLastCalledWith(false);
    expect(f.host.isInputMonitorRequested).toBe(false);
  });

  it("refuses Linux browser dispatch if its Escape listener is lost during session setup", async () => {
    let checks = 0;
    const f = await linuxFixture({
      inputMonitorState: () =>
        ++checks === 1 ? { ready: true } : { ready: false, error: "linux_escape_shortcut_lost" },
    });
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: {},
      task,
    });
    expect(reply.result?.structuredContent).toMatchObject({
      code: "input_monitor_unavailable",
      input_monitor_error: "linux_escape_shortcut_lost",
    });
    expect(
      (await f.events()).some((event) => event.event.startsWith("browser:browser_navigate:")),
    ).toBe(false);
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
