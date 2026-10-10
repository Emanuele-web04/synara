export const PDF_PAGE_MARGIN_PX = 24;

export const PDF_MIN_SCALE = 0.25;
export const PDF_MAX_SCALE = 5;

export const PDF_ZOOM_PRESETS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export type PdfZoomMode =
  | { readonly type: "fit-width" }
  | { readonly type: "fit-page" }
  | { readonly type: "custom"; readonly scale: number };

export interface PdfPageIntrinsicSize {
  readonly width: number;
  readonly height: number;
}

export interface PdfViewportSize {
  readonly width: number;
  readonly height: number;
}

export function clampPdfScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) {
    return 1;
  }
  return Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, scale));
}

function fitWidthScale(page: PdfPageIntrinsicSize, container: PdfViewportSize): number {
  const usable = container.width - PDF_PAGE_MARGIN_PX * 2;
  if (usable <= 0 || page.width <= 0) {
    return 1;
  }
  return clampPdfScale(usable / page.width);
}

function fitPageScale(page: PdfPageIntrinsicSize, container: PdfViewportSize): number {
  const usableHeight = container.height - PDF_PAGE_MARGIN_PX * 2;
  if (usableHeight <= 0 || page.height <= 0) {
    return fitWidthScale(page, container);
  }
  return clampPdfScale(Math.min(fitWidthScale(page, container), usableHeight / page.height));
}

export function resolvePdfScale(
  mode: PdfZoomMode,
  page: PdfPageIntrinsicSize | null,
  container: PdfViewportSize | null,
): number {
  if (mode.type === "custom") {
    return clampPdfScale(mode.scale);
  }
  if (!page || !container) {
    return 1;
  }
  return mode.type === "fit-page" ? fitPageScale(page, container) : fitWidthScale(page, container);
}

export function nextZoomScale(scale: number): number {
  for (const preset of PDF_ZOOM_PRESETS) {
    if (preset > scale + 0.001) {
      return clampPdfScale(preset);
    }
  }
  return clampPdfScale(PDF_MAX_SCALE);
}

export function previousZoomScale(scale: number): number {
  for (let index = PDF_ZOOM_PRESETS.length - 1; index >= 0; index -= 1) {
    const preset = PDF_ZOOM_PRESETS[index];
    if (preset !== undefined && preset < scale - 0.001) {
      return clampPdfScale(preset);
    }
  }
  return clampPdfScale(PDF_MIN_SCALE);
}

export function formatZoomPercent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
