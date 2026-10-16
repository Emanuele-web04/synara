// FILE: ConnectorIcon.tsx
// Purpose: The icon of a connector everywhere it appears (Settings, the connect dialog, the
//   composer menu, `@` chips, sent messages): the vendor mark in its brand color for catalog
//   connectors, the site favicon for custom servers, and the MCP mark otherwise.
// Layer: UI shared component/helper
// Exports: ConnectorIcon, createConnectorIconElement

import { defaultMcpConnectorName, MCP_CONNECTOR_PRESETS } from "@synara/shared/mcpConnectors";
import { renderToStaticMarkup } from "react-dom/server";

import {
  type BrandArtwork,
  KNOWN_BRAND_ARTWORK,
  normalizeBrandKey,
  readableBrandColor,
} from "~/lib/brandIcons";
import { probeSiteFavicon, resolveSiteFaviconUrl, siteFaviconStatusCache } from "~/lib/siteFavicon";

import { SiteFavicon } from "./SiteFavicon";

const MCP_ARTWORK = KNOWN_BRAND_ARTWORK.modelcontextprotocol!;

function connectorBrand(name: string): BrandArtwork | undefined {
  return KNOWN_BRAND_ARTWORK[normalizeBrandKey(name)];
}

/** Whether `name` (a connector or MCP server name) maps to a known vendor mark. */
export function hasConnectorBrand(name: string): boolean {
  return connectorBrand(name) !== undefined;
}

// The site to ask the favicon proxy about: the server URL's host without
// `mcp.`/`api.`/`www.` when known, else the name of a custom connector, which
// defaults to that same host (`superx.so`). Chips only carry the name.
function connectorSiteHost(name: string, url?: string | null): string | null {
  // Catalog connectors without a vendor mark (WorkOS) use their server's site,
  // even where only the name is known (chips, tool rows).
  url ??= MCP_CONNECTOR_PRESETS.find(
    (preset) => normalizeBrandKey(preset.name) === normalizeBrandKey(name),
  )?.url;
  if (url) {
    try {
      return defaultMcpConnectorName(url);
    } catch {
      // Fall through to the name.
    }
  }
  const trimmed = name.trim().toLowerCase();
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(trimmed) ? trimmed : null;
}

function BrandGlyph(props: { artwork: BrandArtwork; className?: string | undefined }) {
  const Icon = props.artwork.icon;
  // Near-black marks (Notion, Vercel) follow the text color instead of vanishing.
  const color = readableBrandColor(props.artwork.color) ?? "var(--foreground)";
  return <Icon aria-hidden="true" className={props.className} style={{ color }} />;
}

export function ConnectorIcon(props: {
  name: string;
  /** The server URL, when known; picks the favicon of a custom server. */
  url?: string | null | undefined;
  className?: string | undefined;
}) {
  const brand = connectorBrand(props.name);
  if (brand) return <BrandGlyph artwork={brand} className={props.className} />;
  const fallback = <BrandGlyph artwork={MCP_ARTWORK} className={props.className} />;
  const host = connectorSiteHost(props.name, props.url);
  return host ? (
    <SiteFavicon url={host} className={props.className} fallback={fallback} />
  ) : (
    fallback
  );
}

/** Lexical composer chips build their DOM imperatively; same icon choice as above. */
export function createConnectorIconElement(name: string, className: string): HTMLElement {
  const host = document.createElement("span");
  host.className = className;
  host.ariaHidden = "true";
  const brand = connectorBrand(name);
  const renderBrand = (artwork: BrandArtwork) => {
    host.innerHTML = renderToStaticMarkup(<BrandGlyph artwork={artwork} className="size-full" />);
  };
  if (brand) {
    renderBrand(brand);
    return host;
  }
  const site = connectorSiteHost(name);
  if (!site) {
    renderBrand(MCP_ARTWORK);
    return host;
  }
  // Same shared probe and status cache as SiteFavicon: one load per host, and
  // no broken image while it is unknown or after it failed.
  const src = resolveSiteFaviconUrl(site);
  const showFavicon = () => {
    const image = document.createElement("img");
    image.alt = "";
    image.className = "size-full rounded-[2px] object-contain";
    image.src = src;
    host.replaceChildren(image);
  };
  const status = siteFaviconStatusCache.get(src);
  if (status === "ok") {
    showFavicon();
    return host;
  }
  renderBrand(MCP_ARTWORK);
  if (status === undefined) {
    void probeSiteFavicon(src).then((result) => {
      if (result === "ok") showFavicon();
    });
  }
  return host;
}
