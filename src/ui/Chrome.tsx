/**
 * アプリの枠（ツールレール・ツールオプションバー・ズーム操作・ステータスバー・トースト）。
 */
import { Brush, Eraser, Pen, Pipette, ChevronDown, Combine, Hand, Info, CircleAlert, MousePointer2, Scissors, SquareDashedMousePointer, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CanvasTool, MessageKind } from "./CanvasView";

// ---------------------------------------------------------------- ツール

export const TOOLS: { id: CanvasTool; label: string; key: string; icon: ReactNode; hint: string }[] = [
  { id: "select", label: "選択", key: "V", icon: <MousePointer2 size={18} />, hint: "タップでパーツを選択。Shift / Ctrl + クリックで追加選択" },
  { id: "split", label: "分割", key: "C", icon: <Scissors size={18} />, hint: "パーツを端から端まで横切るように線を引くと分割" },
  { id: "move", label: "移動ブラシ", key: "B", icon: <Brush size={18} />, hint: "なぞった所にある隣のパーツの画素を移動先パーツへ移す。[ ] でサイズ変更" },
  { id: "pen", label: "ペン", key: "P", icon: <Pen size={18} />, hint: "選択中のレイヤーに描く。Alt（Option）+ クリックで色を拾う。[ ] でサイズ変更" },
  { id: "eraser", label: "消しゴム", key: "E", icon: <Eraser size={18} />, hint: "選択中のレイヤーを消す。[ ] でサイズ変更" },
  { id: "picker", label: "スポイト", key: "I", icon: <Pipette size={18} />, hint: "押した所の色をペンの色にする（押したまま動かすと追従）。ペン中は Alt + クリック、指なら長押しでも拾える" },
  { id: "hand", label: "手のひら", key: "H", icon: <Hand size={18} />, hint: "ドラッグで表示位置を移動。Space を押している間も使えます" },
];

export function ToolRail({ tool, onTool }: { tool: CanvasTool; onTool: (t: CanvasTool) => void }) {
  return (
    <nav className="tool-rail" aria-label="ツール">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={`icon-btn tool-btn${tool === t.id ? " active" : ""}`}
          aria-pressed={tool === t.id}
          aria-label={`${t.label} (${t.key})`}
          title={`${t.label} (${t.key})`}
          onClick={() => onTool(t.id)}
        >
          {t.icon}
          <span className="tool-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

/** 選択中ツールのオプション（Adobe 系のコントロールバーに相当） */
export function ContextBar({
  tool,
  multiSelect,
  onMultiSelect,
  selectedPartCount,
  onMerge,
  onClearSelection,
  brushSize,
  onBrushSize,
  moveTarget,
  paint,
  onPaint,
  paintTarget,
  onPickTool,
}: {
  tool: CanvasTool;
  multiSelect: boolean;
  onMultiSelect: (v: boolean) => void;
  selectedPartCount: number;
  onMerge: () => void;
  onClearSelection: () => void;
  brushSize: number;
  onBrushSize: (v: number) => void;
  /** 移動ブラシの移動先（選択中のパーツ）。未選択なら undefined */
  moveTarget?: { name: string; color?: string };
  /** ペン・消しゴムの設定と変更 */
  paint: PaintSettings;
  onPaint: (p: PaintSettings) => void;
  /** ペン・消しゴムで描くレイヤー（選択中のレイヤー）の名前。描けない場合は理由 */
  paintTarget: { name: string } | { reason: string };
  /** スポイトツールにする */
  onPickTool: () => void;
}) {
  const info = TOOLS.find((t) => t.id === tool)!;
  return (
    <div className="context-bar" role="toolbar" aria-label="ツールオプション">
      <span className="context-title">
        {info.icon}
        {info.label}
      </span>
      <span className="divider" aria-hidden />
      {tool === "select" && (
        <>
          <button className={`chip${multiSelect ? " active" : ""}`} aria-pressed={multiSelect} onClick={() => onMultiSelect(!multiSelect)}>
            <SquareDashedMousePointer size={15} />
            複数選択
          </button>
          <button className="chip" disabled={selectedPartCount < 2} onClick={onMerge} title="選択したパーツを 1 つに結合">
            <Combine size={15} />
            結合{selectedPartCount >= 2 ? ` (${selectedPartCount})` : ""}
          </button>
          <button className="chip ghost" disabled={selectedPartCount === 0} onClick={onClearSelection} title="選択解除 (Esc)">
            選択解除
          </button>
        </>
      )}
      {tool === "move" && (
        <>
          <label className="context-field" title="ブラシの直径（画像のピクセル）。[ で小さく、] で大きく">
            <span>サイズ</span>
            <input type="range" min={BRUSH_MIN} max={BRUSH_MAX} step={1} value={brushSize} onChange={(e) => onBrushSize(Number(e.target.value))} />
            <span className="prop-value">{brushSize}px</span>
          </label>
          <span className="divider" aria-hidden />
          <span className="context-field">
            <span>移動先</span>
            {moveTarget ? (
              <span className="target-chip">
                {moveTarget.color && <span className="swatch" style={{ background: moveTarget.color }} aria-hidden />}
                {moveTarget.name}
              </span>
            ) : (
              <span className="muted">なぞり始めたパーツ</span>
            )}
          </span>
        </>
      )}
      {(tool === "pen" || tool === "eraser") && (
        <PaintOptions tool={tool} paint={paint} onPaint={onPaint} target={paintTarget} onPickTool={onPickTool} />
      )}
      {tool === "picker" && (
        <span className="context-field">
          <span>今の色</span>
          <span className="swatch lg" style={{ background: paint.pen.color }} aria-hidden />
          <span className="prop-value mono">{paint.pen.color}</span>
        </span>
      )}
      <span className="context-hint">{info.hint}</span>
    </div>
  );
}

export const BRUSH_MIN = 1;
export const BRUSH_MAX = 200;

/** [ ] キーでのブラシサイズ変更: サイズに応じた刻み（小さいときは細かく） */
export function stepBrushSize(size: number, dir: 1 | -1): number {
  const step = size < 10 ? 1 : size < 50 ? 5 : 10;
  return Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, size + dir * step));
}

