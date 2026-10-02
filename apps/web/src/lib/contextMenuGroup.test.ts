import { describe, expect, it } from "vitest";

import { contextMenuGroup } from "./contextMenuGroup";

const parent = { id: "copy", label: "Copy", separatorBefore: true };

describe("contextMenuGroup", () => {
  it("nests several related actions under one parent row", () => {
    expect(
      contextMenuGroup(parent, [
        { id: "copy-path", label: "Path", standaloneLabel: "Copy Path" },
        { id: "copy-thread-id", label: "Thread ID", standaloneLabel: "Copy Thread ID" },
      ]),
    ).toEqual([
      {
        id: "copy",
        label: "Copy",
        separatorBefore: true,
        children: [
          { id: "copy-path", label: "Path" },
          { id: "copy-thread-id", label: "Thread ID" },
        ],
      },
    ]);
  });

  it("shows a lone action as a plain row in the group's position", () => {
    expect(
      contextMenuGroup(parent, [{ id: "copy-path", label: "Path", standaloneLabel: "Copy Path" }]),
    ).toEqual([{ id: "copy-path", label: "Copy Path", separatorBefore: true }]);
  });

  it("omits the group when it has no actions", () => {
    expect(contextMenuGroup(parent, [])).toEqual([]);
  });
});
