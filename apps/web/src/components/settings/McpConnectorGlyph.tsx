// FILE: McpConnectorGlyph.tsx
// Purpose: A connector's icon framed in the catalog tile, plus the brand artwork lookup the
//   connect dialog uses for its glow.
// Layer: Settings UI components
// Exports: mcpConnectorArtwork, McpConnectorGlyph

import { ConnectorIcon } from "~/components/ConnectorIcon";
import {
  BRAND_GLYPH_TILE_CLASS_NAME,
  type BrandArtwork,
  KNOWN_BRAND_ARTWORK,
} from "~/lib/brandIcons";
import { cn } from "~/lib/utils";

const MCP_ARTWORK = KNOWN_BRAND_ARTWORK.modelcontextprotocol!;

export function mcpConnectorArtwork(presetId: string | null): BrandArtwork {
  return (presetId ? KNOWN_BRAND_ARTWORK[presetId] : undefined) ?? MCP_ARTWORK;
}

export function McpConnectorGlyph(props: {
  name: string;
  url?: string | undefined;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span aria-hidden="true" className={cn(BRAND_GLYPH_TILE_CLASS_NAME, props.className)}>
      <ConnectorIcon
        name={props.name}
        url={props.url}
        className={cn("size-5", props.iconClassName)}
      />
    </span>
  );
}
