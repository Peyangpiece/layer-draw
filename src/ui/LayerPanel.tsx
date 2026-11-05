import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, CornerDownRight, Eye, EyeOff, Folder, Grid2x2, Lock, LockOpen, Plus, Trash2 } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { createRasterLayer, findNode, findParent, listRasterLayers } from "../core/document";
import type { BlendMode, LayerDocument, LayerNode, RasterLayer } from "../core/types";
import { collectBitmapIds, recolorBitmap } from "../store/buildFromImport";
import { useEditor, type NodePatch } from "../store/editorStore";

const BLEND_LABELS: [BlendMode, string][] = [
  ["normal", "通常"],
  ["multiply", "乗算"],
  ["screen", "スクリーン"],
  ["overlay", "オーバーレイ"],
  ["add", "加算"],
  ["darken", "比較(暗)"],
  ["lighten", "比較(明)"],
  ["color-dodge", "覆い焼きカラー"],
  ["color-burn", "焼き込みカラー"],
  ["hard-light", "ハードライト"],
  ["soft-light", "ソフトライト"],
  ["difference", "差の絶対値"],
  ["exclusion", "除外"],
  ["hue", "色相"],
  ["saturation", "彩度"],
  ["color", "カラー"],
  ["luminosity", "輝度"],
];
const blendLabel = (m: BlendMode) => BLEND_LABELS.find(([v]) => v === m)?.[1] ?? m;

/**
 * レイヤーパネル。
 * 上部に主選択レイヤーのプロパティ（合成モード・不透明度・クリッピング・ロック・パーツの色）、
 * 中央にサムネイル付きの一覧、下部に並べ替え・削除。
 */
export const LayerPanel = memo(function LayerPanel({ doc }: { doc: LayerDocument }) {
  const { state, dispatch, bitmaps } = useEditor();
  const primaryId = state.selectedIds[state.selectedIds.length - 1];
  const primary = primaryId ? findNode(doc.root, primaryId) : undefined;

  /** 空のレイヤーを、選択中のレイヤーのすぐ上（同じフォルダ内）に作る。未選択なら一番上 */
  const addLayer = () => {
    const n = listRasterLayers(doc.root).filter((l) => l.role === "normal").length + 1;
    const layer = createRasterLayer({ name: `レイヤー ${n}`, bitmapId: bitmaps.add(new ImageData(1, 1)), bounds: { x: 0, y: 0, w: 1, h: 1 } });
    const parent = primary ? findParent(doc.root, primary.id) : undefined;
    if (primary && parent) {
      const index = parent.children.findIndex((c) => c.id === primary.id);
      dispatch({ type: "insertNode", node: layer, parentId: parent.id, index });
    } else {
      dispatch({ type: "insertNode", node: layer, index: 0 });
    }
  };

  return (
    <section className="panel layer-panel" aria-label="レイヤー">
      <header className="panel-header">
        <h2>レイヤー</h2>
      </header>
      <LayerProps node={primary} />
      <ul className="layer-list" role="tree" aria-multiselectable>
        {doc.root.children.map((n) => (
          <LayerRow key={n.id} node={n} depth={0} doc={doc} />
        ))}
      </ul>
      <footer className="panel-footer">
        <button className="icon-btn" onClick={addLayer} aria-label="新規レイヤー" title="新規レイヤー（選択中のレイヤーの上に作成）">
          <Plus size={16} />
        </button>
        <button className="icon-btn" disabled={!primary} onClick={() => primary && dispatch({ type: "move", id: primary.id, delta: -1 })} aria-label="前面へ" title="前面へ">
          <ArrowUp size={16} />
        </button>
        <button className="icon-btn" disabled={!primary} onClick={() => primary && dispatch({ type: "move", id: primary.id, delta: 1 })} aria-label="背面へ" title="背面へ">
          <ArrowDown size={16} />
        </button>
        <span className="status-spacer" />
        <button className="icon-btn danger" disabled={!primary} onClick={() => primary && dispatch({ type: "remove", id: primary.id })} aria-label="削除" title="削除">
          <Trash2 size={16} />
        </button>
      </footer>
    </section>
  );
});

