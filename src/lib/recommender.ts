import type { CatFeatures, CatPhoto, PreferenceWeights } from "../types";
import { cosineSimilarity } from "./vector";

export function emptyPrefs(): PreferenceWeights {
  return {
    tags: {},
    source: {},
    orientation: {},
    media: {},
  };
}

export function extractFeatures(cat: CatPhoto): CatFeatures {
  const orientation = cat.width > cat.height ? "landscape" : cat.width < cat.height ? "portrait" : "square";
  const media = cat.mime.includes("gif") ? "gif" : "photo";

  return {
    tags: cat.tags.map((tag) => tag.toLowerCase()).slice(0, 8),
    source: cat.source,
    orientation,
    media,
  };
}

export function applyFeedback(prefs: PreferenceWeights, cat: CatPhoto, delta: number): void {
  const features = extractFeatures(cat);
  for (const tag of features.tags) prefs.tags[tag] = (prefs.tags[tag] || 0) + delta;
  prefs.source[features.source] = (prefs.source[features.source] || 0) + delta;
  prefs.orientation[features.orientation] = (prefs.orientation[features.orientation] || 0) + delta * 0.7;
  prefs.media[features.media] = (prefs.media[features.media] || 0) + delta * 0.5;
}

export function metadataScore(cat: CatPhoto, prefs: PreferenceWeights, randomNoise = Math.random() * 0.2): number {
  const features = extractFeatures(cat);
  let score = randomNoise;

  for (const tag of features.tags) score += (prefs.tags[tag] || 0) * 0.45;
  score += (prefs.source[features.source] || 0) * 0.25;
  score += (prefs.orientation[features.orientation] || 0) * 0.22;
  score += (prefs.media[features.media] || 0) * 0.15;

  return score;
}

export function hybridScore(args: {
  cat: CatPhoto;
  prefs: PreferenceWeights;
  centroid: number[] | null;
  embedding?: number[];
  randomNoise?: number;
}): number {
  const { cat, prefs, centroid, embedding, randomNoise = Math.random() * 0.2 } = args;
  let score = metadataScore(cat, prefs, randomNoise);

  if (centroid) {
    if (embedding) {
      score += cosineSimilarity(embedding, centroid) * 2.2;
    } else {
      score += 0.06;
    }
  }

  return score;
}
