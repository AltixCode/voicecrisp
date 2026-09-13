import { applyBiquad, type BiquadCoefficients } from './biquad';

/**
 * Integrated loudness to ITU-R BS.1770-4, and the gain needed to hit a target.
 *
 * The spec asked for FFmpeg's loudnorm at -14 LUFS with a -1.5 dB true-peak
 * ceiling -- the level TikTok, YouTube and Reels normalise to. Getting this
 * wrong is not subtle to a listener but is invisible in code review: a naive
 * RMS average reads several LU off, and the platform then turns the whole video
 * up or down to compensate.
 *
 * Two details separate BS.1770 from an average:
 *  - K-weighting: a shelf and a high-pass that approximate how the ear weights
 *    frequency, so bass does not dominate the reading.
 *  - Gating: blocks quieter than -70 LUFS absolute, and then more than 10 LU
 *    below the ungated mean, are discarded. Without the gate, silence between
 *    sentences drags the measurement down and the track is normalised too loud.
 */

export const BLOCK_SECONDS = 0.4;
export const BLOCK_OVERLAP = 0.75;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;

/** Stage 1 of K-weighting: high-shelf, ~+4 dB above 1.5 kHz. */
export const kWeightingShelf = (sampleRate: number): BiquadCoefficients => {
  // Coefficients are defined at 48 kHz in BS.1770; they are re-derived here so
  // the measurement stays correct at other rates rather than silently drifting.
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
};

/** Stage 2 of K-weighting: high-pass at ~38 Hz. */
export const kWeightingHighpass = (sampleRate: number): BiquadCoefficients => {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;
  const K = Math.tan((Math.PI * f0) / sampleRate);
  return {
    b0: 1, b1: -2, b2: 1,
    a1: (2 * (K * K - 1)) / (1 + K / Q + K * K),
    a2: (1 - K / Q + K * K) / (1 + K / Q + K * K),
  };
};

/** Mean square of a block, as the loudness formula consumes it. */
const blockMeanSquare = (samples: Float32Array, from: number, length: number): number => {
  let sum = 0;
  for (let i = from; i < from + length; i++) sum += samples[i] * samples[i];
  return sum / length;
};

const loudnessOf = (meanSquare: number): number =>
  meanSquare <= 0 ? Number.NEGATIVE_INFINITY : -0.691 + 10 * Math.log10(meanSquare);

/**
 * Integrated loudness in LUFS for one mono channel.
 *
 * Returns -Infinity for silence, which callers must treat as "no signal to
 * normalise" rather than applying an enormous gain.
 */
export const integratedLoudness = (input: Float32Array, sampleRate: number): number => {
  // K-weight a copy: the measurement must not alter the audio being exported.
  const weighted = Float32Array.from(input);
  applyBiquad(weighted, kWeightingShelf(sampleRate));
  applyBiquad(weighted, kWeightingHighpass(sampleRate));

  const blockLength = Math.round(BLOCK_SECONDS * sampleRate);
  const step = Math.max(1, Math.round(blockLength * (1 - BLOCK_OVERLAP)));
  if (weighted.length < blockLength) return loudnessOf(blockMeanSquare(weighted, 0, weighted.length || 1));

  const blocks: number[] = [];
  for (let from = 0; from + blockLength <= weighted.length; from += step) {
    blocks.push(blockMeanSquare(weighted, from, blockLength));
  }

  const aboveAbsolute = blocks.filter((ms) => loudnessOf(ms) > ABSOLUTE_GATE_LUFS);
  if (!aboveAbsolute.length) return Number.NEGATIVE_INFINITY;

  const ungatedMean = aboveAbsolute.reduce((a, b) => a + b, 0) / aboveAbsolute.length;
  const relativeThreshold = loudnessOf(ungatedMean) + RELATIVE_GATE_LU;
  const gated = aboveAbsolute.filter((ms) => loudnessOf(ms) > relativeThreshold);
  if (!gated.length) return loudnessOf(ungatedMean);

  return loudnessOf(gated.reduce((a, b) => a + b, 0) / gated.length);
};

/** Highest absolute sample, in dBFS. A cheap stand-in for true peak. */
export const samplePeakDb = (samples: Float32Array): number => {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  return peak <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(peak);
};

export interface GainPlan {
  /** Gain to apply, in dB. */
  gainDb: number;
  /** True when the peak ceiling, not the loudness target, decided the gain. */
  peakLimited: boolean;
}

/**
 * Gain that moves the measured loudness to the target without breaching the
 * peak ceiling.
 *
 * The ceiling wins. Overshooting it clips on playback, and every platform
 * re-encodes, which turns clipping into audible distortion rather than a
 * number in a report.
 */
export const planGain = (
  measuredLufs: number,
  peakDb: number,
  targetLufs = -14,
  ceilingDb = -1.5,
): GainPlan => {
  if (!Number.isFinite(measuredLufs)) return { gainDb: 0, peakLimited: false };
  const wanted = targetLufs - measuredLufs;
  const headroom = Number.isFinite(peakDb) ? ceilingDb - peakDb : wanted;
  const gainDb = Math.min(wanted, headroom);
  return { gainDb, peakLimited: gainDb < wanted - 1e-9 };
};

/** Applies a gain in dB, in place. */
export const applyGain = (samples: Float32Array, gainDb: number): Float32Array => {
  const linear = Math.pow(10, gainDb / 20);
  for (let i = 0; i < samples.length; i++) samples[i] *= linear;
  return samples;
};
