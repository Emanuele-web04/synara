/// <reference types="vite/client" />

// Kumo ships its stylesheet as an exports-map entry that resolves to a .css
// file; the specifier itself has no extension, so vite/client's "*.css"
// wildcard does not cover it.
declare module "@cloudflare/kumo/styles/*";
