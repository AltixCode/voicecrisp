// Verifies the file VoiceCrisp exported, independently of the app.
//
// Usage: verify-cleanup <source.wav> <cleaned.m4a>
//
// The app's own loudness engine is unit tested, but a unit test cannot tell you
// that the file on disk is the audio those units produced: the wrong buffer
// could be encoded, the sample rate could be misread, a stage could be skipped,
// or the encoder could undo the work. So this decodes the exported file and
// measures it from scratch.
//
// The K-weighting coefficients below are the published BS.1770-4 values for
// 48 kHz, taken from the table rather than derived. Deriving them the same way
// the app does would make this a check that the app agrees with itself, which
// is the one thing it must not be.

import AVFoundation
import Foundation

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
  FileHandle.standardError.write(Data("usage: verify-cleanup <source> <cleaned>\n".utf8))
  exit(2)
}

/// The chain targets -14 LUFS. A dB either side covers the encoder and the
/// gating landing on slightly different blocks; more than that is a miss.
let targetLufs = -14.0
let loudnessTolerance = 1.0
/// The chain's ceiling is -1.5 dBFS. AAC is lossy and can overshoot slightly on
/// decode, so the gate is a shade looser than the ceiling itself.
let peakCeilingDb = -1.3
/// The fixture's rumble sits here, below anything in a voice.
let rumbleHz = 42.0
/// How much of it the high-pass has to remove.
let minimumRumbleRejectionDb = 12.0

struct Failure: Error { let message: String }

func readMono(_ url: URL) throws -> (samples: [Float], sampleRate: Double) {
  let file = try AVAudioFile(forReading: url)
  let format = file.processingFormat
  guard let buffer = AVAudioPCMBuffer(
    pcmFormat: format,
    frameCapacity: AVAudioFrameCount(file.length)
  ) else {
    throw Failure(message: "could not allocate a buffer for \(url.lastPathComponent)")
  }
  try file.read(into: buffer)
  let frames = Int(buffer.frameLength)
  guard frames > 0, let channels = buffer.floatChannelData else {
    throw Failure(message: "\(url.lastPathComponent) contains no audio")
  }
  let channelCount = Int(format.channelCount)
  var mono = [Float](repeating: 0, count: frames)
  for frame in 0..<frames {
    var sum: Float = 0
    for channel in 0..<channelCount { sum += channels[channel][frame] }
    mono[frame] = sum / Float(channelCount)
  }
  return (mono, format.sampleRate)
}

/// Transposed direct form II, so a stage can be run over a whole signal.
func biquad(_ input: [Double], _ b: [Double], _ a: [Double]) -> [Double] {
  var z1 = 0.0
  var z2 = 0.0
  var output = [Double](repeating: 0, count: input.count)
  for index in 0..<input.count {
    let x = input[index]
    let y = b[0] * x + z1
    z1 = b[1] * x - a[1] * y + z2
    z2 = b[2] * x - a[2] * y
    output[index] = y
  }
  return output
}

/// ITU-R BS.1770-4 integrated loudness, gating and all.
func integratedLoudness(_ samples: [Float], sampleRate: Double) throws -> Double {
  guard abs(sampleRate - 48_000) < 1 else {
    throw Failure(message: String(format: "expected 48 kHz audio, got %.0f Hz", sampleRate))
  }
  // BS.1770-4 Tables 1 and 2, at 48 kHz.
  let shelfB = [1.53512485958697, -2.69169618940638, 1.19839281085285]
  let shelfA = [1.0, -1.69065929318241, 0.73248077421585]
  let highpassB = [1.0, -2.0, 1.0]
  let highpassA = [1.0, -1.99004745483398, 0.99007225036621]

  let weighted = biquad(biquad(samples.map(Double.init), shelfB, shelfA), highpassB, highpassA)

  let blockSize = Int(0.4 * sampleRate)
  let step = blockSize / 4
  guard weighted.count >= blockSize else {
    throw Failure(message: "the audio is shorter than one loudness block")
  }

  var blockLoudness: [Double] = []
  var start = 0
  while start + blockSize <= weighted.count {
    var sum = 0.0
    for index in start..<(start + blockSize) { sum += weighted[index] * weighted[index] }
    let mean = sum / Double(blockSize)
    blockLoudness.append(-0.691 + 10 * log10(max(mean, 1e-20)))
    start += step
  }

  // Absolute gate first, then a relative gate 10 LU below what survives it.
  let absolute = blockLoudness.filter { $0 > -70 }
  guard !absolute.isEmpty else { return -.infinity }
  func meanLoudness(_ blocks: [Double]) -> Double {
    let power = blocks.reduce(0.0) { $0 + pow(10, ($1 + 0.691) / 10) } / Double(blocks.count)
    return -0.691 + 10 * log10(max(power, 1e-20))
  }
  let relativeThreshold = meanLoudness(absolute) - 10
  let gated = absolute.filter { $0 > relativeThreshold }
  return meanLoudness(gated.isEmpty ? absolute : gated)
}

