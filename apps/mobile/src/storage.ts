import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { Profile, SessionRecord, Settings, VoiceProfile } from "./types";
import { defaultProfile } from "./types";

const key = "tingda.workspace.v1";
const voiceKey = "tingda.voice-profile.v1";
// Expo replaces this public flag at bundle time. The demo is intentionally
// memory-only: it must never restore, overwrite or clear a real workspace.
export const demoOnly = typeof process !== "undefined" && process.env.EXPO_PUBLIC_DEMO_ONLY === "1";
const demoServerUrl = "http://127.0.0.1:8787";

export function effectiveSettings(settings: Settings): Settings {
  return demoOnly ? { serverUrl: demoServerUrl, token: "" } : settings;
}

export function parseVoiceProfile(value: unknown): VoiceProfile | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || item.model !== "campplus-zh-v1" ||
    !Array.isArray(item.embedding) || item.embedding.length !== 192 ||
    !item.embedding.every((number) => typeof number === "number" && Number.isFinite(number) && Math.abs(number) <= 1000) ||
    Math.hypot(...item.embedding) <= 1e-6 ||
    (item.voicedMs != null && (typeof item.voicedMs !== "number" || !Number.isFinite(item.voicedMs) || item.voicedMs < 0)))
    return null;
  return {
    version: 1, model: "campplus-zh-v1", embedding: [...item.embedding],
    ...(typeof item.voicedMs === "number" ? { voicedMs: item.voicedMs } : {}),
  };
}

export async function loadVoiceProfile(): Promise<VoiceProfile | null> {
  if (demoOnly) return null;
  const raw = await AsyncStorage.getItem(voiceKey);
  if (!raw) return null;
  try { return parseVoiceProfile(JSON.parse(raw)); } catch { return null; }
}

export async function saveVoiceProfile(value: VoiceProfile | null) {
  if (demoOnly) return;
  if (value === null) return AsyncStorage.removeItem(voiceKey);
  const profile = parseVoiceProfile(value);
  if (!profile) throw new Error("声音资料格式不正确，请重新录入。");
  await AsyncStorage.setItem(voiceKey, JSON.stringify(profile));
}
export function defaultServerUrl() {
  if (demoOnly) return demoServerUrl;
  // Expo inlines this public value into the app bundle; never put API keys here.
  const configured = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (configured) return configured;
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:8787`;
  }
  // A physical phone's localhost is the phone, not the computer running ASR.
  return "";
}
export async function loadWorkspace() {
  if (demoOnly) return {
    profile: { ...defaultProfile },
    settings: { serverUrl: demoServerUrl, token: "" },
    history: [] as SessionRecord[],
  };
  let saved: {
    profile?: Profile;
    serverUrl?: string;
    history?: SessionRecord[];
  } = {};
  const raw = await AsyncStorage.getItem(key);
  if (raw) {
    try {
      saved = JSON.parse(raw);
    } catch {
      /* Start fresh after a corrupted local snapshot. */
    }
  }
  let token = "";
  try {
    token =
      Platform.OS === "web"
        ? typeof sessionStorage !== "undefined"
          ? sessionStorage.getItem("tingda.token") || ""
          : ""
        : (await SecureStore.getItemAsync("tingda.token")) || "";
  } catch {
    /* Browsers may disable private storage. */
  }
  return {
    profile: { ...defaultProfile, ...saved.profile },
    settings: { serverUrl: saved.serverUrl || defaultServerUrl(), token },
    history: Array.isArray(saved.history) ? saved.history : [],
  };
}
export async function saveWorkspace(
  profile: Profile,
  settings: Settings,
  history: SessionRecord[],
) {
  if (demoOnly) return;
  await AsyncStorage.setItem(
    key,
    JSON.stringify({ profile, serverUrl: settings.serverUrl, history }),
  );
  if (Platform.OS === "web") {
    if (typeof sessionStorage !== "undefined")
      sessionStorage.setItem("tingda.token", settings.token);
  } else {
    await SecureStore.setItemAsync("tingda.token", settings.token);
  }
}
export function serverEndpoint(input: string, path: string, websocket = false) {
  if (demoOnly) input = demoServerUrl;
  if (!input.trim())
    throw new Error("请先在连接设置填写服务地址；手机连接电脑时，请使用电脑的局域网 IP。");
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { throw new Error("服务地址格式不正确，请填写完整的 http:// 或 https:// 地址。"); }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol))
    throw new Error("请输入 http 或 https 服务地址");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("地址中请勿包含密码、查询参数或片段");
  url.protocol = websocket
    ? ["https:", "wss:"].includes(url.protocol)
      ? "wss:"
      : "ws:"
    : ["https:", "wss:"].includes(url.protocol)
      ? "https:"
      : "http:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  return url.toString();
}
