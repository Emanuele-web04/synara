// FILE: spaceIconSuggestion.ts
// Purpose: Picks a Space icon from the name the user is typing, so creation is one field.
// Layer: Web presentation utility
// Why: The icon grid made "make a space" a two-decision dialog. The name already says
//      what the space is about; matching it to the curated set (with a stable fallback
//      so the same name always lands on the same icon) removes the second decision
//      while the grid stays available as a manual override.

import { SPACE_ICON_NAMES, type SpaceIconName } from "@synara/contracts";

/**
 * Keyword sets per icon, matched by substring against the lowercased name. Order is the
 * tie-break: earlier entries win when a name matches several sets. English plus the
 * Italian words a bilingual user reaches for first — this is a convenience map, not a
 * translation table, so near-misses just fall through to the stable fallback.
 */
const ICON_KEYWORDS: ReadonlyArray<readonly [SpaceIconName, ReadonlyArray<string>]> = [
  ["code-brackets", ["code", "dev", "engineer", "program", "software", "codice", "sviluppo"]],
  ["bag", ["work", "job", "office", "business", "client", "lavoro", "ufficio", "azienda"]],
  [
    "school",
    [
      "school",
      "study",
      "learn",
      "course",
      "class",
      "uni",
      "degree",
      "exam",
      "scuola",
      "corso",
      "esam",
    ],
  ],
  ["home", ["home", "house", "family", "personal", "casa", "famiglia", "personale"]],
  ["rocket", ["startup", "launch", "ship", "growth", "lancio"]],
  ["light-bulb", ["idea", "brainstorm", "concept", "idee"]],
  ["color-palette", ["design", "art", "brand", "creative", "arte", "grafica"]],
  ["book", ["book", "read", "writ", "note", "doc", "blog", "libr", "lettura", "scritt"]],
  ["lab", ["lab", "research", "experiment", "science", "ricerca", "esperiment"]],
  ["heart", ["health", "love", "fitness", "wellness", "salute", "amore", "benessere"]],
  ["star", ["favorite", "favourite", "important", "priorit", "preferit"]],
  ["globe", ["travel", "world", "international", "viagg", "mondo"]],
  ["cloud", ["cloud", "infra", "devops", "server", "backend"]],
  ["hammer", ["build", "tool", "maker", "hardware", "diy", "strument", "costru"]],
  [
    "chart-2",
    [
      "finanz",
      "financ",
      "money",
      "invest",
      "stock",
      "analytic",
      "data",
      "sales",
      "soldi",
      "dati",
      "vendite",
    ],
  ],
  ["gamecontroller", ["game", "gaming", "play", "gioc"]],
  ["camera-1", ["photo", "video", "film", "media", "content", "foto"]],
  ["target", ["goal", "okr", "focus", "obiettiv"]],
  ["tree", ["nature", "garden", "outdoor", "plant", "natura", "giardino"]],
  ["backpack", ["hobby", "side", "adventure", "trip", "avventura", "zaino"]],
];

/** Deterministic 32-bit hash so the fallback icon is stable for a given name. */
function hashName(name: string): number {
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash;
}

export function suggestSpaceIcon(name: string): SpaceIconName {
  const normalized = name.trim().toLocaleLowerCase();
  if (normalized.length === 0) {
    return SPACE_ICON_NAMES[0];
  }
  for (const [icon, keywords] of ICON_KEYWORDS) {
    if (keywords.some((keyword) => normalized.includes(keyword))) {
      return icon;
    }
  }
  return SPACE_ICON_NAMES[hashName(normalized) % SPACE_ICON_NAMES.length]!;
}
