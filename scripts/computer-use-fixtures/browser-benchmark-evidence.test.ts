import { describe, expect, it } from "vitest";
import {
  assessGitHubCompletion,
  assessNeweggCompletion,
  assessBrowserBenchmarkRuns,
  BROWSER_BENCHMARK_BUDGET_MS,
  browserBenchmarkPrompt,
  parseBrowserBenchmarkRunCount,
  parseBrowserWitness,
  parsePullRequestTitles,
  parseNeweggPageEvidence,
  parseNeweggPrice,
  observedNeweggCategory,
  type BrowserWitness,
  type NeweggRunEvidence,
} from "./browser-benchmark-evidence.ts";
import { neweggItemIdFromUrl, parseObserverDescriptor } from "./browser-benchmark-observer.ts";

const pages = [[{ number: 12, title: "First PR" }], [{ number: 11, title: "Second PR" }]];
const witnesses: BrowserWitness[] = pages.map((prs, index) => ({
  page: index + 1,
  path: "/owner/repo/pulls",
  prs,
  cartVisible: false,
  productPaths: [],
  checkoutVisible: false,
}));
const answer = JSON.stringify({ pages: pages.map((prs, index) => ({ page: index + 1, prs })) });
const proof = () => ({ before: pages, after: pages, witnesses, finalText: answer });

describe("browser benchmark run coverage", () => {
  it("defaults to two runs and accepts only an explicit one- or two-run request", () => {
    expect(parseBrowserBenchmarkRunCount(undefined)).toBe(2);
    expect(parseBrowserBenchmarkRunCount("1")).toBe(1);
    expect(parseBrowserBenchmarkRunCount("2")).toBe(2);
    for (const value of ["", "0", "3", "1.0", "01", "1.5", "-1", "NaN"])
      expect(() => parseBrowserBenchmarkRunCount(value)).toThrow("Invalid --runs");
  });

  it("does not promote a passing smoke to two-run qualification", () => {
    expect(
      assessBrowserBenchmarkRuns({
        requestedRuns: 1,
        completedRuns: 1,
        accepted: true,
        cleanupProven: true,
      }),
    ).toEqual({
      passed: true,
      requestedRuns: 1,
      completedRuns: 1,
      runMode: "single-run-smoke",
      twoRunQualificationPassed: false,
    });
  });

  it("fails missing requested runs, failed evidence, and unproven cleanup", () => {
    const complete = {
      requestedRuns: 2 as const,
      completedRuns: 2,
      accepted: true,
      cleanupProven: true,
    };
    expect(assessBrowserBenchmarkRuns(complete)).toMatchObject({
      passed: true,
      runMode: "two-run-qualification",
      twoRunQualificationPassed: true,
    });
    for (const input of [
      { ...complete, completedRuns: 1 },
      { ...complete, requestedRuns: 1 as const, completedRuns: 0 },
      { ...complete, accepted: false },
      { ...complete, cleanupProven: false },
    ])
      expect(assessBrowserBenchmarkRuns(input)).toMatchObject({
        passed: false,
        twoRunQualificationPassed: false,
      });
  });
});

