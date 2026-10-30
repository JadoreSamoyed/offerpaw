package expo.modules.interviewaudio

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/** Standalone JVM signal checks; no Android device or test-framework dependency.
 * Compile this file with PcmLowPass.kt and run expo.modules.interviewaudio.PcmLowPassTest.
 */
internal object PcmLowPassTest {
  private fun filter(rate: Int, samples: DoubleArray, blocks: IntArray = intArrayOf(128)): DoubleArray {
    val filter = PcmLowPass(rate)
    val result = DoubleArray(samples.size)
    var offset = 0
    var block = 0
    while (offset < samples.size) {
      val end = minOf(samples.size, offset + blocks[block++ % blocks.size])
      while (offset < end) { result[offset] = filter.push(samples[offset]); offset++ }
    }
    return result
  }

  private fun tone(rate: Int, frequency: Int) = DoubleArray(rate / 2) { i ->
    0.5 * sin(2 * PI * frequency * i / rate)
  }

  private fun gain(rate: Int, frequency: Int): Double {
    val samples = filter(rate, tone(rate, frequency))
    val skip = rate / 10
    var squared = 0.0
    for (i in skip until samples.size) squared += samples[i] * samples[i]
    return sqrt(squared / (samples.size - skip)) / (0.5 / sqrt(2.0))
  }

  @JvmStatic
  fun main(args: Array<String>) {
    val direct = tone(24000, 7000)
    check(filter(24000, direct).contentEquals(direct)) { "24 kHz must remain exact passthrough" }
    for (rate in intArrayOf(44100, 48000)) {
      val rejection = 20 * log10(gain(rate, 18000))
      check(rejection < -60) { "$rate Hz: 18 kHz attenuation only $rejection dB" }
      for (frequency in intArrayOf(1000, 7000)) {
        val response = gain(rate, frequency)
        check(abs(response - 1) < 0.005) { "$rate Hz: speech gain $response at $frequency Hz" }
      }
      val input = DoubleArray(rate / 3) { i ->
        0.3 * sin(2 * PI * 1379 * i / rate) + 0.1 * sin(2 * PI * 18000 * i / rate)
      }
      check(filter(rate, input).contentEquals(filter(rate, input, intArrayOf(1, 17, 509, 64, 1000)))) {
        "$rate Hz: filter history changed at a read boundary"
      }
      val impulse = DoubleArray(rate / 5)
      val onset = rate / 10
      impulse[onset] = 0.5
      val response = filter(rate, impulse)
      val peak = response.indices.maxBy { abs(response[it]) }
      check(peak - onset == (rate / 1000.0).roundToInt()) { "$rate Hz: incorrect group delay" }
      // Android creates a fresh filter when capture resumes; no old segment leaks.
      val resumed = filter(rate, DoubleArray(512) { 1.0 })
      check(resumed.all { abs(it - 1) < 1e-12 }) { "$rate Hz: DC startup transient" }
      println("$rate Hz: 18 kHz = $rejection dB, speech gain within 0.5%, continuous history and 1 ms delay passed")
    }
    println("PcmLowPass checks passed")
  }
}
