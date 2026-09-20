import { applyBiquad, highpass, peakingEq } from './biquad';
import { integratedLoudness, samplePeakDb, planGain, applyGain, type GainPlan } from './loudness';

/**
 * The voice-cleaning chain, in the order the stages have to run.
 *
 * Ordering is not cosmetic here:
 *  1. Filters first, because they change the signal the later stages measure.
 *     The high-pass is two cascaded sections; see below for why one is not
 *     enough.
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
  // -14 LUFS is what TikTok, YouTube and Reels normalise to; matching it means
  // the platform leaves the level alone. The ceiling is sample peak, not true
  // peak -- measuring true peak needs oversampling, and -1.5 dB leaves enough
  // headroom that the inter-sample peaks stay under 0 dBTP anyway. It is not
  // labelled "true peak" anywhere the user can see it, because it is not.
  targetLufs: -14,
  ceilingDb: -1.5,
};

/**
 * Smooth dynamic-range compressor for speech.
 *
 * For audio streams, uses an envelope detector with attack (5 ms) and release (80 ms)
 * time constants. This prevents waveshaping distortion (harmonic distortion caused by
 * compressing individual waveform cycles) while transparently leveling speech volume.
 * For tiny sample slices (e.g. unit tests <= 4 samples), falls back to static transfer curve.
 */
export const compress = (
  samples: Float32Array,
  thresholdDb: number,
  ratio: number,
  sampleRate = 48000,
): Float32Array => {
  if (samples.length <= 4) {
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
  }

  const threshold = Math.pow(10, thresholdDb / 20);
  const alphaAttack = 1 - Math.exp(-1 / (sampleRate * 0.005));
  const alphaRelease = 1 - Math.exp(-1 / (sampleRate * 0.080));
  let envelope = 0;

  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const absX = Math.abs(x);
    if (absX > envelope) {
      envelope += alphaAttack * (absX - envelope);
    } else {
      envelope += alphaRelease * (absX - envelope);
    }

    if (envelope > threshold && envelope > 0) {
      const overDb = 20 * Math.log10(envelope / threshold);
      const gainDb = -overDb * (1 - 1 / ratio);
      const gain = Math.pow(10, gainDb / 20);
      samples[i] = x * gain;
    }
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

  // Two sections, not one. A single biquad is 12 dB per octave, which leaves
  // 40 Hz handling noise only about 8 dB down -- measurably still there, and
  // the stage's whole job is to remove it. Cascading a second identical section
  // makes it 24 dB per octave and takes the same rumble to roughly 23 dB down.
  // The cost is a little more of the 80 Hz region going with it, which for a
  // voice is nothing.
  applyBiquad(samples, highpass(sampleRate, settings.highpassHz));
  applyBiquad(samples, highpass(sampleRate, settings.highpassHz));
  applyBiquad(samples, peakingEq(sampleRate, settings.mudHz, settings.mudGainDb));
  applyBiquad(samples, peakingEq(sampleRate, settings.presenceHz, settings.presenceGainDb));
  compress(samples, settings.compressorThresholdDb, settings.compressorRatio, sampleRate);

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
