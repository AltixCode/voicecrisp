import ExpoModulesCore
import AVFoundation

/// Decodes audio to PCM and encodes it back to AAC.
///
/// Everything between those two steps -- the filters, the loudness measurement,
/// the gain planning -- stays in TypeScript, where it is tested. Writing the
/// chain again in Swift would mean the tested code is not the shipped code, and
/// a loudness gate that is subtly wrong on one platform is invisible until a
/// file is posted.
public class AudioCodecModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AudioCodec")

    AsyncFunction("decode") { (uri: String, promise: Promise) in
      Task {
        do {
          let decoded = try await Self.decode(url: Self.url(uri))
          promise.resolve([
            "samples": decoded.samples,
            "sampleRate": decoded.sampleRate,
            "channels": decoded.channels,
            "duration": decoded.duration,
          ])
        } catch let error as CodecError {
          promise.reject("ERR_AUDIO", error.message)
        } catch {
          promise.reject("ERR_AUDIO", error.localizedDescription)
        }
      }
    }

    AsyncFunction("encode") {
      (samples: Data, sampleRate: Int, channels: Int, promise: Promise) in
      Task {
        do {
          let output = try await Self.encode(pcm: samples, sampleRate: sampleRate, channels: channels)
          promise.resolve(["uri": output.absoluteString])
        } catch let error as CodecError {
          promise.reject("ERR_AUDIO", error.message)
        } catch {
          promise.reject("ERR_AUDIO", error.localizedDescription)
        }
      }
    }

    AsyncFunction("saveToFiles") { (uri: String, promise: Promise) in
      DispatchQueue.main.async {
        guard let vc = self.appContext?.utilities?.currentViewController() else {
          promise.resolve(false)
          return
        }
        let url = Self.url(uri)
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        vc.present(picker, animated: true) {
          promise.resolve(true)
        }
      }
    }
  }

  private struct Decoded {
    let samples: Data
    let sampleRate: Int
    let channels: Int
    let duration: Double
  }

  private static func decode(url: URL) async throws -> Decoded {
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
      throw CodecError("This file has no audio track.")
    }

    // The source's own rate and channel count are kept. Resampling here would
    // change what the loudness measurement is measuring, and a voice recording
    // that comes back at a different rate than it went in is a bug report.
    let descriptions = try await track.load(.formatDescriptions)
    guard
      let description = descriptions.first,
      let basic = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee
    else {
      throw CodecError("This audio format could not be read.")
    }
    let sampleRate = Int(basic.mSampleRate)
    let channels = max(1, Int(basic.mChannelsPerFrame))

    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(
      track: track,
      outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: sampleRate,
        AVNumberOfChannelsKey: channels,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
      ]
    )
    guard reader.canAdd(output) else {
      throw CodecError("This audio track cannot be decoded on this device.")
    }
    reader.add(output)
    guard reader.startReading() else {
      throw CodecError(reader.error?.localizedDescription ?? "The audio could not be read.")
    }

    var pcm = Data()
    while let sample = output.copyNextSampleBuffer() {
      guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
      let length = CMBlockBufferGetDataLength(block)
      var bytes = [UInt8](repeating: 0, count: length)
      if CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: &bytes) == kCMBlockBufferNoErr {
        pcm.append(contentsOf: bytes)
      }
    }

    if reader.status == .failed {
      throw CodecError(reader.error?.localizedDescription ?? "The audio could not be decoded.")
    }
    guard !pcm.isEmpty else {
      throw CodecError("This file has no audio to clean.")
    }

    let frames = pcm.count / 2 / channels
    return Decoded(
      samples: pcm,
      sampleRate: sampleRate,
      channels: channels,
      duration: Double(frames) / Double(sampleRate)
    )
  }

  private static func encode(pcm: Data, sampleRate: Int, channels: Int) async throws -> URL {
    guard !pcm.isEmpty else {
      throw CodecError("There is no audio to write.")
    }

    let destination = FileManager.default.temporaryDirectory
      .appendingPathComponent("voicecrisp_\(Int(Date().timeIntervalSince1970 * 1000)).m4a")
    let writer = try AVAssetWriter(outputURL: destination, fileType: .m4a)
    let input = AVAssetWriterInput(
      mediaType: .audio,
      outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: sampleRate,
        AVNumberOfChannelsKey: channels,
        // 128 kbps mono is transparent for speech; the cleanup would be
        // pointless if the encoder undid it.
        AVEncoderBitRateKey: 128_000 * channels,
      ]
    )
    input.expectsMediaDataInRealTime = false
    writer.add(input)
    writer.startWriting()
    writer.startSession(atSourceTime: .zero)

    var format = AudioStreamBasicDescription(
      mSampleRate: Float64(sampleRate),
      mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
      mBytesPerPacket: UInt32(2 * channels),
      mFramesPerPacket: 1,
      mBytesPerFrame: UInt32(2 * channels),
      mChannelsPerFrame: UInt32(channels),
      mBitsPerChannel: 16,
      mReserved: 0
    )
    var formatDescription: CMAudioFormatDescription?
    guard CMAudioFormatDescriptionCreate(
      allocator: kCFAllocatorDefault,
      asbd: &format,
      layoutSize: 0,
      layout: nil,
      magicCookieSize: 0,
      magicCookie: nil,
      extensions: nil,
      formatDescriptionOut: &formatDescription
    ) == noErr, let formatDescription else {
      throw CodecError("The audio format could not be described.")
    }

    // Written in chunks rather than one buffer: a single sample buffer holding
    // minutes of PCM is tens of megabytes the encoder has to hold at once.
    let bytesPerFrame = 2 * channels
    let framesPerChunk = sampleRate
    let bytesPerChunk = framesPerChunk * bytesPerFrame
    var offset = 0
    var presentation = CMTime.zero

    while offset < pcm.count {
      let length = min(bytesPerChunk, pcm.count - offset)
      let frames = length / bytesPerFrame
      guard frames > 0 else { break }

      let chunk = pcm.subdata(in: offset..<(offset + frames * bytesPerFrame))
      var block: CMBlockBuffer?
      let bytes = UnsafeMutableRawPointer.allocate(byteCount: chunk.count, alignment: 1)
      chunk.copyBytes(to: bytes.assumingMemoryBound(to: UInt8.self), count: chunk.count)
      guard CMBlockBufferCreateWithMemoryBlock(
        allocator: kCFAllocatorDefault,
        memoryBlock: bytes,
        blockLength: chunk.count,
        blockAllocator: kCFAllocatorDefault,
        customBlockSource: nil,
        offsetToData: 0,
        dataLength: chunk.count,
        flags: 0,
        blockBufferOut: &block
      ) == noErr, let block else {
        bytes.deallocate()
        throw CodecError("The audio could not be prepared for encoding.")
      }

      var sample: CMSampleBuffer?
      var timing = CMSampleTimingInfo(
        duration: CMTime(value: 1, timescale: CMTimeScale(sampleRate)),
        presentationTimeStamp: presentation,
        decodeTimeStamp: .invalid
      )
      guard CMSampleBufferCreateReady(
        allocator: kCFAllocatorDefault,
        dataBuffer: block,
        formatDescription: formatDescription,
        sampleCount: frames,
        sampleTimingEntryCount: 1,
        sampleTimingArray: &timing,
        sampleSizeEntryCount: 1,
        sampleSizeArray: [bytesPerFrame],
        sampleBufferOut: &sample
      ) == noErr, let sample else {
        throw CodecError("The audio could not be prepared for encoding.")
      }

      while !input.isReadyForMoreMediaData {
        try await Task.sleep(nanoseconds: 2_000_000)
      }
      input.append(sample)

      presentation = CMTimeAdd(presentation, CMTime(value: CMTimeValue(frames), timescale: CMTimeScale(sampleRate)))
      offset += frames * bytesPerFrame
    }

    input.markAsFinished()
    await writer.finishWriting()

    guard writer.status == .completed else {
      throw CodecError(writer.error?.localizedDescription ?? "The audio could not be written.")
    }
    return destination
  }

  private static func url(_ uri: String) -> URL {
    if uri.hasPrefix("file://") {
      let path = String(uri.dropFirst(7))
      let unescaped = path.removingPercentEncoding ?? path
      return URL(fileURLWithPath: unescaped)
    }
    if let parsed = URL(string: uri), parsed.scheme != nil {
      if parsed.isFileURL {
        return URL(fileURLWithPath: parsed.path)
      }
      return parsed
    }
    return URL(fileURLWithPath: uri)
  }

  private struct CodecError: Error {
    let message: String
    init(_ message: String) { self.message = message }
  }
}
