import { describe, expect, it } from "vitest";

import {
  WsProjectsDiscoverScriptsRpc,
  WsReviewLoadPullRequestHeaderRpc,
  WsReviewLoadPullRequestSurfaceRpc,
  WsRpcError,
  WsRpcGroup,
} from "./rpc";

describe("WS RPC contracts", () => {
  it("exports the additive Effect RPC group", () => {
    expect(WsRpcGroup).toBeDefined();
  });

  it("uses a schema-backed transport error", () => {
    expect(new WsRpcError({ message: "failed" }).message).toBe("failed");
  });

  it("exports the project script discovery RPC", () => {
    expect(WsProjectsDiscoverScriptsRpc).toBeDefined();
  });

  it("exports the aggregate review pull request surface RPC", () => {
    expect(WsReviewLoadPullRequestSurfaceRpc).toBeDefined();
  });

  it("exports the lightweight review pull request header RPC", () => {
    expect(WsReviewLoadPullRequestHeaderRpc).toBeDefined();
  });
});
