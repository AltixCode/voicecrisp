/**
 * Biquad filter design, from the Audio EQ Cookbook (Robert Bristow-Johnson).
 *
 * The chain VoiceCrisp applies is the one the spec spelled out as FFmpeg
 * filters. FFmpegKit's binaries were withdrawn from both registries, so the
 * filters are implemented directly -- and the coefficient maths lives here, in
 * one tested place, rather than being written twice in Swift and Kotlin where
 * a transposed sign would be inaudible until someone's voice came out thin.
 */

export interface BiquadCoefficients {
  b0: number; b1: number; b2: number;
  a1: number; a2: number;
}

/** Normalises by a0, so the difference equation needs no division per sample. */
const normalise = (b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): BiquadCoefficients => ({
  b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0,
});

/** Removes handling rumble, mic bumps and wind below the cutoff. */
export const highpass = (sampleRate: number, cutoffHz: number, q = Math.SQRT1_2): BiquadCoefficients => {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return normalise(
    (1 + cos) / 2, -(1 + cos), (1 + cos) / 2,
    1 + alpha, -2 * cos, 1 - alpha,
  );
};

/** Cuts boxiness or adds presence at a centre frequency. */
export const peakingEq = (
  sampleRate: number,
  centreHz: number,
  gainDb: number,
  q = 1,
): BiquadCoefficients => {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * centreHz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return normalise(
    1 + alpha * A, -2 * cos, 1 - alpha * A,
    1 + alpha / A, -2 * cos, 1 - alpha / A,
  );
};

/**
 * Magnitude response at one frequency, in dB.
 *
 * Exposed because it is the only way to check a filter actually does what its
 * name says: coefficients are unreadable, and a sign error produces a filter
 * that runs happily and sounds wrong.
 */
export const responseDb = (c: BiquadCoefficients, sampleRate: number, freqHz: number): number => {
  const w = (2 * Math.PI * freqHz) / sampleRate;
  const cos1 = Math.cos(w), cos2 = Math.cos(2 * w);
  const sin1 = Math.sin(w), sin2 = Math.sin(2 * w);
  const numRe = c.b0 + c.b1 * cos1 + c.b2 * cos2;
  const numIm = -(c.b1 * sin1 + c.b2 * sin2);
  const denRe = 1 + c.a1 * cos1 + c.a2 * cos2;
  const denIm = -(c.a1 * sin1 + c.a2 * sin2);
  const num = Math.hypot(numRe, numIm);
  const den = Math.hypot(denRe, denIm);
  return 20 * Math.log10(num / den);
};

/** Applies a biquad in place, transposed direct form II. */
export const applyBiquad = (samples: Float32Array, c: BiquadCoefficients): Float32Array => {
  let z1 = 0, z2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = c.b0 * x + z1;
    z1 = c.b1 * x - c.a1 * y + z2;
    z2 = c.b2 * x - c.a2 * y;
    samples[i] = y;
  }
  return samples;
};