describe("independent browser benchmark evidence", () => {
  it("requires matching page observations, stable independent reference and final answer", () => {
    expect(assessGitHubCompletion(proof()).status).toBe("verified");
    expect(
      assessGitHubCompletion({ ...proof(), finalText: `\`\`\`json\n${answer}\n\`\`\`` }).status,
    ).toBe("verified");
  });
  it("does not substitute provider prose or audit activity for missing observation", () => {
    expect(assessGitHubCompletion({ ...proof(), witnesses: witnesses.slice(0, 1) })).toMatchObject({
      status: "unverified",
      reason: "complete-browser-page-observation-missing",
    });
    expect(assessGitHubCompletion({ ...proof(), before: null })).toMatchObject({
      status: "unverified",
    });
  });
  it("marks moving references unverified rather than blaming the provider", () => {
    expect(assessGitHubCompletion({ ...proof(), after: [pages[0]!, []] })).toMatchObject({
      status: "unverified",
      reason: "reference-changed-during-run",
    });
  });
  it("fails a structured answer missing or inventing PRs", () => {
    expect(assessGitHubCompletion({ ...proof(), finalText: '{"pages":[]}' }).status).toBe("failed");
    expect(
      assessGitHubCompletion({ ...proof(), finalText: answer.replace("Second PR", "invented") })
        .status,
    ).toBe("failed");
    expect(assessGitHubCompletion({ ...proof(), finalText: "I read every title." }).status).toBe(
      "unverified",
    );
  });
  it("allows a genuinely absent second page without inventing an observation", () => {
    expect(
      assessGitHubCompletion({
        before: [pages[0]!, []],
        after: [pages[0]!, []],
        witnesses: witnesses.slice(0, 1),
        finalText: JSON.stringify({
          pages: [
            { page: 1, prs: pages[0] },
            { page: 2, prs: [] },
          ],
        }),
      }).status,
    ).toBe("verified");
  });
  it("rejects duplicate or malformed PR entries and strips unrelated properties", () => {
    expect(parsePullRequestTitles([pages[0]![0], pages[0]![0]])).toBeNull();
    expect(parsePullRequestTitles([{ number: 2, title: "   " }])).toBeNull();
    expect(
      parsePullRequestTitles([{ number: 2, title: " a\n b ", token: "not persisted" }]),
    ).toEqual([{ number: 2, title: "a b" }]);
  });
  it("projects only bounded page evidence and refuses sensitive arbitrary paths", () => {
    expect(parseBrowserWitness({ ...witnesses[0], rawCookies: "not persisted" })).toEqual(
      witnesses[0],
    );
    expect(parseBrowserWitness({ ...witnesses[0], productPaths: ["/account/private"] })).toBeNull();
    expect(
      parseBrowserWitness({ ...witnesses[0], prs: [], productPaths: ["/p/N82E168123"] })
        ?.productPaths,
    ).toEqual(["/p/N82E168123"]);
    expect(parseBrowserWitness({ ...witnesses[0], page: NaN })).toBeNull();
  });
  it("keeps existing-profile qualification unsupported and budgets fixed", () => {
    expect(() =>
      browserBenchmarkPrompt("github-running", "synara-bench-fixture", "owner/repo"),
    ).toThrow("unsupported");
    expect(BROWSER_BENCHMARK_BUDGET_MS).toEqual({
      "github-running": 120000,
      "github-isolated": 120000,
      newegg: 900000,
    });
  });
  it("labels isolated comparison and explicitly ends before checkout", () => {
    const prompt = browserBenchmarkPrompt("newegg", "synara-bench-fixture");
    expect(prompt).toContain("without the user's cookies");
    expect(prompt).toContain(
      "Do not sign in, enter personal/payment data, check out, submit an order, or purchase anything",
    );
    expect(
      browserBenchmarkPrompt("github-isolated", "synara-bench-fixture", "owner/repo"),
    ).toContain("sort%3Acreated-desc");
    expect(() =>
      browserBenchmarkPrompt("github-isolated", "personal-profile", "owner/repo"),
    ).toThrow();
  });
});

describe("explicit browser observer ownership descriptor", () => {
  const descriptor = {
    profileName: "synara-bench-fixture",
    profileDirectory: "/private/tmp/fixture/synara-bench-fixture",
    browserPid: 123,
    endpoint: "http://127.0.0.1:9333",
  };
  it("requires the exact named fresh run descriptor", () => {
    expect(parseObserverDescriptor(descriptor, descriptor.profileName)).toEqual(descriptor);
    expect(() => parseObserverDescriptor(descriptor, "synara-bench-another")).toThrow();
    expect(() =>
      parseObserverDescriptor({ ...descriptor, browserPid: 0 }, descriptor.profileName),
    ).toThrow();
  });
  it("rejects remote, credential-bearing, path and implicit-port endpoints", () => {
    for (const endpoint of [
      "http://example.com:9333",
      "http://user:secret@127.0.0.1:9333",
      "http://127.0.0.1:9333/private",
      "http://127.0.0.1",
      "http://127.0.0.1:9333?token=secret",
    ])
      expect(() =>
        parseObserverDescriptor({ ...descriptor, endpoint }, descriptor.profileName),
      ).toThrow();
  });
});

