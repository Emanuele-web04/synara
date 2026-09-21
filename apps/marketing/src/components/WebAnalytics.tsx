import Script from "next/script";

// replaces @vercel/analytics which silently collected nothing once the site left Vercel; token presence is the switch so previews can opt in and dev/tests stay quiet; VISUAL_TEST forces it off; cookie-free per /privacy
export function WebAnalytics() {
  const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN;
  if (!token || process.env.VISUAL_TEST === "1") return null;

  return (
    <Script
      // afterInteractive, not beforeInteractive — analytics must never sit on the critical path of a perf-gated page
      strategy="afterInteractive"
      src="https://static.cloudflareinsights.com/beacon.min.js"
      data-cf-beacon={JSON.stringify({ token })}
    />
  );
}
