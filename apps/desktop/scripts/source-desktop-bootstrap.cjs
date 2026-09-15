// Installed inside the generated macOS launcher, before signing. System Settings
// and Finder reopen the bundle without the dev runner's argv or environment.
const fs = require("node:fs");
const path = require("node:path");

const desktopDirectory = path.resolve(__dirname, "../../../../..");
const bundleName = path.basename(path.resolve(__dirname, "../../.."));
const configurationPath = path.join(
  desktopDirectory,
  ".electron-runtime",
  `${bundleName}.launch.json`,
);
const { app, dialog } = require("electron");

try {
  // An explicit source/smoke launch owns its environment. Only an OS reopen
  // needs the saved routing; otherwise it could replace a smoke test's home.
  if (!process.env.SYNARA_SOURCE_DESKTOP_BUILD_MARKER) {
    const configuration = JSON.parse(fs.readFileSync(configurationPath, "utf8"));
    for (const name of [
      "SYNARA_HOME",
      "SYNARA_DESKTOP_FLAVOR",
      "SYNARA_SOURCE_DESKTOP_BUILD_MARKER",
      "VITE_DEV_SERVER_URL",
    ]) {
      const value = configuration[name];
      if (typeof value === "string") process.env[name] = value;
      else delete process.env[name];
    }
  }
  const entry = path.join(desktopDirectory, "dist-electron/main.js");
  const entryStat = fs.statSync(entry);
  if (!entryStat.isFile() || entryStat.size === 0) {
    throw new Error("The desktop build is not ready.");
  }
  // Match a source launch even when LaunchServices supplies no working directory.
  process.chdir(desktopDirectory);
  app.setAppPath(desktopDirectory);
  require(entry);
} catch (error) {
  dialog.showErrorBox(
    "Synara development build could not start",
    `${error instanceof Error ? error.message : String(error)}\n\nRun bun run electron:dev from ${path.resolve(desktopDirectory, "../..")} and wait for the build to finish.`,
  );
  app.exit(1);
}
