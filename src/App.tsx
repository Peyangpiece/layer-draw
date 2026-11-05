import { ImagePlus, Layers, LoaderCircle, Redo2, Save, Undo2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { findNode, listRasterLayers } from "./core/document";
import type { LayerDocument } from "./core/types";
import { canRedo, canUndo } from "./core/history";
import { runDecompose, type DecomposeJob } from "./decompose/client";
import { recolorPartsFrom } from "./decompose/layers";
import { DEFAULT_DECOMPOSE_PARAMS, type DecomposeParams, type DecomposeResult, type DecomposeStage } from "./decompose/types";
import { canPickLocation, downloadBlob, fileNameFor, FORMAT_INFO, isEmbedded, pickSaveFile, writeToHandle, type SaveFormat } from "./io/export/save";
import { ACCEPT_ATTR } from "./io/formats";
import { importFile } from "./io/importFile";
import type { ImportedImage } from "./io/importImage";
import { countRasters } from "./io/layered/model";
import { buildDecomposedFolder, buildDocumentFromImport } from "./store/buildFromImport";
import { buildDocumentFromLayered, placeOnCanvas } from "./store/buildFromLayered";
import { useEditor } from "./store/editorStore";
import { mergeSelected } from "./store/partActions";
import { Canvas2DCompositor } from "./render/compositor";
import { CanvasView, type CanvasTool, type MessageKind } from "./ui/CanvasView";
import { ContextBar, DEFAULT_PAINT, StatusBar, stepPaintSize, stepBrushSize, Toasts, ToolRail, ZoomControl, type PaintSettings, type Toast } from "./ui/Chrome";
import { DecomposePanel } from "./ui/DecomposePanel";
import { LayerPanel } from "./ui/LayerPanel";
import { SaveDialog, type SaveRequest } from "./ui/SaveDialog";
import { centerAt, fitView, nextPreset, rotateTo, rotationDegrees, zoomTo, type Pt, type ViewTransform } from "./ui/viewport";

const STAGE_LABEL: Record<DecomposeStage, string> = {
  lineart: "線画を抽出しています",
  segment: "領域を分割しています",
  merge: "パーツを統合しています",
  underfill: "線の下を補完しています",
  layers: "レイヤーを生成しています",
};

const FILL_LABEL = { source: "元画像の色", palette: "自動配色", white: "白" } as const;

/** 分解結果の通知文 */
function decomposeSummary(result: DecomposeResult): string {
  const total = Object.values(result.timings).reduce((a, b) => a + b, 0);
  const lw = result.lineWidth;
  const lineNote = lw.auto && lw.estimated !== null ? `・線の太さ 約${lw.estimated}px` : "";
  return `パーツ ${result.parts.length} 個に分解しました（塗り: ${FILL_LABEL[result.resolvedFill]}${lineNote}・${(total / 1000).toFixed(1)} 秒）`;
}
const TOOL_KEYS: Record<string, CanvasTool> = { v: "select", c: "split", b: "move", p: "pen", e: "eraser", i: "picker", h: "hand" };

type Busy = { label: string; job?: DecomposeJob } | null;

/** 最後に保存した内容と保存先（レイヤー付きで保存した = 作業を保存した、とみなす PSD のみ） */
interface SavedInfo {
  docId: string;
  /** 保存した時点のドキュメント（今のものと同じなら「保存済み」） */
  present: LayerDocument;
  fileName: string;
  /** picked: 保存ダイアログで選んだファイル / downloads: ブラウザのダウンロード */
  where: "picked" | "downloads";
  /** 上書き保存に使う（保存先を選んだ場合・アプリでファイルを開いた場合） */
  handle?: FileSystemFileHandle;
}
const WHERE_LABEL = { picked: "選んだフォルダ", downloads: "「ダウンロード」フォルダ" } as const;

/** 画面と同じ合成で、PNG または PSD のデータを作る */
async function encodeDocument(doc: LayerDocument, bitmaps: ReturnType<typeof useEditor>["bitmaps"], format: SaveFormat): Promise<Blob> {
  const canvas = document.createElement("canvas");
  new Canvas2DCompositor(bitmaps).render(doc, canvas);
  if (format === "png") {
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG を作れませんでした"))), "image/png"));
  }
  const composite = canvas.getContext("2d")!.getImageData(0, 0, doc.width, doc.height);
  const { writeDocumentPsd } = await import("./io/export/psd");
  const bytes = writeDocumentPsd(doc, (id) => bitmaps.get(id), composite);
  return new Blob([bytes], { type: FORMAT_INFO.psd.mime });
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName));

