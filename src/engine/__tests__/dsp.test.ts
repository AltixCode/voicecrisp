/**
 * DSP is the one part of this app nobody can review by reading it. A sign error
 * in a coefficient or a missing gate produces audio that plays fine and is
 * wrong, so each filter is checked against its frequency response and the
 * loudness meter against signals whose level is known by construction.
 */
import { highpass, peakingEq, responseDb, applyBiquad } from '../biquad';
import {
  integratedLoudness, samplePeakDb, planGain, applyGain,
  kWeightingShelf, kWeightingHighpass,
} from '../loudness';
import { enhance, compress } from '../enhanceChain';

const SR = 48000;

/** A sine at a known amplitude, so its level is known without measuring it. */
const sine = (freq: number, seconds: number, amplitude = 0.5): Float32Array => {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
};

describe('highpass', () => {
  it('passes the band above the cutoff', () => {
    expect(responseDb(highpass(SR, 80), SR, 1000)).toBeCloseTo(0, 1);
  });

  it('is 3 dB down at the cutoff', () => {
    // The defining property of a Butterworth cutoff; a sign error moves it.
    expect(responseDb(highpass(SR, 80), SR, 80)).toBeCloseTo(-3, 0);
  });

  it('rejects rumble well below the cutoff', () => {
    // 80 Hz highpass, two octaves down: handling noise and wind should be gone.
    expect(responseDb(highpass(SR, 80), SR, 20)).toBeLessThan(-20);
  });
});

describe('peakingEq', () => {
  it('applies its gain at the centre frequency', () => {
    expect(responseDb(peakingEq(SR, 3500, 3.5), SR, 3500)).toBeCloseTo(3.5, 1);
  });

  it('cuts when the gain is negative', () => {
    expect(responseDb(peakingEq(SR, 250, -3), SR, 250)).toBeCloseTo(-3, 1);
  });

  it('leaves distant frequencies alone', () => {
    expect(responseDb(peakingEq(SR, 250, -3), SR, 8000)).toBeCloseTo(0, 1);
  });
});

describe('applyBiquad', () => {
  it('attenuates a tone below the cutoff', () => {
    const low = sine(30, 0.5);
    const before = samplePeakDb(low);
    applyBiquad(low, highpass(SR, 80));
    expect(samplePeakDb(low)).toBeLessThan(before - 10);
  });

  it('leaves a tone in the passband roughly untouched', () => {
    const mid = sine(1000, 0.5);
    const before = samplePeakDb(mid);
    applyBiquad(mid, highpass(SR, 80));
    // Measured after the filter has settled. A biquad rings for a few
    // milliseconds at the start, and that transient peaks about 0.7 dB above
    // steady state -- which is why the pipeline measures peak *after*
    // filtering, not before, when deciding how much gain the ceiling allows.
    const settled = mid.subarray(Math.round(0.05 * SR));
    expect(samplePeakDb(settled)).toBeCloseTo(before, 0);
  });

  it('can push the peak above the input during its startup transient', () => {
    // Documented because it drives pipeline ordering: gain planning must see
    // the post-filter peak or the ceiling can be breached.
    const mid = sine(1000, 0.5);
    const before = samplePeakDb(mid);
    applyBiquad(mid, highpass(SR, 80));
    expect(samplePeakDb(mid)).toBeGreaterThan(before);
  });
});

describe('K-weighting', () => {
  it('lifts the presence band', () => {
    expect(responseDb(kWeightingShelf(SR), SR, 8000)).toBeGreaterThan(3);
  });
  it('rolls off the very low end', () => {
    expect(responseDb(kWeightingHighpass(SR), SR, 20)).toBeLessThan(-6);
  });
});

