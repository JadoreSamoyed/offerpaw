import type { AudioChunk, Recorder, Recording } from './types';
import { completeRecording, loadWav, openAudioDatabase, recordingID, recordingURI, removeRecording, saveChunk } from './storage.web';

export type { AudioChunk, Recorder, Recording } from './types';
let owner: symbol | null = null;

function cancelledStart(): Error {
  return new Error('录音启动已取消。');
}

/** Browser permission prompts cannot be dismissed programmatically. Stop waiting
 * immediately, but still dispose any microphone stream granted after cancellation. */
function duringStart<T>(operation: Promise<T>, signal: AbortSignal, disposeLate?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true;
      reject(cancelledStart());
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    operation.then(value => {
      signal.removeEventListener('abort', cancel);
      if (settled) { disposeLate?.(value); return; }
      settled = true;
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', cancel);
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function createRecorder(): Recorder {
  const token = Symbol('web-recorder');
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let worklet: AudioWorkletNode | undefined;
  let db: IDBDatabase | undefined;
  let id = '';
  let sequence = 0;
  let totalBytes = 0;
  let savedBytes = 0;
  let result: Recording | null = null;
  let stopping = false;
  let pendingStart: AbortController | undefined;
  let failure: Error | undefined;
  let onFailure: ((message: string) => void) | undefined;
  let operations: Promise<unknown> = Promise.resolve();
  let writes: Promise<void> = Promise.resolve();
  const acknowledgements = new Map<number, () => void>();
  let commandSequence = 0;

  const serialize = <T,>(action: () => Promise<T>): Promise<T> => {
    const next = operations.then(action, action);
    operations = next.catch(() => undefined);
    return next;
  };

  const cleanup = async () => {
    if (context) context.onstatechange = null;
    stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    source?.disconnect();
    worklet?.disconnect();
    worklet?.port.close();
    acknowledgements.forEach((acknowledge) => acknowledge());
    acknowledgements.clear();
    if (context && context.state !== 'closed') await context.close().catch(() => undefined);
    context = undefined; worklet = undefined; source = undefined; stream = undefined;
  };

  const report = (error: unknown) => {
    if (failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    onFailure?.(failure.message);
    // End the microphone even if a consumer only displays the error.
    if (!stopping) void api.stop().catch(() => undefined);
  };

  const command = (type: 'pause' | 'resume' | 'stop') => new Promise<void>((resolve, reject) => {
    if (!worklet || !context || context.state === 'closed') { resolve(); return; }
    if (context.state === 'suspended') {
      // A browser interruption must not leave microphone tracks running indefinitely.
      reject(new Error('浏览器已暂停音频处理，录音将结束。'));
      return;
    }
    const commandID = commandSequence++;
    const timeout = setTimeout(() => {
      acknowledgements.delete(commandID);
      reject(new Error('音频处理未响应，录音已停止。'));
    }, 1200);
    acknowledgements.set(commandID, () => { clearTimeout(timeout); resolve(); });
    worklet.port.postMessage({ type, id: commandID });
  });

  const api: Recorder = {
    start(onChunk, onError) {
      if (pendingStart || owner === token) return Promise.reject(new Error('已有录音正在进行，请先结束当前录音。'));
      const cancellation = new AbortController();
      pendingStart = cancellation;
      return serialize(async () => {
        try {
          if (cancellation.signal.aborted) throw cancelledStart();
          if (owner) throw new Error('已有录音正在进行，请先结束当前录音。');
          if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
            throw new Error('浏览器录音需要 HTTPS 或 localhost 安全连接。');
          }
          owner = token;
          onFailure = onError;
          result = null; failure = undefined; stopping = false;
          totalBytes = 0; savedBytes = 0; sequence = 0;
          writes = Promise.resolve();
          id = crypto.randomUUID();
          // Ask for 24 kHz so the browser's resampler can do the conversion first.
          try { context = new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' }); }
          catch { context = new AudioContext({ latencyHint: 'interactive' }); }
          await duringStart(context.resume(), cancellation.signal);
          if (cancellation.signal.aborted) throw cancelledStart();
          db = await duringStart(openAudioDatabase(), cancellation.signal);
          if (cancellation.signal.aborted) throw cancelledStart();
          stream = await duringStart(
            navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }).catch((error: unknown) => {
              if (error && typeof error === 'object' && 'name' in error) {
                switch (error.name) {
                  case 'NotAllowedError':
                    throw new Error('麦克风访问未获允许，请在浏览器的网站设置和系统隐私设置中允许麦克风后重试。');
                  case 'NotFoundError':
                    throw new Error('未找到可用麦克风，请连接麦克风并检查系统输入设备后重试。');
                  case 'NotReadableError':
                    throw new Error('无法读取麦克风，请关闭可能占用麦克风的应用，并检查设备连接后重试。');
                }
              }
              throw error;
            }),
            cancellation.signal,
            lateStream => lateStream.getTracks().forEach(track => track.stop()),
          );
          if (cancellation.signal.aborted) throw cancelledStart();
          stream.getAudioTracks().forEach((track) => { track.onended = () => report(new Error('麦克风已断开，录音已停止。')); });
          await duringStart(context.audioWorklet.addModule('/pcm-worklet.js'), cancellation.signal);
          if (cancellation.signal.aborted) throw cancelledStart();
          worklet = new AudioWorkletNode(context, 'interview-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
          worklet.onprocessorerror = () => report(new Error('音频处理发生错误，录音已停止。'));
          worklet.port.onmessage = ({ data }) => {
            if (data.type === 'ack') {
              acknowledgements.get(data.id)?.();
              acknowledgements.delete(data.id);
              return;
            }
            if (data.type !== 'chunk' || !(data.bytes instanceof ArrayBuffer)) return;
            const bytes = data.bytes as ArrayBuffer;
            const seq = sequence++;
            totalBytes += bytes.byteLength;
            const size = totalBytes;
            writes = writes.then(async () => {
              if (failure) return;
              await saveChunk(db!, id, seq, bytes, size);
              savedBytes = size;
            }).catch(report);
            if (!failure) {
              try { onChunk({ audio: base64(bytes), level: Math.min(1, data.level), seq }); }
              catch (error) { report(error); }
            }
          };
          source = context.createMediaStreamSource(stream);
          source.connect(worklet);
          worklet.connect(context.destination); // Processor output is all zero: no feedback.
          context.onstatechange = () => {
            if (!stopping && context && context.state !== 'running') {
              report(new Error('浏览器已中断音频处理，录音已停止并保留已保存部分。'));
            }
          };
        } catch (error) {
          await cleanup();
          if (owner === token) owner = null;
          throw error;
        } finally {
          if (pendingStart === cancellation) pendingStart = undefined;
        }
      });
    },
    pause: () => serialize(async () => {
      if (owner !== token || stopping) return;
      try {
        await command('pause');
        stream?.getAudioTracks().forEach((track) => { track.enabled = false; });
        await writes;
      } catch (error) { report(error); throw error; }
    }),
    resume: () => serialize(async () => {
      if (owner !== token || stopping || failure) return;
      try {
        await context?.resume();
        stream?.getAudioTracks().forEach((track) => { track.enabled = true; });
        await command('resume');
      } catch (error) { report(error); throw error; }
    }),
    stop: () => {
      // Signal before entering the operation queue: start may still await permission.
      pendingStart?.abort();
      return serialize(async () => {
      if (owner !== token) return result;
      stopping = true;
      try {
        await command('stop').catch((error: Error) => { onFailure?.(error.message); });
        await cleanup();
        await writes;
        if (db && savedBytes > 0) {
          await completeRecording(db, id, savedBytes).catch((error: Error) => { onFailure?.(error.message); });
          result = { uri: recordingURI(id), mimeType: 'audio/wav', durationMs: savedBytes / 48 };
        }
        return result;
      } finally {
        await cleanup();
        owner = null;
      }
      });
    },
  };
  return api;
}

export async function shareRecording(recording: Recording): Promise<void> {
  const blob = await loadWav(recordingID(recording.uri));
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `interview-${recordingID(recording.uri)}.wav`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function deleteRecording(recording: Recording): Promise<void> {
  await removeRecording(recordingID(recording.uri));
}
