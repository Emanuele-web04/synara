/** Read-only observation of one explicitly described, freshly-created Cua
 * Chrome profile. Never scans profiles or navigates/clicks the observed page. */
import { execFileSync } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { assertLoopbackUrl } from "./packaged-client.ts";
import {
  parseBrowserWitness,
  parsePullRequestTitles,
  parseNeweggPrice,
  type BrowserBenchmarkTask,
  type BrowserWitness,
  type NeweggPageEvidence,
  type NeweggRunEvidence,
} from "./browser-benchmark-evidence.ts";

/** Canonical retailer SKU from current and legacy public product URLs. */
export function neweggItemIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !(url.hostname === "newegg.com" || url.hostname.endsWith(".newegg.com"))
    )
      return null;
    const itemId =
      /\/p\/([a-z0-9]{6,32})\/?$/i.exec(url.pathname)?.[1] ??
      (/\/Product\.aspx$/i.test(url.pathname) ? url.searchParams.get("Item") : null);
    return itemId && /^[a-z0-9]{6,32}$/i.test(itemId) ? itemId.toUpperCase() : null;
  } catch {
    return null;
  }
}

/** Serialized into the explicitly owned browser. It reads rendered product
 * specs/cart controls, with no navigation, account data or hidden app state. */
export function readNeweggPageDom(): NeweggPageEvidence {
  const visible = (element: Element) => {
    const style = getComputedStyle(element);
    return (
      element.getClientRects().length > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      element.getAttribute("aria-hidden") !== "true"
    );
  };
  const text = (element: Element | null) =>
    element instanceof HTMLElement && visible(element)
      ? element.innerText.replace(/\s+/g, " ").trim()
      : "";
  const result: NeweggPageEvidence = {};
  const itemId = neweggItemIdFromUrl(location.href);
  if (itemId) {
    const title = text(document.querySelector("h1"));
    const breadcrumbs = [
      ...document.querySelectorAll(
        '.breadcrumb a, .breadcrumb li:last-child, nav[aria-label*="breadcrumb" i] a, nav[aria-label*="breadcrumb" i] li:last-child',
      ),
    ]
      .map(text)
      .filter((value) => value && value.length <= 160)
      .slice(0, 16);
    const facts = [
      ...document.querySelectorAll(
        '.table-horizontal tr, .product-specs tr, #specifications tr, [data-testid="specifications"] tr',
      ),
    ]
      .flatMap((row) => {
        const cells = row.querySelectorAll("th,td");
        const label = text(cells[0] ?? null);
        const value = text(cells[1] ?? null);
        return label &&
          value &&
          label.length <= 120 &&
          value.length <= 512 &&
          /socket|memory|form factor|motherboard|power|wattage|length|height|cooler|cooling device|^type$/i.test(
            label,
          )
          ? [{ label, value }]
          : [];
      })
      .slice(0, 48);
    if (title && title.length <= 1024) result.product = { itemId, title, breadcrumbs, facts };
  }
  if (!/\/cart(?:\/|$)/i.test(location.pathname)) return result;
  const roots = [
    ...document.querySelectorAll(
      '[data-testid="cart-items"], #cart-items, .cart-items, .cart-body, .cart-content',
    ),
  ].filter(visible);
  const summaryRoots = [
    ...document.querySelectorAll(
      '[data-testid="cart-summary"], #cart-summary, .cart-summary, .summary-content',
    ),
  ].filter(visible);
  const currencies = summaryRoots
    .flatMap((root) =>
      [...root.querySelectorAll('[itemprop="priceCurrency"], [data-currency], .currency')].map(
        (element) =>
          element.getAttribute("content") ?? element.getAttribute("data-currency") ?? text(element),
      ),
    )
    .filter(Boolean);
  const currencyHint =
    currencies.length && currencies.every((value) => value.trim() === "USD") ? "USD" : null;
  const summaries = summaryRoots
    .flatMap((root) => [...root.querySelectorAll("div,li,tr,p")])
    .filter(visible)
    .map(text)
    .filter((value) => value.length < 160);
  const subtotalRows = summaries.filter((value) =>
    /^Subtotal(?:\s*\([^)]*\))?\s*:?\s*(?:US\s*\$|USD|\$)/i.test(value),
  );
  const subtotalValues = [
    ...new Set(
      subtotalRows.map((value) => value.replace(/^Subtotal(?:\s*\([^)]*\))?\s*:?\s*/i, "")),
    ),
  ];
  const subtotal =
    subtotalValues.length === 1 ? parseNeweggPrice(subtotalValues[0]!, currencyHint) : null;
  const counts = [
    ...new Set(
      subtotalRows.flatMap((value) =>
        [...value.matchAll(/\b(\d+)\s+items?\b/gi)].map((match) => Number(match[1])),
      ),
    ),
  ];
  const candidateRows = [
    ...new Set(
      roots.flatMap((root) => [
        ...root.querySelectorAll(
          '[data-testid="cart-item"], .cart-item, .cart-item-container, .item-cell, .item-container',
        ),
      ]),
    ),
  ].filter(visible);
  const quantitySelector =
    'select[name*="qty" i], input[name*="qty" i], select[name*="quantity" i], input[name*="quantity" i], select[aria-label*="quantity" i], input[aria-label*="quantity" i], .qty-box input, [data-testid="quantity"]';
  const removable = (row: Element) =>
    [...row.querySelectorAll("button,a")].some(
      (element) =>
        visible(element) &&
        /^(?:remove|remove item|delete item)$/i.test(
          element.getAttribute("aria-label") ?? text(element),
        ),
    );
  const qualified = candidateRows.filter(
    (row) => row.querySelector(quantitySelector) && removable(row),
  );
  const rows = qualified.filter(
    (row) => !qualified.some((parent) => parent !== row && parent.contains(row)),
  );
  let complete =
    roots.length > 0 && summaryRoots.length > 0 && rows.length > 0 && rows.length <= 32;
  const items = rows.slice(0, 32).flatMap((row) => {
    const links = [...row.querySelectorAll<HTMLAnchorElement>("a[href]")]
      .filter(visible)
      .flatMap((anchor) => {
        const id = neweggItemIdFromUrl(anchor.href);
        const title = text(anchor);
        return id && title ? [{ id, title }] : [];
      });
    const ids = [...new Set(links.map((link) => link.id))];
    const title = links
      .filter((link) => link.id === ids[0])
      .sort((a, b) => b.title.length - a.title.length)[0]?.title;
    if (ids.length !== 1 || !title || title.length > 1024) {
      complete = false;
      return [];
    }
    const quantityNodes = [...row.querySelectorAll(quantitySelector)].filter(visible);
    const quantityValues = [
      ...new Set(
        quantityNodes.map((element) =>
          element instanceof HTMLInputElement || element instanceof HTMLSelectElement
            ? element.value
            : text(element),
        ),
      ),
    ];
    const quantity =
      quantityValues.length === 1 && /^[1-9]\d?$/.test(quantityValues[0]!)
        ? Number(quantityValues[0])
        : null;
    const explicitPrice = row.querySelector(
      '[data-testid="unit-price"], [data-price-type="unit"], .item-unit-price',
    );
    // An unlabeled cart price is ambiguous for multiple units; never treat a
    // line total as a unit price in that case.
    const priceNode =
      explicitPrice ?? (quantity === 1 ? row.querySelector(".price-current") : null);
    const price = parseNeweggPrice(text(priceNode), currencyHint);
    return [
      {
        itemId: ids[0]!,
        title,
        quantity,
        unitPriceMinor: price?.minor ?? null,
        currency: price?.currency ?? null,
        unavailable: /\b(?:out of stock|sold out|no longer available)\b/i.test(text(row)),
      },
    ];
  });
  const scopedIds = new Set(
    roots
      .flatMap((root) =>
        [...root.querySelectorAll<HTMLAnchorElement>("a[href]")]
          .filter(visible)
          .map((anchor) => neweggItemIdFromUrl(anchor.href)),
      )
      .filter(Boolean),
  );
  if (scopedIds.size !== new Set(items.map((item) => item.itemId)).size) complete = false;
  result.cart = {
    items,
    itemCount: counts.length === 1 ? counts[0]! : null,
    subtotalMinor: subtotal?.minor ?? null,
    currency: subtotal?.currency ?? null,
    rowCoverageComplete: complete,
  };
  return result;
}

