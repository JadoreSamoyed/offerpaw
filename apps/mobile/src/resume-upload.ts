import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import { fetch as expoFetch } from "expo/fetch";
import { Platform } from "react-native";
import { effectiveSettings, serverEndpoint } from "./storage";
import type { ResumeAttachment, Settings } from "./types";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 20000;

function checkSize(size: number) {
  if (!Number.isFinite(size) || size <= 0)
    throw new Error("文件为空或无法读取，请重新选择简历文件。");
  if (size > MAX_BYTES)
    throw new Error("简历文件不能超过 5 MB，请压缩文件或粘贴简历文字。");
}

function releaseAsset(asset: DocumentPicker.DocumentPickerAsset) {
  try {
    if (Platform.OS === "web") {
      if (asset.uri.startsWith("blob:")) URL.revokeObjectURL(asset.uri);
      return;
    }
    // Delete only the picker's temporary cache copy, never the user's original.
    const cache = new URL("DocumentPicker/", `${Paths.cache.uri.replace(/\/$/, "")}/`);
    const uri = new URL(asset.uri);
    const leaf = decodeURIComponent(uri.pathname.slice(cache.pathname.length));
    if (uri.protocol === "file:" && uri.href.startsWith(cache.href)
      && !uri.search && !uri.hash && leaf && leaf !== "." && leaf !== ".."
      && !/[\/\\\x00]/.test(leaf)) {
      const file = new File(asset.uri);
      if (file.exists) file.delete();
    }
  } catch {
    // A cache cleanup failure must not discard successfully extracted text.
  }
}

export async function pickAndExtractResume(
  settings: Settings,
  signal?: AbortSignal,
): Promise<{ text: string; attachment: ResumeAttachment; truncated: boolean } | null> {
  if (signal?.aborted) return null;
  settings = effectiveSettings(settings);
  const endpoint = serverEndpoint(settings.serverUrl, "/resume/extract");
  // Keep this call before any await so browser file selection has a user gesture.
  const selection = await DocumentPicker.getDocumentAsync({
    type: ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain"],
    copyToCacheDirectory: true,
    multiple: false,
    base64: false,
  });
  if (selection.canceled || !selection.assets[0]) return null;
  const asset = selection.assets[0];
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 45000);
  try {
    if (signal?.aborted) return null;
    const format = /\.([^.]+)$/.exec(asset.name)?.[1]?.toLowerCase();
    if (format !== "pdf" && format !== "docx" && format !== "txt")
      throw new Error("仅支持 PDF、DOCX 和 TXT；旧版 DOC 或图片请先转换为 DOCX 或文字版 PDF。");
    if (asset.size !== undefined) checkSize(asset.size);
    let bytes: ArrayBuffer;
    if (Platform.OS === "web") {
      if (!asset.file) throw new Error("浏览器未能读取文件，请重新选择简历附件。");
      checkSize(asset.file.size);
      bytes = await asset.file.arrayBuffer();
    } else {
      const file = new File(asset.uri);
      checkSize(file.size);
      bytes = await file.arrayBuffer();
    }
    checkSize(bytes.byteLength);
    if (signal?.aborted) return null;
    if (controller.signal.aborted) throw new Error("简历读取超时，请重试。");
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "X-Resume-Name": encodeURIComponent(asset.name),
    };
    if (settings.token.trim()) headers.Authorization = `Bearer ${settings.token.trim()}`;
    let response: Response;
    try {
      response = await expoFetch(endpoint, {
        method: "POST", headers, body: bytes, signal: controller.signal,
        redirect: "error", credentials: "omit",
      });
    } catch {
      throw new Error("无法连接简历提取服务，请检查服务地址和网络后重试。");
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.error?.message;
      throw new Error(typeof message === "string" && message.length <= 250
        ? message
        : "简历提取失败，请确认服务已更新并稍后重试。");
    }
    if (typeof payload?.text !== "string" || !payload.text.trim()
      || payload.text.length > MAX_TEXT || payload.format !== format
      || typeof payload.truncated !== "boolean")
      throw new Error("服务返回的简历文字无效，请重新上传。");
    if (signal?.aborted) return null;
    if (timedOut) throw new Error("简历提取超时，请重试或粘贴简历文字。");
    return {
      text: payload.text,
      attachment: { name: asset.name, size: bytes.byteLength, format, importedAt: new Date().toISOString() },
      truncated: payload.truncated,
    };
  } catch (error) {
    if (signal?.aborted) return null;
    if (timedOut) throw new Error("简历提取超时，请重试或粘贴简历文字。");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    releaseAsset(asset);
  }
}
