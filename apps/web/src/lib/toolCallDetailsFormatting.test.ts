import { describe, expect, it } from "vitest";

import {
  createMarkdownCodeFence,
  formatShellCommand,
  formatShellTranscript,
  formatToolOutputText,
} from "./toolCallDetailsFormatting";

describe("formatShellCommand", () => {
  it("prefixes the first command line like a shell prompt", () => {
    expect(formatShellCommand("git status\npwd")).toBe("$ git status\npwd");
  });
});

describe("formatToolOutputText", () => {
  it("combines bounded output fields in display order", () => {
    expect(
      formatToolOutputText({
        output: "summary\n",
        stdout: "stdout\n",
        stderr: "stderr\n",
      }),
    ).toBe("summary\n\nstdout\n\nstderr");
  });

  it("ignores empty output fields", () => {
    expect(formatToolOutputText({ output: "   ", stdout: "ok" })).toBe("ok");
  });
});

describe("formatShellTranscript", () => {
  it("omits the output section when no output text exists", () => {
    expect(formatShellTranscript("pwd", { exitCode: 0 })).toBe("$ pwd");
  });

  it("joins the command and output with one blank line", () => {
    expect(formatShellTranscript("pwd", { stdout: "/tmp/project" })).toBe("$ pwd\n\n/tmp/project");
  });
});

describe("createMarkdownCodeFence", () => {
  it("uses a longer fence when code already contains backticks", () => {
    expect(createMarkdownCodeFence("bash", "echo ```")).toBe("````bash\necho ```\n````");
  });
});
