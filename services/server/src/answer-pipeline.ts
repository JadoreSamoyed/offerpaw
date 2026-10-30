import { createHash } from 'node:crypto';
import type { AnswerSource } from './answers.js';
import type { Profile, ServerEvent } from './protocol.js';

export type AnswerOrigin = 'fresh' | 'prepared' | 'cache';
export interface AnswerPipelineOptions {
  source: AnswerSource;
  profile: Profile;
  emit: (event: ServerEvent) => void;
  timeoutMs: number;
  onAnswer?: (answer: string) => void;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
}
export interface AnswerCommitOptions { itemId?: string; contextKey?: string; bypassCache?: boolean }

interface Generation {
  key: string;
  itemId?: string;
  question: string;
  controller: AbortController;
  began: number;
  firstTokenMs?: number;
  answer: string;
  state: 'running' | 'complete' | 'failed';
  completedAt?: number;
  task: Promise<void>;
}
interface Delivery {
  questionId: string;
  committedAt: number;
  origin: AnswerOrigin;
  generation?: Generation;
  deliveredLength: number;
  firstDelivered: boolean;
}
interface CachedAnswer { answer: string; firstTokenMs: number; completedAt: number }

/** Preserve case, internal word boundaries and technical symbols such as C++ and C#. */
export function normalizeAnswerQuestion(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/gu, ' ').replace(/[?？。!！]+$/u, '').trim();
}

/**
 * One session owns one immutable source/profile scope. contextKey must describe the
 * exact context used by that source, excluding the utterance currently being asked.
 * Preparation is private until an exact question + context + item match is committed.
 */
export class AnswerPipeline {
  private readonly profile: Profile;
  private readonly source: AnswerSource;
  private readonly cache = new Map<string, CachedAnswer>();
  private readonly ttl: number;
  private readonly capacity: number;
  private prepared?: Generation;
  private active?: Delivery;
  private disposed = false;

  constructor(private readonly options: AnswerPipelineOptions) {
    this.profile = Object.freeze({ ...options.profile });
    this.source = options.source;
    this.ttl = Math.max(0, Math.min(options.cacheTtlMs ?? 300000, 300000));
    this.capacity = Math.max(0, Math.min(Math.floor(options.maxCacheEntries ?? 12), 12));
  }

  prepare(itemId: string, text: string, contextKey = ''): void {
    if (this.disposed) return;
    const key = this.key(text, contextKey);
    this.expireCache();
    if (this.prepared?.key === key && this.prepared.itemId === itemId && this.usable(this.prepared)) return;
    this.invalidatePrepared();
    if (!text.trim() || text.length > 3000 || this.cache.has(key)) return;
    const generation = this.create(text, key, itemId);
    this.prepared = generation;
    this.start(generation);
  }

  /** Call immediately on an ASR revision, before waiting for another debounce. */
  invalidatePrepared(itemId?: string): void {
    if (!this.prepared || (itemId !== undefined && this.prepared.itemId !== itemId)) return;
    const old = this.prepared;
    this.prepared = undefined;
    old.controller.abort('cancelled');
    old.answer = '';
  }

  async commit(questionId: string, text: string, options: AnswerCommitOptions = {}): Promise<void> {
    if (this.disposed) return;
    const committedAt = performance.now();
    this.cancelActive();
    const key = this.key(text, options.contextKey ?? '');
    this.expireCache();
    const cached = options.bypassCache ? undefined : this.cache.get(key);
    const prepared = !options.bypassCache && options.itemId !== undefined
      && this.prepared?.itemId === options.itemId && this.prepared.key === key && this.usable(this.prepared)
      ? this.prepared : undefined;
    if (cached) {
      this.invalidatePrepared();
      // Refresh LRU order, but never extend the original completion TTL.
      this.cache.delete(key); this.cache.set(key, cached);
      const delivery = this.begin(questionId, committedAt, 'cache');
      this.deliver(delivery, cached.answer, cached.firstTokenMs);
      this.finish(delivery, cached.answer, cached.firstTokenMs);
      return;
    }
    if (prepared) this.prepared = undefined;
    else this.invalidatePrepared();
    const generation = prepared ?? this.create(text, key);
    const delivery = this.begin(questionId, committedAt, prepared ? 'prepared' : 'fresh', generation);
    if (this.active !== delivery) { generation.controller.abort('cancelled'); return; }
    if (generation.answer && generation.firstTokenMs !== undefined) {
      this.deliver(delivery, generation.answer, generation.firstTokenMs);
    }
    if (generation.state === 'complete') {
      this.complete(generation);
    } else if (!prepared) {
      this.start(generation);
    }
    await generation.task;
  }

  /** Pause drops all in-flight work; completed session-local cache entries remain. */
  cancel(): void { this.cancelActive(); this.invalidatePrepared(); }
  dispose(): void { this.disposed = true; this.cancel(); this.cache.clear(); }

  private key(text: string, contextKey: string): string {
    // Source/profile are fixed by the instance; only a digest of context is retained.
    return createHash('sha256').update(JSON.stringify([normalizeAnswerQuestion(text), contextKey])).digest('hex');
  }

  private usable(generation: Generation): boolean {
    return !generation.controller.signal.aborted && generation.state !== 'failed'
      && (generation.completedAt === undefined || Date.now() - generation.completedAt < this.ttl);
  }

