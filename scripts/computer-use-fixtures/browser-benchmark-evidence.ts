export type BrowserBenchmarkTask = "github-running" | "github-isolated" | "newegg";
export const BROWSER_BENCHMARK_BUDGET_MS = {
  "github-running": 120_000,
  "github-isolated": 120_000,
  newegg: 900_000,
} as const;

export function parseBrowserBenchmarkRunCount(value: string | undefined): 1 | 2 {
  if (value === undefined || value === "2") return 2;
  if (value === "1") return 1;
  throw new Error("Invalid --runs: expected 1 or 2");
}

export function assessBrowserBenchmarkRuns(input: {
  requestedRuns: 1 | 2;
  completedRuns: number;
  accepted: boolean;
  cleanupProven: boolean;
}) {
  const passed =
    input.accepted && input.completedRuns === input.requestedRuns && input.cleanupProven;
  return {
    passed,
    requestedRuns: input.requestedRuns,
    completedRuns: input.completedRuns,
    runMode: input.requestedRuns === 1 ? "single-run-smoke" : "two-run-qualification",
    twoRunQualificationPassed: input.requestedRuns === 2 && passed,
  };
}

export interface PullRequestTitle {
  number: number;
  title: string;
}

export interface BrowserWitness {
  page: number;
  path: string;
  prs: PullRequestTitle[];
  cartVisible: boolean;
  productPaths: string[];
  checkoutVisible: boolean;
  newegg?: NeweggPageEvidence;
}

export const NEWEGG_CORE_CATEGORIES = [
  "cpu",
  "motherboard",
  "gpu",
  "memory",
  "storage",
  "psu",
  "case",
] as const;
export type NeweggCategory = (typeof NEWEGG_CORE_CATEGORIES)[number] | "cooler";
export interface NeweggProduct {
  itemId: string;
  title: string;
  /** Visible product breadcrumbs, never the model's suggested category. */
  breadcrumbs: string[];
  facts: { label: string; value: string }[];
}
export interface NeweggCartItem {
  itemId: string;
  title: string;
  quantity: number | null;
  unitPriceMinor: number | null;
  currency: "USD" | null;
  unavailable: boolean;
}
export interface NeweggCart {
  items: NeweggCartItem[];
  /** Explicitly labeled rendered cart count; used to detect omitted rows. */
  itemCount: number | null;
  subtotalMinor: number | null;
  currency: "USD" | null;
  rowCoverageComplete: boolean;
}
export interface NeweggPageEvidence {
  product?: NeweggProduct;
  cart?: NeweggCart;
}
export interface NeweggRunEvidence {
  products: NeweggProduct[];
  carts: { cart: NeweggCart; observedAtMs: number }[];
}

const validItemId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z0-9]{6,32}$/.test(value);
const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const shortText = (value: unknown, max = 1024): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

/** Prices use integer cents. A bare dollar sign alone does not prove USD. */
export function parseNeweggPrice(text: string, currencyHint: string | null = null) {
  const input = text.replace(/\s+/g, " ").trim();
  const usd = currencyHint === "USD" || /\bUSD\b|US\s*\$/i.test(input);
  if (!usd || /\b(?:CAD|AUD|NZD|HKD)\b|[€£¥]/i.test(input)) return null;
  const stripped = input
    .replace(/\bUSD\b|US\s*\$/gi, "")
    .replace(/^\s*\$/, "")
    .trim();
  if (!/^(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d{2})$/.test(stripped)) return null;
  const cents = Number(stripped.replace(/[,\.]/g, ""));
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= 10_000_000
    ? { minor: cents, currency: "USD" as const }
    : null;
}

