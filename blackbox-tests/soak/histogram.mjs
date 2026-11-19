// Frame-age histogram for the soak's latency percentiles.

import { round } from "./config.mjs";

/** 1 ms buckets up to maxBucketMs, plus an overflow counter. ~1.2 MB at 300 s. */
export class LatencyHistogram {
  constructor(maxBucketMs = 300_000) {
    this.buckets = new Uint32Array(maxBucketMs + 1);
    this.overflow = 0;
    this.count = 0;
    this.sum = 0;
    this.max = 0;
  }

  add(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (ms >= this.buckets.length) this.overflow++;
    else this.buckets[Math.floor(ms)]++;
    this.count++;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  }

  percentile(p) {
    if (this.count === 0) return null;
    const target = Math.ceil(this.count * p);
    let seen = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      seen += this.buckets[i];
      if (seen >= target) return i;
    }
    return this.buckets.length; // in the overflow bucket
  }

  summary() {
    if (this.count === 0) return { count: 0 };
    return {
      count: this.count,
      meanMs: round(this.sum / this.count, 1),
      p50Ms: this.percentile(0.5),
      p95Ms: this.percentile(0.95),
      p99Ms: this.percentile(0.99),
      p999Ms: this.percentile(0.999),
      maxMs: round(this.max, 1),
      overflow: this.overflow,
    };
  }
}
