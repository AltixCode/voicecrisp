import { useAudioStore, FREE_SECONDS } from '../useAudioStore';
import type { EnhanceReport } from '../../engine/enhanceChain';

const SOURCE = { uri: 'file:///take.m4a', name: 'take.m4a', sampleRate: 48000, channels: 1, duration: 30 };
const REPORT: EnhanceReport = {
  loudnessBeforeLufs: -28,
  loudnessAfterLufs: -14,
  peakAfterDb: -1.6,
  gain: { gainDb: 14, peakLimited: false },
};

beforeEach(() => {
  useAudioStore.getState().reset();
  useAudioStore.getState().setIsPro(false);
});

describe('useAudioStore', () => {
  it('keeps the decoded samples with the file they came from', () => {
    const samples = new Float32Array([0.1, -0.1]);
    useAudioStore.getState().setSource(SOURCE, samples);
    expect(useAudioStore.getState().samples).toBe(samples);
    expect(useAudioStore.getState().source?.name).toBe('take.m4a');
  });

  it('clears the previous result when a new file is loaded', () => {
    useAudioStore.getState().setSource(SOURCE, new Float32Array(2));
    useAudioStore.getState().setResult(REPORT, 'file:///out.m4a');
    useAudioStore.getState().setSource({ ...SOURCE, name: 'other.m4a' }, new Float32Array(2));
    expect(useAudioStore.getState().report).toBeNull();
    expect(useAudioStore.getState().outputUri).toBeNull();
  });

  it('reports ready once a result exists', () => {
    useAudioStore.getState().setSource(SOURCE, new Float32Array(2));
    useAudioStore.getState().setResult(REPORT, 'file:///out.m4a');
    expect(useAudioStore.getState().stage).toBe('ready');
    expect(useAudioStore.getState().report?.loudnessAfterLufs).toBe(-14);
  });

  it('flags a file past the free duration, and stops flagging once unlocked', () => {
    useAudioStore.getState().setSource({ ...SOURCE, duration: FREE_SECONDS + 1 });
    expect(useAudioStore.getState().overFreeLimit()).toBe(true);
    useAudioStore.getState().setIsPro(true);
    expect(useAudioStore.getState().overFreeLimit()).toBe(false);
  });

  it('allows a file exactly at the free limit', () => {
    useAudioStore.getState().setSource({ ...SOURCE, duration: FREE_SECONDS });
    expect(useAudioStore.getState().overFreeLimit()).toBe(false);
  });

  it('flags nothing with no file loaded', () => {
    expect(useAudioStore.getState().overFreeLimit()).toBe(false);
  });
});
