// FILE: share/[format]/route.tsx
// Purpose: The profile's share images, drawn with next/og: `poster` (a 4:5 feed post: the
// lifetime token count large, one sentence, the trailing month as a line), `story` (a 9:16
// receipt of the profile) and `card` (the link preview, the same image as the social
// preview). Unknown and private handles 404, like the page.
// Layer: profiles app route.

import { ImageResponse } from "next/og";
import { SYNARA_LOGO_PATHS } from "@synara/profile-ui/logo";
import { handleFromParam } from "../../../../lib/handleParam";
import { drawableAvatar } from "../../../../lib/imageAvatar";
import { imageFonts } from "../../../../lib/imageFonts";
import { fetchPublicProfile, type PublicProfile } from "../../../../lib/publicProfile";
import {
  isShareFormat,
  linePath,
  posterSentence,
  SHARE_SIZES,
  type ShareCardData,
  shareCardData,
} from "../../../../lib/shareCards";
import OgImage from "../../opengraph-image";

type Params = { params: Promise<{ handle: string; format: string }> };

const PAPER = "#f6f4ef";
const INK = "#1a1917";
const MUTED = "#6f6b62";

export async function GET(request: Request, { params }: Params) {
  const { handle: rawHandle, format: rawFormat } = await params;
  const format = rawFormat.replace(/\.png$/u, "");
  const handle = handleFromParam(rawHandle);
  if (!handle || !isShareFormat(format)) return new Response("Not found", { status: 404 });
  if (format === "card") return OgImage({ params: Promise.resolve({ handle: rawHandle }) });

  const profile = await fetchPublicProfile(handle).catch(() => null);
  if (!profile) return new Response("Not found", { status: 404 });
  const appearance =
    new URL(request.url).searchParams.get("appearance") === "dark" ? "dark" : "light";
  const data = shareCardData(profile, appearance);
  const [avatar, fonts] = await Promise.all([
    drawableAvatar(profile.avatarUrl),
    imageFonts(
      format === "poster"
        ? [
            { family: "Instrument Serif", weights: [400] },
            { family: "Geist", weights: [400, 600] },
          ]
        : [{ family: "JetBrains Mono", weights: [400, 700] }],
    ),
  ]);
  return new ImageResponse(
    format === "poster" ? (
      <Poster profile={profile} data={data} avatar={avatar} />
    ) : (
      <Receipt profile={profile} data={data} />
    ),
    {
      ...SHARE_SIZES[format],
      fonts,
      headers: {
        // Publication can be revoked at any time, like the page and its preview.
        "Cache-Control": "private, no-store",
        "Content-Disposition": `inline; filename="synara-${profile.handle}-${format}.png"`,
      },
    },
  );
}

function SynaraMark({ edge, color }: { edge: number; color: string }) {
  return (
    <svg viewBox="0 0 470 504" width={edge} height={Math.round(edge * (504 / 470))} fill="none">
      {SYNARA_LOGO_PATHS.map((path) => (
        <path key={path} d={path} fill={color} />
      ))}
    </svg>
  );
}

function Avatar({
  profile,
  avatar,
  edge,
  accent,
}: {
  profile: PublicProfile;
  /** A drawable data URL from drawableAvatar, or null for the initial. */
  avatar: string | null;
  edge: number;
  accent: string;
}) {
  if (avatar) {
    return (
      <img
        src={avatar}
        width={edge}
        height={edge}
        style={{ borderRadius: 9999, objectFit: "cover" }}
      />
    );
  }
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: edge,
        height: edge,
        borderRadius: 9999,
        backgroundColor: accent,
        color: "#ffffff",
        fontSize: Math.round(edge * 0.42),
      }}
    >
      {profile.displayName.trim().charAt(0).toUpperCase()}
    </div>
  );
}

// ── Poster (4:5) ───────────────────────────────────────────────────────

const POSTER_CHART = { width: 888, height: 170 };

function Poster({
  profile,
  data,
  avatar,
}: {
  profile: PublicProfile;
  data: ShareCardData;
  avatar: string | null;
}) {
  const line = linePath(
    data.month.map((point) => point.tokens),
    POSTER_CHART.width,
    POSTER_CHART.height,
  );
  const area = `${line} L${POSTER_CHART.width},${POSTER_CHART.height} L0,${POSTER_CHART.height} Z`;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "88px 96px",
        backgroundColor: PAPER,
        color: INK,
        fontFamily: "Geist",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 26 }}>
        <Avatar profile={profile} avatar={avatar} edge={52} accent={data.accent} />
        <span style={{ display: "flex" }}>@{profile.handle}</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <span style={{ fontSize: 26, color: MUTED }}>Tokens written with agents</span>
        <span
          style={{
            fontFamily: "Instrument Serif",
            fontSize: 300,
            lineHeight: 0.8,
            letterSpacing: "-0.03em",
          }}
        >
          {data.totalTokens}
        </span>
        <span
          style={{
            marginTop: 16,
            maxWidth: 820,
            fontFamily: "Instrument Serif",
            fontSize: 48,
            lineHeight: 1.15,
            color: "#3b3934",
          }}
        >
          {posterSentence(data)}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <svg
          width={POSTER_CHART.width}
          height={POSTER_CHART.height}
          viewBox={`0 0 ${POSTER_CHART.width} ${POSTER_CHART.height}`}
        >
          <path d={area} fill={data.accent} fillOpacity={0.12} />
          <path d={line} fill="none" stroke={data.accent} strokeWidth={3} strokeLinejoin="round" />
        </svg>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            paddingTop: 14,
            borderTop: `2px solid ${INK}`,
            fontSize: 22,
            color: MUTED,
          }}
        >
          <span>Last 30 days</span>
          <span>{data.currentStreak > 0 ? `${data.currentStreak}-day streak` : " "}</span>
          <span>{data.peakDay ? `peak ${data.peakDay}` : " "}</span>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 22,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <SynaraMark edge={30} color={INK} />
          <span>Synara</span>
        </div>
        <span style={{ color: MUTED }}>trysynara.com/@{profile.handle}</span>
      </div>
    </div>
  );
}

