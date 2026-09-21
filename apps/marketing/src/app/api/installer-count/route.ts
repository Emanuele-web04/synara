import { NextResponse } from "next/server";

import { getInstallerCount } from "@/lib/installerCount";

// the homepage mounts InstallerCount twice, each polling every 30s — uncached, every poll hit a function + GitHub call; a 60s cache makes polls free CDN hits
export const revalidate = 60;

export async function GET() {
  const count = await getInstallerCount();

  if (count === null) {
    return NextResponse.json(
      { error: "Unable to fetch installer count." },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  }

  return NextResponse.json(
    { count },
    {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    },
  );
}
