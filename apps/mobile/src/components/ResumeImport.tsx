import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Icon } from "../Icon";
import { pickAndExtractResume } from "../resume-upload";
import type { ResumeAttachment, Settings } from "../types";

const MAX_RESUME_LENGTH = 20000;

type Preview = {
  text: string;
  attachment: ResumeAttachment;
  truncated: boolean;
  originalText: string;
};

function fileSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

function Action({
  label,
  onPress,
  primary = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        primary && styles.primary,
        (disabled || pressed) && { opacity: disabled ? 0.4 : 0.75 },
      ]}
    >
      <Text style={[styles.buttonText, primary && { color: "#FFF" }]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function ResumeImport({
  settings,
  currentText,
  attachment,
  onApply,
}: {
  settings: Settings;
  currentText: string;
  attachment?: ResumeAttachment;
  onApply: (text: string, attachment: ResumeAttachment) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current += 1;
      controller.current?.abort();
      controller.current = null;
    };
  }, []);

  async function upload() {
    if (controller.current) return;
    const currentRequest = ++request.current;
    const abortController = new AbortController();
    controller.current = abortController;
    const originalText = currentText;
    setBusy(true);
    setError("");
    setStatus("");
    setPreview(null);
    try {
      const result = await pickAndExtractResume(settings, abortController.signal);
      if (
        !mounted.current ||
        currentRequest !== request.current ||
        abortController.signal.aborted
      )
        return;
      if (!result) {
        setStatus("已取消选择，简历内容保持不变。");
        return;
      }
      setPreview({
        text: result.text.slice(0, MAX_RESUME_LENGTH),
        attachment: result.attachment,
        truncated: result.truncated || result.text.length > MAX_RESUME_LENGTH,
        originalText,
      });
    } catch (cause) {
      if (
        !mounted.current ||
        currentRequest !== request.current ||
        abortController.signal.aborted
      )
        return;
      setError(cause instanceof Error ? cause.message : "附件读取失败，请重试。");
    } finally {
      if (mounted.current && currentRequest === request.current) {
        controller.current = null;
        setBusy(false);
      }
    }
  }

  function cancel() {
    request.current += 1;
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
    setStatus("已取消上传，简历内容保持不变。");
  }

  return (
    <View style={styles.container}>
      {attachment && (
        <View style={styles.source}>
          <Icon name="file" size={19} color="#236B51" />
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={styles.label}>附件来源：{attachment.name}</Text>
            <Text style={styles.caption}>
              {attachment.format.toUpperCase()} · {fileSize(attachment.size)} ·
              已应用，可继续编辑正文
            </Text>
          </View>
        </View>
      )}
      <View style={styles.actions}>
        <Action
          label={attachment || preview ? "重新上传附件" : "上传简历附件"}
          onPress={() => void upload()}
          disabled={busy}
        />
        {busy && <Action label="取消上传" onPress={cancel} />}
      </View>
      <Text style={styles.caption}>
        支持 PDF / DOCX / TXT，单个文件不超过 5 MB。扫描件或图片暂不支持文字识别。
      </Text>
      <Text style={styles.caption}>
        附件会发送到你配置的服务提取文字；检查预览后再应用到简历。
      </Text>
      {busy && (
        <View style={styles.progress}>
          <ActivityIndicator size="small" color="#236B51" />
          <Text accessibilityLiveRegion="polite" style={styles.caption}>
            正在选择或提取附件文字…
          </Text>
        </View>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {!!status && (
        <Text accessibilityLiveRegion="polite" style={styles.caption}>
          {status}
        </Text>
      )}
      {preview && (
        <View style={styles.preview}>
          <Text style={styles.label}>附件文字预览 · 可编辑</Text>
          <Text style={styles.caption}>
            {preview.attachment.name} · {fileSize(preview.attachment.size)}
          </Text>
          {preview.truncated && (
            <Text style={styles.warning}>
              附件文字超过 20,000 字符，已截断。请检查并保留最相关的经历。
            </Text>
          )}
          <TextInput
            accessibilityLabel="附件文字预览"
            value={preview.text}
            onChangeText={(text) =>
              setPreview((previous) =>
                previous
                  ? { ...previous, text: text.slice(0, MAX_RESUME_LENGTH) }
                  : null,
              )
            }
            multiline
            maxLength={MAX_RESUME_LENGTH}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Text style={styles.caption}>
            {preview.text.length.toLocaleString()} / 20,000 字符
            {preview.text.length >= MAX_RESUME_LENGTH ? " · 已达到字数上限" : ""}
          </Text>
          <Text style={currentText !== preview.originalText ? styles.warning : styles.caption}>
            {currentText !== preview.originalText
              ? "你已修改简历正文，应用此预览将替换当前文字。"
              : "应用后将替换当前简历正文，附件来源信息会一同保存。"}
          </Text>
          <View style={styles.actions}>
            <Action
              label="应用到简历"
              primary
              disabled={busy || !preview.text.trim()}
              onPress={() => {
                onApply(preview.text, preview.attachment);
                setPreview(null);
                setStatus("已应用附件文字，可在简历栏继续编辑。");
              }}
            />
            <Action
              label="放弃预览"
              onPress={() => {
                setPreview(null);
                setStatus("已放弃预览，简历内容保持不变。");
              }}
            />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 9 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  button: {
    minHeight: 39,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#E0E6D9",
    backgroundColor: "#F9FAF5",
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  primary: { backgroundColor: "#236B51", borderColor: "#236B51" },
  buttonText: { color: "#202E29", fontSize: 12, fontWeight: "600" },
  label: { color: "#45583F", fontSize: 12, fontWeight: "600", lineHeight: 20 },
  caption: { color: "#7A847F", fontSize: 11, lineHeight: 20 },
  source: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 9,
    padding: 12,
    backgroundColor: "#EAF2E9",
  },
  progress: { flexDirection: "row", alignItems: "center", gap: 9 },
  error: { color: "#924A38", fontSize: 12, lineHeight: 21 },
  warning: { color: "#87642C", fontSize: 11, lineHeight: 20 },
  preview: {
    gap: 11,
    borderWidth: 1,
    borderColor: "#DFE6D8",
    borderRadius: 10,
    padding: 15,
    backgroundColor: "#F4F8F1",
  },
  input: {
    minHeight: 210,
    maxHeight: 420,
    borderWidth: 1,
    borderColor: "#DFE6D8",
    borderRadius: 9,
    padding: 14,
    backgroundColor: "#FFF",
    color: "#202E29",
    fontSize: 13,
    lineHeight: 24,
    textAlignVertical: "top",
  },
});
