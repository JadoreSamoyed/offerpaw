import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { Icon, type IconName } from "./src/Icon";
import {
  demoOnly,
  loadWorkspace,
  saveWorkspace,
  defaultServerUrl,
  serverEndpoint,
} from "./src/storage";
import {
  defaultProfile,
  type Profile,
  type Settings,
  type SessionRecord,
  type Speaker,
  type SpeakerMode,
} from "./src/types";
import { useAssistant } from "./src/useAssistant";
import { deleteRecording, shareRecording } from "./src/audio";
import { ResumeImport } from "./src/components/ResumeImport";

const C = {
  bg: "#F4F5F1",
  paper: "#FFFFFF",
  ink: "#202E29",
  muted: "#7A847F",
  line: "#E3E8E1",
  green: "#236B51",
  mint: "#EAF2E9",
  dark: "#1B3029",
  gold: "#DCE9AE",
};
type Tab = "desk" | "profile" | "history" | "settings";
const tabs: { id: Tab; label: string; icon: IconName; sub: string }[] = [
  { id: "desk", label: "面试台", icon: "grid", sub: "把注意力，留给对话。" },
  {
    id: "profile",
    label: "面试资料",
    icon: "file",
    sub: "好回答，从了解你开始。",
  },
  {
    id: "history",
    label: "会话记录",
    icon: "history",
    sub: "每一次交流，都值得复盘。",
  },
  {
    id: "settings",
    label: "连接设置",
    icon: "settings",
    sub: "连接你的实时辅助服务。",
  },
];
function duration(ms: number) {
  const sec = Math.floor(ms / 1000);
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}
function speakerLabel(speaker?: Speaker) {
  return speaker === "interviewer" ? "面试官" : speaker === "candidate" ? "我" : "未确认";
}
const speakerOptions: { mode: SpeakerMode; label: string }[] = [
  { mode: "auto", label: "自动识别" },
  { mode: "candidate", label: "我在回答" },
  { mode: "interviewer", label: "面试官提问" },
];
function Button({
  label,
  icon,
  onPress,
  kind = "primary",
  disabled = false,
  small = false,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  kind?: "primary" | "secondary" | "ghost" | "danger";
  disabled?: boolean;
  small?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        s.button,
        small && s.buttonSmall,
        kind === "secondary" && s.secondary,
        kind === "ghost" && s.ghost,
        kind === "danger" && s.danger,
        disabled && s.disabled,
        pressed && { opacity: 0.75 },
      ]}
    >
      {icon && (
        <Icon
          name={icon}
          size={small ? 16 : 19}
          color={
            kind === "primary" ? "#FFF" : kind === "danger" ? "#9F483C" : C.ink
          }
        />
      )}
      <Text
        style={[
          s.buttonText,
          kind !== "primary" && {
            color: kind === "danger" ? "#9F483C" : C.ink,
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}
function Field({
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  secure = false,
  maxLength = 12000,
  editable = true,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  secure?: boolean;
  maxLength?: number;
  editable?: boolean;
}) {
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        editable={editable}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#9BA59D"
        multiline={multiline}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={maxLength}
        style={[
          s.input,
          multiline && {
            minHeight: 150,
            textAlignVertical: "top",
            lineHeight: 24,
          },
        ]}
      />
    </View>
  );
}
function Wave({
  active,
  level = 0,
  light = false,
}: {
  active: boolean;
  level?: number;
  light?: boolean;
}) {
  return (
    <View style={s.wave}>
      {Array.from({ length: 35 }, (_, i) => (
        <View
          key={i}
          style={{
            width: 3,
            borderRadius: 4,
            height: active
              ? 5 + (Math.sin(i * 1.7) + 1) * 10 + level * ((i % 5) + 1) * 9
              : 4 + Math.abs(Math.sin(i * 1.23)) * 12,
            backgroundColor: light ? "#B3C99D" : C.green,
            opacity: active ? 0.4 + (i % 4) * 0.18 : 0.25,
          }}
        />
      ))}
    </View>
  );
}

function Workspace() {
  const { width } = useWindowDimensions();
  const wide = width >= 1050;
  const compact = width < 640;
  const [tab, setTab] = useState<Tab>("desk");
  const [profile, setProfile] = useState<Profile>(defaultProfile);
  const [settings, setSettings] = useState<Settings>({
    serverUrl: defaultServerUrl(),
    token: "",
  });
  const [history, setHistory] = useState<SessionRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState("");
  const [focus, setFocus] = useState(false);
  const [manual, setManual] = useState("");
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [health, setHealth] = useState<{
    busy: boolean;
    text: string;
    ok: boolean;
  }>({ busy: false, text: "", ok: false });
  const workspace = useRef({ profile, settings, history });
  workspace.current = { profile, settings, history };
  const assistant = useAssistant(profile, settings, async (record) => {
    const snapshot = workspace.current;
    const records = [
      record,
      ...snapshot.history.filter((item) => item.id !== record.id),
    ];
    workspace.current = { ...snapshot, history: records };
    setHistory(records);
    // Persist directly, including when the recorder finishes after the view has unmounted.
    await saveWorkspace(snapshot.profile, snapshot.settings, records);
  });
  const latestId = assistant.questions.at(-1)?.id;
  const current =
    assistant.questions.find((q) => q.id === selectedQuestion) ||
    assistant.questions.at(-1);
  const session = history.find((item) => item.id === selectedSession);
  const active = assistant.active;
  const pending =
    assistant.stage === "connecting" || assistant.stage === "stopping";
  const paused = assistant.stage === "paused";
  const pauseLabel =
    assistant.mode === "demo"
      ? paused
        ? "继续演示"
        : "暂停演示"
      : paused
        ? "继续聆听"
        : "暂停聆听";
  const modeLabel =
    assistant.mode === "demo"
      ? "模拟演示 · 麦克风关闭"
      : assistant.stage === "connecting"
        ? "正在连接 · 尚未录音"
        : paused
          ? "实时面试 · 录音暂停"
          : assistant.stage === "stopping"
            ? "正在保存录音与问答"
            : "实时面试 · 前台录音";
  const tabInfo = tabs.find((t) => t.id === tab)!;
  const statusText =
    assistant.stage === "stopping"
      ? "正在保存"
      : pending
        ? "正在连接"
        : paused
          ? "已暂停"
          : assistant.enrolling
            ? "正在录入本人声音"
          : assistant.stage === "thinking"
            ? "正在生成回答…"
            : active
              ? assistant.mode === "demo"
                ? "模拟演示中"
                : "正在聆听"
              : "等待开始";
  const profileCount = [
    profile.role,
    profile.resume,
    profile.jobDescription,
  ].filter((v) => v.trim()).length;

  useEffect(() => {
    loadWorkspace()
      .then((saved) => {
        setProfile(saved.profile);
        setSettings(saved.settings);
        setHistory(saved.history);
      })
      .catch(() => setNotice("无法读取本地资料，将使用空白配置。"))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const timeout = setTimeout(() => {
      saveWorkspace(profile, settings, history).catch(() =>
        setNotice("本地保存失败，请检查设备剩余空间。"),
      );
    }, 350);
    return () => clearTimeout(timeout);
  }, [profile, settings, history, loaded]);
  useEffect(() => {
    setSelectedQuestion(null);
  }, [latestId]);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timeout);
  }, [notice]);

  async function checkConnection() {
    setHealth({ busy: true, text: "", ok: false });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(
        serverEndpoint(settings.serverUrl, "/health"),
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error(`服务返回 ${response.status}，请检查后端地址。`);
      const data = await response.json();
      const live =
        data.capabilities?.live ??
        data.liveReady ??
        data.providers?.liveReady ??
        false;
      const modelReady = data.capabilities?.text ?? live;
      const asrConfigured = data.capabilities?.asrConfigured ?? live;
      const modelStatus = modelReady
        ? "大模型已配置"
        : "大模型未配置";
      const voiceStatus = asrConfigured
        ? "语音转写已配置"
        : "语音转写未配置，暂不能收音转写";
      const connectionHint = live
        ? "配置已就绪，开始时会确认语音服务连接。"
        : "请先补齐语音与模型服务配置，也可体验模拟演示。";
      setHealth({
        busy: false,
        ok: true,
        text: `服务已连接 · ${modelStatus} · ${voiceStatus}。${connectionHint}`,
      });
    } catch (error) {
      setHealth({
        busy: false,
        ok: false,
        text: error instanceof Error && error.name !== "AbortError"
          ? `${error.message} 请确认服务地址和网络连接。`
          : "连接超时。请确认后端已启动、地址可访问；公网请使用 HTTPS。",
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  async function removeSession(record: SessionRecord) {
    try {
      if (record.recording) await deleteRecording(record.recording);
      setHistory((items) => items.filter((item) => item.id !== record.id));
      setConfirmDelete(null);
      if (selectedSession === record.id) setSelectedSession(null);
      setNotice(record.recording ? "已删除会话和本地录音" : "已删除会话");
    } catch {
      setNotice("删除录音失败，请重试。");
    }
  }
  const changeProfile = (key: keyof Profile, value: string) =>
    setProfile((p) => ({ ...p, [key]: value }));
  const navigate = (next: Tab) => {
    setTab(next);
    setFocus(false);
  };
  const renderNav = (mobile = false) =>
    tabs.map((item) => (
      <Pressable
        key={item.id}
        accessibilityRole="tab"
        accessibilityState={{ selected: tab === item.id }}
        accessibilityLabel={item.label}
        onPress={() => navigate(item.id)}
        style={({ pressed }) => [
          mobile ? s.bottomItem : s.navItem,
          tab === item.id && (mobile ? { opacity: 1 } : s.navSelected),
          pressed && { opacity: 0.7 },
        ]}
      >
        <Icon
          name={item.icon}
          color={tab === item.id ? C.green : C.muted}
          size={mobile ? 21 : 19}
        />
        <Text
          style={[
            mobile ? s.bottomLabel : s.navLabel,
            tab === item.id && { color: C.green, fontWeight: "700" },
          ]}
        >
          {item.label}
        </Text>
        {!mobile && tab === item.id && <View style={s.navDot} />}
      </Pressable>
    ));

  if (!loaded)
    return (
      <View style={[s.app, s.center]}>
        <ActivityIndicator color={C.green} />
        <Text style={s.muted}>正在整理你的面试空间…</Text>
      </View>
    );

  return (
    <SafeAreaView style={s.app}>
      <StatusBar barStyle="dark-content" />
      <View style={s.shell}>
        {wide && !focus && (
          <View style={s.sidebar}>
            <View style={s.brand}>
              <View style={s.brandMark}>
                <Icon name="wave" color="#FFF" size={23} />
              </View>
              <Text style={s.brandName}>
                Offer汪<Text style={s.brandDot}>.</Text>
              </Text>
            </View>
            <Text style={s.sidebarCaption}>YOUR INTERVIEW COMPANION</Text>
            <View style={s.nav}>{renderNav()}</View>
            <View style={{ flex: 1 }} />
            <View style={s.sidebarNote}>
              <View style={s.tinyLabelRow}>
                <View style={s.dot} />
                <Text style={s.tinyLabel}>为下一次机会做好准备</Text>
              </View>
              <Text style={s.sidebarNoteText}>
                听清问题，直接回答。{"\n"}每一次回答，都更从容。
              </Text>
              <View style={s.sideLine} />
              <Text style={s.smallMuted}>安卓 / iOS · 首版预览</Text>
            </View>
            <View style={s.sidebarFooter}>
              <View style={s.avatar}>
                <Text style={{ color: C.green, fontWeight: "700" }}>我</Text>
              </View>
              <View>
                <Text style={s.label}>我的面试空间</Text>
                <Text style={s.smallMuted}>资料保存在当前设备</Text>
              </View>
            </View>
          </View>
        )}
        <View style={s.main}>
          <View style={[s.topbar, compact && { paddingHorizontal: 20 }]}>
            <View style={s.row}>
              {(!wide || focus) && (
                <View style={s.brandMarkSmall}>
                  <Icon name="wave" color="#FFF" size={19} />
                </View>
              )}
              <Text style={s.breadcrumb}>
                {focus ? "Offer汪 / 专注模式" : `我的空间  /  ${tabInfo.label}`}
              </Text>
            </View>
            <View style={s.row}>
              <View style={s.versionPill}>
                <View style={[s.dot, { width: 5, height: 5 }]} />
                <Text style={s.versionText}>PREVIEW 0.1</Text>
              </View>
              {focus && (
                <Button
                  label="退出专注"
                  small
                  kind="ghost"
                  onPress={() => setFocus(false)}
                />
              )}
            </View>
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={[
              s.content,
              compact && { padding: 20, gap: 22 },
              focus && { maxWidth: 1060 },
            ]}
            keyboardShouldPersistTaps="handled"
          >
            {notice !== "" && (
              <Pressable onPress={() => setNotice("")} style={s.notice}>
                <Icon name="check" size={17} color={C.green} />
                <Text style={s.noticeText}>{notice}</Text>
                <Icon name="close" size={16} />
              </Pressable>
            )}
            {assistant.error !== "" && (
              <View style={s.errorBanner}>
                <Text style={s.errorText}>{assistant.error}</Text>
                <Pressable
                  accessibilityLabel="关闭错误提示"
                  onPress={assistant.clearError}
                >
                  <Icon name="close" size={18} color="#924A38" />
                </Pressable>
              </View>
            )}
            {!focus && !(active && tab === "desk") && (
              <View style={s.pageHeading}>
                <View style={{ gap: 10, flex: 1 }}>
                  <Text style={s.eyebrow}>
                    {tab === "desk"
                      ? "READY FOR YOUR NEXT CHAPTER"
                      : tab === "profile"
                        ? "A LITTLE CONTEXT. A BETTER ANSWER."
                        : tab === "history"
                          ? "EVERY CONVERSATION COUNTS"
                          : "LET’S GET CONNECTED"}
                  </Text>
                  <Text style={[s.title, compact && { fontSize: 28 }]}>
                    {tabInfo.sub}
                  </Text>
                  <Text style={s.subtitle}>
                    {tab === "desk"
                      ? "实时聆听面试问题，生成可直接照读的面试回答。"
                      : tab === "profile"
                        ? "补充真实经历与岗位信息，让回答更贴近你。"
                        : tab === "history"
                          ? "录音和问答保存在当前设备，随时回看。"
                          : "连接语音转写与大模型服务，开始实时面试。"}
                  </Text>
                </View>
                {!compact && tab === "desk" && (
                  <View style={s.headingStamp}>
                    <Text style={s.stampLarge}>声声有回应</Text>
                    <Text style={s.stampSmall}>LISTEN. THINK. RESPOND.</Text>
                  </View>
                )}
              </View>
            )}

            {tab === "desk" && (
              <>
                {!focus && !active && (
                  <View
                    style={[
                      s.prepStrip,
                      compact && {
                        alignItems: "flex-start",
                        flexDirection: "column",
                      },
                    ]}
                  >
                    <View style={[s.row, { flex: 1 }]}>
                      <View style={s.softIcon}>
                        <Icon name="file" color={C.green} size={20} />
                      </View>
                      <View style={{ gap: 5, flex: 1 }}>
                        <Text style={s.prepTitle}>
                          {profile.role || "为这场面试，准备一份专属背景"}
                        </Text>
                        <Text style={s.smallMuted}>
                          {profileCount === 3
                            ? "岗位、简历和职位描述已准备好"
                            : `面试资料已完成 ${profileCount}/3 项 · 补充后回答会更贴合你`}
                        </Text>
                      </View>
                    </View>
                    <Button
                      label={profileCount ? "编辑资料" : "完善资料"}
                      icon="arrow"
                      kind="ghost"
                      small
                      onPress={() => navigate("profile")}
                    />
                  </View>
                )}
                {!wide && !focus && (
                  <View style={s.mobileSession}>
                    <View style={s.rowBetween}>
                      <View style={s.row}>
                        <View
                          style={[
                            s.dot,
                            !active && { backgroundColor: "#ADB7A6" },
                          ]}
                        />
                        <Text style={s.label}>{statusText}</Text>
                      </View>
                      <Text style={s.mobileTimer}>
                        {duration(assistant.elapsed)}
                      </Text>
                    </View>
                    {active && <Text style={s.smallMuted}>{modeLabel}</Text>}
                    {!active ? (
                      <View style={s.row}>
                        <View style={{ flex: 1 }}>
                          <Button
                            label="开始面试"
                            icon="mic"
                            disabled={demoOnly || assistant.voiceProfileLoading}
                            onPress={() => assistant.start("live")}
                          />
                        </View>
                        <Button
                          label="模拟演示"
                          icon="play"
                          kind="secondary"
                          onPress={() => assistant.start("demo")}
                        />
                      </View>
                    ) : (
                      <View style={s.row}>
                        <View style={{ flex: 1 }}>
                          <Button
                            label={
                              pending
                                ? "连接中…"
                                : pauseLabel
                            }
                            icon={paused ? "play" : "pause"}
                            disabled={pending || assistant.enrolling}
                            onPress={assistant.togglePause}
                          />
                        </View>
                        <Button
                          label={pending ? "取消连接" : "结束并保存"}
                          icon="stop"
                          kind="secondary"
                          onPress={() => assistant.stop()}
                        />
                      </View>
                    )}
                  </View>
                )}
                {(!active || assistant.mode === "live") && (
                  <View style={s.speakerCard}>
                    <View style={s.rowBetween}>
                      <View style={{ gap: 5, flex: 1, minWidth: 180 }}>
                        <Text style={s.label}>
                          {assistant.enrolling ? "先记住你的声音" : assistant.speakerMode === "candidate"
                            ? "我在回答 · 只记录，答案保持显示"
                            : assistant.speakerMode === "interviewer" ? "面试官提问 · 识别问题后回答"
                            : active && assistant.transcripts.length
                              ? `自动识别 · ${speakerLabel(assistant.transcripts.at(-1)?.speaker)}`
                              : "自动区分说话人"}
                        </Text>
                        <Text style={s.smallMuted}>
                          {assistant.speakerMode === "auto"
                            ? assistant.voiceProfileReady
                              ? "已记住本机声音资料。只回答面试官的问题，你的回答会保留在记录中。"
                              : "首次开始后，请用自己的声音朗读约 10 秒，随后自动进入面试。"
                            : "已手动指定当前说话人。轮到另一方时请切换；也可恢复自动识别。"}
                        </Text>
                      </View>
                      {!active && assistant.voiceProfileReady && (
                        <Button label="重新录入本人声音" kind="ghost" small onPress={assistant.resetVoiceProfile} />
                      )}
                    </View>
                    <View style={s.speakerOptions}>
                      {speakerOptions.map((option) => (
                        <Pressable
                          key={option.mode}
                          accessibilityRole="button"
                          accessibilityLabel={option.label}
                          accessibilityState={{ selected: assistant.speakerMode === option.mode, disabled: pending || paused }}
                          disabled={pending || paused}
                          onPress={() => assistant.selectSpeaker(option.mode)}
                          style={[s.speakerOption, assistant.speakerMode === option.mode && s.speakerOptionSelected, (pending || paused) && s.disabled]}
                        >
                          <Text style={[s.speakerOptionText, assistant.speakerMode === option.mode && { color: C.green, fontWeight: "600" }]}>{option.label}</Text>
                        </Pressable>
                      ))}
                    </View>
                    {active && assistant.enrolling ? (
                      <View style={s.enrollmentBox}>
                        <View style={s.rowBetween}>
                          <Text style={s.label}>{assistant.enrollmentFailed ? "请重新朗读一遍" : assistant.enrollmentPending ? "正在确认你的声音…" : "请正常说话，让电脑暂时保持安静"}</Text>
                          <Text style={s.smallMuted}>{Math.min(10, Math.floor(assistant.enrollmentMs / 1000))} / 10 秒</Text>
                        </View>
                        <View style={s.enrollmentTrack}><View style={[s.enrollmentProgress, { width: `${Math.min(100, assistant.enrollmentMs / 100)}%` }]} /></View>
                        <Text style={s.enrollmentScript}>“你好，我现在准备开始面试。我会结合自己的实际经历，介绍项目背景、承担的工作，以及解决问题的方法。接下来我会认真听清每一道问题，再自然地作答。”</Text>
                        <Wave active={!paused && !assistant.enrollmentPending && !assistant.enrollmentFailed} level={assistant.level} />
                        {assistant.enrollmentFailed ? (
                          <Button label="继续录入 10 秒" small disabled={paused || pending} onPress={assistant.retryEnrollment} />
                        ) : <Text style={s.smallMuted}>声音资料仅保存在本机，用于区分你和面试官。录入完成后会自动继续；也可点上方角色切换为手动。</Text>}
                      </View>
                    ) : <Text style={s.smallMuted}>一个人模拟双方对话时，请手动切换角色；同一个人的声音无法自动区分为两个人。</Text>}
                  </View>
                )}
                <View
                  style={[
                    s.deskGrid,
                    (!wide || focus) && { flexDirection: "column" },
                  ]}
                >
                  <View style={{ flex: 1, gap: 20, minWidth: 0 }}>
                    <View style={s.questionCard}>
                      <View style={s.sectionTop}>
                        <View style={s.row}>
                          <Text style={s.sectionNumber}>01</Text>
                          <Text style={s.sectionLabel}>面试官的问题</Text>
                        </View>
                        {active && (
                          <View style={s.pill}>
                            <View
                              style={[
                                s.dot,
                                assistant.mode === "demo" && {
                                  backgroundColor: "#B18A45",
                                },
                              ]}
                            />
                            <Text style={s.pillText}>
                              {assistant.mode === "demo"
                                ? "模拟演示"
                                : "实时会话"}
                            </Text>
                          </View>
                        )}
                      </View>
                      <Text
                        selectable
                        style={[
                          s.questionText,
                          !current && { color: "#9AA49D", fontWeight: "400" },
                          compact && { fontSize: 21 },
                        ]}
                      >
                        {current?.text || "下一道问题，\n从这里开始。"}
                      </Text>
                      <View style={s.questionFooter}>
                        <View style={s.row}>
                          <Icon name="mic" size={14} color={C.muted} />
                          <Text style={s.smallMuted}>
                            {current
                              ? `问题 ${assistant.questions.indexOf(current) + 1} / ${assistant.questions.length}`
                              : "确认面试官提问后显示；你回答时保持不变"}
                          </Text>
                        </View>
                        {current && (
                          <Button
                            label="重新回答"
                            small
                            kind="ghost"
                            icon="history"
                            disabled={!active || paused || pending || assistant.enrolling}
                            onPress={() => assistant.ask(current.text, true)}
                          />
                        )}
                      </View>
                    </View>
                    <View style={[s.answerCard, focus && { minHeight: 440 }]}>
                      <View style={s.sectionTop}>
                        <View style={s.row}>
                          <Text
                            style={[
                              s.sectionNumber,
                              { color: "#AAC5A8", borderColor: "#4C6356" },
                            ]}
                          >
                            02
                          </Text>
                          <Text style={[s.sectionLabel, { color: "#E4EEE2" }]}>
                            面试回答
                          </Text>
                        </View>
                        <View style={s.row}>
                          {(current?.commitLatencyMs != null || current?.latencyMs != null) &&
                            assistant.mode !== "demo" && (
                              <Text style={s.answerMeta}>
                                {current?.commitLatencyMs != null
                                  ? `服务端首段 ${(current.commitLatencyMs / 1000).toFixed(2)}s`
                                  : `模型首段 ${((current?.latencyMs ?? 0) / 1000).toFixed(2)}s`}
                                {current?.answerSource === "prepared" ? " · 提前准备" : current?.answerSource === "cache" ? " · 缓存" : " · 新生成"}
                              </Text>
                            )}
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={
                              focus ? "退出专注模式" : "专注模式"
                            }
                            onPress={() => setFocus(!focus)}
                            hitSlop={12}
                          >
                            <Icon name="expand" color="#C2D2C0" size={18} />
                          </Pressable>
                        </View>
                      </View>
                      {current ? (
                        <View style={s.answerBody}>
                          {current.answer ? (
                            <Text
                              selectable
                              style={[
                                s.answerText,
                                focus && {
                                  fontSize: compact ? 24 : 28,
                                  lineHeight: compact ? 38 : 44,
                                },
                              ]}
                            >
                              {current.answer
                                .replace(/^#{1,3} /gm, "")
                                .replace(/\*\*/g, "")}
                              {!current.done && active && !paused ? " ▍" : ""}
                            </Text>
                          ) : (
                            <View style={s.answerWaiting}>
                              {!current.interrupted && active && !paused && (
                                <ActivityIndicator color={C.gold} />
                              )}
                              <Text style={s.answerMuted}>
                                {current.interrupted
                                  ? "本题生成已中断，可重新回答"
                                  : active && !paused
                                    ? "正在生成回答…"
                                    : "本题未生成回答"}
                              </Text>
                            </View>
                          )}
                        </View>
                      ) : (
                        <View style={s.answerEmpty}>
                          <View style={s.answerOrbit}>
                            <Icon name="wave" size={34} color={C.gold} />
                          </View>
                          <Text style={s.answerEmptyTitle}>
                            面试回答，直接照读。
                          </Text>
                          <Text style={s.answerEmptyCaption}>
                            {`听清面试问题后，${compact ? "\n" : ""}生成可直接照读的完整回答。\n结合你填写的真实经历，用自然口语表达。`}
                          </Text>
                          <View style={s.answerSkeleton}>
                            <View style={[s.skeletonLine, { width: "86%" }]} />
                            <View style={[s.skeletonLine, { width: "100%" }]} />
                            <View style={[s.skeletonLine, { width: "62%" }]} />
                          </View>
                        </View>
                      )}
                      <View style={s.answerBottom}>
                        <View style={s.row}>
                          <View
                            style={[
                              s.dot,
                              { backgroundColor: C.gold, width: 5, height: 5 },
                            ]}
                          />
                          <Text style={s.answerFootnote}>
                            {current?.interrupted
                              ? "回答已中断 · 可重新生成"
                              : assistant.mode === "demo" && (active || current)
                                ? "演示内容 · 非真实 AI 回答"
                                : "口语回答 · 可直接照读"}
                          </Text>
                        </View>
                        {current?.answer ? (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="复制回答"
                            onPress={() => {
                              Clipboard.setStringAsync(current.answer)
                                .then(() => setNotice("回答已复制"))
                                .catch(() =>
                                  setNotice(
                                    "复制失败，请长按回答文本选择复制。",
                                  ),
                                );
                            }}
                            style={s.row}
                          >
                            <Icon name="copy" size={14} color="#B5C7B7" />
                            <Text style={s.answerFootnote}>复制</Text>
                          </Pressable>
                        ) : (
                          <Text style={s.answerFootnote}>STREAMING ANSWER</Text>
                        )}
                      </View>
                    </View>
                    {assistant.questions.length > 1 && (
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={{ gap: 8 }}
                      >
                        {assistant.questions.map((q, index) => (
                          <Pressable
                            key={q.id}
                            onPress={() => setSelectedQuestion(q.id)}
                            style={[
                              s.questionChip,
                              current?.id === q.id && {
                                backgroundColor: C.mint,
                                borderColor: "#B6CDB4",
                              },
                            ]}
                          >
                            <Text
                              numberOfLines={1}
                              style={[
                                s.smallMuted,
                                { color: C.ink, maxWidth: 190 },
                              ]}
                            >
                              {String(index + 1).padStart(2, "0")} · {q.text}
                            </Text>
                          </Pressable>
                        ))}
                      </ScrollView>
                    )}
                    {active && !assistant.enrolling && (
                      <View style={s.manualBox}>
                        <Icon name="file" size={18} color={C.muted} />
                        <TextInput
                          accessibilityLabel="手动输入问题"
                          value={manual}
                          onChangeText={setManual}
                          maxLength={2000}
                          placeholder="开始面试后，可在这里补充或修改问题"
                          placeholderTextColor="#8C968E"
                          style={s.manualInput}
                          onSubmitEditing={() => {
                            if (assistant.ask(manual)) setManual("");
                          }}
                          returnKeyType="send"
                        />
                        <Button
                          label="发送"
                          icon="arrow"
                          small
                          disabled={pending || paused || !manual.trim()}
                          onPress={() => {
                            if (assistant.ask(manual)) setManual("");
                          }}
                        />
                      </View>
                    )}
                  </View>
                  {!focus && (
                    <View style={[s.rightColumn, !wide && { width: "100%" }]}>
                      {wide && (
                        <View style={s.sessionCard}>
                          <View style={s.sectionTop}>
                            <Text style={s.sectionLabel}>会话状态</Text>
                            <View style={s.statusDotWrap}>
                              <View
                                style={[
                                  s.dot,
                                  {
                                    backgroundColor: paused
                                      ? "#B89553"
                                      : active
                                        ? C.green
                                        : "#B2BBB1",
                                  },
                                ]}
                              />
                              <Text style={s.smallMuted}>{statusText}</Text>
                            </View>
                          </View>
                          <Text style={s.timer}>
                            {duration(assistant.elapsed)}
                          </Text>
                          <Text style={[s.smallMuted, { textAlign: "center" }]}>
                            {active ? modeLabel : "准备好后，开启你的面试"}
                          </Text>
                          <Wave
                            active={
                              active && !paused && assistant.mode === "live"
                            }
                            level={assistant.level}
                          />
                          <View style={s.sessionDivider} />
                          {!active ? (
                            <>
                              <Button
                                label="开始面试"
                                icon="mic"
                                disabled={demoOnly || assistant.voiceProfileLoading}
                                onPress={() => assistant.start("live")}
                              />
                              <Button
                                label="模拟演示"
                                icon="play"
                                kind="secondary"
                                onPress={() => assistant.start("demo")}
                              />
                              <Text style={s.sessionHint}>
                                模拟演示无需 API，回答为预设内容{"\n"}
                                实时面试需连接语音与模型服务
                              </Text>
                            </>
                          ) : (
                            <>
                              <Button
                                label={
                                  pending
                                    ? "正在连接…"
                                    : pauseLabel
                                }
                                icon={paused ? "play" : "pause"}
                                disabled={pending || assistant.enrolling}
                                onPress={assistant.togglePause}
                              />
                              <Button
                                label={pending ? "取消连接" : "结束并保存"}
                                icon="stop"
                                kind="secondary"
                                onPress={() => assistant.stop()}
                              />
                              {assistant.mode === "demo" && (
                                <Button
                                  label="演示下一个问题"
                                  kind="ghost"
                                  small
                                  disabled={paused || pending}
                                  onPress={() =>
                                    assistant.ask(
                                      "你如何处理项目中的团队分歧？",
                                    )
                                  }
                                />
                              )}
                            </>
                          )}
                        </View>
                      )}
                      <View style={s.transcriptCard}>
                        <View style={s.sectionTop}>
                          <Text style={s.sectionLabel}>实时转写</Text>
                          <Text style={s.monoLabel}>{assistant.mode === "demo" && (active || current) ? "DEMO" : "LIVE"}</Text>
                        </View>
                        <ScrollView
                          nestedScrollEnabled
                          style={{ maxHeight: 250 }}
                          contentContainerStyle={{ gap: 14 }}
                        >
                          <Text style={s.transcriptCaption}>
                            {assistant.mode === "demo" && (active || current)
                              ? "模拟转写 · 麦克风关闭"
                              : "按说话人记录 · 本人回答不触发答案"}
                          </Text>
                          {assistant.transcripts.length ? (
                            assistant.transcripts.map((t) => (
                              <View key={t.id} style={s.transcriptItem}>
                                <View
                                  style={[
                                    s.dot,
                                    {
                                      backgroundColor: t.final
                                        ? "#B4C6B1"
                                        : "#D8B16A",
                                      marginTop: 7,
                                      width: 4,
                                      height: 4,
                                    },
                                  ]}
                                />
                                <View style={{ flex: 1, gap: 3 }}>
                                  <Text style={[s.transcriptSpeaker, t.speaker === "candidate" && { color: "#7C786E" }]}>{speakerLabel(t.speaker)}{!t.final ? " · 识别中" : ""}{t.speakerSource === "manual" ? " · 手动指定" : ""}</Text>
                                  <Text selectable style={[s.transcriptText, !t.final && { color: C.muted }]}>{t.text}</Text>
                                  {active && t.final && t.speaker === "unknown" && !assistant.enrolling && (
                                    <View style={{ alignItems: "flex-start" }}><Button label="回答这句" kind="ghost" small disabled={pending || paused} onPress={() => assistant.ask(t.text)} /></View>
                                  )}
                                </View>
                              </View>
                            ))
                          ) : (
                            <View style={s.transcriptEmpty}>
                              <Icon name="wave" color="#C1CCC0" size={25} />
                              <Text style={s.transcriptEmptyText}>
                                安静聆听，不错过重点。{"\n"}对话文字会显示在这里。
                              </Text>
                            </View>
                          )}
                        </ScrollView>
                      </View>
                      <View style={s.tip}>
                        <Text style={s.tipLabel}>一个小提示</Text>
                        <Text style={s.tipText}>
                          电脑面试时请将声音外放，手机放在旁边收音，并保持应用在前台。
                        </Text>
                      </View>
                    </View>
                  )}
                </View>
                {!focus && (
                  <View style={s.pageFooter}>
                    <Text style={s.smallMuted}>
                      Offer汪，给每一次表达多一点底气。
                    </Text>
                    <Text style={s.footerMark}>MADE FOR YOUR NEXT STEP ↗</Text>
                  </View>
                )}
              </>
            )}

            {tab === "profile" && (
              <View style={[s.formGrid, !wide && { flexDirection: "column" }]}>
                <View style={[s.formCard, { flex: 1 }]}>
                  <View style={s.formHeader}>
                    <Text style={s.cardTitle}>你的面试背景</Text>
                    <Text style={s.smallMuted}>自动保存到本机</Text>
                  </View>
                  {active && (
                    <Text style={s.inlineHint}>
                      当前会话使用开始时的资料，修改将在下一次会话生效。
                    </Text>
                  )}
                  <Field
                    label="目标岗位"
                    value={profile.role}
                    onChangeText={(v) => changeProfile("role", v)}
                    placeholder="例如：高级产品经理 / Java 开发工程师"
                    maxLength={160}
                  />
                  <View style={{ gap: 14 }}>
                    <Field
                      label="简历与项目经历"
                      multiline
                      value={profile.resume}
                      onChangeText={(v) => changeProfile("resume", v)}
                      placeholder="上传简历附件，或粘贴你的工作经历、项目职责与真实成果。回答会以这些信息为依据。"
                      maxLength={20000}
                    />
                    <ResumeImport
                      settings={settings}
                      currentText={profile.resume}
                      attachment={profile.resumeAttachment}
                      onApply={(text, attachment) => {
                        setProfile((previous) => ({
                          ...previous,
                          resume: text,
                          resumeAttachment: attachment,
                        }));
                        setNotice("附件正文已应用到简历，正在自动保存。");
                      }}
                    />
                  </View>
                  <Field
                    label="岗位要求 / JD"
                    multiline
                    value={profile.jobDescription}
                    onChangeText={(v) => changeProfile("jobDescription", v)}
                    placeholder="粘贴职位描述、团队方向，以及你希望重点准备的能力要求。"
                  />
                </View>
                <View style={[s.formSide, !wide && { width: "100%" }]}>
                  <View style={s.formCard}>
                    <Text style={s.cardTitle}>回答偏好</Text>
                    <Text style={s.label}>回答语言</Text>
                    <View style={s.segment}>
                      {(["zh", "en"] as const).map((value) => (
                        <Pressable
                          key={value}
                          onPress={() => changeProfile("language", value)}
                          style={[
                            s.segmentItem,
                            profile.language === value && s.segmentActive,
                          ]}
                        >
                          <Text
                            style={[
                              s.segmentText,
                              profile.language === value && { color: C.green },
                            ]}
                          >
                            {value === "zh" ? "中文" : "English"}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                    <Text style={s.label}>表达方式</Text>
                    {(["concise", "structured"] as const).map((value) => (
                      <Pressable
                        key={value}
                        onPress={() => changeProfile("answerStyle", value)}
                        style={[
                          s.option,
                          profile.answerStyle === value && {
                            borderColor: "#91B295",
                            backgroundColor: "#F4F8F1",
                          },
                        ]}
                      >
                        <View style={s.row}>
                          <View
                            style={[
                              s.radio,
                              profile.answerStyle === value && {
                                borderWidth: 5,
                                borderColor: C.green,
                              },
                            ]}
                          />
                          <Text style={s.label}>
                            {value === "concise" ? "简短回答" : "充分回答"}
                          </Text>
                        </View>
                        <Text
                          style={[
                            s.smallMuted,
                            { paddingLeft: 28, lineHeight: 20 },
                          ]}
                        >
                          {value === "concise"
                            ? "直接回答问题，用简短口语段落表达，可直接照读"
                            : "完整解释问题，用自然口语充分展开，可直接照读"}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  <View style={s.noteCard}>
                    <Icon name="file" color={C.green} size={25} />
                    <Text style={s.noteTitle}>真实经历，才有说服力。</Text>
                    <Text style={s.tipText}>
                      资料不完整时，回答会使用通用口语表达，不替你编造项目成果。实时面试时，这些资料会发送到你配置的模型服务。
                    </Text>
                  </View>
                  <Button
                    label="回到面试台"
                    icon="arrow"
                    onPress={() => navigate("desk")}
                  />
                </View>
              </View>
            )}

            {tab === "history" && (
              <View style={{ gap: 18 }}>
                {session ? (
                  <>
                    <View style={s.rowBetween}>
                      <Button
                        label="返回会话列表"
                        kind="ghost"
                        icon="history"
                        onPress={() => setSelectedSession(null)}
                      />
                      <Text style={s.smallMuted}>
                        {session.mode === "demo" ? "模拟演示" : session.mode === "text" ? "历史文字问答" : "真实面试"} ·{" "}
                        {duration(session.durationMs)}
                      </Text>
                    </View>
                    <View style={s.formCard}>
                      <Text style={s.cardTitle}>{session.role}</Text>
                      <Text style={s.muted}>
                        {new Date(session.date).toLocaleString("zh-CN")}
                      </Text>
                      {session.recording && (
                        <Button
                          label="导出本次录音"
                          icon="download"
                          kind="secondary"
                          onPress={() => {
                            shareRecording(session.recording!).catch((e) =>
                              setNotice(
                                e instanceof Error ? e.message : "导出失败",
                              ),
                            );
                          }}
                        />
                      )}
                    </View>
                    {session.questions.map((q, i) => (
                      <View key={q.id} style={s.formCard}>
                        <Text style={s.eyebrow}>
                          QUESTION {String(i + 1).padStart(2, "0")}
                        </Text>
                        <Text selectable style={s.historyQuestion}>
                          {q.text}
                        </Text>
                        <Text selectable style={s.historyAnswer}>
                          {q.answer || "本题未生成回答"}
                        </Text>
                      </View>
                    ))}
                    {Boolean(session.transcripts?.length) && (
                      <View style={s.formCard}>
                        <Text style={s.cardTitle}>对话记录</Text>
                        {session.transcripts!.map((item) => (
                          <View key={item.id} style={{ gap: 5 }}>
                            <Text style={s.transcriptSpeaker}>{speakerLabel(item.speaker)}{!item.final ? " · 未完成转写" : ""}</Text>
                            <Text selectable style={s.muted}>{item.text}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </>
                ) : history.length ? (
                  history.map((item) => (
                    <View key={item.id} style={s.historyCard}>
                      <Pressable
                        style={{ flex: 1, gap: 10 }}
                        accessibilityRole="button"
                        accessibilityLabel={`查看${item.role}会话`}
                        onPress={() => setSelectedSession(item.id)}
                      >
                        <View style={s.row}>
                          <View style={s.softIcon}>
                            <Icon name="history" color={C.green} />
                          </View>
                          <View style={{ gap: 6, flex: 1 }}>
                            <Text style={s.cardTitle}>{item.role}</Text>
                            <Text style={s.smallMuted}>
                              {new Date(item.date).toLocaleString("zh-CN")} ·{" "}
                              {item.questions.length} 个问题 ·{" "}
                              {duration(item.durationMs)}
                            </Text>
                          </View>
                          <View style={s.pill}>
                            <Text style={s.pillText}>
                              {item.mode === "demo" ? "演示" : item.mode === "text" ? "历史文字问答" : "面试"}
                            </Text>
                          </View>
                        </View>
                      </Pressable>
                      <View style={[s.row, { justifyContent: "flex-end" }]}>
                        {confirmDelete === item.id ? (
                          <>
                            <Text style={s.smallMuted}>{item.recording ? "同时删除本地录音？" : "删除这次问答记录？"}</Text>
                            <Button
                              label="取消"
                              small
                              kind="ghost"
                              onPress={() => setConfirmDelete(null)}
                            />
                            <Button
                              label="确认删除"
                              small
                              kind="danger"
                              onPress={() => removeSession(item)}
                            />
                          </>
                        ) : (
                          <>
                            <Button
                              label="查看详情"
                              small
                              kind="ghost"
                              icon="arrow"
                              onPress={() => setSelectedSession(item.id)}
                            />
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`删除${item.role}会话`}
                              onPress={() => setConfirmDelete(item.id)}
                              style={{ padding: 10 }}
                            >
                              <Icon name="trash" size={17} color={C.muted} />
                            </Pressable>
                          </>
                        )}
                      </View>
                    </View>
                  ))
                ) : (
                  <View style={s.emptyHistory}>
                    <View style={s.emptyCircle}>
                      <Icon name="history" size={32} color={C.green} />
                    </View>
                    <Text style={s.answerEmptyTitleLight}>
                      你的第一场对话，值得留下。
                    </Text>
                    <Text style={s.emptyDescription}>
                      结束会话后，问答和录音会保存在这里。{"\n"}
                      先从模拟演示开始，熟悉面试节奏。
                    </Text>
                    <Button
                      label="去面试台体验"
                      icon="arrow"
                      onPress={() => navigate("desk")}
                    />
                  </View>
                )}
                {!session && history.length > 0 && (
                  <Text style={s.smallMuted}>
                    会话和录音保留到你主动删除。卸载应用或清除浏览器数据会移除本机记录，请及时导出重要录音。
                  </Text>
                )}
              </View>
            )}

            {tab === "settings" && (
              <View style={[s.formGrid, !wide && { flexDirection: "column" }]}>
                <View style={[s.formCard, { flex: 1 }]}>
                  <Text style={s.cardTitle}>服务连接</Text>
                  {demoOnly && <Text style={s.inlineHint}>隔离演示：仅连接本机，资料与历史只保留在当前页面内存中，不读取或覆盖已有记录。刷新页面后清空。</Text>}
                  <Field
                    label="服务地址"
                    editable={!demoOnly}
                    value={settings.serverUrl}
                    onChangeText={(serverUrl) => {
                      setSettings((p) => ({ ...p, serverUrl }));
                      setHealth({ busy: false, text: "", ok: false });
                    }}
                    placeholder="https://interview.example.com"
                    maxLength={500}
                  />
                  <Text style={s.inlineHint}>
                    填写服务器的 HTTPS 地址，无需添加 /session。局域网调试可填写
                    http://电脑IP:8787；实体手机上的 localhost 指向手机自身。
                  </Text>
                  <Field
                    label="访问令牌"
                    editable={!demoOnly}
                    value={settings.token}
                    onChangeText={(token) =>
                      setSettings((p) => ({ ...p, token }))
                    }
                    placeholder="与服务端 APP_ACCESS_TOKEN 一致"
                    secure
                    maxLength={512}
                  />
                  <Text style={s.inlineHint}>
                    用于访问你自己的后端。大模型 API Key 在服务端配置。
                  </Text>
                  <View style={{ alignItems: "flex-start" }}>
                    <Button
                      label={health.busy ? "正在检测…" : "检测连接"}
                      icon="wifi"
                      disabled={health.busy}
                      onPress={checkConnection}
                    />
                  </View>
                  {health.text !== "" && (
                    <View
                      style={[
                        s.healthBox,
                        !health.ok && { backgroundColor: "#FCF1EA" },
                      ]}
                    >
                      <Icon
                        name={health.ok ? "check" : "close"}
                        color={health.ok ? C.green : "#A15D3C"}
                        size={18}
                      />
                      <Text
                        style={{
                          flex: 1,
                          color: health.ok ? C.green : "#924A38",
                          lineHeight: 23,
                        }}
                      >
                        {health.text}
                      </Text>
                    </View>
                  )}
                </View>
                <View style={[s.formSide, !wide && { width: "100%" }]}>
                  <View style={s.noteCard}>
                    <Icon name="wave" color={C.green} size={26} />
                    <Text style={s.noteTitle}>一条对话，两种能力。</Text>
                    <Text style={s.tipText}>
                      语音转写（ASR）负责把声音变成文字；大模型（LLM）负责生成回答。两者可分别选择服务商。
                    </Text>
                    <View style={s.sideLine} />
                    <Text style={s.tipText}>
                      实时面试需配置语音转写和大模型服务。模拟演示使用预设回答，不调用真实模型。
                    </Text>
                  </View>
                  <View style={s.tip}>
                    <Text style={s.tipLabel}>连接提示</Text>
                    <Text style={s.tipText}>
                      公网使用 HTTPS / WSS。本地浏览器录音需要 localhost 或
                      HTTPS。实时录音请保持前台使用，切到后台会结束并保存。
                    </Text>
                  </View>
                </View>
              </View>
            )}
          </ScrollView>
          {focus && (
            <View
              style={[
                s.focusControls,
                { padding: 14, borderTopWidth: 1, borderColor: C.line },
              ]}
            >
              <Text style={s.label}>
                {statusText} · {duration(assistant.elapsed)}{active ? ` · ${modeLabel}` : ""}
              </Text>
              <Button
                label={pauseLabel}
                kind="secondary"
                small
                disabled={!active || pending || assistant.enrolling}
                onPress={assistant.togglePause}
              />
              <Button
                label={
                  assistant.stage === "stopping" ? "保存中…" : "结束并保存"
                }
                kind="secondary"
                small
                disabled={!active || assistant.stage === "stopping"}
                onPress={() => assistant.stop()}
              />
            </View>
          )}
          {!wide && !focus && (
            <View style={s.bottomNav}>{renderNav(true)}</View>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}
export default function App() {
  return (
    <SafeAreaProvider>
      <Workspace />
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  app: { flex: 1, backgroundColor: C.bg },
  shell: { flex: 1, flexDirection: "row" },
  center: { alignItems: "center", justifyContent: "center", gap: 16 },
  sidebar: {
    width: 226,
    backgroundColor: "#FCFCF8",
    paddingHorizontal: 22,
    borderRightWidth: 1,
    borderColor: C.line,
    paddingTop: 38,
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingLeft: 7,
  },
  brandMark: {
    width: 37,
    height: 37,
    backgroundColor: C.green,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  brandMarkSmall: {
    width: 28,
    height: 28,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.green,
  },
  brandName: {
    color: C.ink,
    fontSize: 29,
    fontWeight: "800",
    letterSpacing: 1,
  },
  brandDot: { color: C.green },
  sidebarCaption: {
    color: "#929D93",
    fontSize: 8,
    letterSpacing: 1.2,
    marginTop: 14,
    paddingLeft: 7,
  },
  nav: { marginTop: 51, gap: 12 },
  navItem: {
    minHeight: 48,
    borderRadius: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    paddingHorizontal: 16,
  },
  navSelected: { backgroundColor: "#EAF0E6" },
  navLabel: { fontSize: 14, color: "#707C72" },
  navDot: {
    width: 5,
    height: 5,
    backgroundColor: C.green,
    borderRadius: 4,
    marginLeft: "auto",
  },
  sidebarNote: {
    backgroundColor: "#F1F4EA",
    borderRadius: 11,
    padding: 16,
    marginBottom: 28,
  },
  tinyLabelRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  tinyLabel: { fontSize: 10, color: C.green, fontWeight: "600" },
  sidebarNoteText: {
    fontSize: 12,
    color: "#71806E",
    lineHeight: 22,
    marginTop: 13,
  },
  sideLine: { height: 1, backgroundColor: "#DDE6D6", marginVertical: 14 },
  sidebarFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingVertical: 22,
    borderTopWidth: 1,
    borderColor: C.line,
  },
  avatar: {
    width: 33,
    height: 33,
    backgroundColor: "#E8EDDE",
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  main: { flex: 1, minWidth: 0 },
  topbar: {
    minHeight: 76,
    paddingHorizontal: 38,
    borderBottomWidth: 1,
    borderColor: C.line,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  breadcrumb: { fontSize: 12, color: "#7D877F" },
  versionPill: {
    flexDirection: "row",
    gap: 7,
    alignItems: "center",
    backgroundColor: "#EBEFE5",
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 6,
  },
  versionText: { fontSize: 9, color: "#75856F", letterSpacing: 1.2 },
  content: {
    padding: 38,
    paddingTop: 34,
    gap: 26,
    width: "100%",
    maxWidth: 1440,
    alignSelf: "center",
    paddingBottom: 30,
  },
  pageHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 20,
    marginBottom: 2,
  },
  eyebrow: {
    color: "#85927F",
    fontSize: 9,
    letterSpacing: 1.8,
    fontWeight: "600",
  },
  title: {
    fontSize: 32,
    fontWeight: "600",
    color: C.ink,
    letterSpacing: -0.8,
    lineHeight: 45,
  },
  subtitle: { color: "#8A938B", fontSize: 12, lineHeight: 22 },
  headingStamp: {
    alignItems: "flex-end",
    gap: 8,
    borderLeftWidth: 1,
    borderColor: "#D8E0D3",
    paddingLeft: 25,
  },
  stampLarge: {
    color: "#85947D",
    fontSize: 17,
    letterSpacing: 4,
    fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
  },
  stampSmall: { color: "#A4AEA0", fontSize: 7, letterSpacing: 1.7 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 10,
  },
  dot: { width: 6, height: 6, borderRadius: 4, backgroundColor: C.green },
  prepStrip: {
    paddingHorizontal: 19,
    paddingVertical: 15,
    backgroundColor: "#EEF2E8",
    borderWidth: 1,
    borderColor: "#DFE6D6",
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  softIcon: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#E1EAD9",
    borderRadius: 11,
    marginRight: 4,
  },
  prepTitle: {
    fontSize: 13,
    color: "#3D573B",
    fontWeight: "600",
    lineHeight: 21,
  },
  deskGrid: { flexDirection: "row", gap: 22, alignItems: "stretch" },
  rightColumn: { width: 278, gap: 18 },
  questionCard: {
    padding: 23,
    backgroundColor: C.paper,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 15,
    minHeight: 202,
  },
  sectionTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  sectionNumber: {
    width: 23,
    height: 23,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#DEE5DA",
    textAlign: "center",
    lineHeight: 21,
    fontSize: 10,
    color: "#869680",
  },
  sectionLabel: {
    fontSize: 12,
    color: "#5E6E60",
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 5,
    backgroundColor: "#EFF3E9",
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  pillText: { fontSize: 10, color: "#6D815F" },
  questionText: {
    fontSize: 24,
    fontWeight: "600",
    lineHeight: 36,
    color: C.ink,
    marginTop: 24,
    marginBottom: 18,
  },
  questionFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 6,
  },
  answerCard: {
    backgroundColor: C.dark,
    borderRadius: 15,
    padding: 24,
    minHeight: 340,
    overflow: "hidden",
  },
  answerMeta: { color: "#B1C8AA", fontSize: 10 },
  answerBody: { paddingVertical: 27, flex: 1 },
  answerText: {
    fontSize: 19,
    lineHeight: 32,
    color: "#EFF5E9",
    letterSpacing: 0.2,
  },
  answerWaiting: { paddingVertical: 45, gap: 18, alignItems: "center" },
  answerMuted: { color: "#A0B69D", fontSize: 13 },
  answerEmpty: { paddingTop: 28, paddingBottom: 26, flex: 1 },
  answerOrbit: {
    width: 58,
    height: 58,
    borderRadius: 20,
    backgroundColor: "#30483A",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  answerEmptyTitle: {
    color: "#E8EEDC",
    fontSize: 24,
    fontWeight: "500",
    letterSpacing: 0.2,
  },
  answerEmptyCaption: {
    color: "#91A68C",
    fontSize: 12,
    lineHeight: 23,
    marginTop: 14,
  },
  answerSkeleton: { gap: 8, maxWidth: 340, marginTop: 28 },
  skeletonLine: { height: 5, borderRadius: 4, backgroundColor: "#354B3C" },
  answerBottom: {
    borderTopWidth: 1,
    borderColor: "#344B3B",
    paddingTop: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 7,
  },
  answerFootnote: { fontSize: 9, letterSpacing: 0.3, color: "#9DB492" },
  manualBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: C.line,
    backgroundColor: "#FFF",
    borderRadius: 10,
    padding: 9,
    paddingLeft: 15,
  },
  manualInput: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    color: C.ink,
    paddingVertical: 10,
    outlineWidth: 0,
  } as any,
  sessionCard: {
    backgroundColor: C.paper,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 15,
    padding: 21,
    gap: 11,
  },
  statusDotWrap: { flexDirection: "row", alignItems: "center", gap: 5 },
  timer: {
    fontSize: 47,
    color: "#324937",
    textAlign: "center",
    fontWeight: "400",
    letterSpacing: 2,
    marginTop: 13,
    fontVariant: ["tabular-nums"],
    fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
  },
  wave: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    height: 47,
    marginTop: 4,
  },
  sessionDivider: { height: 1, backgroundColor: "#E8ECE4", marginBottom: 7 },
  sessionHint: {
    fontSize: 10,
    color: "#9BA397",
    textAlign: "center",
    lineHeight: 19,
    marginTop: 4,
  },
  button: {
    minHeight: 45,
    borderRadius: 8,
    backgroundColor: C.green,
    paddingHorizontal: 17,
    paddingVertical: 11,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  buttonSmall: { minHeight: 33, paddingHorizontal: 11, paddingVertical: 7 },
  buttonText: { color: "#FFF", fontSize: 12, fontWeight: "600" },
  secondary: {
    backgroundColor: "#F9FAF5",
    borderWidth: 1,
    borderColor: "#E0E6D9",
  },
  ghost: { backgroundColor: "transparent" },
  danger: { backgroundColor: "#FBECE7" },
  disabled: { opacity: 0.4 },
  transcriptCard: {
    padding: 21,
    backgroundColor: "#FCFDF9",
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 15,
    gap: 18,
  },
  monoLabel: { fontSize: 8, color: "#9EA997", letterSpacing: 1.2 },
  transcriptCaption: { fontSize: 10, color: "#ABB2A6", marginTop: -4 },
  transcriptSpeaker: { color: C.green, fontSize: 11, fontWeight: "600", lineHeight: 19 },
  speakerCard: { borderWidth: 1, borderColor: C.line, backgroundColor: "#FCFDF9", borderRadius: 12, padding: 18, gap: 12 },
  speakerOptions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  speakerOption: { minHeight: 38, justifyContent: "center", alignItems: "center", borderRadius: 7, borderWidth: 1, borderColor: C.line, paddingHorizontal: 15, paddingVertical: 9, backgroundColor: "#FFF" },
  speakerOptionSelected: { backgroundColor: C.mint, borderColor: "#B6CDB4" },
  speakerOptionText: { color: C.muted, fontSize: 12 },
  enrollmentBox: { padding: 16, backgroundColor: "#F0F4E9", borderRadius: 9, gap: 12 },
  enrollmentTrack: { height: 5, borderRadius: 4, overflow: "hidden", backgroundColor: "#DBE5D4" },
  enrollmentProgress: { height: 5, backgroundColor: C.green, borderRadius: 4 },
  enrollmentScript: { color: "#52664B", fontSize: 14, lineHeight: 25 },
  transcriptItem: { flexDirection: "row", gap: 9 },
  transcriptText: { flex: 1, fontSize: 12, color: "#5E6E5B", lineHeight: 23 },
  transcriptEmpty: { paddingVertical: 13, gap: 13 },
  transcriptEmptyText: { color: "#A3AD9C", fontSize: 12, lineHeight: 22 },
  tip: { padding: 4, gap: 9 },
  tipLabel: {
    fontSize: 10,
    color: "#89947D",
    fontWeight: "600",
    letterSpacing: 0.4,
  },
  tipText: { color: "#8B9783", fontSize: 12, lineHeight: 23 },
  pageFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap",
    paddingTop: 2,
  },
  footerMark: { fontSize: 8, color: "#A6B09E", letterSpacing: 1.1 },
  muted: { color: C.muted, fontSize: 13, lineHeight: 22 },
  smallMuted: { color: "#909B8B", fontSize: 10, lineHeight: 18 },
  label: { color: "#45583F", fontSize: 12, fontWeight: "600", lineHeight: 20 },
  formGrid: { flexDirection: "row", gap: 24, alignItems: "flex-start" },
  formCard: {
    width: "100%",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.line,
    backgroundColor: C.paper,
    padding: 25,
    gap: 24,
  },
  formHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardTitle: { color: C.ink, fontSize: 16, fontWeight: "600", lineHeight: 25 },
  formSide: { width: 300, gap: 20 },
  input: {
    borderWidth: 1,
    borderColor: "#DFE6D8",
    backgroundColor: "#FCFDF9",
    borderRadius: 9,
    padding: 14,
    color: C.ink,
    fontSize: 13,
    minHeight: 48,
  },
  inlineHint: {
    color: "#94A08A",
    fontSize: 11,
    lineHeight: 21,
    marginTop: -10,
  },
  segment: {
    flexDirection: "row",
    backgroundColor: "#F0F3EB",
    padding: 4,
    borderRadius: 8,
    marginTop: -10,
  },
  segmentItem: { flex: 1, alignItems: "center", padding: 11, borderRadius: 5 },
  segmentActive: { backgroundColor: "#FFF" },
  segmentText: { color: C.muted, fontSize: 12 },
  option: {
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 9,
    padding: 14,
    gap: 7,
    marginTop: -10,
  },
  radio: {
    width: 16,
    height: 16,
    borderWidth: 1,
    borderColor: "#BCCAB3",
    borderRadius: 9,
  },
  noteCard: {
    backgroundColor: "#EBF0E4",
    borderRadius: 13,
    padding: 23,
    gap: 16,
  },
  noteTitle: { color: "#55704A", fontSize: 17, fontWeight: "500" },
  healthBox: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: "#EDF5E9",
    padding: 15,
    borderRadius: 9,
  },
  notice: {
    backgroundColor: "#E5EFDD",
    borderRadius: 8,
    padding: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  noticeText: { color: C.green, fontSize: 12, flex: 1, lineHeight: 21 },
  errorBanner: {
    backgroundColor: "#FBEDE4",
    borderRadius: 8,
    padding: 15,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  errorText: { color: "#924A38", fontSize: 12, lineHeight: 22, flex: 1 },
  emptyHistory: {
    minHeight: 390,
    backgroundColor: "#FCFDF9",
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
    gap: 22,
  },
  emptyCircle: {
    width: 76,
    height: 76,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 28,
    backgroundColor: "#E9F0E1",
  },
  answerEmptyTitleLight: {
    fontSize: 22,
    color: "#3A5232",
    textAlign: "center",
  },
  emptyDescription: {
    color: "#8F9D84",
    fontSize: 13,
    lineHeight: 24,
    textAlign: "center",
  },
  historyCard: {
    padding: 22,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 13,
    backgroundColor: C.paper,
    gap: 15,
  },
  historyQuestion: {
    color: C.ink,
    fontSize: 20,
    lineHeight: 32,
    fontWeight: "600",
  },
  historyAnswer: { color: "#607256", fontSize: 16, lineHeight: 29 },
  questionChip: {
    padding: 11,
    borderWidth: 1,
    borderColor: C.line,
    backgroundColor: "#FFF",
    borderRadius: 8,
  },
  focusControls: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  },
  mobileSession: {
    backgroundColor: "#FFF",
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 12,
    padding: 17,
    gap: 12,
  },
  mobileTimer: { fontSize: 20, color: C.green, fontVariant: ["tabular-nums"] },
  bottomNav: {
    flexDirection: "row",
    paddingHorizontal: 9,
    paddingTop: 11,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderColor: C.line,
    backgroundColor: "#FCFCF8",
  },
  bottomItem: { flex: 1, alignItems: "center", gap: 6, paddingVertical: 4 },
  bottomLabel: { fontSize: 10, color: C.muted },
});
