// FILE: windowsWindowProbe.ts
// Purpose: Report the Windows foreground HWND and every top-level HWND owned by
//          a process so AppSnap can prefer the real focused window and skip
//          Electron DevTools/child windows that BrowserWindow.getAllWindows misses.
// Layer: Desktop-native Windows helper (compiled on demand with csc.exe)

import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import { resolveCscCompiler } from "./windowsShellAppUserModel";

export const WINDOWS_WINDOW_PROBE_TIMEOUT_MS = 1500;

export const WINDOWS_WINDOW_PROBE_SOURCE = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace Synara {
  public static class WindowProbe {
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    public static int Main(string[] args) {
      uint targetPid = 0;
      if (args.Length > 0) {
        uint.TryParse(args[0], out targetPid);
      }

      IntPtr foreground = GetForegroundWindow();
      Console.WriteLine("foreground " + (foreground == IntPtr.Zero ? "0" : foreground.ToInt64().ToString()));

      var owned = new List<string>();
      EnumWindows((hWnd, lParam) => {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        if (pid != targetPid || !IsWindowVisible(hWnd)) return true;
        var title = new StringBuilder(512);
        GetWindowTextW(hWnd, title, title.Capacity);
        owned.Add(hWnd.ToInt64().ToString() + "\\t" + title.ToString());
        return true;
      }, IntPtr.Zero);

      foreach (string line in owned) {
        Console.WriteLine("owned " + line);
      }
      return 0;
    }
  }
}
`.trim();

export interface WindowsWindowProbeResult {
  readonly foregroundHwnd: bigint | null;
  readonly ownedHwnds: ReadonlySet<string>;
}

export function windowsWindowProbeHelperName(): string {
  const hash = Crypto.createHash("sha1")
    .update(WINDOWS_WINDOW_PROBE_SOURCE)
    .digest("hex")
    .slice(0, 12);
  return `windows-window-probe-${hash}.exe`;
}

export function ensureWindowsWindowProbeHelper(cacheDirectory: string): string {
  FS.mkdirSync(cacheDirectory, { recursive: true });
  const exePath = Path.join(cacheDirectory, windowsWindowProbeHelperName());
  if (FS.existsSync(exePath)) return exePath;
  const csc = resolveCscCompiler();
  if (!csc) throw new Error("csc.exe not found");
  const csPath = Path.join(cacheDirectory, "windows-window-probe.cs");
  FS.writeFileSync(csPath, WINDOWS_WINDOW_PROBE_SOURCE, "utf8");
  const compiled = ChildProcess.spawnSync(
    csc,
    [
      "/nologo",
      "/target:exe",
      "/platform:x64",
      "/main:Synara.WindowProbe",
      `/out:${exePath}`,
      csPath,
    ],
    { windowsHide: true, encoding: "utf8" },
  );
  if (compiled.status !== 0 || !FS.existsSync(exePath)) {
    throw new Error(compiled.stderr?.toString().trim() || "Failed to compile Windows window probe");
  }
  return exePath;
}

export function parseWindowsWindowProbeOutput(stdout: string): WindowsWindowProbeResult {
  let foregroundHwnd: bigint | null = null;
  const ownedHwnds = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("foreground ")) {
      const value = line.slice("foreground ".length);
      if (value && value !== "0") {
        try {
          foregroundHwnd = BigInt(value);
        } catch {
          foregroundHwnd = null;
        }
      }
      continue;
    }
    if (line.startsWith("owned ")) {
      const rest = line.slice("owned ".length);
      const [hwnd] = rest.split("\t", 1);
      if (hwnd) ownedHwnds.add(hwnd);
    }
  }
  return { foregroundHwnd, ownedHwnds };
}

export function probeWindowsWindows(
  helperPath: string,
  processId: number,
  spawnSync: typeof ChildProcess.spawnSync = ChildProcess.spawnSync,
): WindowsWindowProbeResult | null {
  try {
    const result = spawnSync(helperPath, [String(processId)], {
      windowsHide: true,
      encoding: "utf8",
      timeout: WINDOWS_WINDOW_PROBE_TIMEOUT_MS,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    return parseWindowsWindowProbeOutput(result.stdout);
  } catch {
    return null;
  }
}
