// FILE: providerOrdering.test.ts
// Purpose: Keeps provider ordering normalization covered for every exposed provider.
// Layer: Web settings tests
// Depends on: provider display metadata from contracts and providerOrdering helpers.

import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROVIDER_ORDER,
  isProviderKind,
  normalizeHiddenProviders,
  normalizeProviderOrder,
} from "./providerOrdering";

const ALL_PROVIDER_KINDS = Object.keys(PROVIDER_DISPLAY_NAMES) as ProviderKind[];

describe("providerOrdering", () => {
  it("includes every displayable provider in the default order", () => {
    expect(DEFAULT_PROVIDER_ORDER).toHaveLength(ALL_PROVIDER_KINDS.length);
    expect(new Set(DEFAULT_PROVIDER_ORDER)).toEqual(new Set(ALL_PROVIDER_KINDS));
  });

  it("keeps Pi as a valid provider for persisted order and visibility settings", () => {
    expect(isProviderKind("pi")).toBe(true);
    expect(normalizeProviderOrder(["pi", "codex"])[0]).toBe("pi");
    expect(normalizeHiddenProviders(["bogus", "pi", "pi"])).toEqual(["pi"]);
  });
});