export interface BrowserObserverDescriptor {
  profileName: string;
  profileDirectory: string;
  browserPid: number;
  endpoint: string;
}

export function parseObserverDescriptor(
  value: unknown,
  profileName: string,
): BrowserObserverDescriptor {
  const row = value as Partial<BrowserObserverDescriptor> | null;
  if (
    !row ||
    row.profileName !== profileName ||
    typeof row.profileDirectory !== "string" ||
    !row.profileDirectory.startsWith("/") ||
    !Number.isSafeInteger(row.browserPid) ||
    Number(row.browserPid) < 1 ||
    typeof row.endpoint !== "string"
  )
    throw new Error("Observer descriptor does not identify this isolated run.");
  const endpoint = assertLoopbackUrl(row.endpoint, "http:");
  if (endpoint.search || endpoint.pathname !== "/" || !endpoint.port)
    throw new Error("Observer descriptor needs an exact loopback CDP origin.");
  return {
    profileName,
    profileDirectory: row.profileDirectory,
    browserPid: Number(row.browserPid),
    endpoint: endpoint.origin,
  };
}

const readSmallJson = async (path: string) => {
  if ((await stat(path)).size > 8192) throw new Error("Observer descriptor is too large.");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
};

function readOnlyCdp(endpoint: string) {
  const socket = new WebSocket(assertLoopbackUrl(endpoint, "ws:"));
  let sequence = 0;
  const pending = new Map<number, { resolve: (result: unknown) => void; reject: () => void }>();
  const opened = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      socket.close();
      resolve(false);
    }, 3000);
    const settle = (ok: boolean) => {
      clearTimeout(timer);
      resolve(ok);
    };
    socket.addEventListener("open", () => settle(true), { once: true });
    socket.addEventListener("error", () => settle(false), { once: true });
    socket.addEventListener("close", () => settle(false), { once: true });
  });
  const rejectPending = () => {
    for (const request of pending.values()) request.reject();
    pending.clear();
  };
  socket.addEventListener("close", rejectPending);
  socket.addEventListener("error", rejectPending);
  socket.addEventListener("message", (event) => {
    try {
      const data = String(event.data);
      if (data.length > 1_048_576) throw new Error("Observer response too large");
      const message = JSON.parse(data);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject();
      else request.resolve(message.result);
    } catch {
      rejectPending();
    }
  });
  return {
    async read(expression: string): Promise<unknown> {
      if (!(await opened) || socket.readyState !== WebSocket.OPEN)
        throw new Error("Observer connection unavailable");
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Observer read timed out"));
        }, 3000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: () => {
            clearTimeout(timeout);
            reject(new Error("Observer read failed"));
          },
        });
        socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true },
          }),
        );
      });
    },
    close() {
      rejectPending();
      socket.close();
    },
  };
}

