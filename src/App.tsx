import { useCallback, useEffect, useState } from "react";
import { findNode } from "./core/document";
import { canRedo, canUndo } from "./core/history";
import { runDecompose, type DecomposeJob } from "./decompose/client";
import { DEFAULT_DECOMPOSE_PARAMS, type DecomposeParams, type DecomposeStage } from "./decompose/types";
import { ACCEPT_ATTR } from "./io/formats";
import { importImageFile, type ImportedImage } from "./io/importImage";
import { buildDocumentFromImport } from "./store/buildFromImport";
import { useEditor } from "./store/editorStore";
import { mergeSelected } from "./store/partActions";
import { CanvasView, type CanvasTool } from "./ui/CanvasView";
import { DecomposePanel } from "./ui/DecomposePanel";
import { LayerPanel } from "./ui/LayerPanel";

const STAGE_LABEL: Record<DecomposeStage, string> = {
  lineart: "線画を抽出中",
  segment: "領域を分割中",
  merge: "パーツを統合中",
  underfill: "線の下を補完中",
  layers: "レイヤーを生成中",
};

const FILL_LABEL = { source: "元画像の色", palette: "自動配色", white: "白" } as const;

type Busy = { label: string; job?: DecomposeJob } | null;

export function App() {
  const { state, dispatch, bitmaps } = useEditor();
  const [busy, setBusy] = useState<Busy>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [multiSelect, setMultiSelect] = useState(false);
  const h = state.history;
  const showMessage = useCallback((m: string) => setMessages([m]), []);

  // 結合できるのは選択中のパーツが 2 つ以上のとき
  const selectedPartCount = h
    ? state.selectedIds.filter((id) => {
        const n = findNode(h.present.root, id);
        return n?.kind === "raster" && n.role === "part";
      }).length
    : 0;
  const merge = () => {
    if (!h) return;
    const r = mergeSelected(h.present, bitmaps, state.selectedIds);
    if (r.ok) dispatch(r.action);
    showMessage(r.ok ? r.message : r.reason);
  };

  /** 自動分解を実行し、結果を新しいドキュメントとして開く */
  const decomposeAndOpen = useCallback(
    async (imported: ImportedImage, params: DecomposeParams) => {
      const job = runDecompose(
        { width: imported.image.width, height: imported.image.height, data: imported.image.data },
        params,
        (stage) => setBusy((b) => (b ? { ...b, label: STAGE_LABEL[stage] } : b)),
      );
      setBusy({ label: STAGE_LABEL.lineart, job });
      const result = await job.promise;
      bitmaps.clear();
      dispatch({ type: "open", doc: buildDocumentFromImport(imported, result, params, bitmaps) });
      const total = Object.values(result.timings).reduce((a, b) => a + b, 0);
      return `パーツ ${result.parts.length} 個に分解しました（塗り: ${FILL_LABEL[result.resolvedFill]}、処理 ${(total / 1000).toFixed(1)} 秒）。`;
    },
    [bitmaps, dispatch],
  );

  const openFile = useCallback(
    async (file: File) => {
      setMessages([]);
      setBusy({ label: "画像を読み込み中" });
      try {
        const imported = await importImageFile(file);
        const summary = await decomposeAndOpen(imported, DEFAULT_DECOMPOSE_PARAMS);
        setMessages([...imported.warnings, summary]);
      } catch (e) {
        setMessages([e instanceof Error ? e.message : String(e)]);
      } finally {
        setBusy(null);
      }
    },
    [decomposeAndOpen],
  );

  /** 現在のドキュメントの元画像を、新しいパラメータで分解し直す */
  const redecompose = useCallback(
    async (params: DecomposeParams) => {
      const doc = h?.present;
      const src = doc?.source;
      const image = src && bitmaps.get(src.bitmapId);
      if (!doc || !src || !image) return;
      if (canUndo(h) && !window.confirm("再分解すると、現在のレイヤーへの変更と取り消し履歴は失われます。続けますか？")) return;
      setMessages([]);
      try {
        const summary = await decomposeAndOpen(
          { format: src.format, fileName: src.fileName, image, originalWidth: src.originalWidth, originalHeight: src.originalHeight, warnings: [] },
          params,
        );
        setMessages([summary]);
      } catch (e) {
        setMessages([e instanceof Error ? e.message : String(e)]);
      } finally {
        setBusy(null);
      }
    },
    [h, bitmaps, decomposeAndOpen],
  );

  // キーボードショートカット: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y, Esc（選択解除）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dispatch({ type: "select", id: null });
        return;
      }
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
        {h && (
          <div className="tool-group" role="group" aria-label="ツール">
            <button aria-pressed={tool === "select"} className={tool === "select" ? "active" : ""} onClick={() => setTool("select")}>
              選択
            </button>
            <button aria-pressed={tool === "split"} className={tool === "split" ? "active" : ""} onClick={() => setTool("split")}>
              分割
            </button>
            {tool === "select" && (
              <button aria-pressed={multiSelect} className={multiSelect ? "active" : ""} onClick={() => setMultiSelect((v) => !v)}>
                複数選択
              </button>
            )}
            <button disabled={selectedPartCount < 2} onClick={merge}>
              結合{selectedPartCount >= 2 ? `（${selectedPartCount}）` : ""}
            </button>
          </div>
        )}
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
            <CanvasView doc={h.present} tool={tool} multiSelect={multiSelect} onMessage={showMessage} />
            <aside className="side-panel">
              {h.present.source && (
                <DecomposePanel key={h.present.id} initial={h.present.source.params} onRun={(p) => void redecompose(p)} disabled={!!busy} />
              )}
              <LayerPanel doc={h.present} />
            </aside>
          </>
        ) : (
          <div className="empty">
            <p>PNG / JPEG / SVG をドロップ、または「画像を開く」から読み込んでください。</p>
            <p className="hint">読み込んだ画像は線画レイヤーとパーツレイヤーに自動で分解されます。</p>
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