export function App() {
  const { state, dispatch, bitmaps } = useEditor();
  const [busy, setBusy] = useState<Busy>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [multiSelect, setMultiSelect] = useState(false);
  const [brushSize, setBrushSize] = useState(20);
  const [paint, setPaint] = useState<PaintSettings>(DEFAULT_PAINT);
  // キー操作の処理から今のツールを参照するため（[ ] で今のツールの大きさを変える）
  const toolRef = useRef(tool);
  toolRef.current = tool;
  /** スポイトに切り替える直前のツール（色を拾ったら戻る） */
  const beforePickerRef = useRef<CanvasTool>("pen");
  const selectTool = useCallback((t: CanvasTool) => {
    if (t === "picker" && toolRef.current !== "picker") beforePickerRef.current = toolRef.current;
    setTool(t);
  }, []);
  /** 色を拾い終えたら、ペン・消しゴムからなら元に戻り、それ以外からならペンにする（色を拾うのは描くため） */
  const onPickerDone = useCallback(() => {
    const prev = beforePickerRef.current;
    setTool(prev === "pen" || prev === "eraser" ? prev : "pen");
  }, []);
  const [view, setView] = useState<ViewTransform | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [panelOpen, setPanelOpen] = useState(false); // 狭い画面でのボトムシート
  const cursorRef = useRef<HTMLSpanElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const h = state.history;
  const doc = h?.present;
  const [saved, setSaved] = useState<SavedInfo | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const lastFormatRef = useRef<SaveFormat>("psd");
  const savedForDoc = saved && doc && saved.docId === doc.id ? saved : null;
  /** 最後に PSD で保存してから変更があるか（まだ保存していなければ true） */
  const dirty = !!doc && savedForDoc?.present !== doc;

  // ---------------------------------------------------------------- 通知
  const nextToastId = useRef(1);
  const showMessage = useCallback((text: string, kind: MessageKind = "info") => {
    const id = nextToastId.current++;
    setToasts((ts) => [...ts.slice(-2), { id, text, kind }]);
    window.setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), kind === "error" ? 6000 : 3500);
  }, []);

  // ---------------------------------------------------------------- 読み込み・分解
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
      return decomposeSummary(result);
    },
    [bitmaps, dispatch],
  );

  const openFile = useCallback(
    async (file: File, handle?: FileSystemFileHandle) => {
      setBusy({ label: "画像を読み込んでいます" });
      try {
        const res = await importFile(file);
        if (res.kind === "layered") {
          // レイヤー付きのファイルは、レイヤー構成のまま開く（自動分解はしない）
          const imp = res.layered;
          bitmaps.clear();
          const opened = buildDocumentFromLayered(imp, bitmaps);
          dispatch({ type: "open", doc: opened });
          // アプリで PSD を開いた場合（launchQueue）は、そのファイルに上書き保存できる
          if (handle && imp.format === "psd") setSaved({ docId: opened.id, present: opened, fileName: handle.name, where: "picked", handle });
          showMessage(`${imp.format.toUpperCase()} のレイヤー ${countRasters(imp.children)} 枚を読み込みました。分解したいレイヤーを選び、「自動分解の設定」から分解できます`);
          // 警告はまとめて 1 つにする（通知は最大 3 件なので、個別に出すと他の通知が押し出される）
          if (imp.warnings.length > 0) showMessage(`反映できなかった内容: ${imp.warnings.join("。")}`, "error");
          return;
        }
        const imported = res.image;
        const summary = await decomposeAndOpen(imported, DEFAULT_DECOMPOSE_PARAMS);
        imported.warnings.forEach((w) => showMessage(w));
        showMessage(summary);
      } catch (e) {
        showMessage(e instanceof Error ? e.message : String(e), "error");
      } finally {
        setBusy(null);
      }
    },
    [decomposeAndOpen, showMessage, bitmaps, dispatch],
  );

  // 確認ダイアログ。window.confirm は埋め込み先（サンドボックス化された iframe）で無視されることがあるため、ページ内に描く
  const [confirmReq, setConfirmReq] = useState<{ title: string; message: string; confirmLabel: string; onConfirm: () => void } | null>(null);

  const runRedecompose = useCallback(
    async (params: DecomposeParams) => {
      const src = doc?.source;
      const image = src && bitmaps.get(src.bitmapId);
      if (!src || !image) return;
      try {
        const summary = await decomposeAndOpen(
          { format: src.format, fileName: src.fileName, image, originalWidth: src.originalWidth, originalHeight: src.originalHeight, warnings: [] },
          params,
        );
        showMessage(summary);
      } catch (e) {
        showMessage(e instanceof Error ? e.message : String(e), "error");
      } finally {
        setBusy(null);
      }
    },
    [doc, bitmaps, decomposeAndOpen, showMessage],
  );

  const redecompose = useCallback(
    (params: DecomposeParams) => {
      if (h && canUndo(h)) {
        setConfirmReq({
          title: "再分解しますか？",
          message: "現在のレイヤーへの変更と、取り消しの履歴は失われます。",
          confirmLabel: "再分解する",
          onConfirm: () => void runRedecompose(params),
        });
      } else {
        void runRedecompose(params);
      }
    },
    [h, runRedecompose],
  );

  // レイヤー単位の自動分解（レイヤー付きのファイル）: 選んだレイヤーだけを分解し、結果のフォルダをその上に入れて元のレイヤーを隠す
  const primaryNode = doc && state.selectedIds.length > 0 ? findNode(doc.root, state.selectedIds[state.selectedIds.length - 1]!) : undefined;
  const layerTarget = primaryNode?.kind === "raster" ? primaryNode : undefined;
  const decomposeLayer = useCallback(
    async (params: DecomposeParams) => {
      if (!doc || !layerTarget) return;
      const img = bitmaps.get(layerTarget.bitmapId);
      if (!img) return;
      try {
        const job = runDecompose(placeOnCanvas(img, layerTarget.bounds, doc.width, doc.height), params, (stage) =>
          setBusy((b) => (b ? { ...b, label: STAGE_LABEL[stage] } : b)),
        );
        setBusy({ label: STAGE_LABEL.lineart, job });
        let result = await job.promise;
        // 塗り色は、今見えている絵（全レイヤーの合成画像）から取る。「自動配色」「白」を選んだ場合はそのまま
        const composite = doc.source && bitmaps.get(doc.source.bitmapId);
        if (composite && (params.segment.fill === "auto" || params.segment.fill === "source")) {
          result = { ...result, parts: recolorPartsFrom(result.parts, composite, result.lineart), resolvedFill: "source" };
        }
        const folder = buildDecomposedFolder(result, { width: doc.width, height: doc.height }, bitmaps, `自動分解: ${layerTarget.name}`);
        dispatch({ type: "replaceNode", id: layerTarget.id, nodes: [folder, { ...layerTarget, visible: false }], select: [folder.id] });
        showMessage(`「${layerTarget.name}」を${decomposeSummary(result)}。元のレイヤーは非表示にしました`);
      } catch (e) {
        showMessage(e instanceof Error ? e.message : String(e), "error");
      } finally {
        setBusy(null);
      }
    },
    [doc, layerTarget, bitmaps, dispatch, showMessage],
  );

  // ---------------------------------------------------------------- 表示（ズーム・回転）
  const center = { x: viewport.w / 2, y: viewport.h / 2 };
  const zoomStep = useCallback(
    (dir: 1 | -1) => setView((v) => (v ? zoomTo(v, nextPreset(v.scale, dir), { x: viewport.w / 2, y: viewport.h / 2 }) : v)),
    [viewport],
  );
  const fit = useCallback(() => {
    if (doc) setView((v) => fitView(doc.width, doc.height, viewport.w, viewport.h, v?.rotation ?? 0));
  }, [doc, viewport]);
  const setScale = useCallback(
    (s: number) => {
      if (doc) setView((v) => centerAt(doc.width, doc.height, viewport.w, viewport.h, s, v?.rotation ?? 0));
    },
    [doc, viewport],
  );
  const resetRotation = () => setView((v) => (v ? rotateTo(v, 0, center) : v));
  const onViewportSize = useCallback((w: number, hh: number) => setViewport({ w, h: hh }), []);
  const onCursor = useCallback((p: Pt | null) => {
    const el = cursorRef.current;
    if (el) el.textContent = p ? `X ${Math.round(p.x)}  Y ${Math.round(p.y)}` : "";
  }, []);

  // ---------------------------------------------------------------- パーツ操作
  const selectedPartCount = doc
    ? state.selectedIds.filter((id) => {
        const n = findNode(doc.root, id);
        return n?.kind === "raster" && n.role === "part";
      }).length
    : 0;
  // 移動ブラシの移動先として表示する主選択パーツ
  const primary = doc && state.selectedIds.length > 0 ? findNode(doc.root, state.selectedIds[state.selectedIds.length - 1]!) : undefined;
  const moveTarget = primary?.kind === "raster" && primary.role === "part" ? { name: primary.name, color: primary.part?.fillColor } : undefined;
  // ペン・消しゴムで描く先（選択中のレイヤー）
  const paintTarget = !primary
    ? { reason: "レイヤーを選んでください" }
    : primary.kind !== "raster"
      ? { reason: "フォルダには描けません" }
      : !primary.visible
        ? { reason: `「${primary.name}」は非表示です` }
        : primary.locked
          ? { reason: `「${primary.name}」はロック中です` }
          : { name: primary.name + (primary.alphaLocked ? "（透明度保護）" : "") };
  const partCount = doc ? listRasterLayers(doc.root).filter((l) => l.role === "part").length : 0;
  const merge = () => {
    if (!doc) return;
    const r = mergeSelected(doc, bitmaps, state.selectedIds);
    if (r.ok) dispatch(r.action);
    showMessage(r.ok ? r.message : r.reason, r.ok ? "info" : "error");
  };

  // ---------------------------------------------------------------- 保存
  const saveAs = async ({ format, baseName }: SaveRequest) => {
    setSaveOpen(false);
    if (!doc) return;
    lastFormatRef.current = format;
    const name = fileNameFor(baseName, format);
    const snapshot = doc;
    try {
      // 保存ダイアログは、ボタンを押した直後（利用者の操作の中）で開く必要があるので、データを作る前に開く
      let handle: FileSystemFileHandle | null = null;
      if (canPickLocation()) {
        handle = await pickSaveFile(name, format);
        if (!handle) return; // キャンセル
      }
      setBusy({ label: "保存しています" });
      const blob = await encodeDocument(snapshot, bitmaps, format);
      const where = handle ? "picked" : "downloads";
      const fileName = handle?.name ?? name;
      if (handle) await writeToHandle(handle, blob);
      else downloadBlob(blob, name);
      if (format === "psd") setSaved({ docId: snapshot.id, present: snapshot, fileName, where, handle: handle ?? undefined });
      const layersNote = format === "png" ? "。レイヤーは含まれません（続きを編集するには PSD で保存してください）" : "";
      if (!handle && isEmbedded()) {
        showMessage(`「${fileName}」のダウンロードを始めました${layersNote}。保存されない場合は、Dock に追加したアプリ版から保存してください`);
      } else {
        showMessage(`「${fileName}」を${WHERE_LABEL[where]}に保存しました${layersNote}`);
      }
    } catch (e) {
      showMessage(`保存できませんでした（${e instanceof Error ? e.message : String(e)}）`, "error");
    } finally {
      setBusy(null);
    }
  };

  /** Ctrl/⌘+S: 保存先を選んで保存したファイルがあれば上書き、無ければ保存ダイアログ */
  const quickSave = async () => {
    if (!doc) return;
    const s = savedForDoc;
    if (!s?.handle) {
      setSaveOpen(true);
      return;
    }
    const snapshot = doc;
    try {
      setBusy({ label: "保存しています" });
      await writeToHandle(s.handle, await encodeDocument(snapshot, bitmaps, "psd"));
      setSaved({ ...s, present: snapshot });
      showMessage(`「${s.fileName}」に上書き保存しました`);
    } catch (e) {
      showMessage(`上書き保存できませんでした（${e instanceof Error ? e.message : String(e)}）。「保存」から保存し直してください`, "error");
    } finally {
      setBusy(null);
    }
  };
  // キー操作の処理（一度だけ登録）から、今のドキュメントでの保存を呼ぶため
  const saveKeysRef = useRef({ quickSave: () => {}, open: () => {} });
  saveKeysRef.current = { quickSave: () => void quickSave(), open: () => doc && setSaveOpen(true) };

  // 保存していない変更があるまま閉じようとしたら、ブラウザの確認を出す
  const warnOnClose = dirty && (!!savedForDoc || (!!h && canUndo(h)));
  useEffect(() => {
    if (!warnOnClose) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [warnOnClose]);

  // ---------------------------------------------------------------- ファイルから起動
  // インストールしたアプリで画像を「このアプリで開く」と、launchQueue 経由でファイルが渡される（Chrome / Edge）
  useEffect(() => {
    const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: { files?: FileSystemFileHandle[] }) => void): void } }).launchQueue;
    lq?.setConsumer(async (params) => {
      const handle = params.files?.[0];
      if (handle) void openFile(await handle.getFile(), handle);
    });
  }, [openFile]);

  // ---------------------------------------------------------------- キーボード
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (e.key === "Escape") {
        dispatch({ type: "select", id: null });
      } else if (mod && k === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
      } else if (mod && k === "y") {
        e.preventDefault();
        dispatch({ type: "redo" });
      } else if (mod && (e.key === "+" || e.key === "=" || e.key === ";")) {
        // ";" は日本語配列の「+」キー（Shift なし）
        e.preventDefault();
        zoomStep(1);
      } else if (mod && (e.key === "-" || e.key === "_")) {
        e.preventDefault();
        zoomStep(-1);
      } else if (mod && e.key === "0") {
        e.preventDefault();
        fit();
      } else if (mod && e.key === "1") {
        e.preventDefault();
        setScale(1);
      } else if (mod && k === "s") {
        e.preventDefault();
        if (e.shiftKey) saveKeysRef.current.open();
        else saveKeysRef.current.quickSave();
      } else if (mod && k === "o") {
        e.preventDefault();
        fileRef.current?.click();
      } else if (!mod && (e.key === "[" || e.key === "]")) {
        const dir = e.key === "]" ? 1 : -1;
        const t = toolRef.current;
        if (t === "pen" || t === "eraser") {
          setPaint((p) => ({ ...p, [t]: { ...p[t], size: stepPaintSize(p[t].size, dir) } }));
        } else {
          setBrushSize((v) => stepBrushSize(v, dir));
        }
      } else if (!mod && !e.altKey && TOOL_KEYS[k]) {
        selectTool(TOOL_KEYS[k]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, zoomStep, fit, setScale, selectTool]);

  const rotationDeg = view ? rotationDegrees(view) : 0;

  return (
    <div
      className={`app${dragOver ? " drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files[0];
        if (f) void openFile(f);
      }}
    >
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT_ATTR}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void openFile(f);
        }}
      />

      <header className="app-bar">
        <div className="app-bar-group">
          <span className="brand" aria-label="layer-draw">
            <span className="brand-mark" aria-hidden>
              <Layers size={16} />
            </span>
            <span className="brand-name">layer-draw</span>
          </span>
          <button className="btn" onClick={() => fileRef.current?.click()} title="画像を開く (Ctrl+O)">
            <ImagePlus size={16} />
            <span className="btn-label">開く</span>
          </button>
          {doc && (
            <button className="btn" onClick={() => setSaveOpen(true)} title={savedForDoc?.handle ? `保存（⌘S / Ctrl+S で「${savedForDoc.fileName}」に上書き）` : "保存 (Ctrl+S)"}>
              <Save size={16} />
              <span className="btn-label">保存</span>
            </button>
          )}
          <span className="divider" aria-hidden />
          <button className="icon-btn" disabled={!h || !canUndo(h)} onClick={() => dispatch({ type: "undo" })} aria-label="取り消し" title="取り消し (Ctrl+Z)">
            <Undo2 size={17} />
          </button>
          <button className="icon-btn" disabled={!h || !canRedo(h)} onClick={() => dispatch({ type: "redo" })} aria-label="やり直し" title="やり直し (Ctrl+Shift+Z)">
            <Redo2 size={17} />
          </button>
        </div>
        <div className="doc-title" title={doc?.name}>
          {doc ? (
            <>
              <span className="doc-name">{doc.name}</span>
              <span className="doc-sub">{doc.source?.format.toUpperCase()}</span>
              <span
                className={`save-state${dirty ? " dirty" : ""}`}
                title={savedForDoc ? `最後の保存: ${savedForDoc.fileName}（${WHERE_LABEL[savedForDoc.where]}）` : "まだ保存していません。「保存」から PSD で保存すると、レイヤーを保ったまま続きを編集できます"}
              >
                {!savedForDoc ? "未保存" : dirty ? "未保存の変更あり" : `保存済み: ${savedForDoc.fileName}（${WHERE_LABEL[savedForDoc.where]}）`}
              </span>
            </>
          ) : null}
        </div>
        <div className="app-bar-group end">
          {doc && view && (
            <ZoomControl
              scale={view.scale}
              rotationDeg={rotationDeg}
              onZoomIn={() => zoomStep(1)}
              onZoomOut={() => zoomStep(-1)}
              onFit={fit}
              onActual={() => setScale(1)}
              onSetScale={setScale}
              onResetRotation={resetRotation}
            />
          )}
          {doc && (
            <button className={`icon-btn panel-toggle${panelOpen ? " active" : ""}`} onClick={() => setPanelOpen((v) => !v)} aria-label="レイヤーパネル" aria-pressed={panelOpen}>
              <Layers size={18} />
            </button>
          )}
        </div>
      </header>

      {doc && (
        <ContextBar
          tool={tool}
          multiSelect={multiSelect}
          onMultiSelect={setMultiSelect}
          selectedPartCount={selectedPartCount}
          onMerge={merge}
          onClearSelection={() => dispatch({ type: "select", id: null })}
          brushSize={brushSize}
          onBrushSize={setBrushSize}
          moveTarget={moveTarget}
          paint={paint}
          onPaint={setPaint}
          paintTarget={paintTarget}
          onPickTool={() => selectTool("picker")}
        />
      )}

      <div className="main">
        {doc && <ToolRail tool={tool} onTool={selectTool} />}
        <main className="workspace">
          {doc ? (
            <CanvasView
              doc={doc}
              tool={tool}
              multiSelect={multiSelect}
              brushSize={brushSize}
              paint={paint}
              onPickColor={(hex) => setPaint((p) => ({ ...p, pen: { ...p.pen, color: hex } }))}
              onPickerDone={onPickerDone}
              view={view}
              setView={setView}
              onViewportSize={onViewportSize}
              onMessage={showMessage}
              onCursor={onCursor}
            />
          ) : (
            <EmptyState onOpen={() => fileRef.current?.click()} />
          )}
        </main>
        {doc && (
          <aside className={`side-panel${panelOpen ? " open" : ""}`} aria-label="パネル">
            <div className="sheet-handle">
              <span>パネル</span>
              <button className="icon-btn sm" onClick={() => setPanelOpen(false)} aria-label="パネルを閉じる">
                <X size={16} />
              </button>
            </div>
            {doc.source && (
              <DecomposePanel
                key={doc.id}
                initial={doc.source.params}
                mode={doc.source.layered ? "layer" : "document"}
                targetName={layerTarget?.name}
                onRun={doc.source.layered ? (p) => void decomposeLayer(p) : redecompose}
                disabled={!!busy}
              />
            )}
            <LayerPanel doc={doc} />
          </aside>
        )}
      </div>

      {/* 表示変換が決まる前から描画して、ビューポートの大きさを確定させる（画面に合わせる計算がずれないように） */}
      {doc && (
        <StatusBar
          scale={view?.scale ?? 1}
          rotationDeg={rotationDeg}
          docSize={`${doc.width} × ${doc.height} px`}
          cursorRef={cursorRef}
          partCount={partCount}
          selectedCount={state.selectedIds.length}
          onResetRotation={resetRotation}
        />
      )}

      {saveOpen && doc && (
        <SaveDialog
          defaultName={(savedForDoc?.fileName ?? doc.name).replace(/\.(psd|png)$/i, "")}
          defaultFormat={lastFormatRef.current}
          canPick={canPickLocation()}
          embedded={isEmbedded()}
          overwriteName={savedForDoc?.handle ? savedForDoc.fileName : undefined}
          onSave={(r) => void saveAs(r)}
          onCancel={() => setSaveOpen(false)}
        />
      )}

      {confirmReq && (
        <ConfirmDialog
          {...confirmReq}
          onCancel={() => setConfirmReq(null)}
          onConfirm={() => {
            const fn = confirmReq.onConfirm;
            setConfirmReq(null);
            fn();
          }}
        />
      )}

      <Toasts toasts={toasts} onDismiss={(id) => setToasts((ts) => ts.filter((t) => t.id !== id))} />

      {dragOver && (
        <div className="drop-overlay" aria-hidden>
          <Upload size={28} />
          <span>ドロップして開く</span>
        </div>
      )}

      {busy && (
        <div className="modal-backdrop" role="alertdialog" aria-live="polite" aria-label="処理中">
          <div className="modal">
            <LoaderCircle size={22} className="spin" />
            <span>{busy.label}…</span>
            {busy.job && (
              <button className="btn ghost" onClick={() => busy.job?.cancel()}>
                キャンセル
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-msg">
        <h2 id="confirm-title">{title}</h2>
        <p id="confirm-msg">{message}</p>
        <div className="dialog-actions">
          <button className="btn ghost" onClick={onCancel}>
            キャンセル
          </button>
          <button ref={okRef} className="btn primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="empty-state">
      <div className="drop-card">
        <span className="drop-icon">
          <ImagePlus size={28} />
        </span>
        <h1>画像を読み込んで始める</h1>
        <p>線画とパーツのレイヤーに自動で分解します。</p>
        <button className="btn primary lg" onClick={onOpen}>
          画像を開く
        </button>
        <p className="muted">またはここにドラッグ＆ドロップ ・ PNG / JPEG / SVG / PSD / ORA</p>
        <p className="muted">保存した PSD を開くと、レイヤーを保ったまま続きから編集できます。</p>
      </div>
    </div>
  );
}
