import { useCallback, useEffect, useState } from "react";
import { canRedo, canUndo } from "./core/history";
import { runDecompose, type DecomposeJob } from "./decompose/client";
import { DEFAULT_DECOMPOSE_PARAMS, type DecomposeStage } from "./decompose/types";
import { ACCEPT_ATTR } from "./io/formats";
import { importImageFile } from "./io/importImage";
import { buildDocumentFromImport } from "./store/buildFromImport";
import { useEditor } from "./store/editorStore";
import { CanvasView } from "./ui/CanvasView";
import { LayerPanel } from "./ui/LayerPanel";

const STAGE_LABEL: Record<DecomposeStage, string> = {
  lineart: "線画を抽出中",
  segment: "領域を分割中",
  merge: "パーツを統合中",
  underfill: "線の下を補完中",
  layers: "レイヤーを生成中",
};

type Busy = { label: string; job?: DecomposeJob } | null;

export function App() {
  const { state, dispatch, bitmaps } = useEditor();
  const [busy, setBusy] = useState<Busy>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const h = state.history;

  const openFile = useCallback(
    async (file: File) => {
      setMessages([]);
      setBusy({ label: "画像を読み込み中" });
      try {
        const imported = await importImageFile(file);
        const job = runDecompose(
          { width: imported.image.width, height: imported.image.height, data: imported.image.data },
          DEFAULT_DECOMPOSE_PARAMS,
          (stage) => setBusy((b) => (b ? { ...b, label: STAGE_LABEL[stage] } : b)),
        );
        setBusy({ label: STAGE_LABEL.lineart, job });
        const result = await job.promise;
        bitmaps.clear();
        dispatch({ type: "open", doc: buildDocumentFromImport(imported, result, bitmaps) });
        setMessages(imported.warnings);
      } catch (e) {
        setMessages([e instanceof Error ? e.message : String(e)]);
      } finally {
        setBusy(null);
      }
    },
    [bitmaps, dispatch],
  );

  // キーボードショートカット: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
      } else if (k === "y") {
        e.preventDefault();
        dispatch({ type: "redo" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  return (
    <div
      className={`app${dragOver ? " drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files[0];
        if (f) void openFile(f);
      }}
    >
      <header className="toolbar">
        <strong className="brand">layer-draw</strong>
        <label className="button primary">
          画像を開く
          <input
            type="file"
            accept={ACCEPT_ATTR}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void openFile(f);
            }}
          />
        </label>
        <button disabled={!h || !canUndo(h)} onClick={() => dispatch({ type: "undo" })}>
          取り消し
        </button>
        <button disabled={!h || !canRedo(h)} onClick={() => dispatch({ type: "redo" })}>
          やり直し
        </button>
        {h && <span className="doc-info">{h.present.name} — {h.present.width}×{h.present.height}</span>}
      </header>

      {messages.length > 0 && (
        <div className="messages" role="status">
          {messages.map((m, i) => (
            <p key={i}>{m}</p>
          ))}
        </div>
      )}

      <main className="workspace">
        {h ? (
          <>
            <CanvasView doc={h.present} />
            <LayerPanel doc={h.present} />
          </>
        ) : (
          <div className="empty">
            <p>PNG / JPEG / SVG をドロップ、または「画像を開く」から読み込んでください。</p>
            <p className="hint">読み込んだ画像は線画レイヤーとパーツレイヤーに自動で分解されます（パーツ分割は開発中）。</p>
          </div>
        )}
      </main>

      {busy && (
        <div className="overlay" role="alertdialog" aria-live="polite">
          <div className="dialog">
            <p>{busy.label}…</p>
            {busy.job && <button onClick={() => busy.job?.cancel()}>キャンセル</button>}
          </div>
        </div>
      )}
    </div>
  );
}
