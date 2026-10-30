import Svg, { Circle, Line, Path, Rect } from "react-native-svg";

export type IconName =
  | "wave"
  | "grid"
  | "file"
  | "history"
  | "settings"
  | "arrow"
  | "mic"
  | "pause"
  | "play"
  | "stop"
  | "check"
  | "close"
  | "chevron"
  | "copy"
  | "expand"
  | "download"
  | "trash"
  | "wifi";
export function Icon({
  name,
  size = 21,
  color = "#65736e",
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  const paths: Partial<Record<IconName, string>> = {
    wave: "M3 10v4m4-8v12m5-15v18m5-15v12m4-8v4",
    file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5",
    history: "M3 11a9 9 0 1 1 2.6 7.4 M3 4v7h7 M12 7v5l3 2",
    arrow: "M5 12h14 M13 6l6 6-6 6",
    mic: "M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3 M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8",
    play: "M7 3l14 9-14 9z",
    check: "M5 12l4 4L19 6",
    close: "M6 6l12 12 M6 18L18 6",
    chevron: "m9 5 7 7-7 7",
    copy: "M9 5V3h12v14h-3 M3 7h13v14H3z",
    expand: "M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5",
    download: "M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5",
    trash: "M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7",
    wifi: "M2 8a16 16 0 0 1 20 0 M5 12a11 11 0 0 1 14 0 M8 16a6 6 0 0 1 8 0 M12 20h.01",
    settings:
      "M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2 2 M16.4 16.4l2 2 M5.6 18.4l2-2 M16.4 7.6l2-2",
  };
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name] && <Path d={paths[name]} />}
      {name === "settings" && <Circle cx={12} cy={12} r={5} />}
      {name === "grid" && (
        <>
          <Rect x={3} y={3} width={7} height={7} rx={1.5} />
          <Rect x={14} y={3} width={7} height={7} rx={1.5} />
          <Rect x={3} y={14} width={7} height={7} rx={1.5} />
          <Rect x={14} y={14} width={7} height={7} rx={1.5} />
        </>
      )}
      {name === "pause" && (
        <>
          <Line x1={8} x2={8} y1={4} y2={20} strokeWidth={3} />
          <Line x1={16} x2={16} y1={4} y2={20} strokeWidth={3} />
        </>
      )}
      {name === "stop" && <Rect x={5} y={5} width={14} height={14} rx={2} />}
    </Svg>
  );
}