function LayerProps({ node }: { node: LayerNode | undefined }) {
  const { state, dispatch, bitmaps } = useEditor();
  if (!node) {
    return <div className="layer-props empty-props">レイヤーを選択するとプロパティを編集できます</div>;
  }
  const patch = (p: NodePatch, commit = true) => dispatch({ type: "patch", id: node.id, patch: p, commit });
  const pct = Math.round(node.opacity * 100);

  return (
    <div className="layer-props">
      <div className="prop-row">
        <select aria-label="合成モード" value={node.blendMode} onChange={(e) => patch({ blendMode: e.target.value as BlendMode })}>
          {BLEND_LABELS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <div className="toggle-group">
          <button className={`icon-btn sm${node.clipping ? " active" : ""}`} aria-pressed={node.clipping} title="クリッピング" aria-label="クリッピング" onClick={() => patch({ clipping: !node.clipping })}>
            <CornerDownRight size={15} />
          </button>
          {node.kind === "raster" && (
            <button
              className={`icon-btn sm${node.alphaLocked ? " active" : ""}`}
              aria-pressed={node.alphaLocked}
              title="透明度保護（塗ってある所だけに描く）"
              aria-label="透明度保護"
              onClick={() => patch({ alphaLocked: !node.alphaLocked })}
            >
              <Grid2x2 size={15} />
            </button>
          )}
          <button className={`icon-btn sm${node.locked ? " active" : ""}`} aria-pressed={node.locked} title={node.locked ? "ロック解除" : "ロック"} aria-label="ロック" onClick={() => patch({ locked: !node.locked })}>
            {node.locked ? <Lock size={15} /> : <LockOpen size={15} />}
          </button>
        </div>
      </div>
      <label className="prop-row opacity-row">
        <span className="prop-label">不透明度</span>
        <input
          type="range"
          min={0}
          max={100}
          value={pct}
          onChange={(e) => patch({ opacity: Number(e.target.value) / 100 }, false)}
          onPointerUp={() => dispatch({ type: "commit" })}
          onKeyUp={() => dispatch({ type: "commit" })}
        />
        <span className="prop-value">{pct}%</span>
      </label>
      {node.kind === "raster" && node.role === "part" && (
        <label className="prop-row">
          <span className="prop-label">塗り色</span>
          <input
            type="color"
            disabled={node.locked}
            value={node.part?.fillColor ?? "#ffffff"}
            onChange={(e) => {
              const src = bitmaps.get(node.bitmapId);
              if (!src) return;
              const bitmapId = bitmaps.add(recolorBitmap(src, e.target.value));
              dispatch({ type: "setPartFill", id: node.id, bitmapId, fillColor: e.target.value, commit: false });
            }}
            onBlur={() => {
              dispatch({ type: "commit" });
              // 履歴から参照されなくなった途中の色のビットマップを解放する
              const h = state.history;
              if (h) bitmaps.gc(collectBitmapIds([...h.past, h.present, ...h.future, ...(h.pending ? [h.pending] : [])]));
            }}
          />
          <span className="prop-value mono">{node.part?.fillColor ?? ""}</span>
        </label>
      )}
    </div>
  );
}

function LayerRow({ node, depth, doc }: { node: LayerNode; depth: number; doc: LayerDocument }) {
  const { state, dispatch } = useEditor();
  const selected = state.selectedIds.includes(node.id);
  const primary = state.selectedIds[state.selectedIds.length - 1] === node.id;
  const patch = (p: NodePatch) => dispatch({ type: "patch", id: node.id, patch: p });

  return (
    <li role="treeitem" aria-selected={selected} aria-expanded={node.kind === "group" ? node.expanded : undefined}>
      <div
        className={`layer-row${selected ? " selected" : ""}${primary ? " primary" : ""}${node.visible ? "" : " hidden-layer"}`}
        style={{ paddingLeft: 4 + depth * 14 }}
        onClick={(e) => dispatch({ type: "select", id: node.id, mode: e.shiftKey || e.ctrlKey || e.metaKey ? "toggle" : "replace" })}
      >
        <button
          className="icon-btn sm eye"
          aria-label={node.visible ? "非表示にする" : "表示する"}
          aria-pressed={node.visible}
          onClick={(e) => {
            e.stopPropagation();
            patch({ visible: !node.visible });
          }}
        >
          {node.visible ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
        {node.kind === "group" ? (
          <button
            className="icon-btn sm"
            aria-label={node.expanded ? "閉じる" : "開く"}
            onClick={(e) => {
              e.stopPropagation();
              patch({ expanded: !node.expanded });
            }}
          >
            {node.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          node.clipping && <CornerDownRight size={13} className="clip-mark" aria-label="クリッピング" />
        )}
        {node.kind === "group" ? (
          <span className="thumb folder">
            <Folder size={18} />
          </span>
        ) : (
          <Thumbnail layer={node} doc={doc} />
        )}
        <span className="layer-text">
          <span className="layer-name">{node.name}</span>
          <span className="layer-meta">
            {blendLabel(node.blendMode)}
            {node.opacity < 1 ? ` ・ ${Math.round(node.opacity * 100)}%` : ""}
            {node.kind === "raster" && node.isReference ? " ・ 参照" : ""}
          </span>
        </span>
        {node.locked && <Lock size={13} className="row-icon" aria-label="ロック中" />}
        {node.kind === "raster" && node.role === "part" && node.part?.fillColor && (
          <span className="swatch" style={{ background: node.part.fillColor }} aria-hidden />
        )}
      </div>
      {node.kind === "group" && node.expanded && (
        <ul className="layer-list" role="group">
          {node.children.map((c) => (
            <LayerRow key={c.id} node={c} depth={depth + 1} doc={doc} />
          ))}
        </ul>
      )}
    </li>
  );
}

const THUMB = 40;

/** ドキュメント全体の枠の中にレイヤーを配置したサムネイル（位置関係が分かるように） */
function Thumbnail({ layer, doc }: { layer: RasterLayer; doc: LayerDocument }) {
  const { bitmaps } = useEditor();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = THUMB * dpr;
    c.height = THUMB * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const src = bitmaps.getCanvas(layer.bitmapId);
    if (!src) return;
    const s = Math.min(c.width / doc.width, c.height / doc.height);
    const ox = (c.width - doc.width * s) / 2, oy = (c.height - doc.height * s) / 2;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, ox + layer.bounds.x * s, oy + layer.bounds.y * s, layer.bounds.w * s, layer.bounds.h * s);
  }, [layer.bitmapId, layer.bounds, doc.width, doc.height, bitmaps]);
  return <canvas ref={ref} className="thumb" style={{ width: THUMB, height: THUMB }} aria-hidden />;
}
