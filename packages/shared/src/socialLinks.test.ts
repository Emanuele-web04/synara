import { describe, expect, it } from "vitest";
import {
  normalizeSocialUsername,
  sanitizeSocialLinks,
  socialLinkLabel,
  socialProfileUrl,
} from "./socialLinks";

describe("normalizeSocialUsername", () => {
  it("accepts a bare username or a leading @", () => {
    expect(normalizeSocialUsername("x", "emanueledpt")).toBe("emanueledpt");
    expect(normalizeSocialUsername("x", "  @emanueledpt ")).toBe("emanueledpt");
    expect(normalizeSocialUsername("threads", "@ema.dpt")).toBe("ema.dpt");
  });

  it("extracts the username from that platform's profile URL", () => {
    expect(normalizeSocialUsername("x", "https://twitter.com/emanueledpt?s=21")).toBe(
      "emanueledpt",
    );
    expect(normalizeSocialUsername("x", "x.com/emanueledpt/")).toBe("emanueledpt");
    expect(normalizeSocialUsername("linkedin", "https://www.linkedin.com/in/ema-dpt/")).toBe(
      "ema-dpt",
    );
    expect(normalizeSocialUsername("github", "https://github.com/Emanuele-web04")).toBe(
      "Emanuele-web04",
    );
    expect(normalizeSocialUsername("threads", "https://www.threads.net/@ema.dpt")).toBe("ema.dpt");
    expect(normalizeSocialUsername("youtube", "m.youtube.com/@emadpt")).toBe("emadpt");
  });

  it("rejects other hosts, other paths and invalid usernames", () => {
    expect(normalizeSocialUsername("x", "https://evil.example/emanueledpt")).toBeNull();
    expect(normalizeSocialUsername("github", "https://github.com/a/b")).toBeNull();
    expect(normalizeSocialUsername("linkedin", "https://linkedin.com/company/acme")).toBeNull();
    expect(normalizeSocialUsername("x", "way_too_long_for_x_handles")).toBeNull();
    expect(normalizeSocialUsername("github", "-leading-dash")).toBeNull();
    expect(normalizeSocialUsername("x", "javascript:alert(1)")).toBeNull();
    expect(normalizeSocialUsername("youtube", "")).toBeNull();
  });
});

describe("socialProfileUrl", () => {
  it("builds each canonical profile URL", () => {
    expect(socialProfileUrl("x", "a")).toBe("https://x.com/a");
    expect(socialProfileUrl("linkedin", "abc")).toBe("https://www.linkedin.com/in/abc");
    expect(socialProfileUrl("github", "a")).toBe("https://github.com/a");
    expect(socialProfileUrl("threads", "a")).toBe("https://www.threads.com/@a");
    expect(socialProfileUrl("youtube", "abc")).toBe("https://www.youtube.com/@abc");
    expect(socialLinkLabel("linkedin")).toBe("LinkedIn");
  });
});

describe("sanitizeSocialLinks", () => {
  it("keeps known platforms with valid usernames only", () => {
    expect(
      sanitizeSocialLinks({
        x: "emanueledpt",
        github: "https://github.com/x",
        mastodon: "someone",
        youtube: 42,
      }),
    ).toEqual({ x: "emanueledpt" });
    expect(sanitizeSocialLinks(null)).toEqual({});
    expect(sanitizeSocialLinks(["x"])).toEqual({});
  });
});
