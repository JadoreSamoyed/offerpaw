import { requireOptionalNativeModule } from 'expo-modules-core';
import { PermissionsAndroid, Platform } from 'react-native';
import { File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { AudioChunk, Recorder, Recording } from './types';

export type { AudioChunk, Recorder, Recording } from './types';

type Subscription = { remove(): void };
type NativeRecording = Recording & { lastSeq: number };
type NativeRecorder = {
  start(): Promise<void>;
  pause(): Promise<number>;
  resume(): Promise<void>;
  stop(): Promise<NativeRecording | null>;
  addListener(event: 'onAudioChunk', listener: (chunk: AudioChunk) => void): Subscription;
  addListener(event: 'onAudioError', listener: (error: { message: string }) => void): Subscription;
};

// Optional loading lets the UI and demo open in Expo Go. Real audio needs a development build.
const native = requireOptionalNativeModule<NativeRecorder>('InterviewAudio');
let owner: symbol | null = null;

export function createRecorder(): Recorder {
  const token = Symbol('recorder');
  let subscriptions: Subscription[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  let result: Recording | null = null;
  let deliveredSequence = -1;
  let pendingDrain: { sequence: number; resolve(): void } | undefined;
  let reportError: ((message: string) => void) | undefined;
  const serialize = <T,>(action: () => Promise<T>): Promise<T> => {
    const next = tail.then(action, action);
    tail = next.catch(() => undefined);
    return next;
  };
  const removeListeners = () => {
    subscriptions.forEach((subscription) => subscription.remove());
    subscriptions = [];
  };
  const drain = (sequence: number) => new Promise<void>((resolve) => {
    if (deliveredSequence >= sequence) { resolve(); return; }
    const timeout = setTimeout(() => {
      pendingDrain = undefined;
      reportError?.('录音已保存在本地，但最后一段音频未及时传递给实时识别。');
      resolve();
    }, 1000);
    pendingDrain = { sequence, resolve: () => { clearTimeout(timeout); resolve(); } };
  });
  return {
    start(onChunk, onError) {
      return serialize(async () => {
        if (!native) throw new Error('真实录音需要安装 Android / iOS 开发构建；Expo Go 仅支持界面演示。');
        if (owner) throw new Error('已有录音正在进行，请先结束当前录音。');
        owner = token;
        result = null;
        deliveredSequence = -1;
        reportError = onError;
        try {
          if (Platform.OS === 'android') {
            const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
            if (granted !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('未获得麦克风权限，请在系统设置中开启后重试。');
          }
          subscriptions = [
            native.addListener('onAudioChunk', (chunk) => {
              if (owner !== token) return;
              try { onChunk(chunk); }
              finally {
                deliveredSequence = chunk.seq;
                if (pendingDrain && deliveredSequence >= pendingDrain.sequence) {
                  pendingDrain.resolve();
                  pendingDrain = undefined;
                }
              }
            }),
            native.addListener('onAudioError', ({ message }) => { if (owner === token) onError?.(message); }),
          ];
          await native.start();
        } catch (error) {
          await native.stop().catch(() => undefined);
          removeListeners();
          owner = null;
          throw error;
        }
      });
    },
    pause: () => serialize(async () => {
      if (owner === token) await drain(await native!.pause());
    }),
    resume: () => serialize(async () => { if (owner === token) await native?.resume(); }),
    stop: () => serialize(async () => {
      if (owner !== token) return result;
      try {
        const recording = await native!.stop();
        if (recording) {
          await drain(recording.lastSeq);
          result = { uri: recording.uri, mimeType: recording.mimeType, durationMs: recording.durationMs };
        }
        return result;
      } finally {
        removeListeners();
        owner = null;
      }
    }),
  };
}

export async function shareRecording(recording: Recording): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('此设备暂不支持文件分享。');
  await Sharing.shareAsync(recording.uri, { mimeType: recording.mimeType, UTI: 'com.microsoft.waveform-audio', dialogTitle: '导出面试录音' });
}

export async function deleteRecording(recording: Recording): Promise<void> {
  const file = new File(recording.uri);
  if (file.exists) file.delete();
}
