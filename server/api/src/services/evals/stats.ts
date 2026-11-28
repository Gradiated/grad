const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
};

const round4 = (value: number): number => Number(value.toFixed(4));

/** Mean with a seeded percentile-bootstrap 95% confidence interval. */
export const bootstrapMeanCI = (
  values: readonly number[],
  seed = 42,
  resamples = 1000,
): { mean: number; ci_low: number; ci_high: number } => {
  if (values.length === 0) return { mean: 0, ci_low: 0, ci_high: 0 };

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (values.length === 1) {
    const rounded = round4(mean);
    return { mean: rounded, ci_low: rounded, ci_high: rounded };
  }

  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let b = 0; b < resamples; b += 1) {
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
      sum += values[Math.floor(rand() * values.length)] ?? 0;
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);

  // The trainer's percentile rule (metrics.py bootstrap_ci): as many
  // resamples cut from each tail.
  const lowIdx = Math.floor(0.025 * (resamples - 1));
  const highIdx = Math.ceil(0.975 * (resamples - 1));

  return {
    mean: round4(mean),
    ci_low: round4(means[lowIdx] ?? mean),
    ci_high: round4(means[highIdx] ?? mean),
  };
};

const choose = (n: number, k: number): number => {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 1; i <= Math.min(k, n - k); i += 1) {
    result = (result * (n - i + 1)) / i;
  }

  return result;
};

/** Unbiased pass@k estimator (Chen et al. 2021) for one task's samples. */
export const computePassAtK = (
  samplePasses: readonly boolean[],
  k: number,
): number => {
  const n = samplePasses.length;
  if (n === 0 || k <= 0) return 0;
  const c = samplePasses.filter(Boolean).length;
  if (c === 0) return 0;
  if (n - c < k) return 1;

  return round4(1 - choose(n - c, k) / choose(n, k));
};