describe('integratedLoudness', () => {
  it('measures a 1 kHz tone near its known level', () => {
    // A -6 dBFS sine is about -9 LUFS once K-weighting and the -0.691 offset
    // are applied; a plain RMS average lands several LU away.
    const lufs = integratedLoudness(sine(1000, 3, 0.5), SR);
    expect(lufs).toBeGreaterThan(-12);
    expect(lufs).toBeLessThan(-6);
  });

  it('reports -Infinity for digital silence instead of a huge negative number', () => {
    expect(integratedLoudness(new Float32Array(SR), SR)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('is not dragged down by silence between phrases', () => {
    // Gating is the whole point: without it, pauses pull the measurement down
    // and the track gets normalised too loud.
    const speech = sine(1000, 2, 0.5);
    const withGaps = new Float32Array(speech.length * 2);
    withGaps.set(speech, 0); // second half stays silent
    const gapped = integratedLoudness(withGaps, SR);
    const solid = integratedLoudness(speech, SR);
    expect(Math.abs(gapped - solid)).toBeLessThan(1.5);
  });

  it('reads a louder signal as louder', () => {
    expect(integratedLoudness(sine(1000, 2, 0.5), SR))
      .toBeGreaterThan(integratedLoudness(sine(1000, 2, 0.05), SR));
  });

  it('handles audio shorter than one measurement block', () => {
    expect(Number.isFinite(integratedLoudness(sine(1000, 0.1, 0.5), SR))).toBe(true);
  });
});

describe('planGain', () => {
  it('lifts a quiet track to the target', () => {
    expect(planGain(-24, -20).gainDb).toBeCloseTo(10, 5);
  });

  it('lets the peak ceiling override the loudness target', () => {
    // Wants +10 dB, but the peak is already at -3 dBFS: going there would clip,
    // and every platform re-encodes, which turns clipping into distortion.
    const plan = planGain(-24, -3);
    expect(plan.gainDb).toBeCloseTo(1.5, 5);
    expect(plan.peakLimited).toBe(true);
  });

  it('pulls a too-loud track down', () => {
    expect(planGain(-8, -1).gainDb).toBeCloseTo(-6, 5);
  });

  it('does nothing to silence rather than applying an enormous gain', () => {
    expect(planGain(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY).gainDb).toBe(0);
  });
});

describe('applyGain', () => {
  it('scales by the stated amount', () => {
    const s = new Float32Array([0.5, -0.5]);
    applyGain(s, -6);
    expect(s[0]).toBeCloseTo(0.2506, 3);
  });
  it('is a no-op at 0 dB', () => {
    const s = new Float32Array([0.3]);
    applyGain(s, 0);
    expect(s[0]).toBeCloseTo(0.3, 6);
  });
});

describe('enhance', () => {
  it('brings a quiet recording up towards the target', () => {
    const quiet = sine(500, 3, 0.02);
    const report = enhance(quiet, SR);
    expect(report.loudnessAfterLufs).toBeGreaterThan(report.loudnessBeforeLufs);
    expect(report.loudnessAfterLufs).toBeGreaterThan(-20);
  });

  it('never leaves the peak above the ceiling', () => {
    // The whole point of planning gain against the post-chain peak.
    const hot = sine(500, 3, 0.95);
    const report = enhance(hot, SR);
    expect(report.peakAfterDb).toBeLessThanOrEqual(-1.5 + 0.01);
  });

  it('leaves silence alone instead of amplifying noise into it', () => {
    const silence = new Float32Array(SR);
    const report = enhance(silence, SR);
    expect(report.gain.gainDb).toBe(0);
    expect(silence.every((s) => s === 0)).toBe(true);
  });
});

describe('compress', () => {
  it('leaves signal below the threshold untouched', () => {
    const s = new Float32Array([0.01, -0.01]);
    compress(s, -24, 2.5);
    expect(s[0]).toBeCloseTo(0.01, 6);
  });

  it('reduces signal above the threshold by the ratio', () => {
    // 0.5 is about -6 dBFS, 18 dB over a -24 dB threshold; at 2.5:1 that
    // becomes 7.2 dB over, so about -16.8 dBFS.
    const s = new Float32Array([0.5]);
    compress(s, -24, 2.5);
    expect(20 * Math.log10(s[0])).toBeCloseTo(-16.8, 0);
  });

  it('preserves sign so the waveform is not inverted', () => {
    const s = new Float32Array([-0.5]);
    compress(s, -24, 2.5);
    expect(s[0]).toBeLessThan(0);
  });
});

describe('loudness gating, isolated', () => {
  it('ignores quiet room tone that the absolute gate alone would keep', () => {
    // Room tone at about -50 dBFS sits well above the -70 LUFS absolute gate,
    // so only the relative gate excludes it. Without that gate the quiet half
    // drags the reading down and the track is normalised too loud.
    const loud = sine(1000, 2, 0.5);
    const tone = sine(1000, 2, 0.003);
    const mixed = new Float32Array(loud.length + tone.length);
    mixed.set(loud, 0);
    mixed.set(tone, loud.length);

    const gated = integratedLoudness(mixed, SR);
    const loudOnly = integratedLoudness(sine(1000, 2, 0.5), SR);
    expect(Math.abs(gated - loudOnly)).toBeLessThan(1.5);
  });
});

describe('enhance measurement ordering, isolated', () => {
  it('plans gain from the audio as it will be exported, not the input', () => {
    // Most of this signal's energy is at 40 Hz, which the highpass removes. A
    // chain that planned gain from the pre-filter measurement would think the
    // track was already loud and under-gain it badly.
    const rumble = sine(40, 3, 0.7);
    const voice = sine(1000, 3, 0.05);
    const mixed = new Float32Array(rumble.length);
    for (let i = 0; i < mixed.length; i++) mixed[i] = rumble[i] + voice[i];

    const report = enhance(mixed, SR);
    expect(report.loudnessAfterLufs).toBeGreaterThan(-18);
    expect(report.loudnessAfterLufs).toBeLessThan(-10);
  });
});
