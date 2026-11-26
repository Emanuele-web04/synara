// FILE: global.d.ts
// Purpose: Declare ambient modules used by the web app when upstream packages omit types.
// Layer: Web type declarations
// Exports: module declarations only

declare module "@fontsource-variable/jetbrains-mono";

// The engine ships its language definitions (`{ conf, language }`) without
// declarations; only the language configuration is consumed (editorHighlighting.ts).
declare module "monaco-editor/languages/definitions/*" {
  export const conf: import("monaco-editor/editor/editor.api").languages.LanguageConfiguration;
}
