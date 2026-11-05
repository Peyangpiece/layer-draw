/**
 * 他のアプリの合成モード名 → エディタの合成モード。対応しないものは null（呼び出し側で「通常」にして警告する）。
 */
import type { BlendMode } from "../../core/types";

/** Photoshop（ag-psd の名前） */
const PSD_BLEND: Record<string, BlendMode> = {
  normal: "normal",
  darken: "darken",
  multiply: "multiply",
  "color burn": "color-burn",
  lighten: "lighten",
  screen: "screen",
  "color dodge": "color-dodge",
  "linear dodge": "add", // 覆い焼き（リニア）= 加算
  overlay: "overlay",
  "soft light": "soft-light",
  "hard light": "hard-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

/** Photoshop の合成モードの日本語名（警告の表示用） */
const PSD_BLEND_JA: Record<string, string> = {
  dissolve: "ディザ合成",
  "linear burn": "焼き込み（リニア）",
  "darker color": "カラー比較（暗）",
  "lighter color": "カラー比較（明）",
  "vivid light": "ビビッドライト",
  "linear light": "リニアライト",
  "pin light": "ピンライト",
  "hard mix": "ハードミックス",
  subtract: "減算",
  divide: "除算",
};

export function psdBlend(name: string | undefined): BlendMode | null {
  if (!name) return "normal";
  return PSD_BLEND[name] ?? null;
}

export function psdBlendLabel(name: string): string {
  return PSD_BLEND_JA[name] ?? name;
}

/** OpenRaster の composite-op（仕様の svg:* と、Krita などが使う同等の名前） */
const ORA_BLEND: Record<string, BlendMode> = {
  "svg:src-over": "normal",
  "svg:multiply": "multiply",
  "svg:screen": "screen",
  "svg:overlay": "overlay",
  "svg:darken": "darken",
  "svg:lighten": "lighten",
  "svg:color-dodge": "color-dodge",
  "svg:color-burn": "color-burn",
  "svg:hard-light": "hard-light",
  "svg:soft-light": "soft-light",
  "svg:difference": "difference",
  "svg:exclusion": "exclusion",
  "svg:hue": "hue",
  "svg:saturation": "saturation",
  "svg:color": "color",
  "svg:luminosity": "luminosity",
  "svg:plus": "add",
};

export function oraBlend(op: string | undefined): BlendMode | null {
  if (!op) return "normal";
  return ORA_BLEND[op] ?? null;
}
