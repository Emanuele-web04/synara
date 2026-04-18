import { describe, expect, it } from "vitest";

import { quotePosixShellArgument } from "./shellQuote";

describe("quotePosixShellArgument", () => {
  it("returns empty single quotes for an empty string", () => {
    expect(quotePosixShellArgument("")).toBe("''");
  });

  it("leaves safe tokens unquoted", () => {
    expect(quotePosixShellArgument("project")).toBe("project");
    expect(quotePosixShellArgument("/Users/dev/code/my-project")).toBe(
      "/Users/dev/code/my-project",
    );
    expect(quotePosixShellArgument("a_b.c-d/e+f@g%h:i,j=k")).toBe("a_b.c-d/e+f@g%h:i,j=k");
  });

  it("wraps tokens with whitespace in single quotes", () => {
    expect(quotePosixShellArgument("/Users/dev/My Code/proj")).toBe("'/Users/dev/My Code/proj'");
  });

  it("wraps tokens that contain shell metacharacters", () => {
    expect(quotePosixShellArgument("foo;rm -rf /")).toBe("'foo;rm -rf /'");
    expect(quotePosixShellArgument("a$(echo b)")).toBe("'a$(echo b)'");
    expect(quotePosixShellArgument("a&b|c")).toBe("'a&b|c'");
    expect(quotePosixShellArgument("a*b?c[d]")).toBe("'a*b?c[d]'");
  });

  it("escapes embedded single quotes using the close/escape/open idiom", () => {
    expect(quotePosixShellArgument("it's")).toBe(`'it'\\''s'`);
    expect(quotePosixShellArgument("a'b'c")).toBe(`'a'\\''b'\\''c'`);
  });

  it("preserves unicode characters inside single quotes", () => {
    expect(quotePosixShellArgument("/Users/dev/项目")).toBe("'/Users/dev/项目'");
  });
});
