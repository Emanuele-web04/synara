// FILE: ChatView.compiler.test.ts
// Purpose: The chat hot-path React Compiler guard for ChatView.tsx. The bailout
//          triggers and the other hot-path modules are listed in
//          chatHotPath.compiler.test.ts. ChatView takes about 70% of that guard's
//          compile time, so it runs as its own file and CI can compile both files
//          at once (.github/CI.md).
// Layer: Web build-integrity test
// Depends on: babel-plugin-react-compiler (same plugin the Vite build uses).

import { describeHotPathCompilation } from "../test/hotPathCompiler";

describeHotPathCompilation(import.meta.dirname, [
  { relativePath: "ChatView.tsx", requiredFunction: "ChatView", allowedBailoutReasons: [] },
]);
