import { buildLlmsFullTxt } from "@/lib/llmText";

export const revalidate = false;

export async function GET() {
  return new Response(`${await buildLlmsFullTxt()}\n`, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
