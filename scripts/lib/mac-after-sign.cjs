// Mandatory afterSign gate. electron-builder must finish this before creating
// the DMG/update ZIP. The child uses the same Node runtime as packaging.
const { spawn } = require("node:child_process");
const { join } = require("node:path");
module.exports = async (context) => {
  if (context.electronPlatformName !== "darwin")
    throw new Error("macOS notarization hook used on another platform.");
  require("./mac-after-pack.cjs").finish(context);
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, "../notarize-mac-app.ts"), app], {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Mandatory app notarization failed (${code}).`)),
    );
  });
};
