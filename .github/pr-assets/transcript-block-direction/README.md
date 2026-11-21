# Transcript block direction — evidence

Same fixture rendered by the real `ChatMarkdown` component with the app stylesheet
(Chromium, 900×980). The fixture holds a Persian heading, two Persian paragraphs
that open with Latin text (`netkeep`, `src/app/layout.tsx`, `Actually`), a
Latin-first Persian list, and one English paragraph.

| File         | What it shows                                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `before.png` | `dir="auto"` per block (first strong character): every paragraph that opens with a Latin word, path, or bold English label lays out LTR. |
| `after.png`  | Direction from the dominant script of each block: the Persian paragraphs and list are RTL, the English paragraph stays LTR.              |

The fixture harness used to capture these images was temporary and is not part of
the change.
