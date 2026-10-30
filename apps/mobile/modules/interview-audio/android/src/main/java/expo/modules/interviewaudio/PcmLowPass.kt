package expo.modules.interviewaudio

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/** Anti-alias filter before converting hardware PCM to 24 kHz. */
internal class PcmLowPass(sampleRate: Int) {
  // The 10 kHz cutoff leaves a transition band below the output Nyquist limit.
  // A symmetric, normalized Hamming FIR adds approximately 1 ms of group delay.
  private val half = (sampleRate / 1000.0).roundToInt()
  private val kernel = if (sampleRate > 24000) DoubleArray(2 * half + 1) { i ->
    val x = i - half
    val cutoff = 10000.0 / sampleRate
    val sinc = if (x == 0) 2 * cutoff else sin(2 * PI * cutoff * x) / (PI * x)
    sinc * (0.54 - 0.46 * cos(2 * PI * i / (2 * half)))
  }.also { values ->
    val sum = values.sum()
    for (i in values.indices) values[i] /= sum
  } else DoubleArray(0)
  private val history = DoubleArray(kernel.size)
  private var position = 0
  private var initialized = false

  fun push(sample: Double): Double {
    if (kernel.isEmpty()) return sample
    // Extend the first sample at the capture boundary; retain history across reads.
    if (!initialized) { history.fill(sample); initialized = true }
    history[position] = sample
    var index = position
    var value = 0.0
    for (coefficient in kernel) {
      value += history[index] * coefficient
      if (--index < 0) index = history.lastIndex
    }
    if (++position == history.size) position = 0
    return value
  }
}
