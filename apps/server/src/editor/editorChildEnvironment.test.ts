import { expect, it } from "vitest";
import { editorChildEnvironment } from "./editorChildEnvironment";

it("removes control-plane authority and inherited injection hooks without mutating the parent", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/developer",
    APP_ENV: "development",
    SYNARA_AUTH_TOKEN: "server-only",
    Synara_Auth_Token: "windows-case-variant",
    SYNARA_HOME: "/private/app-state",
    NODE_OPTIONS: "--require=/unrelated/preload.cjs",
    NODE_PATH: "/unrelated/modules",
    BUN_OPTIONS: "--preload=/unrelated/preload.ts",
    ELECTRON_RUN_AS_NODE: "1",
  };
  const env = editorChildEnvironment(parent, false);
  expect(env).toEqual({ PATH: parent.PATH, HOME: parent.HOME, APP_ENV: parent.APP_ENV });
  expect(parent.SYNARA_AUTH_TOKEN).toBe("server-only");
});

it("explicitly enables Node mode only for the packaged Electron executable", () => {
  expect(editorChildEnvironment({}, true)).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  expect(editorChildEnvironment({}, false)).toEqual({});
});
