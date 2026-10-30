import { z } from 'zod';

const number = (fallback: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(fallback);
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'), PORT: number(8787, 0, 65535),
  APP_ACCESS_TOKEN: z.string().default(''), MAX_SESSIONS: number(20, 1, 1000),
  LLM_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  LLM_API_KEY: z.string().default(''), LLM_MODEL: z.string().default(''),
  LLM_TIMEOUT_MS: number(25000, 1000, 120000), LLM_MAX_TOKENS: number(650, 50, 8000),
  LLM_TOKEN_PARAMETER: z.enum(['max_tokens', 'max_completion_tokens']).default('max_tokens'),
  LLM_THINKING: z.enum(['default', 'disabled', 'enabled']).default('default'),
  ANSWER_PREFETCH_ENABLED: z.enum(['true', 'false']).default('true'),
  ANSWER_PREFETCH_STABLE_MS: number(400, 80, 2000),
  ANSWER_PREFETCH_MAX_PER_TURN: number(3, 0, 6),
  ASR_PROVIDER: z.enum(['openai', 'local', 'qwen', 'dashscope']).default('openai'),
  ASR_LOCAL_URL: z.string().url().default('ws://127.0.0.1:8765'),
  ASR_LOCAL_TOKEN: z.string().max(4096).default(''),
  ASR_WS_URL: z.string().url().optional(),
  ASR_API_KEY: z.string().default(''), ASR_MODEL: z.string().default(''),
  ASR_TURN_DETECTION: z.enum(['client_vad', 'server_vad']).optional(),
  ASR_DASHSCOPE_VAD_MODEL: z.enum(['near_meeting_16k', 'far_field_meeting_16k']).default('near_meeting_16k'),
  ASR_VAD_SILENCE_MS: number(420, 200, 2000),
  ASR_VAD_RMS_THRESHOLD: z.coerce.number().min(0.001).max(0.5).default(0.012),
  ASR_TRANSCRIPTION_OPTIONS: z.string().default('{}'),
  ASR_CONNECT_TIMEOUT_MS: number(12000, 1000, 60000), ALLOWED_ORIGINS: z.string().default(''),
});

export type Config = Omit<z.infer<typeof schema>, 'ASR_WS_URL' | 'ASR_TURN_DETECTION'> & {
  ASR_WS_URL: string;
  ASR_TURN_DETECTION: 'client_vad' | 'server_vad';
  transcriptionOptions: Record<string, unknown>;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid server settings: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`);
  const config = {
    ...parsed.data,
    ASR_WS_URL: parsed.data.ASR_WS_URL ?? (parsed.data.ASR_PROVIDER === 'dashscope'
      ? 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
      : parsed.data.ASR_PROVIDER === 'qwen' ? 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime' : 'wss://api.openai.com/v1/realtime?intent=transcription'),
    ASR_MODEL: parsed.data.ASR_MODEL || (parsed.data.ASR_PROVIDER === 'dashscope'
      ? 'qwen-audio-3.1-asr-flash-streaming' : parsed.data.ASR_PROVIDER === 'qwen' ? 'qwen3-asr-flash-realtime' : ''),
    ASR_TURN_DETECTION: parsed.data.ASR_TURN_DETECTION ?? (['qwen', 'dashscope'].includes(parsed.data.ASR_PROVIDER) ? 'server_vad' : 'client_vad'),
  };
  if (config.ASR_PROVIDER === 'dashscope' && config.ASR_TURN_DETECTION !== 'server_vad') {
    throw new Error('DashScope streaming requires ASR_TURN_DETECTION=server_vad.');
  }
  if (config.NODE_ENV === 'production' && config.APP_ACCESS_TOKEN.length < 24) {
    throw new Error('Production requires APP_ACCESS_TOKEN of at least 24 characters.');
  }
  for (const [raw, protocols] of [[config.LLM_BASE_URL, ['https:', 'http:']], [config.ASR_WS_URL, ['wss:', 'ws:']]] as const) {
    const url = new URL(raw);
    if (!protocols.includes(url.protocol as never) || url.username || url.password) throw new Error('Invalid provider URL.');
    if (config.NODE_ENV === 'production' && !['https:', 'wss:'].includes(url.protocol)) {
      throw new Error('Production provider URLs must use TLS.');
    }
  }
  const local = new URL(config.ASR_LOCAL_URL);
  if (!['ws:', 'wss:'].includes(local.protocol) || local.username || local.password) throw new Error('Invalid local ASR URL.');
  const loopback = local.hostname === 'localhost' || local.hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(local.hostname);
  if (config.NODE_ENV === 'production' && local.protocol === 'ws:' && !loopback) {
    throw new Error('Production local ASR requires TLS unless it uses a loopback address.');
  }
  let transcriptionOptions: unknown;
  try { transcriptionOptions = JSON.parse(config.ASR_TRANSCRIPTION_OPTIONS); } catch { throw new Error('ASR_TRANSCRIPTION_OPTIONS must be a JSON object.'); }
  if (!transcriptionOptions || typeof transcriptionOptions !== 'object' || Array.isArray(transcriptionOptions)) throw new Error('ASR_TRANSCRIPTION_OPTIONS must be a JSON object.');
  return { ...config, transcriptionOptions: transcriptionOptions as Record<string, unknown> };
}

export function textConfigured(config: Config): boolean {
  return Boolean(config.LLM_API_KEY && config.LLM_MODEL);
}

export function asrConfigured(config: Config): boolean {
  // Configuration alone is not a readiness probe; connect() waits for model/session readiness.
  return config.ASR_PROVIDER === 'local' || Boolean(config.ASR_API_KEY && config.ASR_MODEL);
}

export function liveConfigured(config: Config): boolean {
  return textConfigured(config) && asrConfigured(config);
}
