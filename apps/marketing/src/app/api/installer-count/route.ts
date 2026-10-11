// FILE: route.ts
// Purpose: Exposes the live installer total to the client as a CDN-cached JSON response.
// Layer: App Router route handler
// Depends on: getInstallerCount server utility

import { NextResponse } from "next/server";

import { getInstallerCount } from "@/lib/installerCount";

// The installer total is a once-a-day number: the count itself is cached for a
// day in getInstallerCount and the homepage no longer polls this route, so the
// CDN can hold the response for a day as well.
const ONE_DAY_SECONDS = 24 * 60 * 60;
export const revalidate = 86400;

// Returns the current installer total.
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
        "Cache-Control": `public, s-maxage=${ONE_DAY_SECONDS}, stale-while-revalidate=${ONE_DAY_SECONDS}`,
      },
    },
  );
}
