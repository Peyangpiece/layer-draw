import type { BlendMode, LayerDocument, LayerNode } from "../core/types";
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

export function LayerPanel({ doc }: { doc: LayerDocument }) {
  return (
    <aside className="layer-panel" aria-label="レイヤー">
      <h2>レイヤー</h2>
      <ul className="layer-list">
        {doc.root.children.map((n) => (
          <LayerRow key={n.id} node={n} depth={0} />
        ))}
      </ul>
    </aside>
  );
}

function LayerRow({ node, depth }: { node: LayerNode; depth: number }) {
  const { state, dispatch } = useEditor();
  const selected = state.selectedId === node.id;
  const patch = (p: NodePatch, commit = true) =>
    dispatch({ type: "patch", id: node.id, patch: p, commit });

  return (
    <li>
      <div
        className={`layer-row${selected ? " selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => dispatch({ type: "select", id: node.id })}
      >
        <button
          className="icon"
          aria-label={node.visible ? "非表示にする" : "表示する"}
          aria-pressed={node.visible}
          onClick={(e) => {
            e.stopPropagation();
            patch({ visible: !node.visible });
          }}
        >
          {node.visible ? "●" : "○"}
        </button>
        {node.clipping && <span className="badge" title="クリッピング">↳</span>}
        <span className="layer-name">
          {node.kind === "group" ? "📁 " : ""}
          {node.name}
        </span>
        {node.kind === "raster" && node.isReference && <span className="badge">参照</span>}
      </div>

      {selected && (
        <div className="layer-props" style={{ paddingLeft: 8 + depth * 16 }}>
          <label>
            不透明度 {Math.round(node.opacity * 100)}%
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(node.opacity * 100)}
              onChange={(e) => patch({ opacity: Number(e.target.value) / 100 }, false)}
              onPointerUp={() => dispatch({ type: "commit" })}
              onKeyUp={() => dispatch({ type: "commit" })}
            />
          </label>
          <label>
            合成モード
            <select value={node.blendMode} onChange={(e) => patch({ blendMode: e.target.value as BlendMode })}>
              {BLEND_LABELS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={node.clipping} onChange={(e) => patch({ clipping: e.target.checked })} />
            クリッピング
          </label>
          <div className="row-buttons">
            <button onClick={() => dispatch({ type: "move", id: node.id, delta: -1 })}>上へ</button>
            <button onClick={() => dispatch({ type: "move", id: node.id, delta: 1 })}>下へ</button>
            <button className="danger" onClick={() => dispatch({ type: "remove", id: node.id })}>
              削除
            </button>
          </div>
        </div>
      )}

      {node.kind === "group" && node.expanded && (
        <ul className="layer-list">
          {node.children.map((c) => (
            <LayerRow key={c.id} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}
