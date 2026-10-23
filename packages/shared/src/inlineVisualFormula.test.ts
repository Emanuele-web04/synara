import { describe, expect, it } from "vitest";

import { compileInlineVisualFormula } from "./inlineVisualFormula";

const inputs = new Set(["total", "people", "tip"]);

function evaluate(source: string, values: Record<string, number> = {}) {
  const compiled = compileInlineVisualFormula(source, inputs);
  if (!compiled.ok) throw new Error(compiled.error);
  return compiled.formula.evaluate(values);
}

describe("compileInlineVisualFormula", () => {
  it("evaluates arithmetic with precedence and right-associative powers", () => {
    expect(evaluate("1 + 2 * 3")).toBe(7);
    expect(evaluate("(1 + 2) * 3")).toBe(9);
    expect(evaluate("2 ^ 3 ^ 2")).toBe(512);
    expect(evaluate("-2 ^ 2")).toBe(-4);
    expect(evaluate("10 % 4 - .5")).toBe(1.5);
  });

  it("reads inputs and functions", () => {
    expect(
      evaluate("round(total * (1 + tip / 100) / people, 2)", { total: 100, tip: 15, people: 3 }),
    ).toBe(38.33);
    expect(evaluate("max(total, people, 1)", { total: 4, people: 9 })).toBe(9);
    expect(evaluate("sqrt(abs(-16)) + floor(1.9) + ceil(0.1)")).toBe(6);
  });

  it("returns NaN for results that are not finite", () => {
    expect(evaluate("total / people", { total: 1, people: 0 })).toBeNaN();
    expect(evaluate("sqrt(-1)")).toBeNaN();
  });

  it("rejects unknown names, bad arity, and stray syntax", () => {
    const error = (source: string) => {
      const compiled = compileInlineVisualFormula(source, inputs);
      return compiled.ok ? null : compiled.error;
    };
    expect(error("price * 2")).toBe('unknown input "price"');
    expect(error("eval(1)")).toBe('unknown function "eval"');
    expect(error("constructor")).toBe('unknown input "constructor"');
    expect(error("sqrt(1, 2)")).toBe("sqrt takes 1 value");
    expect(error("1 +")).toBe("formula ends early");
    expect(error("(1")).toBe('expected ")"');
    expect(error("1 2")).toBe('unexpected "2"');
    expect(error("total; alert(1)")).toBe('unexpected ";"');
  });
});