  private expireCache(): void {
    const now = Date.now();
    for (const [key, value] of this.cache) if (now - value.completedAt >= this.ttl) this.cache.delete(key);
  }

  private create(question: string, key: string, itemId?: string): Generation {
    return { key, itemId, question, controller: new AbortController(), began: 0,
      answer: '', state: 'running', task: Promise.resolve() };
  }

  private start(generation: Generation): void {
    // run handles source failures; the final catch also contains a throwing transport callback.
    generation.task = this.run(generation).catch(() => {});
  }

  private begin(questionId: string, committedAt: number, origin: AnswerOrigin, generation?: Generation): Delivery {
    const delivery: Delivery = { questionId, committedAt, origin, generation, deliveredLength: 0, firstDelivered: false };
    this.active = delivery;
    this.options.emit({ type: 'answer.start', questionId, source: origin });
    if (this.active === delivery) this.options.emit({ type: 'status', stage: 'thinking' });
    return delivery;
  }

  private deliver(delivery: Delivery, answer: string, firstTokenMs: number): void {
    if (this.active !== delivery) return;
    const delta = answer.slice(delivery.deliveredLength);
    if (!delta) return;
    if (!delivery.firstDelivered) {
      delivery.firstDelivered = true;
      this.options.emit({ type: 'answer.timing', questionId: delivery.questionId, source: delivery.origin,
        requestToFirstTokenMs: firstTokenMs,
        questionCommitToFirstTokenMs: Math.round(performance.now() - delivery.committedAt) });
    }
    if (this.active !== delivery) return;
    delivery.deliveredLength = answer.length;
    this.options.emit({ type: 'answer.delta', questionId: delivery.questionId, text: delta });
  }

  private complete(generation: Generation): void {
    const delivery = this.active;
    if (delivery?.generation !== generation || generation.firstTokenMs === undefined) return;
    if (this.capacity > 0 && this.ttl > 0) {
      this.expireCache();
      this.cache.delete(generation.key);
      this.cache.set(generation.key, { answer: generation.answer, firstTokenMs: generation.firstTokenMs,
        completedAt: generation.completedAt! });
      while (this.cache.size > this.capacity) this.cache.delete(this.cache.keys().next().value!);
    }
    this.finish(delivery, generation.answer, generation.firstTokenMs);
  }

  private finish(delivery: Delivery, answer: string, firstTokenMs: number): void {
    if (this.active !== delivery) return;
    this.options.onAnswer?.(answer);
    if (this.active !== delivery) return;
    this.options.emit({ type: 'answer.done', questionId: delivery.questionId, latencyMs: firstTokenMs });
    if (this.active === delivery) {
      this.active = undefined;
      this.options.emit({ type: 'status', stage: 'listening' });
    }
  }

  private cancelActive(): void {
    const generation = this.active?.generation;
    this.active = undefined;
    generation?.controller.abort('cancelled');
    if (generation) generation.answer = '';
  }

  private async run(generation: Generation): Promise<void> {
    const signal = generation.controller.signal;
    let rejectAbort: (reason: unknown) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => generation.controller.abort('timeout'), this.options.timeoutMs);
    let iterator: AsyncIterator<string> | undefined;
    let ended = false;
    generation.began = performance.now();
    try {
      signal.throwIfAborted();
      iterator = this.source(generation.question, this.profile, signal)[Symbol.asyncIterator]();
      while (true) {
        // A deadline still settles even if a provider ignores AbortSignal.
        const result = await Promise.race([iterator.next(), aborted]);
        signal.throwIfAborted();
        if (result.done) { ended = true; break; }
        const delta = result.value;
        if (!delta) continue;
        if (generation.answer.length + delta.length > 32000) throw new Error('ANSWER_TOO_LONG');
        generation.firstTokenMs ??= Math.round(performance.now() - generation.began);
        generation.answer += delta;
        const delivery = this.active;
        if (delivery?.generation === generation) this.deliver(delivery, generation.answer, generation.firstTokenMs);
      }
      if (!generation.answer.trim()) throw new Error('EMPTY_ANSWER');
      generation.state = 'complete'; generation.completedAt = Date.now();
      this.complete(generation);
    } catch (error) {
      generation.state = 'failed';
      if (this.prepared === generation) this.prepared = undefined;
      if (this.active?.generation === generation && signal.reason !== 'cancelled') {
        const timeout = signal.reason === 'timeout';
        const incomplete = error instanceof Error && error.message === 'LLM_INCOMPLETE_STREAM';
        this.options.emit({ type: 'error', code: timeout ? 'ANSWER_TIMEOUT' : incomplete ? 'ANSWER_INCOMPLETE' : 'ANSWER_FAILED',
          message: timeout ? '回答超时，请缩短问题后重试。' : incomplete ? '回答未完整生成，请缩短问题或增加服务端输出长度后重试。' : '回答服务暂不可用，请检查服务端 API 配置或稍后重试。',
          recoverable: true });
      }
      generation.answer = '';
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', onAbort);
      if (!ended && iterator?.return) {
        try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* Closed source. */ }
      }
      if (this.active?.generation === generation) {
        this.active = undefined;
        this.options.emit({ type: 'status', stage: 'listening' });
      }
    }
  }
}
