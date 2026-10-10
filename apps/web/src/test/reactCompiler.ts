import { readFileSync } from "node:fs";
import { transformSync } from "@babel/core";

export interface CompilerEvent {
  readonly kind: string;
  readonly fnName?: string | null;
  readonly detail?: { readonly reason?: string; readonly description?: string };
  readonly data?: unknown;
}

export function compileReactModule(filePath: string): CompilerEvent[] {
  const events: CompilerEvent[] = [];
  transformSync(readFileSync(filePath, "utf8"), {
    filename: filePath,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    plugins: [
      [
        "babel-plugin-react-compiler",
        {
          panicThreshold: "none",
          logger: {
            logEvent: (_filename: unknown, event: CompilerEvent) => events.push(event),
          },
        },
      ],
    ],
  });
  return events;
}
