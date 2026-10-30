import { useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { createRecorder, type Recording } from "./audio";
import { demoOnly, effectiveSettings, loadVoiceProfile, parseVoiceProfile, saveVoiceProfile, serverEndpoint } from "./storage";
import type {
  Profile,
  Question,
  SessionMode,
  SessionRecord,
  Settings,
  Stage,
  Transcript,
  SpeakerMode,
  VoiceProfile,
} from "./types";

export function useAssistant(
  profile: Profile,
  settings: Settings,
  onSave: (record: SessionRecord) => void | Promise<void>,
) {
  const [stage, setStage] = useState<Stage>("idle");
  const [mode, setMode] = useState<SessionMode>("demo");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [speakerMode, setSpeakerMode] = useState<SpeakerMode>("auto");
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfile | null>(null);
  const [voiceProfileLoading, setVoiceProfileLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollmentMs, setEnrollmentMs] = useState(0);
  const [enrollmentPending, setEnrollmentPending] = useState(false);
  const [enrollmentFailed, setEnrollmentFailed] = useState(false);
  const voice = useRef<VoiceProfile | null>(null);
  const requestedSpeaker = useRef<SpeakerMode | null>(null);
  const enrollment = useRef({ active: false, audioMs: 0, pending: false, failed: false });
  const socket = useRef<WebSocket | null>(null);
  const recorder = useRef<ReturnType<typeof createRecorder> | null>(null);
  const state = useRef({
    active: false,
    ready: false,
    stopping: false,
    startedAt: 0,
    mode: "demo" as SessionMode,
    id: "",
    role: "",
    questions: [] as Question[],
    transcripts: [] as Transcript[],
  });
  const save = useRef(onSave);
  save.current = onSave;
  const readyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const questionArrivedAt = useRef(new Map<string, number>());

  function updateQuestions(fn: (q: Question[]) => Question[]) {
    state.current.questions = fn(state.current.questions).slice(-100);
    setQuestions(state.current.questions);
  }

  function finishEnrollment() {
    if (!enrollment.current.active || enrollment.current.pending ||
      socket.current?.readyState !== WebSocket.OPEN || !state.current.active) return;
    enrollment.current.pending = true;
    setEnrollmentPending(true);
    socket.current.send(JSON.stringify({ type: "voice.enroll.finish" }));
  }

  function retryEnrollment() {
    if (!enrollment.current.active || !state.current.active) return;
    enrollment.current = { active: true, audioMs: 0, pending: false, failed: false };
    setEnrollmentMs(0);
    setEnrollmentPending(false);
    setEnrollmentFailed(false);
    setError("");
  }

  function selectSpeaker(next: SpeakerMode) {
    if (!state.current.active) { setSpeakerMode(next); return; }
    if (!state.current.ready || socket.current?.readyState !== WebSocket.OPEN) return;
    // Do not clear audio for an already selected mode. Track the most recent
    // request too, so rapid A → B → A clicks still send the user's final choice.
    if (next === (requestedSpeaker.current ?? speakerMode)) return;
    if (next === "auto" && !voice.current && !enrollment.current.active) {
      setError("自动识别需要录入本人声音。请结束并保存后，选择自动识别，再开始录入。");
      return;
    }
    requestedSpeaker.current = next;
    socket.current.send(JSON.stringify({ type: "speaker.set", speaker: next }));
  }

  async function resetVoiceProfile() {
    if (state.current.active) return;
    try {
      await saveVoiceProfile(null);
      voice.current = null;
      setVoiceProfile(null);
      setSpeakerMode("auto");
      setError("");
    } catch { setError("无法清除本机声音资料，请重试。"); }
  }

  async function stop(message?: string) {
    const current = state.current;
    if (current.stopping || !current.active) return;
    current.stopping = true;
    current.ready = false;
    requestedSpeaker.current = null;
    enrollment.current.active = false;
    setEnrolling(false);
    setStage("stopping");
    if (readyTimeout.current) clearTimeout(readyTimeout.current);
    if (message) setError(message);
    const ws = socket.current;
    let recording: Recording | null = null;
    try {
      recording = (await recorder.current?.stop()) || null;
    } catch {
      setError("录音收尾失败，本次问答已保留。");
    }
    // Stop capture first: the recorder drains its final partial PCM frame to this socket.
    current.active = false;
    socket.current = null;
    if (ws?.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "session.stop" }));
    ws?.close();
    recorder.current = null;
    updateQuestions((items) =>
      items.map((q) => (q.done ? q : { ...q, interrupted: true, done: true })),
    );
    await deactivateKeepAwake("interview").catch(() => undefined);
    if (current.questions.length || current.transcripts.length || recording) {
      try {
        await save.current({
          id: current.id || String(current.startedAt),
          date: new Date(current.startedAt).toISOString(),
          role: current.role || "未设置岗位",
          mode: current.mode,
          durationMs: Date.now() - current.startedAt,
          questions: [...current.questions],
          transcripts: [...current.transcripts],
          recording,
        });
      } catch {
        setError(
          recording
            ? "会话索引保存失败，请检查设备空间；录音文件可能仍保留在应用目录中。"
            : "会话保存失败，请检查设备空间。",
        );
      }
    }
    setStage("stopped");
    setLevel(0);
    current.stopping = false;
  }

  async function start(nextMode: "demo" | "live") {
    if (state.current.active || state.current.stopping) return;
    if (demoOnly) nextMode = "demo";
    const connection = effectiveSettings(settings);
    if (nextMode === "live" && voiceProfileLoading) return;
    let endpoint: string;
    try { endpoint = serverEndpoint(connection.serverUrl, "/session", true); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : "请先在连接设置填写服务地址。");
      return;
    }
    const shouldEnroll = nextMode === "live" && speakerMode === "auto" && !voice.current;
    requestedSpeaker.current = null;
    enrollment.current = { active: shouldEnroll, audioMs: 0, pending: false, failed: false };
    setEnrolling(shouldEnroll);
    setEnrollmentMs(0);
    setEnrollmentPending(false);
    setEnrollmentFailed(false);
    setError("");
    setQuestions([]);
    questionArrivedAt.current.clear();
    setTranscripts([]);
    setElapsed(0);
    setMode(nextMode);
    setStage("connecting");
    state.current = {
      active: true,
      ready: false,
      stopping: false,
      startedAt: Date.now(),
      mode: nextMode,
      id: "",
      role: profile.role,
      questions: [],
      transcripts: [],
    };
    try {
      const ws = new WebSocket(endpoint);
      socket.current = ws;
      readyTimeout.current = setTimeout(() => {
        void stop("连接超时，请检查服务地址和后端是否启动。");
      }, 15000);
      ws.onopen = () =>
        ws.send(
          JSON.stringify({
            type: "session.start",
            mode: nextMode,
            ...(nextMode === "live" ? {
              speakerMode,
              voiceProfile: voice.current || undefined,
              enrollSpeaker: shouldEnroll,
            } : {}),
            profile: {
              role: profile.role,
              resume: profile.resume,
              jobDescription: profile.jobDescription,
              language: profile.language,
              answerStyle: profile.answerStyle,
            },
            token: connection.token.trim() || undefined,
          }),
        );
      ws.onmessage = async (message) => {
        if (
          !state.current.active ||
          state.current.stopping ||
          socket.current !== ws
        )
          return;
        let event: Record<string, any>;
        try {
          event = JSON.parse(String(message.data));
        } catch {
          return;
        }
        switch (event.type) {
          case "session.ready": {
            if (state.current.id) break;
            if (readyTimeout.current) clearTimeout(readyTimeout.current);
            state.current.id = event.sessionId;
            if (nextMode === "live") {
              const capture = createRecorder();
              recorder.current = capture;
              try {
                await capture.start(
                  (chunk) => {
                    if (
                      !state.current.active ||
                      ws.readyState !== WebSocket.OPEN
                    )
                      return;
                    if (ws.bufferedAmount > 192000) {
                      void stop(
                        "网络传输积压，已停止录音并保存会话，请检查网络后重试。",
                      );
                      return;
                    }
                    setLevel(chunk.level);
                    ws.send(
                      JSON.stringify({
                        type: "audio.append",
                        audio: chunk.audio,
                        seq: chunk.seq,
                      }),
                    );
                    const enrollmentState = enrollment.current;
                    if (enrollmentState.active && !enrollmentState.pending && !enrollmentState.failed) {
                      const padding = chunk.audio.endsWith("==") ? 2 : chunk.audio.endsWith("=") ? 1 : 0;
                      enrollmentState.audioMs += (chunk.audio.length * 3 / 4 - padding) / 48;
                      setEnrollmentMs(Math.min(10000, enrollmentState.audioMs));
                      if (enrollmentState.audioMs >= 10000) finishEnrollment();
                    }
                  },
                  (message) => {
                    void stop(message);
                  },
                );
                if (
                  !state.current.active ||
                  state.current.stopping ||
                  socket.current !== ws
                ) {
                  await capture.stop();
                  return;
                }
              } catch (e) {
                if (
                  socket.current === ws &&
                  state.current.active &&
                  !state.current.stopping
                ) {
                  await stop(e instanceof Error ? e.message : "无法启动麦克风");
                }
                return;
              }
            }
            if (
              !state.current.active ||
              state.current.stopping ||
              socket.current !== ws
            )
              return;
            state.current.ready = true;
            void activateKeepAwakeAsync("interview").catch(() => undefined);
            setStage("listening");
            break;
          }
          case "speaker.state": {
            if (!["auto", "interviewer", "candidate"].includes(event.mode)) break;
            setSpeakerMode(event.mode);
            if (requestedSpeaker.current === event.mode) requestedSpeaker.current = null;
            const activeEnrollment = event.enrolling === true;
            enrollment.current.active = activeEnrollment;
            setEnrolling(activeEnrollment);
            if (!activeEnrollment) {
              enrollment.current.pending = false;
              setEnrollmentPending(false);
              setEnrollmentFailed(false);
            }
            break;
          }
          case "voice.enrolled": {
            const enrolled = parseVoiceProfile(event.profile);
            if (!enrolled) { setError("收到的声音资料不完整，请重新录入。"); break; }
            voice.current = enrolled;
            setVoiceProfile(enrolled);
            enrollment.current.active = false;
            setEnrolling(false);
            setEnrollmentPending(false);
            setEnrollmentFailed(false);
            setError("");
            try { await saveVoiceProfile(enrolled); }
            catch { setError("本次声音识别已就绪，但声音资料未能保存到本机，下次需要重新录入。"); }
            break;
          }
          case "transcript.partial":
          case "transcript.final": {
            if (typeof event.id !== "string" || typeof event.text !== "string") break;
            const item: Transcript = {
              id: event.id, text: event.text, final: event.type === "transcript.final",
              speaker: ["interviewer", "candidate"].includes(event.speaker) ? event.speaker : "unknown",
              speakerSource: ["voice", "manual", "unavailable"].includes(event.speakerSource) ? event.speakerSource : undefined,
              speakerReason: typeof event.speakerReason === "string" ? event.speakerReason : undefined,
            };
            const existing = state.current.transcripts.findIndex((t) => t.id === item.id);
            const items = [...state.current.transcripts];
            if (existing < 0) items.push(item); else items[existing] = item;
            state.current.transcripts = items.slice(-2000);
            setTranscripts(state.current.transcripts.slice(-60));
            break;
          }
          case "question.detected":
            if (event.speaker !== "interviewer" && nextMode !== "demo") break;
            if (typeof event.id !== "string" || typeof event.text !== "string" ||
              state.current.questions.some((q) => q.id === event.id)) break;
            questionArrivedAt.current.set(event.id, performance.now());
            if (questionArrivedAt.current.size > 100)
              questionArrivedAt.current.delete(questionArrivedAt.current.keys().next().value!);
            updateQuestions((items) => [
              ...items.map((q) =>
                q.done ? q : { ...q, interrupted: true, done: true },
              ),
              { id: event.id, text: event.text, answer: "", done: false },
            ]);
            break;
          case "answer.start":
            if (!state.current.questions.some((q) => q.id === event.questionId)) break;
            updateQuestions((items) => items.map((q) =>
              q.id === event.questionId ? { ...q, answerSource: event.source } : q,
            ));
            setStage("thinking");
            break;
          case "answer.timing":
            updateQuestions((items) => items.map((q) =>
              q.id === event.questionId ? {
                ...q, answerSource: event.source,
                latencyMs: event.requestToFirstTokenMs,
                commitLatencyMs: event.questionCommitToFirstTokenMs,
              } : q,
            ));
            break;
          case "answer.delta":
            updateQuestions((items) =>
              items.map((q) =>
                q.id === event.questionId
                  ? {
                      ...q, answer: q.answer + event.text,
                      clientFirstDeltaMs: q.clientFirstDeltaMs ?? Math.round(
                        performance.now() - (questionArrivedAt.current.get(q.id) ?? performance.now()),
                      ),
                    }
                  : q,
              ),
            );
            break;
          case "answer.done":
            updateQuestions((items) =>
              items.map((q) =>
                q.id === event.questionId
                  ? { ...q, done: true, latencyMs: event.latencyMs }
                  : q,
              ),
            );
            setStage((previous) =>
              previous === "paused" ? previous : "listening",
            );
            break;
          case "status":
            if (
              state.current.ready &&
              [
                "listening", "transcribing", "thinking", "paused",
              ].includes(event.stage)
            )
              setStage(event.stage as Stage);
            break;
          case "error":
            setError(event.message || "会话发生错误");
            if (["VOICE_ENROLL_TOO_SHORT", "VOICE_ENROLL_INCONSISTENT", "VOICE_ENROLL_INVALID_AUDIO"].includes(event.code)) {
              enrollment.current.pending = false;
              enrollment.current.failed = true;
              setEnrollmentPending(false);
              setEnrollmentFailed(true);
            }
            if (
              ["ANSWER_FAILED", "ANSWER_TIMEOUT", "ANSWER_INCOMPLETE"].includes(
                event.code,
              )
            )
              updateQuestions((items) =>
                items.map((q) =>
                  q.done ? q : { ...q, interrupted: true, done: true },
                ),
              );
            if (!event.recoverable) await stop(event.message || "会话已中断");
            break;
          case "session.stopped":
            await stop();
            break;
        }
      };
      ws.onerror = () => {
        if (socket.current === ws)
          void stop("无法连接服务，请检查地址、访问令牌和网络。");
      };
      ws.onclose = () => {
        if (socket.current === ws && state.current.active)
          void stop(
            nextMode === "live"
              ? "连接已断开，本次录音和问答已收尾保存。"
              : "连接已断开，本次问答已收尾保存。",
          );
      };
    } catch (e) {
      await stop(e instanceof Error ? e.message : "启动失败");
    }
  }

  async function togglePause() {
    // A pause clears the ASR buffer. Keep enrollment continuous so its audio counter
    // cannot outlive the samples the voice model will receive.
    if (!socket.current || !state.current.active || !state.current.ready || enrollment.current.active)
      return;
    try {
      if (stage === "paused") {
        socket.current.send(JSON.stringify({ type: "session.resume" }));
        await recorder.current?.resume();
        setStage("listening");
      } else {
        await recorder.current?.pause();
        updateQuestions((items) =>
          items.map((q) =>
            q.done ? q : { ...q, interrupted: true, done: true },
          ),
        );
        socket.current.send(JSON.stringify({ type: "session.pause" }));
        setStage("paused");
        setLevel(0);
      }
    } catch (e) {
      await stop(e instanceof Error ? e.message : "会话暂停失败");
    }
  }
  function ask(text: string, bypassCache = false) {
    if (text.trim().length < 2) {
      setError("请至少输入两个字的问题。");
      return false;
    }
    if (
      !state.current.active ||
      !state.current.ready ||
      stage === "paused" ||
      enrollment.current.active ||
      socket.current?.readyState !== WebSocket.OPEN
    )
      return false;
    socket.current.send(
      JSON.stringify({ type: "question.ask", text: text.trim(), bypassCache }),
    );
    setError("");
    return true;
  }

  useEffect(() => {
    let mounted = true;
    loadVoiceProfile().then((saved) => {
      if (!mounted) return;
      voice.current = saved;
      setVoiceProfile(saved);
    }).catch(() => {
      if (mounted) setError("无法读取本机声音资料，可重新录入或手动指定说话人。");
    }).finally(() => { if (mounted) setVoiceProfileLoading(false); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const tick = setInterval(() => {
      if (state.current.active)
        setElapsed(Date.now() - state.current.startedAt);
    }, 1000);
    const subscription = AppState.addEventListener("change", (next) => {
      if (
        next === "background" &&
        state.current.active &&
        state.current.mode === "live"
      )
        void stop("应用进入后台，已结束本次录音。首版请保持前台使用。");
    });
    const onHide = () => {
      if (
        typeof document !== "undefined" &&
        document.hidden &&
        state.current.active &&
        state.current.mode === "live"
      )
        void stop("页面进入后台，已结束本次录音并保存。");
    };
    if (Platform.OS === "web")
      document.addEventListener("visibilitychange", onHide);
    return () => {
      clearInterval(tick);
      subscription.remove();
      if (Platform.OS === "web")
        document.removeEventListener("visibilitychange", onHide);
      void stop();
    };
  }, []);
  return {
    stage,
    mode,
    questions,
    transcripts,
    error,
    elapsed,
    level,
    speakerMode,
    voiceProfileReady: Boolean(voiceProfile),
    voiceProfileLoading,
    enrolling,
    enrollmentMs,
    enrollmentPending,
    enrollmentFailed,
    retryEnrollment,
    selectSpeaker,
    resetVoiceProfile,
    start,
    stop,
    togglePause,
    ask,
    clearError: () => setError(""),
    active: !["idle", "stopped"].includes(stage),
  };
}
