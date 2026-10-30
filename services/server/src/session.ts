import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { demoAnswerSource, liveAnswerSource, type AnswerSource } from './answers.js';
import { AnswerPipeline, normalizeAnswerQuestion } from './answer-pipeline.js';
import { tokenMatches } from './auth.js';
import { liveConfigured, textConfigured, type Config } from './config.js';
import { consoleDiagnosticSink, diagnosticErrorCode, diagnosticSpeakerReason, writeSessionDiagnostic, type DiagnosticSink, type SessionDiagnosticEvent } from './diagnostics.js';
import { clientEventSchema, type ClientEvent, type Profile, type ServerEvent, type SpeakerMetadata, type SpeakerMode, type VoiceProfile } from './protocol.js';
import { QuestionDetector, looksLikeQuestion } from './questions.js';
import { createTranscriber, type Transcriber, type TranscriptionCallbacks, type TranscriberOptions } from './transcription.js';

export interface SessionDependencies {
  transcriber?: (callbacks: TranscriptionCallbacks, options: TranscriberOptions) => Transcriber;
  answerSource?: AnswerSource;
  demoDelayMs?: number;
  diagnosticSink?: DiagnosticSink;
}

export class InterviewSession {
  private readonly sessionId = randomUUID();
  private finalNumber = 0;
  private activeQuestionId?: string;
  private started = false;
  private ready = false;
  private stopped = false;
  private paused = false;
  private mode: 'demo' | 'text' | 'live' = 'demo';
  private profile?: Profile;
  private speakerMode: SpeakerMode = 'auto';
  private voiceProfile?: VoiceProfile;
  private enrolling = false;
  private speakerSupported = false;
  private transcriber?: Transcriber;
  private sequence = -1;
  private recentTranscript: string[] = [];
  private detector = new QuestionDetector();
  private answers?: AnswerPipeline;
  private prepareTimer?: ReturnType<typeof setTimeout>;
  private utterance?: { id: string; text: string; context: string[]; attempts: number; lastPreparedAt: number };
  private answerContext: string[] = [];
  private lastVoiceQuestion?: { text: string; context: string[]; at: number };
  private demoTimer?: ReturnType<typeof setTimeout>;
  private authTimer: ReturnType<typeof setTimeout>;
  private durationTimer: ReturnType<typeof setTimeout>;
  private lastManualAt = 0;
  private messageTimes: number[] = [];

  constructor(private socket: WebSocket, private config: Config, private dependencies: SessionDependencies = {}) {
    this.authTimer = setTimeout(() => this.fatal('AUTH_TIMEOUT', '连接未完成验证，请重新连接。'), 10000);
    this.durationTimer = setTimeout(() => this.fatal('SESSION_EXPIRED', '本次连接已达两小时，请重新开始。'), 2 * 60 * 60 * 1000);
    socket.on('message', (raw, isBinary) => {
      if (this.stopped) return;
      if (isBinary) { this.fatal('INVALID_MESSAGE', '请使用 JSON 协议发送消息。'); return; }
      const now = Date.now();
      this.messageTimes = this.messageTimes.filter(time => now - time < 1000);
      if (this.messageTimes.length >= 100) { this.fatal('RATE_LIMIT', '发送过于频繁，请重新连接。'); return; }
      this.messageTimes.push(now);
      let data: unknown;
      try { data = JSON.parse(raw.toString()); } catch { this.fatal('INVALID_MESSAGE', '消息格式无效。'); return; }
      const parsed = clientEventSchema.safeParse(data);
      if (!parsed.success) {
        if (this.started && data && typeof data === 'object' && 'type' in data && data.type === 'question.ask') {
          this.error('INVALID_QUESTION', '请输入 2–3000 字的问题。'); return;
        }
        this.fatal('INVALID_MESSAGE', '消息字段或长度无效。'); return;
      }
      void this.handle(parsed.data).catch(() => this.fatal('SESSION_FAILED', '会话处理失败，请重新连接。'));
    });
    socket.on('close', code => { this.diagnose({ event: 'socket_closed', code }); this.dispose(); });
    socket.on('error', () => { this.diagnose({ event: 'socket_error' }); this.dispose(); });
  }

