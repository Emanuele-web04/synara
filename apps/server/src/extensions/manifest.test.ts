import { describe, expect, it } from "vitest";
import { ExtensionArchivePaths } from "./archivePaths";
import {
  activationEvents,
  CODE_OSS_VERSION,
  extensionArchivePath,
  extensionId,
  parseExtensionManifest,
} from "./manifest";

const manifest = {
  publisher: "example",
  name: "formatter",
  version: "1.0.0",
  engines: { vscode: "^1.80.0" },
};
describe("extension package boundaries", () => {
  it("pins the API version and rejects incompatible manifests", () => {
    expect(CODE_OSS_VERSION).toBe("1.138.0");
    expect(parseExtensionManifest(manifest).name).toBe("formatter");
    expect(() => parseExtensionManifest({ ...manifest, engines: { vscode: "^99.0.0" } })).toThrow(
      "requires VS Code",
    );
    expect(() => parseExtensionManifest({ ...manifest, version: "not-a-version" })).toThrow();
    expect(() => parseExtensionManifest({ ...manifest, main: "../outside.js" })).toThrow();
    expect(() => extensionId("../publisher.extension")).toThrow();
    expect(extensionId("Example.Formatter")).toBe("example.formatter");
  });
  it.each([
    "../escape",
    "/escape",
    "extension/../escape",
    "extension\\escape",
    "C:/escape",
    "extension/CON.txt",
    "extension/name.",
    "extension/name ",
    "extension/a:b",
    "extension//file",
    "extension/./file",
    "extension/a\0b",
  ])("rejects unsafe archive path %j", (value) => {
    expect(() => extensionArchivePath(value)).toThrow();
  });
  it("detects case collisions in implicit parents and file/directory conflicts", () => {
    const paths = new ExtensionArchivePaths();
    paths.add("extension/Foo/a.js", false);
    expect(() => paths.add("extension/foo/b.js", false)).toThrow("case-colliding");
    expect(() => paths.add("extension/Foo", false)).toThrow("conflicting");
    paths.add("extension/Foo/", true);
    expect(() => paths.add("extension/Foo/a.js", false)).toThrow("duplicate");
  });
  it("includes implicit command, language and debugger activation events", () => {
    expect(
      activationEvents(
        parseExtensionManifest({
          ...manifest,
          contributes: {
            commands: [{ command: "example.format" }],
            languages: [{ id: "example" }],
            debuggers: [{ type: "example-debug" }],
          },
        }),
      ),
    ).toEqual([
      "onCommand:example.format",
      "onLanguage:example",
      "onDebugResolve:example-debug",
      "onDebugInitialConfigurations:example-debug",
    ]);
  });
});
