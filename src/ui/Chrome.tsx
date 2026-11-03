/**
 * アプリの枠（ツールレール・ツールオプションバー・ズーム操作・ステータスバー・トースト）。
 */
import { ChevronDown, Combine, Hand, Info, CircleAlert, MousePointer2, Scissors, SquareDashedMousePointer, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CanvasTool, MessageKind } from "./CanvasView";

// ---------------------------------------------------------------- ツール

export const TOOLS: { id: CanvasTool; label: string; key: string; icon: ReactNode; hint: string }[] = [
  { id: "select", label: "選択", key: "V", icon: <MousePointer2 size={18} />, hint: "タップでパーツを選択。Shift / Ctrl + クリックで追加選択" },
  { id: "split", label: "分割", key: "C", icon: <Scissors size={18} />, hint: "パーツを端から端まで横切るように線を引くと分割" },
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
}: {
  tool: CanvasTool;
  multiSelect: boolean;
  onMultiSelect: (v: boolean) => void;
  selectedPartCount: number;
  onMerge: () => void;
  onClearSelection: () => void;
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
      <span className="context-hint">{info.hint}</span>
    </div>
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
