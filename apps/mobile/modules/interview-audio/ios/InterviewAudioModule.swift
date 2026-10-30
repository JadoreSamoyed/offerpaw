import AVFoundation
import ExpoModulesCore

public final class InterviewAudioModule: Module {
  private let processing = DispatchQueue(label: "interview.audio.pcm", qos: .userInitiated)
  private var engine: AVAudioEngine?
  private var converter: AVAudioConverter?
  private var file: FileHandle?
  private var fileURL: URL?
  private var bytesWritten: UInt32 = 0
  private var pending = Data()
  private var squareSum: Double = 0
  private var sequence = 0
  private var accepting = false
  private var permissionPending = false
  private var disposed = false
  private var interruptionObserver: NSObjectProtocol?
  private var routeObserver: NSObjectProtocol?
  private var configurationObserver: NSObjectProtocol?
  private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!

  public func definition() -> ModuleDefinition {
    Name("InterviewAudio")
    Events("onAudioChunk", "onAudioError")

    AsyncFunction("start") { (promise: Promise) in
      guard !self.disposed else {
        promise.reject("RECORDER_DISPOSED", "The audio runtime has been closed")
        return
      }
      guard self.file == nil && !self.permissionPending else {
        promise.reject("RECORDING_ACTIVE", "A recording is already active")
        return
      }
      self.permissionPending = true
      AVAudioSession.sharedInstance().requestRecordPermission { granted in
        DispatchQueue.main.async {
          self.permissionPending = false
          guard !self.disposed else {
            promise.reject("RECORDER_DISPOSED", "The audio runtime has been closed")
            return
          }
          guard granted else {
            promise.reject("MICROPHONE_DENIED", "未获得麦克风权限，请在系统设置中开启后重试。")
            return
          }
          do {
            try self.startRecording()
            promise.resolve(nil)
          } catch {
            _ = try? self.finishRecording()
            if let url = self.fileURL { try? FileManager.default.removeItem(at: url) }
            self.fileURL = nil
            promise.reject("RECORDING_START_FAILED", error.localizedDescription)
          }
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("pause") {
      try self.pauseRecording()
      return self.sequence - 1
    }.runOnQueue(.main)
    AsyncFunction("resume") {
      guard self.file != nil else { throw self.failure("No recording to resume") }
      if self.engine?.isRunning != true { try self.beginCapture() }
    }.runOnQueue(.main)
    AsyncFunction("stop") { try self.finishRecording() }.runOnQueue(.main)
    OnDestroy {
      // Native teardown also closes the device if the JS runtime is reloaded.
      if Thread.isMainThread { self.dispose() }
      else { DispatchQueue.main.async { self.dispose() } }
    }
  }

  private func dispose() {
    disposed = true
    permissionPending = false
    _ = try? finishRecording()
  }

  private func failure(_ message: String) -> NSError {
    NSError(domain: "InterviewAudio", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }

  private func startRecording() throws {
    // A failed new start must never clean up the previous interview's saved file.
    fileURL = nil
    let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("interview-recordings", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    var url = folder.appendingPathComponent("interview-\(UUID().uuidString).wav")
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    guard FileManager.default.createFile(atPath: url.path, contents: Data(count: 44)) else {
      throw failure("Cannot create recording file")
    }
    fileURL = url
    try url.setResourceValues(values)
    file = try FileHandle(forWritingTo: url)
    bytesWritten = 0
    pending.removeAll(keepingCapacity: true)
    squareSum = 0
    sequence = 0
    try writeHeader()
    try beginCapture()
    interruptionObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
    ) { [weak self] notification in
      guard let self,
        let type = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
        type == AVAudioSession.InterruptionType.began.rawValue else { return }
      try? self.pauseRecording()
      self.sendEvent("onAudioError", ["message": "录音被系统中断，已保留录音。请结束或重新开始本次会话。"])
    }
    routeObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
    ) { [weak self] notification in
      guard let self, self.engine?.isRunning == true,
        let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
        reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
      try? self.pauseRecording()
      self.sendEvent("onAudioError", ["message": "麦克风连接已变化，录音已暂停并保留。"])
    }
    configurationObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main
    ) { [weak self] notification in
      guard let self, let activeEngine = self.engine,
        let changedEngine = notification.object as? AVAudioEngine,
        activeEngine === changedEngine else { return }
      // A route/format change may stop the engine without an interruption notification.
      // Tell JS to save the session instead of leaving the screen falsely listening.
      try? self.pauseRecording()
      self.sendEvent("onAudioError", ["message": "麦克风配置已变化，录音已暂停并保留。请重新开始本次会话。"])
    }
  }

  private func beginCapture() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.record, mode: .measurement, options: [.allowBluetooth])
    try session.setPreferredSampleRate(48_000)
    try session.setPreferredIOBufferDuration(0.02)
    try session.setActive(true)
    let captureEngine = AVAudioEngine()
    let input = captureEngine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0,
      let conversion = AVAudioConverter(from: format, to: target) else {
      throw failure("No usable microphone input is available")
    }
    converter = conversion
    processing.sync { accepting = true }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      guard let self,
        let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else { return }
      copy.frameLength = buffer.frameLength
      let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
      let destination = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
      for index in 0..<source.count {
        guard let from = source[index].mData, let to = destination[index].mData else { continue }
        memcpy(to, from, Int(source[index].mDataByteSize))
      }
      // The engine reuses its tap buffer; pass an owned copy to the file/encoding queue.
      self.processing.async {
        guard self.accepting else { return }
        do { try self.consume(copy) }
        catch {
          self.accepting = false
          DispatchQueue.main.async {
            try? self.pauseRecording()
            self.sendEvent("onAudioError", ["message": "录音中断：\(error.localizedDescription)"])
          }
        }
      }
    }
    engine = captureEngine
    do {
      captureEngine.prepare()
      try captureEngine.start()
    } catch {
      input.removeTap(onBus: 0)
      engine = nil
      processing.sync { accepting = false }
      try? session.setActive(false, options: .notifyOthersOnDeactivation)
      throw error
    }
  }

  private func consume(_ input: AVAudioPCMBuffer) throws {
    guard let converter else { return }
    let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * 24_000 / input.format.sampleRate) + 64)
    guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
    var supplied = false
    var conversionError: NSError?
    let status = converter.convert(to: converted, error: &conversionError) { _, inputStatus in
      if supplied { inputStatus.pointee = .noDataNow; return nil }
      supplied = true
      inputStatus.pointee = .haveData
      return input
    }
    if status == .error { throw conversionError ?? failure("Audio conversion failed") }
    try appendConverted(converted)
  }

  private func appendConverted(_ converted: AVAudioPCMBuffer) throws {
    guard let channel = converted.floatChannelData?[0] else { return }
    for index in 0..<Int(converted.frameLength) {
      let normalized = min(1.0, max(-1.0, Double(channel[index])))
      let sample = Int16(normalized < 0 ? normalized * 32768 : normalized * 32767)
      var littleEndian = sample.littleEndian
      withUnsafeBytes(of: &littleEndian) { pending.append(contentsOf: $0) }
      squareSum += normalized * normalized
      if pending.count == 4800 { try flushChunk() }
    }
  }

  private func drainConverter() throws {
    guard let converter else { return }
    // AVAudioConverter can retain filter-delay frames. Drain them before closing a segment.
    for _ in 0..<8 {
      guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: 4096) else { return }
      var conversionError: NSError?
      let status = converter.convert(to: converted, error: &conversionError) { _, inputStatus in
        inputStatus.pointee = .endOfStream
        return nil
      }
      if status == .error { throw conversionError ?? failure("Audio conversion drain failed") }
      try appendConverted(converted)
      if status == .endOfStream || converted.frameLength == 0 { return }
    }
  }

  private func flushChunk() throws {
    guard !pending.isEmpty, let file else { return }
    guard UInt64(bytesWritten) + UInt64(pending.count) <= UInt64(UInt32.max) - 36 else {
      throw failure("WAV size limit reached")
    }
    try file.write(contentsOf: pending)
    bytesWritten += UInt32(pending.count)
    let payload: [String: Any] = [
      "audio": pending.base64EncodedString(),
      "level": min(1.0, sqrt(squareSum / Double(pending.count / 2))),
      "seq": sequence
    ]
    sequence += 1
    pending.removeAll(keepingCapacity: true)
    squareSum = 0
    try writeHeader()
    sendEvent("onAudioChunk", payload)
  }

  private func writeHeader() throws {
    guard let file else { return }
    var header = Data()
    func text(_ value: String) { header.append(contentsOf: value.utf8) }
    func word<T: FixedWidthInteger>(_ value: T) {
      var littleEndian = value.littleEndian
      withUnsafeBytes(of: &littleEndian) { header.append(contentsOf: $0) }
    }
    text("RIFF"); word(UInt32(36) + bytesWritten); text("WAVEfmt ")
    word(UInt32(16)); word(UInt16(1)); word(UInt16(1)); word(UInt32(24_000))
    word(UInt32(48_000)); word(UInt16(2)); word(UInt16(16)); text("data"); word(bytesWritten)
    try file.seek(toOffset: 0)
    try file.write(contentsOf: header)
    try file.seek(toOffset: UInt64(44) + UInt64(bytesWritten))
  }

  private func pauseRecording() throws {
    defer {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    if let engine {
      engine.stop()
      engine.inputNode.removeTap(onBus: 0)
      self.engine = nil
    }
    try processing.sync {
      defer { converter = nil }
      let shouldDrain = accepting
      accepting = false
      if shouldDrain { try drainConverter() }
      try flushChunk()
      try writeHeader()
      try file?.synchronize()
    }
  }

  private func finishRecording() throws -> [String: Any]? {
    guard file != nil else { return nil }
    defer {
      try? file?.close()
      file = nil
      if let observer = interruptionObserver { NotificationCenter.default.removeObserver(observer) }
      if let observer = routeObserver { NotificationCenter.default.removeObserver(observer) }
      if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer) }
      interruptionObserver = nil
      routeObserver = nil
      configurationObserver = nil
    }
    try pauseRecording()
    return ["uri": fileURL!.absoluteString, "mimeType": "audio/wav", "durationMs": Double(bytesWritten) / 48.0, "lastSeq": sequence - 1]
  }
}
