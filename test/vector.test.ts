import { describe, expect, it } from "vitest";
import { centroidOf, cosineSimilarity, normalize } from "../src/lib/vector";

describe("vector utils", () => {
  it("normalizes vectors to unit length", () => {
    const out = normalize([3, 4]);
    expect(out[0]).toBeCloseTo(0.6, 5);
    expect(out[1]).toBeCloseTo(0.8, 5);
  });

  it("computes cosine similarity", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it("builds centroid for vectors", () => {
    const center = centroidOf([
      [1, 0, 0],
      [1, 0, 0],
    ]);

    expect(center).not.toBeNull();
    expect(center?.[0]).toBeCloseTo(1, 5);
  });
});
