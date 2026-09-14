import { requireNativeModule } from 'expo-modules-core';

export interface DecodedAudio {
  /** Interleaved 16-bit signed PCM, little endian. */
  samples: Uint8Array;
  sampleRate: number;
  channels: number;
  /** Seconds. */
  duration: number;
}

export interface EncodedAudio {
  uri: string;
}

interface AudioCodecModule {
  /** Decodes any audio or video file's audio track to raw PCM. */
  decode(uri: string): Promise<DecodedAudio>;
  /** Writes PCM back out as AAC in an m4a container. */
  encode(samples: Uint8Array, sampleRate: number, channels: number): Promise<EncodedAudio>;
}

/**
 * Audio decode and encode, and deliberately nothing else.
 *
 * The cleanup itself stays in TypeScript. It could have been written twice in
 * Swift and Kotlin and would have run faster, but then the filters, the
 * loudness measurement and the gain planning that the test suite actually
 * covers would not be the code that ships -- two untested reimplementations
 * would be, and a BS.1770 gate or a biquad that is subtly wrong on one platform
 * is not something a user can see until the file is posted.
 *
 * Samples cross the bridge as a typed array rather than an array of numbers.
 * Three minutes of stereo 48 kHz is seventeen million samples; as JS numbers
 * that is a bridge call that never returns.
 */
export const codec = requireNativeModule<AudioCodecModule>('AudioCodec');

/** Interleaved Int16 bytes to the mono Float32 the DSP works in. */
export const toMono = (decoded: DecodedAudio): Float32Array => {
  const view = new DataView(
    decoded.samples.buffer,
    decoded.samples.byteOffset,
    decoded.samples.byteLength,
  );
  const frames = Math.floor(decoded.samples.byteLength / 2 / decoded.channels);
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < decoded.channels; channel += 1) {
      sum += view.getInt16((frame * decoded.channels + channel) * 2, true);
    }
    // 32768 rather than 32767: the negative extreme is what clips first, and
    // dividing by 32767 lets a full-scale negative sample come back above 1.0.
    mono[frame] = sum / decoded.channels / 32768;
  }
  return mono;
};

/** Float32 back to interleaved Int16 bytes for the encoder. */
export const fromMono = (samples: Float32Array): Uint8Array => {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(index * 2, Math.round(clamped * 32767), true);
  }
  return bytes;
};

export default codec;
