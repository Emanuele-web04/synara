import type { Page } from "@playwright/test";

const FREEZE_MOTION = `
  *, *::before, *::after {
    animation-delay: 0s !important;
    animation-duration: 0s !important;
    animation-iteration-count: 1 !important;
    transition-delay: 0s !important;
    transition-duration: 0s !important;
    scroll-behavior: auto !important;
  }
`;

export async function preparePage(page: Page, theme: "light" | "dark") {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate((selectedTheme) => {
    document.documentElement.classList.toggle("dark", selectedTheme === "dark");
    localStorage.setItem("synara-theme", selectedTheme);
  }, theme);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addStyleTag({ content: FREEZE_MOTION });
  await waitForImages(page);
  await page.evaluate(() => document.fonts.ready);
}

export async function prepareRoute(page: Page, pathname: string, theme: "light" | "dark") {
  await page.goto(pathname, { waitUntil: "domcontentloaded" });
  await page.evaluate((selectedTheme) => {
    document.documentElement.classList.toggle("dark", selectedTheme === "dark");
    localStorage.setItem("synara-theme", selectedTheme);
  }, theme);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addStyleTag({ content: FREEZE_MOTION });
  await waitForImages(page);
  await page.evaluate(() => document.fonts.ready);
}

export async function waitForImages(page: Page) {
  await page.evaluate(async () => {
    const renderedImages = [...document.images].filter(
      (image) => image.getClientRects().length > 0,
    );
    for (const image of renderedImages) {
      image.scrollIntoView({ block: "center", inline: "nearest" });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForFunction(
    () =>
      [...document.images]
        .filter((image) => image.getClientRects().length > 0)
        .every((image) => image.complete && image.naturalWidth > 0),
    undefined,
    { timeout: 30_000 },
  );
  const incomplete = await page.evaluate(
    () =>
      [...document.images].filter(
        (image) =>
          image.getClientRects().length > 0 && (!image.complete || image.naturalWidth === 0),
      ).length,
  );
  if (incomplete !== 0) {
    throw new Error(`Found ${incomplete} incomplete rendered images`);
  }
}
