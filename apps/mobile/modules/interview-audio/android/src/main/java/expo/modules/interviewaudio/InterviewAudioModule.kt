package expo.modules.interviewaudio

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.Uri
import android.os.Process
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import kotlin.math.max
import kotlin.math.sqrt

class InterviewAudioModule : Module() {
  private val lifecycleLock = Any()
  @Volatile private var capturing = false
  private var disposed = false
  private var recorder: AudioRecord? = null
  private var worker: Thread? = null
  private var output: RandomAccessFile? = null
  private var path: File? = null
  private var byteCount = 0L
  private var sequence = 0
  private var nativeRate = 24000
  private var pending = ByteArray(4800)
  private var pendingBytes = 0
  private var squared = 0.0
  private var previous = 0.0
  private var lowPass = PcmLowPass(24000)
  private var inputIndex = 0L
  private var nextOutputPosition = 0.0

  override fun definition() = ModuleDefinition {
    Name("InterviewAudio")
    Events("onAudioChunk", "onAudioError")
    AsyncFunction("start") { synchronized(lifecycleLock) { startRecording() } }
    AsyncFunction("pause") { synchronized(lifecycleLock) { stopCapture(); finalizeHeader(); sequence - 1 } }
    AsyncFunction("resume") {
      synchronized(lifecycleLock) {
        check(output != null) { "No recording to resume" }
        if (!capturing) { stopCapture(); beginCapture() }
      }
    }
    AsyncFunction("stop") { synchronized(lifecycleLock) { finishRecording() } }
    OnDestroy { synchronized(lifecycleLock) { disposed = true; finishRecording() } }
  }

  private fun startRecording() {
    check(!disposed) { "The audio runtime has been closed" }
    check(output == null) { "A recording already exists" }
    val context = appContext.reactContext ?: error("React context is unavailable")
    check(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
      "Microphone permission is required"
    }
    val folder = File(context.filesDir, "interview-recordings")
    check(folder.exists() || folder.mkdirs()) { "Cannot create recordings folder" }
    path = File(folder, "interview-${UUID.randomUUID()}.wav")
    byteCount = 0
    sequence = 0
    pendingBytes = 0
    squared = 0.0
    try {
      // Retain the handle before the first write, so a full disk during header
      // initialization still reaches the normal close path below.
      output = RandomAccessFile(path, "rw")
      output!!.write(ByteArray(44))
      finalizeHeader()
      beginCapture()
    } catch (error: Exception) {
      try { finishRecording() } catch (cleanupError: Exception) {
        error.addSuppressed(cleanupError)
      } finally {
        path?.delete()
        path = null
      }
      throw error
    }
  }

  private fun beginCapture() {
    // 24 kHz is preferred; some physical devices only accept their hardware rate.
    var selected: AudioRecord? = null
    for (rate in listOf(24000, 48000, 44100)) {
      val minimum = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      if (minimum <= 0) continue
      val candidate = try {
        AudioRecord.Builder()
          .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
          .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
          .setBufferSizeInBytes(max(minimum * 2, rate / 5 * 2)).build()
      } catch (_: IllegalArgumentException) { continue }
        catch (_: UnsupportedOperationException) { continue }
      if (candidate.state == AudioRecord.STATE_INITIALIZED) {
        selected = candidate
        nativeRate = rate
        break
      }
      candidate.release()
    }
    val activeRecorder = selected ?: error("This device cannot initialize microphone PCM capture")
    recorder = activeRecorder
    inputIndex = 0
    nextOutputPosition = 0.0
    previous = 0.0
    // A new capture (including resume) must not retain the previous segment's FIR history.
    lowPass = PcmLowPass(nativeRate)
    try {
      activeRecorder.startRecording()
      check(activeRecorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "Microphone failed to start" }
      capturing = true
      worker = Thread({ capture(activeRecorder) }, "interview-audio-capture").apply { start() }
    } catch (error: Exception) {
      capturing = false
      activeRecorder.release()
      recorder = null
      throw error
    }
  }

  private fun capture(activeRecorder: AudioRecord) {
    val input = ShortArray(nativeRate / 50)
    try {
      Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
      while (capturing) {
        val count = activeRecorder.read(input, 0, input.size, AudioRecord.READ_BLOCKING)
        if (count < 0) {
          if (!capturing) break
          error("Microphone read failed ($count)")
        }
        if (!capturing) break
        for (i in 0 until count) {
          val current = lowPass.push(input[i].toDouble())
          // One continuous phase across read buffers avoids drift at 44.1/48 kHz.
          while (nextOutputPosition <= inputIndex) {
            val fraction = if (inputIndex == 0L) 1.0 else nextOutputPosition - (inputIndex - 1)
            val sample = (previous + (current - previous) * fraction).toInt().coerceIn(-32768, 32767)
            appendSample(sample)
            nextOutputPosition += nativeRate.toDouble() / 24000.0
          }
          previous = current
          inputIndex++
        }
      }
    } catch (error: Exception) {
      capturing = false
      try { activeRecorder.stop() } catch (_: Exception) { }
      sendEvent("onAudioError", mapOf("message" to "录音中断：${error.message ?: "音频设备不可用"}"))
    } finally {
      try { flushChunk(); finalizeHeader() } catch (error: Exception) {
        sendEvent("onAudioError", mapOf("message" to "保存录音失败：${error.message}"))
      }
    }
  }

  private fun appendSample(sample: Int) {
    pending[pendingBytes++] = (sample and 0xff).toByte()
    pending[pendingBytes++] = ((sample shr 8) and 0xff).toByte()
    val normalized = sample / 32768.0
    squared += normalized * normalized
    if (pendingBytes == pending.size) flushChunk()
  }

  private fun flushChunk() {
    if (pendingBytes == 0) return
    val bytes = pending.copyOf(pendingBytes)
    output?.write(bytes)
    byteCount += bytes.size
    val level = sqrt(squared / (pendingBytes / 2)).coerceIn(0.0, 1.0)
    pendingBytes = 0
    squared = 0.0
    // Keep the on-disk header valid as chunks arrive, including after a process crash.
    finalizeHeader()
    sendEvent("onAudioChunk", mapOf("audio" to Base64.encodeToString(bytes, Base64.NO_WRAP), "level" to level, "seq" to sequence++))
  }

  private fun stopCapture() {
    capturing = false
    try { recorder?.stop() } catch (_: IllegalStateException) { }
    // stop() unblocks READ_BLOCKING. Never release the device/file while its worker is writing.
    worker?.join()
    worker = null
    recorder?.release()
    recorder = null
  }

  private fun finalizeHeader() {
    val file = output ?: return
    check(byteCount <= 0xffffffffL - 36L) { "WAV size limit reached" }
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
      .put("RIFF".toByteArray()).putInt((36 + byteCount).toInt()).put("WAVEfmt ".toByteArray())
      .putInt(16).putShort(1).putShort(1).putInt(24000).putInt(48000)
      .putShort(2).putShort(16).put("data".toByteArray()).putInt(byteCount.toInt()).array()
    file.seek(0)
    file.write(header)
    file.seek(44 + byteCount)
  }

  private fun finishRecording(): Map<String, Any>? {
    stopCapture()
    val file = output ?: return null
    try { finalizeHeader(); file.fd.sync() } finally {
      // Even a failed close must not leave an unusable file as the active session.
      try { file.close() } finally { output = null }
    }
    return mapOf("uri" to Uri.fromFile(path).toString(), "mimeType" to "audio/wav", "durationMs" to byteCount * 1000 / 48000, "lastSeq" to sequence - 1)
  }
}
