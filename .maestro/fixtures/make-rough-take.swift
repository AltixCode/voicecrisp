// Generates VoiceCrisp's fixture: a voice recording with the three problems
// the app exists to fix.
//
// A clean recording cannot exercise this app -- the chain would have nothing to
// do and every assertion would pass on a file that was already fine. So the
// speech is synthesised with `say`, then deliberately spoiled: recorded far too
// quietly, with low-frequency rumble underneath it and a boxy resonance on top.
// Each of those is removed by a different stage of the chain, so a stage that
// silently does nothing shows up in the verifier.
//
// Build and run: swiftc -O make-rough-take.swift -o gen && ./gen

import AVFoundation
import Foundation

let sentence = "Nobody tells you the first version is meant to be embarrassing. Ship it anyway."
let sampleRate = 48_000.0

let work = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let speechURL = work.appendingPathComponent("voicecrisp-speech.wav")
let outputURL = work.appendingPathComponent("voicecrisp-rough.wav")
for url in [speechURL, outputURL] { try? FileManager.default.removeItem(at: url) }

// MARK: - Speech

// Asked for at the final rate and format outright. Letting `say` pick its own
// and converting afterwards means an AVAudioConverter in the middle of a
// fixture generator, which is a second thing that can fail for reasons that
// have nothing to do with what is being tested.
let say = Process()
say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
say.arguments = [
  "-o", speechURL.path,
  "--file-format=WAVE",
  "--data-format=LEI16@\(Int(sampleRate))",
  "-r", "170",
  sentence,
]
try say.run()
say.waitUntilExit()
guard say.terminationStatus == 0 else {
  FileHandle.standardError.write(Data("say failed\n".utf8))
  exit(1)
}

// MARK: - Read it back

let file = try AVAudioFile(forReading: speechURL)
let buffer = AVAudioPCMBuffer(
  pcmFormat: file.processingFormat,
  frameCapacity: AVAudioFrameCount(file.length)
)!
try file.read(into: buffer)

let count = Int(buffer.frameLength)
guard count > 0, let channel = buffer.floatChannelData?[0] else {
  FileHandle.standardError.write(Data("no samples\n".utf8))
  exit(1)
}
var samples = [Float](UnsafeBufferPointer(start: channel, count: count))

// MARK: - Spoil it

// Recorded far too quietly: about 20 dB under where it should sit, which is
// what a phone held at arm's length actually produces.
let quietGain = Float(pow(10.0, -20.0 / 20.0))

// Rumble: handling noise and air conditioning, below anything in a voice.
// -26 dBFS is loud enough to dominate the loudness measurement before the
// high-pass removes it, which is the point -- it proves the filter ran.
let rumbleHz = 42.0
let rumbleAmplitude = Float(pow(10.0, -26.0 / 20.0))

// Boxy room resonance around 250 Hz, the frequency the mud cut targets.
let mudHz = 250.0
let mudAmplitude = Float(pow(10.0, -30.0 / 20.0))

for index in 0..<count {
  let time = Double(index) / sampleRate
  let rumble = rumbleAmplitude * Float(sin(2 * .pi * rumbleHz * time))
  let mud = mudAmplitude * Float(sin(2 * .pi * mudHz * time))
  samples[index] = samples[index] * quietGain + rumble + mud
}

// MARK: - Write

// The settings describe what lands on disk; the buffer handed to write(from:)
// has to be in the file's processingFormat, which is always deinterleaved
// float. Handing it an Int16 buffer instead traps rather than converting.
let settings: [String: Any] = [
  AVFormatIDKey: kAudioFormatLinearPCM,
  AVSampleRateKey: sampleRate,
  AVNumberOfChannelsKey: 1,
  AVLinearPCMBitDepthKey: 16,
  AVLinearPCMIsFloatKey: false,
  AVLinearPCMIsBigEndianKey: false,
  AVLinearPCMIsNonInterleaved: false,
]
// Written inside a function so the file object is released, and therefore
// closed, before anything reads it back. A top-level `let` in a script stays
// alive until the process exits, and the header is only finalised on release:
// the file ends up on disk with a valid header claiming zero audio bytes.
func writeWav() throws {
  let outFile = try AVAudioFile(forWriting: outputURL, settings: settings)
  let outBuffer = AVAudioPCMBuffer(
    pcmFormat: outFile.processingFormat,
    frameCapacity: AVAudioFrameCount(count)
  )!
  outBuffer.frameLength = AVAudioFrameCount(count)
  for index in 0..<count {
    outBuffer.floatChannelData![0][index] = max(-1, min(1, samples[index]))
  }
  try outFile.write(from: outBuffer)
}
try writeWav()

try? FileManager.default.removeItem(at: speechURL)
print("wrote \(outputURL.lastPathComponent) (\(String(format: "%.1f", Double(count) / sampleRate))s, \(Int(sampleRate)) Hz mono)")
