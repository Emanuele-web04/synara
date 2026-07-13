import { chromium } from "playwright";

const DEFAULT_URL = "http://127.0.0.1:4173/";
const DEFAULT_SETTLE_MS = 20_000;

function parseArguments(argv) {
  const options = {
    url: DEFAULT_URL,
    settleMs: DEFAULT_SETTLE_MS,
    headed: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--headed") {
      options.headed = true;
      continue;
    }
    if (argument === "--wait-ms") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error("--wait-ms must be followed by a non-negative number");
      }
      options.settleMs = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    }
    options.url = argument;
  }

  return options;
}

const options = parseArguments(process.argv.slice(2));
const browser = await chromium.launch({ headed: options.headed });

try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__synaraLcpAudit = {
      largestContentfulPaint: [],
      longTasks: [],
    };

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const element = entry.element;
        window.__synaraLcpAudit.largestContentfulPaint.push({
          startTime: entry.startTime,
          renderTime: entry.renderTime,
          loadTime: entry.loadTime,
          size: entry.size,
          tagName: element?.tagName ?? null,
          className: typeof element?.className === "string" ? element.className : null,
          text: element?.textContent?.trim().replace(/\s+/g, " ").slice(0, 240) ?? null,
          url: entry.url || null,
        });
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__synaraLcpAudit.longTasks.push({
          startTime: entry.startTime,
          duration: entry.duration,
          name: entry.name,
        });
      }
    }).observe({ type: "longtask", buffered: true });
  });

  const startedAt = performance.now();
  await page.goto(options.url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(options.settleMs);

  const result = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const audit = window.__synaraLcpAudit;
    const finalLcp = audit.largestContentfulPaint.at(-1) ?? null;
    const longTasks = audit.longTasks;

    return {
      url: window.location.href,
      title: document.title,
      lcp: finalLcp,
      lcpCandidates: audit.largestContentfulPaint,
      navigation: navigation
        ? {
            timeToFirstByte: navigation.responseStart - navigation.startTime,
            responseStart: navigation.responseStart,
            domContentLoaded: navigation.domContentLoadedEventEnd,
            loadEventEnd: navigation.loadEventEnd,
          }
        : null,
      longTasks: {
        count: longTasks.length,
        totalDuration: longTasks.reduce((total, entry) => total + entry.duration, 0),
        entries: longTasks,
      },
    };
  });

  console.log(
    JSON.stringify(
      {
        ...result,
        measurementDuration: performance.now() - startedAt,
        settleMs: options.settleMs,
      },
      null,
      2,
    ),
  );

  if (!result.lcp) {
    process.exitCode = 2;
  }
} finally {
  await browser.close();
}