  private diagnose(event: SessionDiagnosticEvent) {
    const sink = this.dependencies.diagnosticSink ?? (this.config.NODE_ENV === 'production' ? consoleDiagnosticSink : undefined);
    if (sink) writeSessionDiagnostic(this.sessionId, event, sink);
  }
  private send(event: ServerEvent) {
    if (this.socket.readyState !== 1) return;
    if (this.socket.bufferedAmount > 512000) { this.dispose(); this.socket.close(1013, 'Slow connection'); return; }
    this.socket.send(JSON.stringify(event));
    // Log only bounded operational metadata, never text, voice profiles, or raw events.
    switch (event.type) {
      case 'session.ready':
        this.diagnose({ event: 'session_ready', mode: event.mode, speakerMode: this.speakerMode }); break;
      case 'answer.start':
        this.activeQuestionId = event.questionId;
        this.diagnose({ event: 'answer_start', questionId: event.questionId, source: event.source ?? 'fresh' }); break;
      case 'answer.timing':
        this.diagnose({ event: 'answer_timing', questionId: event.questionId, source: event.source,
          requestToFirstTokenMs: event.requestToFirstTokenMs, questionCommitToFirstTokenMs: event.questionCommitToFirstTokenMs }); break;
      case 'answer.done':
        this.diagnose({ event: 'answer_done', questionId: event.questionId, latencyMs: event.latencyMs });
        this.activeQuestionId = undefined; break;
      case 'error':
        this.diagnose({ event: 'session_error', code: diagnosticErrorCode(event.code), recoverable: event.recoverable,
          ...(this.activeQuestionId ? { questionId: this.activeQuestionId } : {}) }); break;
      case 'status':
        if (event.stage === 'listening' || event.stage === 'paused' || event.stage === 'stopped') this.activeQuestionId = undefined;
        break;
    }
  }
  private error(code: string, message: string, recoverable = true) { this.send({ type: 'error', code, message, recoverable }); }
  private fatal(code: string, message: string) {
    this.error(code, message, false); this.dispose(); this.socket.close(1008, code);
  }
  private async handle(event: ClientEvent) {
    if (event.type === 'session.start') { await this.start(event); return; }
    if (!this.started) { this.fatal('NOT_AUTHENTICATED', '请先开启会话。'); return; }
    if (event.type === 'session.stop') {
      this.send({ type: 'status', stage: 'stopped' }); this.send({ type: 'session.stopped' });
      this.dispose(); this.socket.close(1000, 'Session stopped'); return;
    }
    if (!this.ready) { this.error('NOT_READY', '语音服务连接中，请稍候。'); return; }
    if (event.type === 'speaker.set') {
      if (this.mode !== 'live') { this.error('SPEAKER_LIVE_ONLY', '说话人设置仅用于实时面试。'); return; }
      if (event.speaker === this.speakerMode) { this.speakerState(); return; }
      if (event.speaker !== 'auto' && this.enrolling) {
        this.transcriber?.cancelEnrollment?.(); this.enrolling = false;
      }
      this.speakerMode = event.speaker;
      this.clearPending(); this.transcriber?.clear(); this.speakerState(); this.speakerNotice(); return;
    }
    if (event.type === 'voice.enroll.finish') {
      if (this.mode !== 'live' || !this.enrolling) { this.error('VOICE_ENROLL_NOT_ACTIVE', '当前没有正在进行的声纹录入。'); return; }
      if (!this.speakerSupported || !this.transcriber?.finishEnrollment) {
        this.error('SPEAKER_UNAVAILABLE', '当前语音服务不支持声纹识别，请手动选择面试官或我在回答。'); return;
      }
      this.transcriber.finishEnrollment(); return;
    }
    if (event.type === 'session.pause') {
      this.paused = true; this.answers?.cancel(); this.clearPending(); this.transcriber?.clear();
      this.send({ type: 'status', stage: 'paused' }); return;
    }
    if (event.type === 'session.resume') {
      this.paused = false; this.transcriber?.clear(); this.send({ type: 'status', stage: 'listening' }); return;
    }
    if (event.type === 'question.ask') {
      if (this.paused) { this.error('SESSION_PAUSED', '请继续会话后再提问。'); return; }
      if (this.enrolling) { this.error('VOICE_ENROLL_ACTIVE', '请先完成声纹录入。'); return; }
      if (Date.now() - this.lastManualAt < 500) { this.error('QUESTION_RATE_LIMIT', '请稍候再提交问题。'); return; }
      this.lastManualAt = Date.now(); this.clearPending(); this.ask(event.text, undefined, this.recentTranscript, event.bypassCache); return;
    }
    if (event.type === 'audio.append') {
      if (this.mode === 'demo') { this.fatal('DEMO_AUDIO_REJECTED', '演示模式不接收麦克风音频。'); return; }
      if (this.mode === 'text') { this.error('TEXT_AUDIO_REJECTED', '文字问答模式不接收麦克风音频，请手动输入问题。'); return; }
      if (this.paused) return;
      if (event.seq <= this.sequence) { this.error('AUDIO_SEQUENCE', '音频顺序异常，请重新开始录音。'); return; }
      this.sequence = event.seq;
      const pcm = Buffer.from(event.audio, 'base64');
      if (!pcm.length || pcm.length % 2 || pcm.length > 48000 || pcm.toString('base64') !== event.audio) {
        this.fatal('INVALID_AUDIO', '音频必须是 24kHz 单声道 PCM16，每帧不超过一秒。'); return;
      }
      try { this.transcriber?.append(pcm); }
      catch { this.fatal('AUDIO_BACKPRESSURE', '语音上传中断或积压，请重新连接。'); }
    }
  }
  private async start(event: Extract<ClientEvent, { type: 'session.start' }>) {
    if (this.started) { this.fatal('ALREADY_STARTED', '每个连接只能开启一次会话。'); return; }
    if (!tokenMatches(this.config.APP_ACCESS_TOKEN, event.token)) { this.fatal('UNAUTHORIZED', '访问口令不正确。'); return; }
    this.started = true; clearTimeout(this.authTimer);
    this.mode = event.mode; this.profile = event.profile;
    this.speakerMode = event.speakerMode ?? 'auto'; this.voiceProfile = event.voiceProfile;
    this.enrolling = event.mode === 'live' && event.enrollSpeaker === true;
    if (this.enrolling) this.speakerMode = 'auto';
    this.answers = new AnswerPipeline({
      profile: event.profile, emit: event => this.send(event), timeoutMs: this.config.LLM_TIMEOUT_MS,
      onAnswer: answer => this.detector.rememberAnswer(answer),
      source: (question, profile, signal) => {
        // Snapshot at request creation: later ASR turns must not change this request's input.
        const context = [...this.answerContext];
        const source = this.dependencies.answerSource ?? (this.mode === 'demo' ? demoAnswerSource : liveAnswerSource(this.config, () => context));
        return source(question, profile, signal);
      },
    });
    if (event.mode === 'text' && !textConfigured(this.config)) {
      this.fatal('PROVIDER_NOT_CONFIGURED', '服务端尚未配置回答 API，请配置后再开启文字问答。'); return;
    }
    if (event.mode === 'live') {
      if (!liveConfigured(this.config)) { this.fatal('PROVIDER_NOT_CONFIGURED', '服务端尚未配置语音识别和回答 API，请先使用演示模式。'); return; }
      this.send({ type: 'status', stage: 'transcribing', message: '正在连接语音识别服务…' });
      const callbacks: TranscriptionCallbacks = {
        partial: (id, text, speaker) => this.partial(id, text, speaker),
        final: (id, text, speaker) => this.transcript(id, text, speaker),
        error: () => { if (!this.stopped) this.fatal('ASR_DISCONNECTED', '语音识别连接已中断，请重新开始。'); },
        speakerCapability: supported => { this.speakerSupported = supported; },
        enrolled: profile => {
          if (this.stopped || !this.enrolling) return;
          this.voiceProfile = profile; this.enrolling = false; this.speakerMode = 'auto'; this.clearPending();
          this.send({ type: 'voice.enrolled', profile }); this.speakerState();
        },
        enrollmentFailed: code => {
          if (this.stopped || !this.enrolling) return;
          const messages = { too_short: '有效语音太短，请重新朗读几句话后再完成录入。', inconsistent: '录入中出现不同声音，请仅由你本人重新朗读后重试。', invalid_audio: '未能提取声纹，请清晰地重新朗读几句话后重试。' };
          this.error(`VOICE_ENROLL_${code.toUpperCase()}`, messages[code]); this.speakerState();
        },
        audioGap: () => {
          if (!this.stopped) {
            this.clearPending(); this.error('ASR_AUDIO_GAP', '切换说话人时识别短暂积压，部分转写已跳过，录音仍在继续。');
          }
        },
      };
      const options: TranscriberOptions = { voiceProfile: this.voiceProfile, enrollSpeaker: this.enrolling, requireSpeaker: this.speakerMode === 'auto' };
      this.transcriber = this.dependencies.transcriber?.(callbacks, options) ?? createTranscriber(this.config, callbacks, options);
      try { await this.transcriber.connect(); }
      catch {
        if (!this.stopped) this.fatal('ASR_UNAVAILABLE', this.config.ASR_PROVIDER === 'local'
          ? '本地语音识别服务未启动或连接失败，请启动语音服务后重试。'
          : '无法连接语音识别服务，请检查服务端配置。');
        return;
      }
      this.speakerSupported = this.transcriber.speakerSupported ?? this.speakerSupported;
    }
    if (this.stopped) return;
    this.ready = true;
    this.send({ type: 'session.ready', sessionId: this.sessionId, mode: this.mode });
    if (this.mode === 'live') { this.speakerState(); this.speakerNotice(); }
    const message = this.mode === 'demo' ? '演示模式：内置问题与答案，不使用麦克风。'
      : this.mode === 'text' ? '文字问答已就绪，请手动输入面试问题。' : undefined;
    this.send({ type: 'status', stage: 'listening', ...(message ? { message } : {}) });
    if (this.mode === 'demo') this.demoTimer = setTimeout(() => {
      if (this.paused || this.stopped) return;
      this.transcript(randomUUID(), '如果要优化一个系统的响应延迟，你会怎么做？');
    }, this.dependencies.demoDelayMs ?? 700);
  }
  private speakerState() {
    this.send({ type: 'speaker.state', mode: this.speakerMode, enrolled: Boolean(this.voiceProfile), enrolling: this.enrolling });
  }
  private speakerNotice() {
    if (this.speakerMode !== 'auto') return;
    if (!this.speakerSupported) this.error('SPEAKER_UNAVAILABLE', '当前语音服务不支持声纹识别，请手动选择面试官或我在回答。');
    else if (!this.voiceProfile && !this.enrolling) this.error('VOICE_PROFILE_REQUIRED', '尚未录入你的声纹，当前仅记录转写；请录入声纹或手动选择说话人。');
  }
  private speakerFor(metadata?: SpeakerMetadata): SpeakerMetadata {
    if (this.mode !== 'live') return { speaker: 'interviewer', speakerSource: 'manual' };
    if (this.speakerMode !== 'auto') return { speaker: this.speakerMode, speakerSource: 'manual' };
    if (this.speakerSupported && this.voiceProfile && metadata?.speakerSource === 'voice') return metadata;
    return { speaker: 'unknown', speakerSource: 'unavailable', speakerReason: !this.voiceProfile ? 'profile_required' : 'speaker_unavailable' };
  }
  private partial(id: string, text: string, metadata?: SpeakerMetadata) {
    if (this.paused || this.stopped || this.enrolling) return;
    const speaker = this.speakerFor(metadata);
    this.send({ type: 'transcript.partial', id, text, ...speaker });
    if (speaker.speaker !== 'interviewer') { this.clearPending(); return; }
    if (this.config.ANSWER_PREFETCH_ENABLED !== 'true' || this.mode !== 'live') return;
    if (this.utterance?.id === id && normalizeAnswerQuestion(this.utterance.text) === normalizeAnswerQuestion(text)) return;
    clearTimeout(this.prepareTimer);
    this.answers?.invalidatePrepared();
    const continuation = this.continuation(text);
    if (this.utterance?.id !== id) {
      this.utterance = { id, text, context: [...(continuation?.context ?? this.recentTranscript)], attempts: 0, lastPreparedAt: 0 };
    } else this.utterance.text = text;
    const utterance = this.utterance;
    const question = continuation ? `${continuation.text}，${text}`.slice(0, 3000) : text;
    if (question.trim().length < 12 || !looksLikeQuestion(question) || utterance.attempts >= this.config.ANSWER_PREFETCH_MAX_PER_TURN) return;
    const wait = Math.max(this.config.ANSWER_PREFETCH_STABLE_MS, 700 - (Date.now() - utterance.lastPreparedAt));
    this.prepareTimer = setTimeout(() => {
      if (this.stopped || this.paused || this.utterance !== utterance || utterance.text !== text) return;
      utterance.attempts++; utterance.lastPreparedAt = Date.now();
      this.answerContext = [...utterance.context];
      this.answers?.prepare(id, question, JSON.stringify(utterance.context));
    }, wait);
  }
  private continuation(text: string) {
    if (!this.lastVoiceQuestion || Date.now() - this.lastVoiceQuestion.at > 8000) return undefined;
    return /^(以及|还有|并且|同时|尤其|特别是|包括|另外还|and\b|also\b)/i.test(text.trim()) ? this.lastVoiceQuestion : undefined;
  }
  private transcript(id: string, text: string, metadata?: SpeakerMetadata) {
    if (!text || this.paused || this.stopped || this.enrolling) return;
    clearTimeout(this.prepareTimer);
    const speaker = this.speakerFor(metadata);
    this.send({ type: 'transcript.final', id, text, ...speaker });
    const finalNumber = ++this.finalNumber;
    const contextText = `${speaker.speaker === 'interviewer' ? '面试官' : speaker.speaker === 'candidate' ? '候选人' : '未确认'}：${text.slice(0, 3000)}`;
    if (speaker.speaker !== 'interviewer') {
      this.diagnose({ event: 'question_decision', finalNumber, speaker: speaker.speaker,
        speakerReason: diagnosticSpeakerReason(speaker.speakerReason), reason: 'not_interviewer' });
      this.clearPending(); this.recentTranscript = [...this.recentTranscript, contextText].slice(-12); return;
    }
    const continuation = this.continuation(text);
    const question = continuation ? `${continuation.text}，${text}`.slice(0, 3000) : text;
    const context = continuation?.context ?? (this.utterance?.id === id ? this.utterance.context : [...this.recentTranscript]);
    const decision = this.detector.evaluate(question);
    this.diagnose({ event: 'question_decision', finalNumber, speaker: speaker.speaker,
      speakerReason: diagnosticSpeakerReason(speaker.speakerReason), reason: decision.reason });
    if (decision.accepted) {
      this.ask(question, id, context);
      this.lastVoiceQuestion = { text: question, context: [...context], at: Date.now() };
    } else {
      this.answers?.invalidatePrepared();
      this.lastVoiceQuestion = undefined;
    }
    this.utterance = undefined;
    this.recentTranscript = [...this.recentTranscript, contextText].slice(-12);
  }
  private ask(text: string, itemId?: string, context = this.recentTranscript, bypassCache = false) {
    if (!this.profile || this.stopped) return;
    const id = randomUUID();
    this.send({ type: 'question.detected', id, text, speaker: 'interviewer' });
    this.answerContext = [...context];
    void this.answers?.commit(id, text, { itemId, contextKey: JSON.stringify(context), bypassCache });
  }
  private clearPending() {
    clearTimeout(this.prepareTimer); clearTimeout(this.demoTimer);
    this.utterance = undefined; this.lastVoiceQuestion = undefined; this.answers?.invalidatePrepared();
  }
  dispose() {
    if (this.stopped) return;
    this.stopped = true; this.clearPending(); clearTimeout(this.authTimer); clearTimeout(this.durationTimer);
    this.answers?.dispose(); this.transcriber?.close(); this.recentTranscript = []; this.answerContext = []; this.profile = undefined; this.voiceProfile = undefined;
  }
}
