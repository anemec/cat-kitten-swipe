export function normalize(vector: number[]): number[] {
  const mag = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0)) || 1;
  return vector.map((n) => n / mag);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i += 1) dot += a[i] * b[i];
  return dot;
}

export function centroidOf(vectors: number[][]): number[] | null {
  if (!vectors.length) return null;
  const size = vectors[0].length;
  const sum = new Array(size).fill(0);

  for (const vec of vectors) {
    for (let i = 0; i < size; i += 1) sum[i] += vec[i];
  }

  for (let i = 0; i < size; i += 1) sum[i] /= vectors.length;
  return normalize(sum);
}
