// Fonts for the share images. next/og ships only Geist Regular; the poster sets its number
// and sentence in Instrument Serif and the receipt is monospaced, so those load from Google
// Fonts as TTF (the format next/og reads) and stay cached for the isolate's lifetime. A
// failed load falls back to the default font rather than failing the image.

export type ImageFont = {
  name: string;
  data: ArrayBuffer;
  weight: 300 | 400 | 500 | 600 | 700;
  style: "normal";
};

type FontRequest = { family: string; weights: readonly ImageFont["weight"][] };

const cache = new Map<string, Promise<ImageFont[]>>();

/** `font-weight: 400; … src: url(…ttf)` pairs out of a Google Fonts css2 stylesheet. */
export function parseFontFaces(css: string): { weight: number; url: string }[] {
  const faces: { weight: number; url: string }[] = [];
  for (const block of css.split("@font-face").slice(1)) {
    const weight = /font-weight:\s*(\d+)/u.exec(block)?.[1];
    const url = /src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/u.exec(block)?.[1];
    if (weight && url) faces.push({ weight: Number(weight), url });
  }
  return faces;
}

async function load({ family, weights }: FontRequest): Promise<ImageFont[]> {
  const query = `${family.replaceAll(" ", "+")}:wght@${weights.join(";")}`;
  // No browser user agent: css2 then answers with TTF sources.
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${query}`)).text();
  return Promise.all(
    parseFontFaces(css)
      .filter((face) => (weights as readonly number[]).includes(face.weight))
      .map(async (face) => ({
        name: family,
        data: await (await fetch(face.url)).arrayBuffer(),
        weight: face.weight as ImageFont["weight"],
        style: "normal" as const,
      })),
  );
}

export async function imageFonts(requests: readonly FontRequest[]): Promise<ImageFont[]> {
  const loaded = await Promise.all(
    requests.map((request) => {
      const key = `${request.family}:${request.weights.join(",")}`;
      let pending = cache.get(key);
      if (!pending) {
        pending = load(request).catch(() => {
          cache.delete(key);
          return [];
        });
        cache.set(key, pending);
      }
      return pending;
    }),
  );
  return loaded.flat();
}
