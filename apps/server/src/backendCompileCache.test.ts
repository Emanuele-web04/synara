import { describe, expect, it } from "vitest";

import { releaseBackendCompileCacheEnvironment } from "./backendCompileCache";

describe("releaseBackendCompileCacheEnvironment", () => {
  it("removes the compile cache the desktop set for the backend alone", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_COMPILE_CACHE: "/home/.synara/userdata/cache/backend-compile/1.5.4",
      SYNARA_BACKEND_COMPILE_CACHE: "/home/.synara/userdata/cache/backend-compile/1.5.4",
      PATH: "/usr/bin",
    };
    releaseBackendCompileCacheEnvironment(env);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("leaves a compile cache the user configured", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_COMPILE_CACHE: "/users/own-cache",
      SYNARA_BACKEND_COMPILE_CACHE: "/home/.synara/userdata/cache/backend-compile/1.5.4",
    };
    releaseBackendCompileCacheEnvironment(env);
    expect(env).toEqual({ NODE_COMPILE_CACHE: "/users/own-cache" });

    const untouched: NodeJS.ProcessEnv = { NODE_COMPILE_CACHE: "/users/own-cache" };
    releaseBackendCompileCacheEnvironment(untouched);
    expect(untouched).toEqual({ NODE_COMPILE_CACHE: "/users/own-cache" });
  });
});
