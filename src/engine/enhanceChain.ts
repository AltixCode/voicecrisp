import { applyBiquad, highpass, peakingEq } from './biquad';
import { integratedLoudness, samplePeakDb, planGain, applyGain, type GainPlan } from './loudness';

/**
 * The voice-cleaning chain, in the order the stages have to run.
 *
 * Ordering is not cosmetic here:
 *  1. Filters first, because they change the signal the later stages measure.
 *  2. Compression next, which raises quiet words and so raises the loudness the
 *     normaliser will read.
 *  3. Measure loudness and peak last, on the audio as it will actually be
 *     exported. Measuring earlier -- which is the obvious way to write it --
 *     plans gain against a signal that no longer exists, and a biquad's startup
 *     transient alone peaks about 0.7 dB above its input.
 */

export interface EnhanceSettings {
  /** Sub-rumble cutoff. Below this is handling noise, not voice. */
  highpassHz: number;
  /** Cut around here removes boxy room resonance. */
  mudHz: number;
  mudGainDb: number;
  /** Lift here adds intelligibility without harshness. */
  presenceHz: number;
  presenceGainDb: number;
  /** Above this, gain is progressively reduced. */
  compressorThresholdDb: number;
  /** How hard: 2 means 2 dB in for 1 dB out above the threshold. */
  compressorRatio: number;
  targetLufs: number;
  ceilingDb: number;
}

export const BROADCAST: EnhanceSettings = {
  highpassHz: 80,
  mudHz: 250,
  mudGainDb: -3,
  presenceHz: 3500,
  presenceGainDb: 3.5,
  compressorThresholdDb: -24,
  compressorRatio: 2.5,
  // -14 LUFS with a -1.5 dBTP ceiling is what TikTok, YouTube and Reels
  // normalise to; matching it means the platform leaves the level alone.
  targetLufs: -14,
  ceilingDb: -1.5,
};

/**
 * Static-curve compressor.
 *
 * No attack or release envelope: a per-sample curve cannot pump, and for speech
 * cleanup the goal is levelling quiet and loud words rather than a mix-bus
 * effect. Keeping it memoryless also keeps it testable.
 */
export const compress = (
  samples: Float32Array,
  thresholdDb: number,
  ratio: number,
): Float32Array => {
  const threshold = Math.pow(10, thresholdDb / 20);
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const magnitude = Math.abs(x);
    if (magnitude <= threshold || magnitude === 0) continue;
    const overDb = 20 * Math.log10(magnitude / threshold);
    const allowedDb = overDb / ratio;
    const target = threshold * Math.pow(10, allowedDb / 20);
    samples[i] = Math.sign(x) * target;
  }
  return samples;
};

export interface EnhanceReport {
  loudnessBeforeLufs: number;
  loudnessAfterLufs: number;
  peakAfterDb: number;
  gain: GainPlan;
}

/**
 * Runs the chain in place and reports what it did.
 *
 * The report is surfaced in the UI rather than kept internal: "we cleaned it"
 * is unfalsifiable, whereas before and after loudness are numbers the user can
 * check against the platform they are posting to.
 */
export const enhance = (
  samples: Float32Array,
  sampleRate: number,
  settings: EnhanceSettings = BROADCAST,
): EnhanceReport => {
  const loudnessBeforeLufs = integratedLoudness(samples, sampleRate);

  applyBiquad(samples, highpass(sampleRate, settings.highpassHz));
  applyBiquad(samples, peakingEq(sampleRate, settings.mudHz, settings.mudGainDb));
  applyBiquad(samples, peakingEq(sampleRate, settings.presenceHz, settings.presenceGainDb));
  compress(samples, settings.compressorThresholdDb, settings.compressorRatio);

  const measured = integratedLoudness(samples, sampleRate);
  const peak = samplePeakDb(samples);
  const gain = planGain(measured, peak, settings.targetLufs, settings.ceilingDb);
  applyGain(samples, gain.gainDb);

  return {
    loudnessBeforeLufs,
    loudnessAfterLufs: integratedLoudness(samples, sampleRate),
    peakAfterDb: samplePeakDb(samples),
    gain,
  };
};