function neweggProof(): NeweggRunEvidence {
  const definitions: [string, string, [string, string][]][] = [
    [
      "cpu",
      "Processors - Desktops",
      [
        ["CPU Socket Type", "AM5"],
        ["Cooling Device", "Not included"],
      ],
    ],
    [
      "motherboard",
      "AMD Motherboards",
      [
        ["CPU Socket Type", "AM5"],
        ["Memory Standard", "DDR5"],
        ["Form Factor", "ATX"],
      ],
    ],
    [
      "gpu",
      "Video Cards & Graphics Cards",
      [
        ["Recommended PSU", "750 W"],
        ["Card Length", "300 mm"],
      ],
    ],
    ["memory", "Desktop Memory", [["Memory Type", "DDR5"]]],
    ["storage", "Internal SSDs", []],
    ["psu", "Power Supplies", [["Maximum Power", "850 W"]]],
    [
      "case",
      "Computer Cases",
      [
        ["Motherboard Compatibility", "ATX / Micro-ATX / Mini-ITX"],
        ["Maximum GPU Length", "400 mm"],
        ["Maximum CPU Cooler Height", "180 mm"],
      ],
    ],
    [
      "cooler",
      "CPU Fans & Heatsinks",
      [
        ["Type", "Air Cooler"],
        ["CPU Socket Support", "AM5 / LGA1700"],
        ["Cooler Height", "160 mm"],
      ],
    ],
  ];
  const products = definitions.map(([title, breadcrumb, facts], index) => ({
    itemId: `N82E1680000000${index}`,
    title,
    breadcrumbs: ["Home", breadcrumb],
    facts: facts.map(([label, value]) => ({ label, value })),
  }));
  const cart = {
    items: products.map((product) => ({
      itemId: product.itemId,
      title: product.title,
      quantity: 1,
      unitPriceMinor: 30000,
      currency: "USD" as const,
      unavailable: false,
    })),
    itemCount: 8,
    subtotalMinor: 240000,
    currency: "USD" as const,
    rowCoverageComplete: true,
  };
  return {
    products,
    carts: [
      { cart: structuredClone(cart), observedAtMs: 1100 },
      { cart: structuredClone(cart), observedAtMs: 1400 },
    ],
  };
}
const assessNewegg = (evidence: NeweggRunEvidence) =>
  assessNeweggCompletion({ evidence, finalObservationStartedAtMs: 1000 });