export function parseNeweggPageEvidence(value: unknown): NeweggPageEvidence | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const result: NeweggPageEvidence = {};
  if (row.product !== undefined) {
    const product = row.product as Partial<NeweggProduct> | null;
    if (
      !product ||
      !validItemId(product.itemId) ||
      !shortText(product.title) ||
      !Array.isArray(product.breadcrumbs) ||
      product.breadcrumbs.length > 16 ||
      !product.breadcrumbs.every((part) => shortText(part, 160)) ||
      !Array.isArray(product.facts) ||
      product.facts.length > 48 ||
      !product.facts.every(
        (fact) => fact && shortText(fact.label, 120) && shortText(fact.value, 512),
      )
    )
      return null;
    result.product = {
      itemId: product.itemId,
      title: normalized(product.title),
      breadcrumbs: product.breadcrumbs.map(normalized),
      facts: product.facts.map(({ label, value }) => ({
        label: normalized(label),
        value: normalized(value),
      })),
    };
  }
  if (row.cart !== undefined) {
    const cart = row.cart as Partial<NeweggCart> | null;
    const nullableInteger = (number: unknown, maximum: number) =>
      number === null || (nonnegativeInteger(number) && number <= maximum);
    if (
      !cart ||
      !Array.isArray(cart.items) ||
      cart.items.length > 32 ||
      typeof cart.rowCoverageComplete !== "boolean" ||
      !nullableInteger(cart.itemCount, 128) ||
      !nullableInteger(cart.subtotalMinor, 10_000_000) ||
      ![null, "USD"].includes(cart.currency!) ||
      !cart.items.every(
        (item) =>
          item &&
          validItemId(item.itemId) &&
          shortText(item.title) &&
          (item.quantity === null ||
            (nonnegativeInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 99)) &&
          nullableInteger(item.unitPriceMinor, 10_000_000) &&
          [null, "USD"].includes(item.currency) &&
          typeof item.unavailable === "boolean",
      )
    )
      return null;
    result.cart = {
      items: cart.items.map(
        ({ itemId, title, quantity, unitPriceMinor, currency, unavailable }) => ({
          itemId,
          title: normalized(title),
          quantity,
          unitPriceMinor,
          currency,
          unavailable,
        }),
      ),
      itemCount: cart.itemCount!,
      subtotalMinor: cart.subtotalMinor!,
      currency: cart.currency!,
      rowCoverageComplete: cart.rowCoverageComplete,
    };
  }
  return result.product || result.cart ? result : null;
}

/** Category coverage requires retailer taxonomy observed on the exact SKU's
 * product page. Matching words in a cart title are not sufficient evidence. */
export function observedNeweggCategory(product: NeweggProduct): NeweggCategory | null {
  const categories: [NeweggCategory, RegExp][] = [
    [
      "cpu",
      /^(?:CPUs?\s*\/\s*Processors|Processors?\s*-\s*Desktops?|Desktop (?:CPUs?|Processors?))$/i,
    ],
    ["motherboard", /^(?:(?:AMD|Intel) )?Motherboards$/i],
    [
      "gpu",
      /^(?:Desktop )?(?:Video Cards(?: & (?:Video Devices|Graphics Cards))?|Graphics Cards)$/i,
    ],
    ["memory", /^Desktop Memory$/i],
    ["storage", /^(?:Internal (?:SSDs|Hard Drives|Solid State Drives)|Solid State Drives)$/i],
    ["psu", /^Power Supplies$/i],
    ["case", /^Computer Cases$/i],
    ["cooler", /^(?:CPU (?:Coolers|Fans & Heatsinks)|Liquid (?:CPU )?Cooling Systems)$/i],
  ];
  const matches = categories.filter(([, pattern]) =>
    product.breadcrumbs.some((part) => pattern.test(part)),
  );
  return matches.length === 1 ? matches[0]![0] : null;
}

