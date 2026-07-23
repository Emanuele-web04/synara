import { describe, expect, it } from "vitest";

import { sanitizeBrowserAnnotationUrl } from "./browserAnnotations";

describe("sanitizeBrowserAnnotationUrl", () => {
  it("keeps ordinary page context while removing fragments and opaque query values", () => {
    expect(
      sanitizeBrowserAnnotationUrl(
        "https://example.test/docs?lang=fr&page=2&filter=active#quick-start",
      ),
    ).toBe("https://example.test/docs?lang=fr&page=2");
  });

  it("removes credentials and redacts sensitive or unknown query keys", () => {
    expect(
      sanitizeBrowserAnnotationUrl(
        "https://alice:hunter2@example.test/docs?token=secret&data=eyJhbGciOiJIUzI1NiJ9.payload.signature&tab=details",
      ),
    ).toBe(
      "https://example.test/docs?tab=details",
    );
  });

  it("redacts private path segments, including values following sensitive route names", () => {
    expect(
      sanitizeBrowserAnnotationUrl(
        "https://example.test/reset/very-private-reset-code-123456/invite/550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe("https://example.test/reset/REDACTED/REDACTED/REDACTED");
  });

  it("redacts short personal identifiers in paths and allow-listed query fields", () => {
    expect(
      sanitizeBrowserAnnotationUrl(
        "https://example.test/patients/123456789/records/jane-doe?section=jane-doe&view=details",
      ),
    ).toBe(
      "https://example.test/patients/REDACTED/records/REDACTED?section=REDACTED&view=details",
    );
  });

  it("redacts codes after compound authentication route names", () => {
    expect(
      sanitizeBrowserAnnotationUrl(
        "https://example.test/reset-password/abc123/magic-link/shortCode",
      ),
    ).toBe("https://example.test/REDACTED/REDACTED/magic-link/REDACTED");
  });

  it("redacts short mixed bearer codes in paths and allow-listed query values", () => {
    expect(
      sanitizeBrowserAnnotationUrl(
        "https://example.test/s/Ab3xY7/share/a1B2c3?section=Ab3xY7&tab=details",
      ),
    ).toBe(
      "https://example.test/s/REDACTED/share/REDACTED?section=REDACTED&tab=details",
    );
  });

  it("redacts short alphabetic bearer codes and non-static route values", () => {
    expect(
      sanitizeBrowserAnnotationUrl(
        "https://example.test/join/QWERTY/invite/qwerty?mode=QWERTY&section=qwerty&sort=QWERTY&tab=qwerty&view=QWERTY",
      ),
    ).toBe(
      "https://example.test/join/REDACTED/invite/REDACTED?mode=REDACTED&section=REDACTED&sort=REDACTED&tab=REDACTED&view=REDACTED",
    );
  });

  it("keeps sensitive collection routes while redacting their entity identifiers", () => {
    expect(
      sanitizeBrowserAnnotationUrl(
        "https://example.test/customers/acme/settings",
      ),
    ).toBe("https://example.test/customers/REDACTED/settings");
  });

  it("keeps ordinary route structure while redacting dynamic identifiers", () => {
    expect(sanitizeBrowserAnnotationUrl("https://example.test/products/alpha")).toBe(
      "https://example.test/products/REDACTED",
    );
    expect(sanitizeBrowserAnnotationUrl("https://example.test/products/beta")).toBe(
      "https://example.test/products/REDACTED",
    );
    expect(
      sanitizeBrowserAnnotationUrl(
        "https://example.test/projects/my-project/tasks/first-task",
      ),
    ).toBe("https://example.test/projects/REDACTED/tasks/REDACTED");
    expect(sanitizeBrowserAnnotationUrl("https://example.test/go/QWERTY")).toBe(
      "https://example.test/REDACTED/REDACTED",
    );
    expect(sanitizeBrowserAnnotationUrl("https://example.test/u/alice")).toBe(
      "https://example.test/REDACTED/REDACTED",
    );
  });

  it("drops unknown query names so the key cannot carry a secret", () => {
    expect(
      sanitizeBrowserAnnotationUrl(
        "https://example.test/docs?550e8400-e29b-41d4-a716-446655440000=on&alice%40example.test=selected&Ab3xY7=1&view=details",
      ),
    ).toBe("https://example.test/docs?view=details");
  });

  it("is deterministic and idempotent", () => {
    const input =
      "https://example.test/users/550e8400-e29b-41d4-a716-446655440000?locale=fr&ticket=abc";
    const sanitized = sanitizeBrowserAnnotationUrl(input);
    expect(sanitizeBrowserAnnotationUrl(sanitized)).toBe(sanitized);
  });

  it("rejects malformed, non-http, and arbitrary URL-like values", () => {
    expect(
      sanitizeBrowserAnnotationUrl(
        "https://alice:hunter2@%/docs?authorization=raw-secret&lang=fr#section",
      ),
    ).toBe("");
    expect(sanitizeBrowserAnnotationUrl("javascript:alert(1)")).toBe("");
    expect(sanitizeBrowserAnnotationUrl("Bearer secret-123")).toBe("");
  });
});
