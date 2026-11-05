import { ChevronRight, SlidersHorizontal } from "lucide-react";
import { memo, useState } from "react";
import type { DecomposeParams, FillMode, LineartMethod } from "../decompose/types";

/** 自動分解パラメータの調整と再分解（仕様書 UC-1 手順 4, 6.2 再分解） */
export const DecomposePanel = memo(function DecomposePanel({
  initial,
  onRun,
  disabled,
  mode = "document",
  targetName,
}: {
  initial: DecomposeParams;
  onRun: (p: DecomposeParams) => void;
  disabled: boolean;
  /** document: 画像全体を分解し直す / layer: 選択中のレイヤーを分解する（レイヤー付きのファイル） */
  mode?: "document" | "layer";
  /** mode=layer のとき、分解する対象のレイヤー名（未選択なら undefined） */
  targetName?: string;
}) {
  const [p, setP] = useState(initial);
  const setL = (patch: Partial<DecomposeParams["lineart"]>) => setP({ ...p, lineart: { ...p.lineart, ...patch } });
  const setS = (patch: Partial<DecomposeParams["segment"]>) => setP({ ...p, segment: { ...p.segment, ...patch } });

  return (
    <details className="panel decompose-panel">
      <summary className="panel-header">
        <ChevronRight size={14} className="disclosure" />
        <SlidersHorizontal size={14} />
        <h2>自動分解の設定</h2>
      </summary>
      <div className="fields">
        <label>
          線画抽出
          <select value={p.lineart.method} onChange={(e) => setL({ method: e.target.value as LineartMethod })}>
            <option value="tophat">周囲より暗い細い線（塗りあり・撮影向け）</option>
            <option value="lightness">暗い部分すべて（白い紙の線画向け）</option>
          </select>
        </label>
        {p.lineart.method === "tophat" && (
          <>
            <label className="check">
              <input id="auto-line-width" type="checkbox" checked={p.lineart.autoLineWidth} onChange={(e) => setL({ autoLineWidth: e.target.checked })} />
              線の太さを画像から自動で決める
            </label>
            {!p.lineart.autoLineWidth && (
              <Range label="線とみなす最大の太さ" unit="px" min={2} max={160} step={1} value={p.lineart.maxLineWidth} onChange={(v) => setL({ maxLineWidth: v })} hint="これより太い暗い部分は、線ではなく塗りとして扱います" />
            )}
          </>
        )}
        <Range label="線の判定しきい値" unit="%" min={5} max={95} step={5} value={Math.round(p.segment.lineThreshold * 100)} onChange={(v) => setS({ lineThreshold: v / 100 })} />
        <Range label="隙間閉じ（半径）" unit="px" min={0} max={10} step={1} value={p.segment.gapRadius} onChange={(v) => setS({ gapRadius: v })} hint={`幅 ${p.segment.gapRadius * 2}px までの線の途切れを閉じます`} />
        <Range label="色の違いの許容量" unit="" min={0} max={441} step={1} value={p.segment.colorTolerance} onChange={(v) => setS({ colorTolerance: v })} hint="大きいほど色で領域を分けなくなります" />
        <Range label="小さい領域を吸収" unit="‰" min={0} max={10} step={0.1} value={Math.round(p.segment.minAreaRatio * 10000) / 10} onChange={(v) => setS({ minAreaRatio: v / 1000 })} hint="画像全体に対する面積の割合" />
        <Range label="パーツ数の上限" unit="" min={1} max={256} step={1} value={p.segment.maxParts} onChange={(v) => setS({ maxParts: v })} />
        <label>
          パーツの色
          <select value={p.segment.fill} onChange={(e) => setS({ fill: e.target.value as FillMode })}>
            <option value="auto">自動（線画のみなら自動配色）</option>
            <option value="source">元画像の色</option>
            <option value="palette">自動配色</option>
            <option value="white">白</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={p.segment.borderAsBackground} onChange={(e) => setS({ borderAsBackground: e.target.checked })} />
          画像の端に接する領域は背景にする
        </label>
        {mode === "layer" && (
          <p className="field-note">
            {targetName ? (
              <>
                分解するレイヤー: <strong>{targetName}</strong>。結果はその上にフォルダとして追加し、元のレイヤーは非表示にします
              </>
            ) : (
              "分解するレイヤー（線画のレイヤーなど）をレイヤー一覧で選んでください"
            )}
          </p>
        )}
        <div className="field-actions">
          <button className="btn ghost" onClick={() => setP(initial)} disabled={disabled}>
            元に戻す
          </button>
          <button className="btn primary" disabled={disabled || (mode === "layer" && !targetName)} onClick={() => onRun(p)}>
            {mode === "layer" ? "選択中のレイヤーを分解" : "再分解"}
          </button>
        </div>
      </div>
    </details>
  );
});

function Range(props: { label: string; unit: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; hint?: string }) {
  return (
    <label className="range-field">
      <span className="field-head">
        <span>{props.label}</span>
        <span className="prop-value">
          {props.value}
          {props.unit}
        </span>
      </span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
      {props.hint && <small className="hint">{props.hint}</small>}
    </label>
  );
}