// ---------------------------------------------------------------- ペン・消しゴム

export interface PaintSettings {
  pen: { size: number; opacity: number; usePressure: boolean; smoothing: number; color: string };
  eraser: { size: number; opacity: number; usePressure: boolean; smoothing: number };
}

export const DEFAULT_PAINT: PaintSettings = {
  pen: { size: 6, opacity: 1, usePressure: true, smoothing: 3, color: "#222222" },
  eraser: { size: 24, opacity: 1, usePressure: false, smoothing: 0 },
};

export const PAINT_SIZE_MAX = 500;

/** [ ] キーでのペン・消しゴムの大きさ変更（小さいときは細かく、大きいときは粗く） */
export function stepPaintSize(size: number, dir: 1 | -1): number {
  const step = size < 10 ? 1 : size < 50 ? 5 : size < 200 ? 10 : 20;
  return Math.min(PAINT_SIZE_MAX, Math.max(1, size + dir * step));
}

function PaintOptions({
  tool,
  paint,
  onPaint,
  target,
  onPickTool,
}: {
  tool: "pen" | "eraser";
  paint: PaintSettings;
  onPaint: (p: PaintSettings) => void;
  target: { name: string } | { reason: string };
  onPickTool: () => void;
}) {
  const s = paint[tool];
  const set = (patch: Partial<PaintSettings["pen"]>) => onPaint({ ...paint, [tool]: { ...s, ...patch } });
  return (
    <>
      {tool === "pen" && (
        <label className="context-field" title="ペンの色（Alt / Option + クリックでキャンバスから拾う）">
          <span>色</span>
          <input id="pen-color" type="color" value={paint.pen.color} onChange={(e) => onPaint({ ...paint, pen: { ...paint.pen, color: e.target.value } })} />
        </label>
      )}
      {tool === "pen" && (
        <button className="icon-btn sm" onClick={onPickTool} aria-label="スポイトで色を拾う" title="スポイトで色を拾う (I)">
          <Pipette size={15} />
        </button>
      )}
      <label className="context-field" title="直径（画像のピクセル）。[ で小さく、] で大きく">
        <span>サイズ</span>
        <input id={`${tool}-size`} type="range" min={1} max={PAINT_SIZE_MAX} step={1} value={s.size} onChange={(e) => set({ size: Number(e.target.value) })} />
        <span className="prop-value">{s.size}px</span>
      </label>
      <label className="context-field">
        <span>不透明度</span>
        <input id={`${tool}-opacity`} type="range" min={1} max={100} step={1} value={Math.round(s.opacity * 100)} onChange={(e) => set({ opacity: Number(e.target.value) / 100 })} className="short" />
        <span className="prop-value">{Math.round(s.opacity * 100)}%</span>
      </label>
      <label className="context-field check" title="ペン（スタイラス）の筆圧で太さを変える。マウス・指では常に最大の太さ">
        <input id={`${tool}-pressure`} type="checkbox" checked={s.usePressure} onChange={(e) => set({ usePressure: e.target.checked })} />
        <span>筆圧</span>
      </label>
      <label className="context-field" title="手ブレ補正（大きいほどなめらかで、ペン先から遅れる）">
        <span>手ブレ補正</span>
        <input id={`${tool}-smoothing`} type="range" min={0} max={10} step={1} value={s.smoothing} onChange={(e) => set({ smoothing: Number(e.target.value) })} className="short" />
        <span className="prop-value">{s.smoothing}</span>
      </label>
      <span className="divider" aria-hidden />
      <span className="context-field">
        <span>{tool === "pen" ? "描く先" : "消す先"}</span>
        {"name" in target ? <span className="target-chip">{target.name}</span> : <span className="muted">{target.reason}</span>}
      </span>
    </>
  );
}

