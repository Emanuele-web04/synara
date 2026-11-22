import { readFileSync } from "node:fs";
import { transformSync } from "@babel/core";

export interface CompilerEvent {
  readonly kind: string;
  readonly fnName?: string | null;
  readonly detail?: { readonly reason?: string; readonly description?: string };
  readonly data?: unknown;
}

/** Compiles `source` as the module at `filePath` and returns the compiler's events. */
export function compileReactSource(filePath: string, source: string): CompilerEvent[] {
  const events: CompilerEvent[] = [];
  transformSync(source, {
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

export function compileReactModule(filePath: string): CompilerEvent[] {
  return compileReactSource(filePath, readFileSync(filePath, "utf8"));
}