func samplePeakDb(_ samples: [Float]) -> Double {
  let peak = samples.reduce(0.0) { max($0, Double(abs($1))) }
  return peak > 0 ? 20 * log10(peak) : -.infinity
}

/// Amplitude at one frequency, by the Goertzel algorithm.
func amplitudeDb(_ samples: [Float], sampleRate: Double, frequency: Double) -> Double {
  let count = samples.count
  guard count > 0 else { return -.infinity }
  let omega = 2 * Double.pi * frequency / sampleRate
  let coefficient = 2 * cos(omega)
  var s1 = 0.0
  var s2 = 0.0
  for sample in samples {
    let s0 = Double(sample) + coefficient * s1 - s2
    s2 = s1
    s1 = s0
  }
  let power = s1 * s1 + s2 * s2 - coefficient * s1 * s2
  let amplitude = 2 * sqrt(max(power, 0)) / Double(count)
  return amplitude > 0 ? 20 * log10(amplitude) : -.infinity
}

var failures: [String] = []
var notes: [String] = []

do {
  let source = try readMono(URL(fileURLWithPath: arguments[1]))
  let cleaned = try readMono(URL(fileURLWithPath: arguments[2]))

  if abs(source.sampleRate - cleaned.sampleRate) > 1 {
    failures.append(String(format: "sample rate changed: %.0f Hz -> %.0f Hz", source.sampleRate, cleaned.sampleRate))
  }

  let sourceSeconds = Double(source.samples.count) / source.sampleRate
  let cleanedSeconds = Double(cleaned.samples.count) / cleaned.sampleRate
  if abs(sourceSeconds - cleanedSeconds) > 0.3 {
    failures.append(String(format: "duration changed: %.2fs -> %.2fs", sourceSeconds, cleanedSeconds))
  }

  let loudness = try integratedLoudness(cleaned.samples, sampleRate: cleaned.sampleRate)
  if abs(loudness - targetLufs) > loudnessTolerance {
    failures.append(String(format: "loudness is %.2f LUFS, not %.0f", loudness, targetLufs))
  }

  let peak = samplePeakDb(cleaned.samples)
  if peak > peakCeilingDb {
    failures.append(String(format: "peak is %.2f dB, above the %.1f dB ceiling", peak, peakCeilingDb))
  }

  // The rumble is measured relative to the overall level of each file, because
  // the cleanup deliberately raises everything: comparing raw amplitudes would
  // credit the high-pass for gain it did not apply, or blame it for gain it
  // did.
  let sourceLoudness = try integratedLoudness(source.samples, sampleRate: source.sampleRate)
  let sourceRumble = amplitudeDb(source.samples, sampleRate: source.sampleRate, frequency: rumbleHz) - sourceLoudness
  let cleanedRumble = amplitudeDb(cleaned.samples, sampleRate: cleaned.sampleRate, frequency: rumbleHz) - loudness
  let rejection = sourceRumble - cleanedRumble
  if rejection < minimumRumbleRejectionDb {
    failures.append(String(format: "the high-pass removed only %.1f dB of %.0f Hz rumble", rejection, rumbleHz))
  }

  notes.append(String(format: "%.2fs, %.0f Hz, %.2f LUFS (from %.2f), peak %.2f dB, rumble down %.1f dB",
                      cleanedSeconds, cleaned.sampleRate, loudness, sourceLoudness, peak, rejection))
} catch let failure as Failure {
  failures.append(failure.message)
} catch {
  failures.append(error.localizedDescription)
}

for note in notes { print("  \(note)") }
if failures.isEmpty {
  print("PASS \(URL(fileURLWithPath: arguments[2]).lastPathComponent)")
  exit(0)
}
for failure in failures { print("FAIL \(failure)") }
exit(1)