// ---------------------------------------------------------------- ズーム

export function ZoomControl({
  scale,
  rotationDeg,
  onZoomIn,
  onZoomOut,
  onFit,
  onActual,
  onSetScale,
  onResetRotation,
}: {
  scale: number;
  rotationDeg: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onActual: () => void;
  onSetScale: (s: number) => void;
  onResetRotation: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const pick = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };
  const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

  return (
    <div className="zoom-control" ref={ref}>
      <button className="icon-btn" onClick={onZoomOut} aria-label={`縮小 (${mod}-)`} title={`縮小 (${mod}-)`}>
        <ZoomOut size={17} />
      </button>
      <button className="zoom-value" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} title="表示倍率">
        {formatPercent(scale)}
        <ChevronDown size={14} />
      </button>
      <button className="icon-btn" onClick={onZoomIn} aria-label={`拡大 (${mod}+)`} title={`拡大 (${mod}+)`}>
        <ZoomIn size={17} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <MenuItem onClick={pick(onFit)} shortcut={`${mod}0`}>画面に合わせる</MenuItem>
          <MenuItem onClick={pick(onActual)} shortcut={`${mod}1`}>100%（実際のピクセル）</MenuItem>
          <div className="menu-sep" />
          {[0.25, 0.5, 2, 4, 8].map((s) => (
            <MenuItem key={s} onClick={pick(() => onSetScale(s))}>
              {formatPercent(s)}
            </MenuItem>
          ))}
          <div className="menu-sep" />
          <MenuItem onClick={pick(onResetRotation)} disabled={rotationDeg === 0}>
            回転をリセット{rotationDeg !== 0 ? `（${rotationDeg}°）` : ""}
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick, shortcut, disabled }: { children: ReactNode; onClick: () => void; shortcut?: string; disabled?: boolean }) {
  return (
    <button className="menu-item" role="menuitem" onClick={onClick} disabled={disabled}>
      <span>{children}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}

export function formatPercent(scale: number): string {
  const p = scale * 100;
  return `${p >= 10 ? Math.round(p) : p.toFixed(1)}%`;
}

// ---------------------------------------------------------------- ステータスバー

export function StatusBar({
  scale,
  rotationDeg,
  docSize,
  cursorRef,
  partCount,
  selectedCount,
  onResetRotation,
}: {
  scale: number;
  rotationDeg: number;
  docSize: string;
  cursorRef: React.RefObject<HTMLSpanElement | null>;
  partCount: number;
  selectedCount: number;
  onResetRotation: () => void;
}) {
  return (
    <footer className="status-bar">
      <span className="status-item">{formatPercent(scale)}</span>
      {rotationDeg !== 0 && (
        <button className="status-item link" onClick={onResetRotation} title="クリックで回転をリセット">
          回転 {rotationDeg}°
        </button>
      )}
      <span className="status-item mono" ref={cursorRef} aria-label="カーソル位置" />
      <span className="status-spacer" />
      <span className="status-item">パーツ {partCount}{selectedCount > 0 ? ` ・ 選択 ${selectedCount}` : ""}</span>
      <span className="status-item mono">{docSize}</span>
    </footer>
  );
}

// ---------------------------------------------------------------- トースト

export interface Toast {
  id: number;
  text: string;
  kind: MessageKind;
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === "error" ? <CircleAlert size={16} /> : <Info size={16} />}
          <span>{t.text}</span>
          <button className="toast-close" onClick={() => onDismiss(t.id)} aria-label="閉じる">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