describe("independent Newegg cart outcome", () => {
  it("verifies a stable reconciled cart and explicit listed fit checks with remaining hardware limits", () => {
    const result = assessNewegg(neweggProof());
    expect(result).toMatchObject({
      status: "verified",
      cart: { itemCount: 8, subtotalMinor: 240000, withinBudget: true },
      compatibility: { status: "listed-checks-matched" },
    });
    expect("compatibility" in result && result.compatibility.unverified).toContain(
      "1440p-frame-rate-and-quality",
    );
  });
  it("does not reuse an earlier complete cart or one transient final observation", () => {
    const proof = neweggProof();
    proof.carts[1]!.observedAtMs = 1150;
    expect(assessNewegg(proof).status).toBe("unverified");
    expect(
      assessNeweggCompletion({ evidence: neweggProof(), finalObservationStartedAtMs: 1300 }).status,
    ).toBe("unverified");
    expect(assessNewegg({ products: neweggProof().products, carts: [] }).status).toBe("unverified");
  });
  it("requires stable final cart contents and complete rows", () => {
    const changed = neweggProof();
    changed.carts[1]!.cart.items.pop();
    expect(assessNewegg(changed).status).toBe("unverified");
    const partial = neweggProof();
    partial.carts.forEach(({ cart }) => {
      cart.rowCoverageComplete = false;
    });
    expect(assessNewegg(partial)).toMatchObject({
      status: "unverified",
      reason: "cart-identifiers-quantities-USD-prices-or-row-coverage-missing",
    });
  });
  it("reconciles quantities and cents against the independent subtotal and count", () => {
    for (const mutation of [
      (cart: NeweggRunEvidence["carts"][number]["cart"]) => {
        cart.itemCount = 9;
      },
      (cart: NeweggRunEvidence["carts"][number]["cart"]) => {
        cart.subtotalMinor = 1;
      },
    ]) {
      const proof = neweggProof();
      proof.carts.forEach(({ cart }) => mutation(cart));
      expect(assessNewegg(proof)).toMatchObject({
        status: "unverified",
        reason: "cart-count-or-subtotal-does-not-reconcile",
      });
    }
  });
  it("fails observable budget excess, unavailable stock or a missing component", () => {
    const expensive = neweggProof();
    expensive.carts.forEach(({ cart }) => {
      cart.items[0]!.unitPriceMinor = 100000;
      cart.subtotalMinor = 310000;
    });
    expect(assessNewegg(expensive).status).toBe("failed");
    const stock = neweggProof();
    stock.carts.forEach(({ cart }) => {
      cart.items[0]!.unavailable = true;
    });
    expect(assessNewegg(stock).status).toBe("failed");
    const missing = neweggProof();
    missing.carts.forEach(({ cart }) => {
      cart.items.splice(5, 1);
      cart.itemCount = 7;
      cart.subtotalMinor = 210000;
    });
    expect(assessNewegg(missing)).toMatchObject({ status: "failed", missingCategories: ["psu"] });
  });
  it("rejects observed socket, DDR, power or clearance mismatches", () => {
    for (const [product, label, value] of [
      [1, "CPU Socket Type", "LGA1700"],
      [3, "Memory Type", "DDR4"],
      [5, "Maximum Power", "500 W"],
      [6, "Maximum GPU Length", "200 mm"],
      [6, "Maximum CPU Cooler Height", "140 mm"],
    ] as const) {
      const proof = neweggProof();
      proof.products[product]!.facts.find((fact) => fact.label === label)!.value = value;
      expect(assessNewegg(proof)).toMatchObject({
        status: "failed",
        compatibility: { status: "incompatible" },
      });
    }
  });
  it("does not infer unobserved compatibility from a model, title or dimensions ordering", () => {
    const proof = neweggProof();
    proof.products[2]!.facts = [
      { label: "Card Dimensions", value: "300 x 150 x 50 mm" },
      { label: "Recommended PSU", value: "750 W" },
    ];
    expect(assessNewegg(proof)).toMatchObject({
      status: "unverified",
      cart: { status: "verified" },
      compatibility: { status: "unknown" },
    });
    const noTaxonomy = neweggProof();
    noTaxonomy.products[0]!.breadcrumbs = [];
    noTaxonomy.products[0]!.title = "CPU AM5 Desktop processor guaranteed compatible";
    expect(observedNeweggCategory(noTaxonomy.products[0]!)).toBeNull();
    expect(assessNewegg(noTaxonomy).status).toBe("unverified");
    const liquid = neweggProof();
    liquid.products[7]!.facts[0]!.value = "Liquid Cooler";
    expect(assessNewegg(liquid)).toMatchObject({
      status: "unverified",
      compatibility: { status: "unknown" },
    });
    const xlBoard = neweggProof();
    xlBoard.products[1]!.facts[2]!.value = "XL-ATX";
    expect(assessNewegg(xlBoard)).toMatchObject({
      status: "unverified",
      compatibility: { status: "unknown" },
    });
  });
  it("allows explicitly included cooling instead of imposing the historical eight-part count", () => {
    const proof = neweggProof();
    proof.products[0]!.facts[1]!.value = "Included";
    proof.carts.forEach(({ cart }) => {
      cart.items.pop();
      cart.itemCount = 7;
      cart.subtotalMinor = 210000;
    });
    expect(assessNewegg(proof)).toMatchObject({ status: "verified", cart: { itemCount: 7 } });
    proof.products[0]!.facts[1]!.value = "Not included";
    expect(assessNewegg(proof).status).toBe("failed");
  });
  it("requires observed currency and exact decimal price syntax", () => {
    expect(parseNeweggPrice("$1,299.95", "USD")).toEqual({ minor: 129995, currency: "USD" });
    expect(parseNeweggPrice("US$ 299.99")).toEqual({ minor: 29999, currency: "USD" });
    for (const price of [
      "$299.99",
      "USD 1,23.99",
      "USD 299.999",
      "CAD $299.99",
      "USD $-1.00",
      "$99.99 or $9.99 monthly",
    ])
      expect(parseNeweggPrice(price)).toBeNull();
    const proof = neweggProof();
    proof.carts.forEach(({ cart }) => {
      cart.currency = null;
    });
    expect(assessNewegg(proof).status).toBe("unverified");
  });
  it("parses only bounded product/cart fields and stable retailer item IDs", () => {
    const proof = neweggProof();
    expect(
      parseNeweggPageEvidence({
        product: { ...proof.products[0], privateNotes: "discarded" },
        cart: proof.carts[0]!.cart,
      }),
    ).toEqual({ product: proof.products[0], cart: proof.carts[0]!.cart });
    expect(
      parseNeweggPageEvidence({
        cart: {
          ...proof.carts[0]!.cart,
          items: [{ ...proof.carts[0]!.cart.items[0], quantity: 0 }],
        },
      }),
    ).toBeNull();
    expect(
      neweggItemIdFromUrl("https://www.newegg.com/product-title/p/N82E16800000001?Item=ignored"),
    ).toBe("N82E16800000001");
    expect(
      neweggItemIdFromUrl("https://www.newegg.com/Product/Product.aspx?Item=N82E16800000001"),
    ).toBe("N82E16800000001");
    expect(neweggItemIdFromUrl("https://evil.example/p/N82E16800000001")).toBeNull();
  });
});
