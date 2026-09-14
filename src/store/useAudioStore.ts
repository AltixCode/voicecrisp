import { create } from 'zustand';
import { BROADCAST, type EnhanceReport, type EnhanceSettings } from '../engine/enhanceChain';

/** Seconds of audio a free user can clean in one export. */
export const FREE_SECONDS = 120;

export type Stage = 'idle' | 'decoding' | 'cleaning' | 'encoding' | 'ready';

export interface Source {
  uri: string;
  name: string;
  sampleRate: number;
  channels: number;
  /** Seconds. */
  duration: number;
}

interface AudioState {
  source: Source | null;
  /** Mono float samples, as decoded. Kept so a second clean does not re-decode. */
  samples: Float32Array | null;
  report: EnhanceReport | null;
  outputUri: string | null;
  settings: EnhanceSettings;
  stage: Stage;
  progress: number;
  isPro: boolean;

  setSource: (source: Source | null, samples?: Float32Array) => void;
  setResult: (report: EnhanceReport, outputUri: string) => void;
  setStage: (stage: Stage, progress?: number) => void;
  setIsPro: (pro: boolean) => void;
  reset: () => void;

  /** Whether the loaded file is longer than the free tier allows. */
  overFreeLimit: () => boolean;
}

export const useAudioStore = create<AudioState>((set, get) => ({
  source: null,
  samples: null,
  report: null,
  outputUri: null,
  settings: BROADCAST,
  stage: 'idle',
  progress: 0,
  isPro: false,

  // A new file clears the previous result outright. Leaving the old report on
  // screen beside a new file is the kind of thing a user only notices after
  // posting the wrong export.
  setSource: (source, samples) =>
    set({ source, samples: samples ?? null, report: null, outputUri: null, stage: 'idle', progress: 0 }),
  setResult: (report, outputUri) => set({ report, outputUri, stage: 'ready', progress: 1 }),
  setStage: (stage, progress = 0) => set({ stage, progress }),
  setIsPro: (pro) => set({ isPro: pro }),
  reset: () => set({ source: null, samples: null, report: null, outputUri: null, stage: 'idle', progress: 0 }),

  overFreeLimit: () => {
    const { source, isPro } = get();
    return !isPro && !!source && source.duration > FREE_SECONDS;
  },
}));
