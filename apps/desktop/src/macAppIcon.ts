// FILE: macAppIcon.ts
// Purpose: Persist a Finder/Dock custom icon after the application quits.
// Layer: Desktop-native preference utility

import * as Crypto from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

import { execProcessFile } from "@synara/shared/processRuntime";

// NSWorkspace writes custom-icon metadata outside the signed Contents tree.
// Passing nil restores the bundle's appearance-aware icon. Arguments are data,
// never interpolated into this script. This does not automate another app.
const SET_FILE_ICON_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  // $() is Objective-C nil; JavaScript null would bridge to NSNull.
  var image = argv[1] === '' ? $() : $.NSImage.alloc.initWithContentsOfFile(argv[1]);
  if (argv[1] !== '' && (!image || !image.isValid)) {
    throw new Error('Unable to load the app icon');
  }
  if (!$.NSWorkspace.sharedWorkspace.setIconForFileOptions(image, argv[0], 0)) {
    throw new Error('Unable to update the app icon; the app must be writable');
  }
}
`;

// Call through the desktop icon apply queue: NSWorkspace icon writes must not
// overlap. PNG bytes come from Electron because native tools cannot read ASAR.
export async function persistMacAppIcon(input: {
  readonly bundlePath: string;
  readonly cacheDirectory: string;
  readonly png: Buffer | null;
}): Promise<void> {
  let imagePath = "";
  if (input.png !== null) {
    const digest = Crypto.createHash("sha256").update(input.png).digest("hex");
    imagePath = Path.join(input.cacheDirectory, `${digest}.png`);
    await FS.mkdir(input.cacheDirectory, { recursive: true });
    await FS.writeFile(imagePath, input.png);
  }

  await new Promise<void>((resolve, reject) => {
    execProcessFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", SET_FILE_ICON_SCRIPT, input.bundlePath, imagePath],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}
