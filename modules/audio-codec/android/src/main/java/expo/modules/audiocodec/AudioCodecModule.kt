package expo.modules.audiocodec

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Decodes audio to PCM and encodes it back to AAC.
 *
 * Everything between those two steps -- the filters, the loudness measurement,
 * the gain planning -- stays in TypeScript, where it is tested. Writing the
 * chain again in Kotlin would mean the tested code is not the shipped code, and
 * a loudness gate that is subtly wrong on one platform is invisible until a
 * file is posted.
 */
class AudioCodecModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AudioCodec")

    AsyncFunction("decode") { uri: String ->
      val decoded = decode(path(uri))
      mapOf(
        "samples" to decoded.pcm,
        "sampleRate" to decoded.sampleRate,
        "channels" to decoded.channels,
        "duration" to decoded.duration,
      )
    }

    AsyncFunction("encode") { samples: ByteArray, sampleRate: Int, channels: Int ->
      val output = File(cacheDir(), "voicecrisp_${System.currentTimeMillis()}.m4a")
      encode(samples, sampleRate, channels, output)
      mapOf("uri" to Uri.fromFile(output).toString())
    }
  }

  private class Decoded(
    val pcm: ByteArray,
    val sampleRate: Int,
    val channels: Int,
    val duration: Double,
  )

  private fun decode(path: String): Decoded {
    val extractor = MediaExtractor()
    extractor.setDataSource(path)

    var track = -1
    for (index in 0 until extractor.trackCount) {
      val mime = extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME) ?: continue
      if (mime.startsWith("audio/")) { track = index; break }
    }
    if (track < 0) {
      extractor.release()
      throw Exception("This file has no audio track.")
    }

    extractor.selectTrack(track)
    val format = extractor.getTrackFormat(track)
    val decoder = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
    decoder.configure(format, null, null, 0)
    decoder.start()

    // The source's own rate and channel count are kept. Resampling here would
    // change what the loudness measurement is measuring, and a recording that
    // comes back at a different rate than it went in is a bug report.
    var sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
    var channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)

    val out = ByteArrayOutputStream()
    val info = MediaCodec.BufferInfo()
    var inputDone = false
    var outputDone = false

    try {
      while (!outputDone) {
        if (!inputDone) {
          val index = decoder.dequeueInputBuffer(10_000)
          if (index >= 0) {
            val buffer = decoder.getInputBuffer(index)!!
            val size = extractor.readSampleData(buffer, 0)
            if (size < 0) {
              decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              decoder.queueInputBuffer(index, 0, size, extractor.sampleTime, 0)
              extractor.advance()
            }
          }
        }

        val index = decoder.dequeueOutputBuffer(info, 10_000)
        when {
          index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            // The decoder is the authority on what it produced; the extractor's
            // format can differ from the decoded stream.
            val decodedFormat = decoder.outputFormat
            sampleRate = decodedFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            channels = decodedFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
          }
          index >= 0 -> {
            val buffer = decoder.getOutputBuffer(index)!!
            buffer.position(info.offset)
            buffer.limit(info.offset + info.size)
            val bytes = ByteArray(info.size)
            buffer.get(bytes)
            out.write(bytes)
            decoder.releaseOutputBuffer(index, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
          }
        }
      }
    } finally {
      runCatching { decoder.stop() }
      runCatching { decoder.release() }
      extractor.release()
    }

    val pcm = out.toByteArray()
    if (pcm.isEmpty()) throw Exception("This file has no audio to clean.")
    val frames = pcm.size / 2 / channels
    return Decoded(pcm, sampleRate, channels, frames.toDouble() / sampleRate)
  }

  private fun encode(pcm: ByteArray, sampleRate: Int, channels: Int, output: File) {
    if (pcm.isEmpty()) throw Exception("There is no audio to write.")

    val format = MediaFormat.createAudioFormat("audio/mp4a-latm", sampleRate, channels).apply {
      setInteger(MediaFormat.KEY_AAC_PROFILE, android.media.MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      // 128 kbps per channel is transparent for speech; the cleanup would be
      // pointless if the encoder undid it.
      setInteger(MediaFormat.KEY_BIT_RATE, 128_000 * channels)
      setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 64 * 1024)
    }

    val encoder = MediaCodec.createEncoderByType("audio/mp4a-latm")
    encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    encoder.start()

    val muxer = MediaMuxer(output.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    var muxerTrack = -1
    var muxerStarted = false

    val bytesPerFrame = 2 * channels
    var offset = 0
    var framesQueued = 0L
    val info = MediaCodec.BufferInfo()
    var inputDone = false
    var outputDone = false

    try {
      while (!outputDone) {
        if (!inputDone) {
          val index = encoder.dequeueInputBuffer(10_000)
          if (index >= 0) {
            val buffer = encoder.getInputBuffer(index)!!
            buffer.clear()
            val length = minOf(buffer.capacity(), pcm.size - offset).let {
              // Whole frames only: a partial frame splits a sample across two
              // buffers and the encoder reads the halves as separate samples,
              // which is audible as a click.
              it - it % bytesPerFrame
            }
            if (length <= 0) {
              encoder.queueInputBuffer(index, 0, 0, presentationUs(framesQueued, sampleRate), MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              buffer.put(pcm, offset, length)
              encoder.queueInputBuffer(index, 0, length, presentationUs(framesQueued, sampleRate), 0)
              offset += length
              framesQueued += length / bytesPerFrame
            }
          }
        }

        val index = encoder.dequeueOutputBuffer(info, 10_000)
        when {
          index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            muxerTrack = muxer.addTrack(encoder.outputFormat)
            muxer.start()
            muxerStarted = true
          }
          index >= 0 -> {
            val buffer = encoder.getOutputBuffer(index)!!
            if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
            if (info.size > 0 && muxerStarted) {
              buffer.position(info.offset)
              buffer.limit(info.offset + info.size)
              muxer.writeSampleData(muxerTrack, buffer, info)
            }
            encoder.releaseOutputBuffer(index, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
          }
        }
      }
    } finally {
      runCatching { encoder.stop() }
      runCatching { encoder.release() }
      if (muxerStarted) runCatching { muxer.stop() }
      runCatching { muxer.release() }
    }

    if (!output.exists() || output.length() == 0L) {
      throw Exception("The audio could not be written.")
    }
  }

  private fun presentationUs(frames: Long, sampleRate: Int): Long =
    frames * 1_000_000L / sampleRate

  private fun cacheDir(): File =
    appContext.reactContext?.cacheDir ?: throw Exception("No cache directory is available.")

  /** MediaExtractor takes file paths; the pickers hand back file:// URIs. */
  private fun path(uri: String): String {
    if (uri.startsWith("file://")) return Uri.parse(uri).path ?: uri
    return uri
  }
}
