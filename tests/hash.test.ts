import { describe, it, expect } from "vitest";
import { stableJson, sha256, verifySignature, truncate } from "../src/util.ts";

describe("stableJson", () => {
  it("sorts object keys ascending", () => {
    expect(stableJson({ b: 1, a: 2 })).toBe(stableJson({ a: 2, b: 1 }));
  });

  it("ignores undefined values", () => {
    expect(stableJson({ a: 1, b: undefined })).toBe(stableJson({ a: 1 }));
  });

  it("handles arrays order-sensitively", () => {
    expect(stableJson([1, 2, 3])).not.toBe(stableJson([3, 2, 1]));
  });

  it("handles nested objects", () => {
    expect(stableJson({ z: { y: 1, x: 2 } })).toBe(stableJson({ z: { x: 2, y: 1 } }));
  });

  it("handles primitives", () => {
    expect(stableJson(null)).toBe("null");
    expect(stableJson(42)).toBe("42");
    expect(stableJson("hi")).toBe('"hi"');
  });
});

describe("sha256", () => {
  it("is deterministic", () => {
    expect(sha256("hello")).toBe(sha256("hello"));
  });

  it("is 64 hex chars", () => {
    expect(sha256("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifySignature", () => {
  it("accepts a valid signature", () => {
    const body = '{"action":"opened"}';
    const secret = "whsec_test";
    const sig = `sha256=${sha256(body + secret)}`;
    expect(verifySignature(body, sig, secret)).toBe(true);
  });

  it("rejects wrong secret", () => {
    const body = "x";
    const sig = `sha256=${sha256(body + "right")}`;
    expect(verifySignature(body, sig, "wrong")).toBe(false);
  });

  it("rejects malformed signature", () => {
    expect(verifySignature("x", "not-a-signature", "s")).toBe(false);
  });
});

describe("truncate", () => {
  it("returns short text unchanged", () => {
    expect(truncate("short", 100)).toBe("short");
  });

  it("truncates long text with a marker", () => {
    const long = "x".repeat(200);
    const out = truncate(long, 50);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain("truncated");
  });
});
