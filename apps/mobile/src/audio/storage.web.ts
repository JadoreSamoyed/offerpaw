const DATABASE = 'interview-audio-v1';
const SCHEME = 'indexeddb://interview-recordings/';
export const recordingURI = (id: string) => SCHEME + id;
export const recordingID = (uri: string) => {
  if (!uri.startsWith(SCHEME)) throw new Error('录音地址格式不正确。');
  return uri.slice(SCHEME.length);
};

let connection: Promise<IDBDatabase> | undefined;
export function openAudioDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('浏览器不支持本地录音存储，请使用手机 App。'));
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('recordings', { keyPath: 'id' });
      db.createObjectStore('chunks', { keyPath: ['id', 'seq'] }).createIndex('recording', 'id');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地录音存储。'));
    request.onblocked = () => reject(new Error('本地录音存储被其他标签页占用，请关闭后重试。'));
  });
  return connection;
}

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('保存录音失败，请检查浏览器存储空间。'));
    transaction.onabort = () => reject(transaction.error ?? new Error('录音存储被中断。'));
  });
}

export async function saveChunk(db: IDBDatabase, id: string, seq: number, bytes: ArrayBuffer, totalBytes: number): Promise<void> {
  const transaction = db.transaction(['chunks', 'recordings'], 'readwrite');
  const finished = committed(transaction);
  transaction.objectStore('chunks').put({ id, seq, bytes });
  transaction.objectStore('recordings').put({ id, totalBytes, complete: false });
  await finished;
}

export async function completeRecording(db: IDBDatabase, id: string, totalBytes: number): Promise<void> {
  const transaction = db.transaction('recordings', 'readwrite');
  const finished = committed(transaction);
  transaction.objectStore('recordings').put({ id, totalBytes, complete: true });
  await finished;
}

export async function removeRecording(id: string): Promise<void> {
  const db = await openAudioDatabase();
  const transaction = db.transaction(['chunks', 'recordings'], 'readwrite');
  const finished = committed(transaction);
  transaction.objectStore('recordings').delete(id);
  const request = transaction.objectStore('chunks').index('recording').openKeyCursor(IDBKeyRange.only(id));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    transaction.objectStore('chunks').delete(cursor.primaryKey);
    cursor.continue();
  };
  await finished;
}

export function wavHeader(byteLength: number): ArrayBuffer {
  if (byteLength > 0xffffffff - 36) throw new Error('录音超过 WAV 文件大小限制。');
  const header = new ArrayBuffer(44);
  const data = new DataView(header);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) data.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF'); data.setUint32(4, byteLength + 36, true); text(8, 'WAVEfmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
  data.setUint32(24, 24000, true); data.setUint32(28, 48000, true);
  data.setUint16(32, 2, true); data.setUint16(34, 16, true); text(36, 'data');
  data.setUint32(40, byteLength, true);
  return header;
}

export async function loadWav(id: string): Promise<Blob> {
  const db = await openAudioDatabase();
  const transaction = db.transaction('chunks', 'readonly');
  const finished = committed(transaction);
  const chunks: ArrayBuffer[] = [];
  let bytes = 0;
  const request = transaction.objectStore('chunks').openCursor(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const chunk = cursor.value.bytes as ArrayBuffer;
    chunks.push(chunk);
    bytes += chunk.byteLength;
    cursor.continue();
  };
  await finished;
  if (!chunks.length) throw new Error('未找到录音文件，可能已被清理或本次没有录到声音。');
  return new Blob([wavHeader(bytes), ...chunks], { type: 'audio/wav' });
}