type CompatibilityCheck = {
  check: string;
  status: "matched" | "mismatched" | "unknown";
  values: (string | number | boolean | null)[];
};
function compareNeweggCompatibility(parts: Partial<Record<NeweggCategory, NeweggProduct>>) {
  const fact = (part: NeweggCategory, label: RegExp) =>
    parts[part]?.facts
      .filter((entry) => label.test(entry.label))
      .map((entry) => entry.value)
      .join(" / ") ?? "";
  const single = (values: string[]) => (new Set(values).size === 1 ? values[0]! : null);
  const sockets = (part: NeweggCategory) =>
    [
      ...fact(
        part,
        /^(?:CPU )?Socket(?: Type| Support| Compatibility|s)?$|^Supported CPU Sockets$/i,
      ).matchAll(/\b(?:AM[345]|LGA\s*\d{3,4})\b/gi),
    ].map((match) => match[0].toUpperCase().replace(/\s/g, ""));
  const memory = (part: NeweggCategory) =>
    single(
      [...fact(part, /^(?:Memory (?:Type|Standard)|Type)$/i).matchAll(/\bDDR[345]\b/gi)].map(
        (match) => match[0].toUpperCase(),
      ),
    );
  const numeric = (part: NeweggCategory, label: RegExp, unit: "W" | "mm") => {
    const text = fact(part, label).trim();
    const match = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*${unit}$`, "i").exec(text);
    return match ? Number(match[1]) : null;
  };
  const forms = (part: NeweggCategory, label: RegExp) =>
    fact(part, label)
      .split(/[,/]|\band\b/i)
      .map((value) =>
        value
          .trim()
          .toUpperCase()
          .replace(/EXTENDED/, "E")
          .replace(/[ -]/g, ""),
      )
      .filter((value) => ["ATX", "EATX", "MICROATX", "MINIITX"].includes(value));
  const checks: CompatibilityCheck[] = [];
  const same = (check: string, a: string | null, b: string | null) =>
    checks.push({
      check,
      status: a === null || b === null ? "unknown" : a === b ? "matched" : "mismatched",
      values: [a, b],
    });
  const fits = (check: string, needed: number | null, available: number | null) =>
    checks.push({
      check,
      status:
        needed === null || available === null
          ? "unknown"
          : available >= needed
            ? "matched"
            : "mismatched",
      values: [needed, available],
    });
  const cpuSocket = single(sockets("cpu"));
  same("CPU-motherboard-socket", cpuSocket, single(sockets("motherboard")));
  same("RAM-motherboard-DDR-standard", memory("memory"), memory("motherboard"));
  const boardForm = single(forms("motherboard", /^Form Factor$/i));
  const caseForms = forms("case", /^Motherboard (?:Compatibility|Support|Supported)$/i);
  checks.push({
    check: "motherboard-case-form-factor",
    status:
      !boardForm || !caseForms.length
        ? "unknown"
        : caseForms.includes(boardForm)
          ? "matched"
          : "mismatched",
    values: [boardForm, caseForms.join(",") || null],
  });
  fits(
    "GPU-listed-minimum-PSU",
    numeric("gpu", /^(?:Recommended|Minimum|Required) (?:PSU|Power Supply|System Power)$/i, "W"),
    numeric("psu", /^(?:Maximum Power|Wattage|Output Power|Power Output)$/i, "W"),
  );
  fits(
    "GPU-case-length",
    numeric("gpu", /^(?:Card|GPU|Graphics Card) Length$/i, "mm"),
    numeric("case", /^Max(?:imum)? (?:GPU|Graphics Card|Video Card) Length$/i, "mm"),
  );
  const cooling = fact("cpu", /^(?:Cooling Device|Cooler Included|Includes Cooler|CPU Cooler)$/i);
  const included = /^(?:Yes|Included|(?:Heatsink|Cooler|Cooling device) included)$/i.test(cooling);
  if (parts.cooler) {
    const supported = sockets("cooler");
    checks.push({
      check: "CPU-cooler-socket",
      status:
        !cpuSocket || !supported.length
          ? "unknown"
          : supported.includes(cpuSocket)
            ? "matched"
            : "mismatched",
      values: [cpuSocket, supported.join(",") || null],
    });
    const coolerType = fact("cooler", /^(?:Type|Cooling Type|Cooler Type)$/i);
    if (/^(?:Air(?: Cooler| Cooling)?|CPU Air Cooler|Heatsink(?: and Fan)?)$/i.test(coolerType))
      fits(
        "air-cooler-case-height",
        numeric("cooler", /^(?:Cooler|Heatsink|Product)? ?Height$/i, "mm"),
        numeric("case", /^Max(?:imum)? CPU Cooler Height$/i, "mm"),
      );
    else
      checks.push({
        check: "cooler-case-mounting-unobserved",
        status: "unknown",
        values: [coolerType || null],
      });
  } else
    checks.push({
      check: "CPU-cooling-included",
      status: included
        ? "matched"
        : /^(?:No|Not included|None)$/i.test(cooling)
          ? "mismatched"
          : "unknown",
      values: [cooling || null],
    });
  return {
    status: checks.some((check) => check.status === "mismatched")
      ? "incompatible"
      : checks.every((check) => check.status === "matched")
        ? "listed-checks-matched"
        : "unknown",
    checks,
    unverified: [
      "1440p-frame-rate-and-quality",
      "BIOS-and-memory-QVL",
      "memory-form-factor-buffering-and-slot-count",
      "storage-slots-and-lane-sharing",
      "PSU-cables-and-transient-load",
      "radiator-RAM-and-connector-clearances",
      "assembly-and-real-hardware-operation",
    ],
  };
}

export function assessNeweggCompletion(input: {
  evidence: NeweggRunEvidence;
  finalObservationStartedAtMs: number;
}) {
  const carts = input.evidence.carts
    .filter((entry) => entry.observedAtMs >= input.finalObservationStartedAtMs)
    .slice(-8);
  const issues: string[] = [];
  if (
    carts.length < 2 ||
    carts.at(-1)!.observedAtMs - carts[0]!.observedAtMs < 200 ||
    carts.some((entry) => JSON.stringify(entry.cart) !== JSON.stringify(carts[0]!.cart))
  )
    return { status: "unverified", reason: "two-stable-final-cart-observations-missing" } as const;
  const cart = carts.at(-1)!.cart;
  if (
    !cart.rowCoverageComplete ||
    cart.itemCount === null ||
    cart.subtotalMinor === null ||
    cart.currency !== "USD" ||
    !cart.items.length ||
    cart.items.some(
      (item) => item.quantity === null || item.unitPriceMinor === null || item.currency !== "USD",
    ) ||
    new Set(cart.items.map((item) => item.itemId)).size !== cart.items.length
  )
    return {
      status: "unverified",
      reason: "cart-identifiers-quantities-USD-prices-or-row-coverage-missing",
    } as const;
  const quantity = cart.items.reduce((sum, item) => sum + item.quantity!, 0);
  const total = cart.items.reduce((sum, item) => sum + item.quantity! * item.unitPriceMinor!, 0);
  if (quantity !== cart.itemCount || total !== cart.subtotalMinor)
    return { status: "unverified", reason: "cart-count-or-subtotal-does-not-reconcile" } as const;
  const parts: Partial<Record<NeweggCategory, NeweggProduct>> = {};
  const coverage: { itemId: string; category: NeweggCategory | null; quantity: number }[] = [];
  for (const item of cart.items) {
    const product = input.evidence.products.find((entry) => entry.itemId === item.itemId);
    const category = product ? observedNeweggCategory(product) : null;
    coverage.push({ itemId: item.itemId, category, quantity: item.quantity! });
    if (!category || !product) issues.push("cart-product-taxonomy-unobserved");
    else if (parts[category])
      issues.push("multiple-products-in-category-need-additional-fit-checks");
    else parts[category] = product;
    if (category && !["storage", "memory"].includes(category) && item.quantity !== 1)
      issues.push("single-PC-component-quantity-ambiguous");
  }
  const missingCategories = NEWEGG_CORE_CATEGORIES.filter((category) => !parts[category]);
  if (missingCategories.length) issues.push("required-component-categories-missing-or-unobserved");
  const compatibility = compareNeweggCompatibility(parts);
  if (compatibility.status === "unknown") issues.push("listed-compatibility-facts-incomplete");
  const failed =
    cart.subtotalMinor > 300_000 ||
    cart.items.some((item) => item.unavailable) ||
    compatibility.status === "incompatible" ||
    (missingCategories.length > 0 && coverage.every((item) => item.category !== null));
  return {
    status: failed ? "failed" : issues.length ? "unverified" : "verified",
    reason: failed
      ? "budget-stock-or-observed-fit-failed"
      : issues.length
        ? "cart-observed-with-open-evidence-gaps"
        : "cart-budget-categories-and-listed-fit-checks-verified",
    scope: "retailer-cart-and-explicit-listed-fit-checks; not a hardware or 1440p performance test",
    issues: [...new Set(issues)],
    coverage,
    missingCategories,
    cart: {
      status: "verified",
      itemCount: cart.itemCount,
      distinctItems: cart.items.length,
      currency: "USD",
      subtotalMinor: cart.subtotalMinor,
      budgetMinor: 300_000,
      withinBudget: cart.subtotalMinor <= 300_000,
      costBasis: "merchandise-subtotal; shipping-and-tax-unverified",
    },
    compatibility,
  };
}

const normalized = (value: string) => value.replace(/\s+/g, " ").trim();

export function parseBrowserWitness(value: unknown): BrowserWitness | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const prs = parsePullRequestTitles(row.prs);
  if (
    !Number.isSafeInteger(row.page) ||
    Number(row.page) < 1 ||
    Number(row.page) > 10_000 ||
    typeof row.path !== "string" ||
    row.path.length > 2048 ||
    !row.path.startsWith("/") ||
    typeof row.cartVisible !== "boolean" ||
    typeof row.checkoutVisible !== "boolean" ||
    !prs ||
    !Array.isArray(row.productPaths) ||
    row.productPaths.length > 32 ||
    !row.productPaths.every(
      (path) => typeof path === "string" && /^\/p\/[A-Za-z0-9_-]+$/.test(path),
    )
  )
    return null;
  return {
    page: Number(row.page),
    path: row.path,
    prs,
    cartVisible: row.cartVisible,
    productPaths: [...new Set(row.productPaths as string[])],
    checkoutVisible: row.checkoutVisible,
    ...(row.newegg !== undefined && parseNeweggPageEvidence(row.newegg)
      ? { newegg: parseNeweggPageEvidence(row.newegg)! }
      : {}),
  };
}

export function parsePullRequestTitles(value: unknown): PullRequestTitle[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const result: PullRequestTitle[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      !Number.isSafeInteger(item.number) ||
      item.number < 1 ||
      typeof item.title !== "string" ||
      item.title.length > 1024 ||
      !normalized(item.title)
    )
      return null;
    result.push({ number: item.number, title: normalized(item.title) });
  }
  return new Set(result.map((item) => item.number)).size === result.length ? result : null;
}

function sameTitles(a: PullRequestTitle[], b: PullRequestTitle[]): boolean {
  const sorted = (items: PullRequestTitle[]) => [...items].sort((x, y) => x.number - y.number);
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

export function assessGitHubCompletion(input: {
  before: PullRequestTitle[][] | null;
  after: PullRequestTitle[][] | null;
  witnesses: readonly BrowserWitness[];
  finalText: string;
}) {
  if (!input.before || !input.after || input.before.length !== 2 || input.after.length !== 2)
    return { status: "unverified", reason: "independent-public-reference-unavailable" } as const;
  if (!input.before.every((page, index) => sameTitles(page, input.after![index]!)))
    return { status: "unverified", reason: "reference-changed-during-run" } as const;
  if (
    !input.after.every(
      (page, index) =>
        (index === 1 && page.length === 0) ||
        input.witnesses.some(
          (witness) => witness.page === index + 1 && sameTitles(witness.prs, page),
        ),
    )
  )
    return { status: "unverified", reason: "complete-browser-page-observation-missing" } as const;
  let answer: unknown;
  try {
    if (input.finalText.length > 100_000) throw new Error("Answer too large");
    const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(input.finalText);
    answer = JSON.parse(fenced?.[1] ?? input.finalText);
  } catch {
    return { status: "unverified", reason: "final-answer-not-structured" } as const;
  }
  const pages = answer && typeof answer === "object" && "pages" in answer ? answer.pages : null;
  if (!Array.isArray(pages) || pages.length !== 2)
    return { status: "failed", reason: "final-answer-missing-pages" } as const;
  for (let index = 0; index < 2; index++) {
    const page = pages.find((item) => item?.page === index + 1);
    const prs = parsePullRequestTitles(page?.prs);
    if (!prs || !sameTitles(prs, input.after[index]!))
      return {
        status: "failed",
        reason: "final-answer-pr-titles-incomplete-or-different",
      } as const;
  }
  return {
    status: "verified",
    reason: "two-page-browser-inventory-and-answer-match-stable-reference",
  } as const;
}

export function browserBenchmarkPrompt(
  task: BrowserBenchmarkTask,
  profileName: string,
  repo?: string,
) {
  if (!/^synara-bench-[a-z0-9-]{1,45}$/.test(profileName))
    throw new Error("Invalid benchmark profile name");
  if (task === "github-running")
    throw new Error(
      "The existing-user-profile benchmark is unsupported; it must not be substituted.",
    );
  const boundary =
    `Use Synara Computer browser tools in a separate driver-owned headless Chrome with isolated_named profile ${profileName}. ` +
    "This explicitly tests a separate isolated Chrome profile, without the user's cookies; do not attach or substitute the user's running browser. " +
    "Keep the user's foreground app, key window and Space unchanged. Use the browser for the task, not shell, HTTP, external search or the in-app browser. ";
  if (task === "github-isolated") {
    if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
      throw new Error("Expected owner/repo");
    return (
      boundary +
      `Open https://github.com/${repo}/pulls?q=is%3Apr+is%3Aopen+sort%3Acreated-desc and read the open PR titles on its first two pages. ` +
      'Do not modify GitHub data. Return only JSON with this shape: {"pages":[{"page":1,"prs":[{"number":123,"title":"Exact PR title"}]},{"page":2,"prs":[]}]}. ' +
      "List every PR on each page; an absent second page is an empty array. Stop honestly if access is blocked."
    );
  }
  return (
    boundary +
    "Go to newegg.com and choose compatible parts for a $3000 gaming PC for 1440p gaming, then add them to the cart. " +
    "Do not sign in, enter personal/payment data, check out, submit an order, or purchase anything. Stop at the cart. " +
    "Report the chosen parts, quantities and subtotal, and explain any missing or uncertain component. Stop honestly if site access is blocked."
  );
}
