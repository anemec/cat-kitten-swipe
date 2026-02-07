import { describe, expect, it } from "vitest";
import { applyFeedback, emptyPrefs, extractFeatures, hybridScore, metadataScore } from "../src/lib/recommender";
import type { CatPhoto } from "../src/types";

function cat(partial: Partial<CatPhoto> = {}): CatPhoto {
  return {
    unique: "x1",
    id: "x1",
    url: "https://example.com/cat.jpg",
    width: 800,
    height: 1000,
    tags: ["Cute"],
    mime: "image/jpeg",
    source: "CATAAS",
    ...partial,
  };
}

describe("recommender", () => {
  it("extracts normalized features", () => {
    const features = extractFeatures(cat({ width: 1200, height: 600, mime: "image/gif", tags: ["Fluffy"] }));
    expect(features.orientation).toBe("landscape");
    expect(features.media).toBe("gif");
    expect(features.tags).toEqual(["fluffy"]);
  });

  it("applies positive feedback to weights", () => {
    const prefs = emptyPrefs();
    applyFeedback(prefs, cat(), 1);

    expect(prefs.source.CATAAS).toBeCloseTo(1, 5);
    expect(prefs.orientation.portrait).toBeCloseTo(0.7, 5);
    expect(prefs.tags.cute).toBeCloseTo(1, 5);
  });

  it("scores preferred metadata higher", () => {
    const prefs = emptyPrefs();
    const liked = cat({ unique: "liked" });
    applyFeedback(prefs, liked, 1);

    const likedScore = metadataScore(liked, prefs, 0);
    const otherScore = metadataScore(cat({ unique: "other", source: "TheCatAPI", tags: ["Other"] }), prefs, 0);
    expect(likedScore).toBeGreaterThan(otherScore);
  });

  it("boosts score using embedding similarity", () => {
    const prefs = emptyPrefs();
    const centroid = [1, 0];

    const similar = hybridScore({
      cat: cat(),
      prefs,
      centroid,
      embedding: [1, 0],
      randomNoise: 0,
    });

    const dissimilar = hybridScore({
      cat: cat(),
      prefs,
      centroid,
      embedding: [0, 1],
      randomNoise: 0,
    });

    expect(similar).toBeGreaterThan(dissimilar);
  });
});