// ── Story receipt (9:16) ───────────────────────────────────────────────

const RECEIPT_RULE = "2px dashed #c4c4bf";

function Receipt({ profile, data }: { profile: PublicProfile; data: ShareCardData }) {
  const maxHour = Math.max(1, ...data.hours);
  const maxDay = Math.max(1, ...data.month.map((point) => point.tokens));
  const lines: [string, string][] = [
    ["PROMPTS", data.prompts.toLocaleString("en-US")],
    ["ACTIVE DAYS", data.activeDays.toLocaleString("en-US")],
    ["PEAK DAY", data.peakDay ?? "—"],
    ["BUSIEST HOUR", data.busiestHour ?? "—"],
    ["STREAK", data.currentStreak > 0 ? `${data.currentStreak} DAYS` : "—"],
  ];
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#e3e1dc",
        color: "#1c1c1a",
        fontFamily: "JetBrains Mono",
      }}
    >
      <div
        style={{
          width: 680,
          display: "flex",
          flexDirection: "column",
          gap: 34,
          padding: "60px 56px 64px",
          backgroundColor: "#fdfdfb",
          fontSize: 24,
          boxShadow: "0 40px 80px -40px rgba(0,0,0,0.35)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <SynaraMark edge={44} color="#1c1c1a" />
          <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: "0.14em" }}>SYNARA</span>
          <span style={{ color: "#7a7a75" }}>@{profile.handle}</span>
        </div>

        <div style={{ display: "flex", borderTop: RECEIPT_RULE }} />

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {lines.map(([label, value]) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{label}</span>
              <span>{value}</span>
            </div>
          ))}
        </div>

        {data.models.length > 0 ? (
          <div style={{ display: "flex", borderTop: RECEIPT_RULE }} />
        ) : null}
        {data.models.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <span style={{ color: "#7a7a75" }}>ITEMS</span>
            {data.models.map((model) => (
              <div key={model.name} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>
                    {model.turns.toLocaleString("en-US")} × {model.name}
                  </span>
                  <span>{model.tokens}</span>
                </div>
                <div style={{ display: "flex", height: 6, backgroundColor: "#efefec" }}>
                  <div
                    style={{
                      width: `${Math.max(1, Math.round(model.relative * 100))}%`,
                      height: 6,
                      backgroundColor: data.accent,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ display: "flex", borderTop: RECEIPT_RULE }} />

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={{ color: "#7a7a75" }}>PROMPTS BY HOUR</span>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 5, height: 88 }}>
            {data.hours.map((prompts, hour) => (
              <div
                // The hour itself, not a list position: the 24 slots never reorder.
                // oxlint-disable-next-line react/no-array-index-key
                key={hour}
                style={{
                  flex: 1,
                  height: Math.max(3, Math.round((prompts / maxHour) * 88)),
                  backgroundColor:
                    prompts === maxHour && prompts > 0
                      ? data.accent
                      : prompts > 0
                        ? "#1c1c1a"
                        : "#e2e2de",
                }}
              />
            ))}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 18,
              color: "#7a7a75",
            }}
          >
            <span>00</span>
            <span>06</span>
            <span>12</span>
            <span>18</span>
            <span>23</span>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "16px 0",
            borderTop: "2px solid #1c1c1a",
            borderBottom: "2px solid #1c1c1a",
            fontSize: 30,
            fontWeight: 700,
          }}
        >
          <span>TOTAL</span>
          <span>{data.totalTokensExact} TOK</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          {/* The last 30 days as a barcode: one bar per day, wider on busier days. */}
          <div style={{ display: "flex", alignItems: "stretch", gap: 3, height: 72 }}>
            {data.month.map(({ day, tokens }) => (
              <div
                key={day}
                style={{
                  width: tokens > 0 ? 3 + Math.round((tokens / maxDay) * 9) : 2,
                  backgroundColor: tokens === maxDay && tokens > 0 ? data.accent : "#1c1c1a",
                }}
              />
            ))}
          </div>
          <span style={{ fontSize: 18, color: "#7a7a75" }}>LAST 30 DAYS, ONE BAR PER DAY</span>
          <span style={{ fontSize: 20 }}>trysynara.com/@{profile.handle}</span>
        </div>
      </div>
    </div>
  );
}
