// FILE: inlineVisualFormula.ts
// Purpose: Parses and evaluates the arithmetic formulas of an inline visual calculator
//          block. Agent text, so no eval: a small recursive-descent parser over numbers,
//          input ids, + - * / % ^, parentheses, and a fixed set of functions.
// Layer: Shared runtime utility (gateway validation, web rendering)
// Exports: compileInlineVisualFormula, InlineVisualFormula

type Node =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "variable"; readonly name: string }
  | { readonly kind: "negate"; readonly operand: Node }
  | {
      readonly kind: "binary";
      readonly operator: string;
      readonly left: Node;
      readonly right: Node;
    }
  | { readonly kind: "call"; readonly name: FunctionName; readonly args: ReadonlyArray<Node> };

const FUNCTIONS = {
  min: { arity: [1, 16], apply: (args: number[]) => Math.min(...args) },
  max: { arity: [1, 16], apply: (args: number[]) => Math.max(...args) },
  round: {
    arity: [1, 2],
    apply: ([value = 0, digits = 0]: number[]) => {
      const factor = 10 ** Math.max(0, Math.min(10, Math.trunc(digits)));
      return Math.round(value * factor) / factor;
    },
  },
  floor: { arity: [1, 1], apply: ([value = 0]: number[]) => Math.floor(value) },
  ceil: { arity: [1, 1], apply: ([value = 0]: number[]) => Math.ceil(value) },
  abs: { arity: [1, 1], apply: ([value = 0]: number[]) => Math.abs(value) },
  sqrt: { arity: [1, 1], apply: ([value = 0]: number[]) => Math.sqrt(value) },
} as const satisfies Record<
  string,
  { arity: readonly [number, number]; apply: (args: number[]) => number }
>;
type FunctionName = keyof typeof FUNCTIONS;

const isFunctionName = (name: string): name is FunctionName => Object.hasOwn(FUNCTIONS, name);

export interface InlineVisualFormula {
  /** NaN when the result is not a finite number (division by zero, sqrt of a negative). */
  readonly evaluate: (values: Readonly<Record<string, number>>) => number;
}

export type CompiledInlineVisualFormula =
  | { readonly ok: true; readonly formula: InlineVisualFormula }
  | { readonly ok: false; readonly error: string };

const TOKEN = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*)|(\S))/y;

function tokenize(source: string): string[] | string {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    const match = TOKEN.exec(source);
    if (match === null) break;
    const [, number, name, symbol] = match;
    const token = number ?? name ?? symbol;
    if (token === undefined) break;
    if (symbol !== undefined && !"+-*/%^(),".includes(symbol)) {
      return `unexpected "${symbol}"`;
    }
    tokens.push(token);
  }
  return tokens;
}

/** Compiles once; unknown names and syntax errors are reported, never evaluated. */
export function compileInlineVisualFormula(
  source: string,
  variables: ReadonlySet<string>,
): CompiledInlineVisualFormula {
  const tokens = tokenize(source);
  if (typeof tokens === "string") return { ok: false, error: tokens };
  let position = 0;
  const peek = () => tokens[position];
  const fail = (message: string): never => {
    throw new FormulaSyntaxError(message);
  };
  const expect = (token: string) => {
    if (tokens[position] !== token) fail(`expected "${token}"`);
    position += 1;
  };

  const parseAdditive = (): Node => {
    let left = parseMultiplicative();
    while (peek() === "+" || peek() === "-") {
      const operator = tokens[position++]!;
      left = { kind: "binary", operator, left, right: parseMultiplicative() };
    }
    return left;
  };
  const parseMultiplicative = (): Node => {
    let left = parseUnary();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const operator = tokens[position++]!;
      left = { kind: "binary", operator, left, right: parseUnary() };
    }
    return left;
  };
  const parseUnary = (): Node => {
    if (peek() === "-") {
      position += 1;
      return { kind: "negate", operand: parseUnary() };
    }
    if (peek() === "+") {
      position += 1;
      return parseUnary();
    }
    return parsePower();
  };
  const parsePower = (): Node => {
    const base = parsePrimary();
    if (peek() !== "^") return base;
    position += 1;
    return { kind: "binary", operator: "^", left: base, right: parseUnary() };
  };
  const parsePrimary = (): Node => {
    const token = tokens[position++];
    if (token === undefined) return fail("formula ends early");
    if (token === "(") {
      const inner = parseAdditive();
      expect(")");
      return inner;
    }
    if (/^[\d.]/.test(token)) return { kind: "number", value: Number(token) };
    if (/^[A-Za-z_]/.test(token)) {
      if (peek() === "(") {
        if (!isFunctionName(token)) return fail(`unknown function "${token}"`);
        position += 1;
        const args: Node[] = [];
        if (peek() !== ")") {
          args.push(parseAdditive());
          while (peek() === ",") {
            position += 1;
            args.push(parseAdditive());
          }
        }
        expect(")");
        const [minimum, maximum] = FUNCTIONS[token].arity;
        if (args.length < minimum || args.length > maximum) {
          const count = minimum === maximum ? `${minimum}` : `${minimum} to ${maximum}`;
          fail(`${token} takes ${count} value${count === "1" ? "" : "s"}`);
        }
        return { kind: "call", name: token, args };
      }
      if (!variables.has(token)) return fail(`unknown input "${token}"`);
      return { kind: "variable", name: token };
    }
    return fail(`unexpected "${token}"`);
  };

  try {
    const root = parseAdditive();
    if (position < tokens.length) fail(`unexpected "${tokens[position]}"`);
    return {
      ok: true,
      formula: {
        evaluate: (values) => {
          const result = evaluateNode(root, values);
          return Number.isFinite(result) ? result : Number.NaN;
        },
      },
    };
  } catch (error) {
    if (error instanceof FormulaSyntaxError) return { ok: false, error: error.message };
    throw error;
  }
}

class FormulaSyntaxError extends Error {}

function evaluateNode(node: Node, values: Readonly<Record<string, number>>): number {
  switch (node.kind) {
    case "number":
      return node.value;
    case "variable":
      return values[node.name] ?? Number.NaN;
    case "negate":
      return -evaluateNode(node.operand, values);
    case "call":
      return FUNCTIONS[node.name].apply(node.args.map((arg) => evaluateNode(arg, values)));
    case "binary": {
      const left = evaluateNode(node.left, values);
      const right = evaluateNode(node.right, values);
      switch (node.operator) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return left / right;
        case "%":
          return left % right;
        default:
          return left ** right;
      }
    }
  }
}
