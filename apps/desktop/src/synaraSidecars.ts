// FILE: synaraSidecars.ts
// Purpose: Run the CUA driver host and the Obscura browser host inside one bun
// process for the GPUI frame — one JSC runtime instead of two (~50-80 MB less
// RSS). Both child modules keep their own argv parsing and sockets unchanged;
// this launcher just feeds each its own args via process.argv before import.
// Usage: bun synaraSidecars.ts -- <cuaDriverHostMac args> -- <browserHostObscura args>
// Layer: Desktop sidecar launcher (non-Electron)

const argv = process.argv.slice(2);
// An optional leading "--" is harmless but must not be read as the separator.
if (argv[0] === "--") argv.shift();
const separator = argv.indexOf("--");
const cuaArgs = separator === -1 ? argv : argv.slice(0, separator);
const browserArgs = separator === -1 ? [] : argv.slice(separator + 1);

async function run(file: string, args: string[], label: string): Promise<void> {
  if (args.length === 0) return;
  process.argv = ["bun", file, ...args];
  try {
    await import(`./${file}`);
  } catch (error) {
    console.error(`[synara-sidecars] ${label} failed to start:`, error);
  }
}

await run("cuaDriverHostMac.ts", cuaArgs, "cua host");
await run("browserHostObscura.ts", browserArgs, "browser host");

export {};
