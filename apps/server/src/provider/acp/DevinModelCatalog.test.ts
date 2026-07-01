import { describe, it, assert } from "@effect/vitest";
import { MODEL_OPTIONS_BY_PROVIDER } from "@t3tools/contracts";
import {
  DEVIN_FALLBACK_MODELS,
  normalizeDevinModelSlug,
  buildDevinVariantMatrix,
  resolveDevinModelSlug,
} from "./DevinModelCatalog.ts";

describe("normalizeDevinModelSlug", () => {
  it('maps "opus" to "claude-opus-4-8-medium"', () => {
    assert.strictEqual(normalizeDevinModelSlug("opus"), "claude-opus-4-8-medium");
  });

  it('trims whitespace and lowercases input (e.g. " SWE " → "swe-1-6")', () => {
    assert.strictEqual(normalizeDevinModelSlug(" SWE "), "swe-1-6");
  });

  it("passes through unknown slugs unchanged", () => {
    assert.strictEqual(normalizeDevinModelSlug("claude-opus-4-8-medium"), "claude-opus-4-8-medium");
    assert.strictEqual(normalizeDevinModelSlug("unknown-model"), "unknown-model");
  });
});

describe("DEVIN_FALLBACK_MODELS", () => {
  it('contains "adaptive"', () => {
    const adaptive = DEVIN_FALLBACK_MODELS.find((m) => m.slug === "adaptive");
    assert.ok(adaptive, "expected adaptive model entry");
    assert.strictEqual(adaptive!.name, "Adaptive");
  });

  it("every entry has non-empty slug and name", () => {
    for (const model of DEVIN_FALLBACK_MODELS) {
      assert.ok(model.slug.length > 0, `expected non-empty slug, got "${model.slug}"`);
      assert.ok(model.name.length > 0, `expected non-empty name for "${model.slug}"`);
    }
  });

  it("slugs equal MODEL_OPTIONS_BY_PROVIDER.devin slugs (no duplication)", () => {
    const contractSlugs = MODEL_OPTIONS_BY_PROVIDER.devin.map((o) => o.slug);
    const catalogSlugs = DEVIN_FALLBACK_MODELS.map((m) => m.slug);
    assert.deepStrictEqual(catalogSlugs, contractSlugs);
  });
});

const MATRIX_INPUT = [
  { slug: "claude-opus-4-8-low", name: "Claude Opus 4.8 Low" },
  { slug: "claude-opus-4-8-medium", name: "Claude Opus 4.8 Medium" },
  { slug: "claude-opus-4-8-high", name: "Claude Opus 4.8 High" },
  { slug: "claude-opus-4-8-high-fast", name: "Claude Opus 4.8 High Fast" },
  { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { slug: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking" },
  { slug: "claude-opus-4-6-thinking-1m", name: "Claude Opus 4.6 Thinking 1M" },
  { slug: "deepseek-v4", name: "DeepSeek V4" },
  { slug: "adaptive", name: "Adaptive" },
];

describe("buildDevinVariantMatrix", () => {
  const matrix = buildDevinVariantMatrix(MATRIX_INPUT);

  it("groups claude-opus-4-8 with efforts, fast mode, medium default", () => {
    const base = matrix.get("claude-opus-4-8");
    assert.ok(base, "expected claude-opus-4-8 base");
    assert.deepStrictEqual(base!.supportedEfforts, ["low", "medium", "high"]);
    assert.strictEqual(base!.supportsFastMode, true);
    assert.strictEqual(base!.supportsThinking, false);
    assert.deepStrictEqual([...base!.contextWindowOptions], []);
    assert.strictEqual(base!.defaultVariant.slug, "claude-opus-4-8-medium");
  });

  it("groups claude-opus-4-6 with thinking, 1m context, bare default", () => {
    const base = matrix.get("claude-opus-4-6");
    assert.ok(base, "expected claude-opus-4-6 base");
    assert.deepStrictEqual([...base!.supportedEfforts], []);
    assert.strictEqual(base!.supportsFastMode, false);
    assert.strictEqual(base!.supportsThinking, true);
    assert.deepStrictEqual([...base!.contextWindowOptions], ["1m"]);
    assert.strictEqual(base!.defaultVariant.slug, "claude-opus-4-6");
  });

  it("groups deepseek-v4 as a bare single-variant base", () => {
    const base = matrix.get("deepseek-v4");
    assert.ok(base, "expected deepseek-v4 base");
    assert.deepStrictEqual([...base!.supportedEfforts], []);
    assert.strictEqual(base!.supportsFastMode, false);
    assert.strictEqual(base!.supportsThinking, false);
    assert.deepStrictEqual([...base!.contextWindowOptions], []);
    assert.strictEqual(base!.defaultVariant.slug, "deepseek-v4");
  });
});

describe("resolveDevinModelSlug", () => {
  const matrix = buildDevinVariantMatrix(MATRIX_INPUT);

  it("resolves effort+fast to exact variant slug", () => {
    assert.strictEqual(
      resolveDevinModelSlug("claude-opus-4-8", { reasoningEffort: "high", fastMode: true }, matrix),
      "claude-opus-4-8-high-fast",
    );
  });

  it("resolves effort-only to exact variant slug", () => {
    assert.strictEqual(
      resolveDevinModelSlug("claude-opus-4-8", { reasoningEffort: "high" }, matrix),
      "claude-opus-4-8-high",
    );
  });

  it("resolves undefined options to default variant", () => {
    assert.strictEqual(
      resolveDevinModelSlug("claude-opus-4-8", undefined, matrix),
      "claude-opus-4-8-medium",
    );
  });

  it("falls back to default when fast-only target has no exact match", () => {
    assert.strictEqual(
      resolveDevinModelSlug("claude-opus-4-8", { fastMode: true }, matrix),
      "claude-opus-4-8-medium",
    );
  });

  it("resolves thinking+context to exact variant slug", () => {
    assert.strictEqual(
      resolveDevinModelSlug("claude-opus-4-6", { thinking: true, contextWindow: "1m" }, matrix),
      "claude-opus-4-6-thinking-1m",
    );
  });

  it("resolves undefined options to bare default for claude-opus-4-6", () => {
    assert.strictEqual(
      resolveDevinModelSlug("claude-opus-4-6", undefined, matrix),
      "claude-opus-4-6",
    );
  });

  it("resolves undefined options to bare default for deepseek-v4", () => {
    assert.strictEqual(resolveDevinModelSlug("deepseek-v4", undefined, matrix), "deepseek-v4");
  });

  it("passes through unknown slugs unchanged", () => {
    assert.strictEqual(resolveDevinModelSlug("unknown-slug", undefined, matrix), "unknown-slug");
  });

  it("passes through full variant slugs unchanged (not a base slug)", () => {
    assert.strictEqual(
      resolveDevinModelSlug("claude-opus-4-8-high-fast", undefined, matrix),
      "claude-opus-4-8-high-fast",
    );
  });
});
