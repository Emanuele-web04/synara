import { describe, expect, it } from "vitest";
import { LRUCache } from "./lruCache";

describe("LRUCache", () => {
  it("returns null for missing keys", () => {
    const cache = new LRUCache<string>(2, 100);
    expect(cache.get("missing")).toBeNull();
  });

  it("evicts oldest by max entries", () => {
    const cache = new LRUCache<string>(2, 1_000);
    cache.set("a", "A", 10);
    cache.set("b", "B", 10);
    cache.set("c", "C", 10);

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");
  });

  it("promotes on get and evicts least recently used", () => {
    const cache = new LRUCache<string>(2, 1_000);
    cache.set("a", "A", 10);
    cache.set("b", "B", 10);
    expect(cache.get("a")).toBe("A");

    cache.set("c", "C", 10);
    expect(cache.get("a")).toBe("A");
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toBe("C");
  });

  it("evicts by memory budget", () => {
    const cache = new LRUCache<string>(10, 25);
    cache.set("a", "A", 10);
    cache.set("b", "B", 10);
    cache.set("c", "C", 10);

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");
  });

  it("correctly tracks size when overwriting an existing key", () => {
    const cache = new LRUCache<string>(5, 100);
    cache.set("a", "A", 10);
    cache.set("a", "AA", 30);
    cache.set("b", "B", 10);
    cache.set("c", "C", 10);
    cache.set("d", "D", 10);
    cache.set("e", "E", 10);

    expect(cache.get("a")).toBe("AA");
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");
    expect(cache.get("d")).toBe("D");
    expect(cache.get("e")).toBe("E");
  });

  it("clear empties the cache and resets size", () => {
    const cache = new LRUCache<string>(5, 100);
    cache.set("a", "A", 10);
    cache.set("b", "B", 10);
    cache.clear();

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBeNull();
    cache.set("c", "C", 10);
    expect(cache.get("c")).toBe("C");
  });

  it("handles maxEntries of 1", () => {
    const cache = new LRUCache<string>(1, 100);
    cache.set("a", "A", 10);
    cache.set("b", "B", 10);

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("B");
  });

  it("evicts enough entries when a large item is inserted", () => {
    const cache = new LRUCache<number>(10, 50);
    cache.set("a", 1, 10);
    cache.set("b", 2, 10);
    cache.set("c", 3, 10);
    cache.set("d", 4, 10);
    cache.set("e", 5, 40);

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toBeNull();
    expect(cache.get("d")).toBe(4);
    expect(cache.get("e")).toBe(5);
  });

  it("get on existing key does not change cache entry count", () => {
    const cache = new LRUCache<string>(2, 1_000);
    cache.set("a", "A", 10);
    cache.set("b", "B", 10);

    expect(cache.get("a")).toBe("A");
    cache.set("c", "C", 10);
    expect(cache.get("a")).toBe("A");
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toBe("C");
  });

  it("does not evict when within both entry and memory limits", () => {
    const cache = new LRUCache<string>(5, 100);
    cache.set("a", "A", 10);
    cache.set("b", "B", 10);
    cache.set("c", "C", 10);

    expect(cache.get("a")).toBe("A");
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");
  });
});
