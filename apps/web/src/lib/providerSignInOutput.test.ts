import { describe, expect, it } from "vitest";

import { parseProviderSignInOutput, stripTerminalControl } from "./providerSignInOutput";

const CLAUDE_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=0DphvPw8BPVk&code_challenge_method=S256&state=-l8fvPPdHDoomuutC9gRbVmvrpuCyKRBriqr6AU528";

/** Hard-wraps like a CLI that lays out its own lines at `columns`. */
function wrap(text: string, columns: number): string {
  const lines: string[] = [];
  for (let index = 0; index < text.length; index += columns) {
    lines.push(text.slice(index, index + columns));
  }
  return lines.join("\r\n");
}

describe("parseProviderSignInOutput", () => {
  it("rejoins Claude's hard-wrapped link and notices the code prompt", () => {
    const output = [
      "\u001B[1mOpening browser to sign in…\u001B[22m",
      wrap(`If the browser didn't open, visit: ${CLAUDE_URL}`, 109),
      "Paste code here if prompted > ",
    ].join("\r\n");

    expect(parseProviderSignInOutput(output)).toEqual({ url: CLAUDE_URL, asksForCode: true });
  });

  it("skips Codex's local callback server and takes the sign-in page", () => {
    const signInUrl =
      "https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=FP64";
    const output = [
      "Starting local login server on http://localhost:1455.",
      "If your browser did not open, navigate to this URL to authenticate:",
      "",
      signInUrl,
      "",
      "On a remote or headless machine? Use `codex login --device-auth` instead.",
    ].join("\n");

    expect(parseProviderSignInOutput(output)).toEqual({ url: signInUrl, asksForCode: false });
  });

  it("does not swallow the line after a link that fits on one line", () => {
    const output = "Visit https://example.com/login to continue.\nnext-line-without-spaces";

    expect(parseProviderSignInOutput(output).url).toBe("https://example.com/login");
  });

  it("reports nothing while the login has printed no link yet", () => {
    expect(parseProviderSignInOutput("Starting…\n")).toEqual({ url: null, asksForCode: false });
  });
});

describe("stripTerminalControl", () => {
  it("drops colors, cursor moves and window-title sequences", () => {
    expect(stripTerminalControl("\u001B]0;claude\u0007\u001B[2K\u001B[32mok\u001B[0m\r\n")).toBe(
      "ok\n",
    );
  });
});
