import { useAudioStore, FREE_SECONDS } from "../useAudioStore";
import type { EnhanceReport } from "../../engine/enhanceChain";

const SOURCE = {
  uri: "file:///take.m4a",
  name: "take.m4a",
  sampleRate: 48000,
  channels: 1,
  duration: 30,
};
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

describe("useAudioStore", () => {
  it("keeps the decoded samples with the file they came from", () => {
    const samples = new Float32Array([0.1, -0.1]);
    useAudioStore.getState().setSource(SOURCE, samples);
    expect(useAudioStore.getState().samples).toBe(samples);
    expect(useAudioStore.getState().source?.name).toBe("take.m4a");
  });

  it("clears the previous result when a new file is loaded", () => {
    useAudioStore.getState().setSource(SOURCE, new Float32Array(2));
    useAudioStore.getState().setResult(REPORT, "file:///out.m4a");
    useAudioStore
      .getState()
      .setSource({ ...SOURCE, name: "other.m4a" }, new Float32Array(2));
    expect(useAudioStore.getState().report).toBeNull();
    expect(useAudioStore.getState().outputUri).toBeNull();
  });

  it("replaces the active file entirely when a different one is chosen", () => {
    // A tester reported that tapping "choose different recording" let them pick
    // a new file but the screen kept showing the old one's name. The picker's
    // own callback (`app/index.tsx`'s `handlePick`) calls `setSource` with the
    // freshly-picked file before it even finishes decoding, specifically so the
    // displayed name updates right away -- this pins that the store actually
    // replaces `source` and `samples` wholesale rather than merging or keeping
    // anything from the file it replaces.
    useAudioStore.getState().setSource(SOURCE, new Float32Array([0.1, -0.1]));
    const OTHER = {
      uri: "file:///second-take.wav",
      name: "second-take.wav",
      sampleRate: 44100,
      channels: 2,
      duration: 12,
    };
    const otherSamples = new Float32Array([0.5, -0.5, 0.25]);
    useAudioStore.getState().setSource(OTHER, otherSamples);

    expect(useAudioStore.getState().source).toEqual(OTHER);
    expect(useAudioStore.getState().source?.name).toBe("second-take.wav");
    expect(useAudioStore.getState().samples).toBe(otherSamples);
  });

  it("reports ready once a result exists", () => {
    useAudioStore.getState().setSource(SOURCE, new Float32Array(2));
    useAudioStore.getState().setResult(REPORT, "file:///out.m4a");
    expect(useAudioStore.getState().stage).toBe("ready");
    expect(useAudioStore.getState().report?.loudnessAfterLufs).toBe(-14);
  });

  it("flags a file past the free duration, and stops flagging once unlocked", () => {
    useAudioStore
      .getState()
      .setSource({ ...SOURCE, duration: FREE_SECONDS + 1 });
    expect(useAudioStore.getState().overFreeLimit()).toBe(true);
    useAudioStore.getState().setIsPro(true);
    expect(useAudioStore.getState().overFreeLimit()).toBe(false);
  });

  it("allows a file exactly at the free limit", () => {
    useAudioStore.getState().setSource({ ...SOURCE, duration: FREE_SECONDS });
    expect(useAudioStore.getState().overFreeLimit()).toBe(false);
  });

  it("flags nothing with no file loaded", () => {
    expect(useAudioStore.getState().overFreeLimit()).toBe(false);
  });
});