async function boundedResponseJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("Observer request failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error("Observer response exceeded its bound");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function verifyDescriptor(
  descriptor: BrowserObserverDescriptor,
  profileRoot: string,
  startedAtMs: number,
) {
  const expected = await realpath(join(profileRoot, descriptor.profileName));
  if (expected !== (await realpath(descriptor.profileDirectory)))
    throw new Error("Observer profile mismatch");
  const activePort = join(expected, "DevToolsActivePort");
  const info = await stat(activePort);
  if (info.size > 4096 || info.mtimeMs < startedAtMs)
    throw new Error("Observer profile is not fresh");
  const lines = (await readFile(activePort, "utf8")).trim().split(/\r?\n/);
  const endpoint = new URL(descriptor.endpoint);
  if (lines[0] !== endpoint.port || !lines[1]?.startsWith("/devtools/browser/"))
    throw new Error("Observer endpoint does not belong to the named profile");
  const args = execFileSync("/bin/ps", ["-p", String(descriptor.browserPid), "-o", "args="], {
    encoding: "utf8",
    maxBuffer: 16_384,
    timeout: 2000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const profileFlag = `--user-data-dir=${expected}`;
  if (
    !/\/(?:Google Chrome|Chromium)(?:\s|$)/.test(args) ||
    !args.includes(profileFlag) ||
    ![" ", "\n", ""].includes(args.charAt(args.indexOf(profileFlag) + profileFlag.length))
  )
    throw new Error("Observer PID does not belong to the named Chrome profile");
  const listeners = execFileSync(
    "/usr/sbin/lsof",
    [
      "-nP",
      "-a",
      "-p",
      String(descriptor.browserPid),
      `-iTCP:${endpoint.port}`,
      "-sTCP:LISTEN",
      "-Fpn",
    ],
    {
      encoding: "utf8",
      maxBuffer: 8192,
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (
    !listeners
      .split("\n")
      .some((line) => line === `n127.0.0.1:${endpoint.port}` || line === `n[::1]:${endpoint.port}`)
  )
    throw new Error("Observer listener ownership was not verified");
}

/** Public GitHub data only; no auth header, account cookie, or private-repo fallback. */
export async function readGitHubReference(repo: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  const pages = [];
  try {
    for (const page of [1, 2]) {
      const response = await fetch(
        `https://api.github.com/repos/${repo}/pulls?state=open&sort=created&direction=desc&per_page=25&page=${page}`,
        {
          headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        },
      );
      if (!response.ok) return null;
      const values = parsePullRequestTitles(await boundedResponseJson(response, 4_194_304));
      if (!values || values.length > 25) return null;
      pages.push(values);
    }
    return pages;
  } catch {
    return null;
  }
}

export function createBrowserObserver(input: {
  descriptorPath: string;
  profileRoot: string;
  profileName: string;
  startedAtMs: number;
  task: BrowserBenchmarkTask;
  repo?: string;
}) {
  const witnesses: BrowserWitness[] = [];
  const issues = new Set<string>();
  const connections = new Map<string, ReturnType<typeof readOnlyCdp>>();
  let descriptorKey = "";
  let connectionsChanged = 0;
  let successfulReads = 0;
  const neweggEvidence: NeweggRunEvidence = { products: [], carts: [] };
  const close = () => {
    for (const connection of connections.values()) connection.close();
    connections.clear();
  };
  const capture = async () => {
    try {
      const descriptor = parseObserverDescriptor(
        await readSmallJson(input.descriptorPath),
        input.profileName,
      );
      const key = JSON.stringify(descriptor);
      if (key !== descriptorKey) {
        await verifyDescriptor(descriptor, input.profileRoot, input.startedAtMs);
        close();
        if (descriptorKey) connectionsChanged++;
        descriptorKey = key;
      }
      const response = await fetch(`${descriptor.endpoint}/json/list`, {
        signal: AbortSignal.timeout(2000),
        redirect: "error",
      });
      const targets = await boundedResponseJson(response, 262_144);
      if (!response.ok || !Array.isArray(targets) || targets.length > 100)
        throw new Error("Invalid targets");
      const candidates = targets
        .filter((target) => {
          if (
            target?.type !== "page" ||
            typeof target.url !== "string" ||
            typeof target.id !== "string" ||
            typeof target.webSocketDebuggerUrl !== "string"
          )
            return false;
          const url = new URL(target.url);
          return input.task === "github-isolated"
            ? url.origin === "https://github.com" && url.pathname === `/${input.repo}/pulls`
            : url.protocol === "https:" &&
                (url.hostname === "newegg.com" || url.hostname.endsWith(".newegg.com")) &&
                !/account|signin|login|password|address|orderhistory/i.test(url.pathname);
        })
        .sort((a, b) => {
          const priority = (url: string) =>
            /checkout|payment|placeorder/i.test(new URL(url).pathname)
              ? 0
              : /\/cart(?:\/|$)/i.test(new URL(url).pathname)
                ? 1
                : neweggItemIdFromUrl(url)
                  ? 2
                  : 3;
          return priority(a.url) - priority(b.url);
        })
        .slice(0, 4);
      const activeIds = new Set(candidates.map((target) => target.id));
      for (const [id, connection] of connections)
        if (!activeIds.has(id)) {
          connection.close();
          connections.delete(id);
        }
      for (const target of candidates) {
        const endpoint = assertLoopbackUrl(target.webSocketDebuggerUrl, "ws:");
        if (
          endpoint.port !== new URL(descriptor.endpoint).port ||
          !endpoint.pathname.startsWith("/devtools/page/") ||
          endpoint.search
        )
          throw new Error("Wrong target endpoint");
        let connection = connections.get(target.id);
        if (!connection) {
          connection = readOnlyCdp(endpoint.toString());
          connections.set(target.id, connection);
        }
        const repositoryPath = input.repo ? `/${input.repo}/pull/` : "";
        const expression = `(() => {
          const parseNeweggPrice = ${parseNeweggPrice.toString()};
          const neweggItemIdFromUrl = ${neweggItemIdFromUrl.toString()};
          const u = new URL(location.href);
          const allowed = ${JSON.stringify(input.task)} === "github-isolated"
            ? u.origin === "https://github.com" && u.pathname === ${JSON.stringify(`/${input.repo}/pulls`)}
            : u.protocol === "https:" && (u.hostname === "newegg.com" || u.hostname.endsWith(".newegg.com"));
          if (!allowed || document.readyState !== "complete") return null;
          if (/checkout|payment|placeorder/i.test(u.pathname)) return {page:1,path:u.pathname,prs:[],cartVisible:false,productPaths:[],checkoutVisible:true};
          const prs = new Map(); const products = new Set();
          for (const a of document.querySelectorAll("a[href]")) {
            const href = new URL(a.href, location.href);
            if (${JSON.stringify(input.task)} === "github-isolated" && href.origin === u.origin &&
              href.pathname.startsWith(${JSON.stringify(repositoryPath)})) {
              const rest = href.pathname.slice(${repositoryPath.length});
              const title = a.textContent.replace(/\\s+/g, " ").trim();
              if (/^\\d+$/.test(rest) && title && !/^#?\\d+$/.test(title)) prs.set(Number(rest), {number:Number(rest),title:title.slice(0,1024)});
            }
            const productId = neweggItemIdFromUrl(href.href);
            if (productId) products.add("/p/" + productId);
          }
          return { page: Number(u.searchParams.get("page") || 1), path:u.pathname,
            prs:[...prs.values()].slice(0,100), cartVisible:/\\/cart(?:\\/|$)/i.test(u.pathname),
            productPaths:[...products].slice(0,32), checkoutVisible:/checkout|payment|placeorder/i.test(u.pathname),
            ...(${JSON.stringify(input.task)} === "newegg" ? {newegg:(${readNeweggPageDom.toString()})()} : {}) };
        })()`;
        const result = (await connection.read(expression)) as { result?: { value?: unknown } };
        const value = parseBrowserWitness(result.result?.value);
        if (!value) continue;
        successfulReads++;
        if (value.newegg?.product) {
          const product = value.newegg.product;
          const index = neweggEvidence.products.findIndex(
            (entry) => entry.itemId === product.itemId,
          );
          if (index >= 0) {
            const previous = neweggEvidence.products[index]!;
            neweggEvidence.products[index] = {
              ...product,
              breadcrumbs: [...new Set([...previous.breadcrumbs, ...product.breadcrumbs])].slice(
                0,
                16,
              ),
              facts: [
                ...new Map(
                  [...previous.facts, ...product.facts].map((fact) => [JSON.stringify(fact), fact]),
                ).values(),
              ].slice(0, 48),
            };
          } else if (neweggEvidence.products.length < 32) neweggEvidence.products.push(product);
        }
        if (value.newegg?.cart) {
          neweggEvidence.carts.push({ cart: value.newegg.cart, observedAtMs: Date.now() });
          if (neweggEvidence.carts.length > 8) neweggEvidence.carts.shift();
        }
        if (!witnesses.some((prior) => JSON.stringify(prior) === JSON.stringify(value))) {
          witnesses.push(value);
          if (witnesses.length > 32) witnesses.shift();
        }
      }
    } catch {
      issues.add("observer-descriptor-or-page-unavailable");
      // Revalidate ownership before reconnecting even when PID/port are reused.
      descriptorKey = "";
      close();
    }
  };
  return {
    capture,
    close,
    witnesses,
    neweggEvidence,
    report: () => ({
      successfulReads,
      connectionsChanged,
      issues: [...issues],
      witnesses,
      ...(input.task === "newegg" ? { newegg: neweggEvidence } : {}),
    }),
  };
}
