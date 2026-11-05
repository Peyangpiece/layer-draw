import { Download, FolderOpen, Info, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { FORMAT_INFO, type SaveFormat } from "../io/export/save";

const FORMAT_CHOICES: { value: SaveFormat; title: string; note: string }[] = [
  {
    value: "psd",
    title: "PSD（レイヤー付き）",
    note: "レイヤーを分けたまま保存します。このアプリにもう一度読み込んで続きを編集できます。アイビスペイント・Photoshop・CLIP STUDIO PAINT などでも開けます。",
  },
  {
    value: "png",
    title: "PNG（1 枚の画像）",
    note: "いま見えているとおりに 1 枚の画像にします。共有や投稿向けです。レイヤーは残りません。",
  },
];

export interface SaveRequest {
  format: SaveFormat;
  /** 拡張子なし */
  baseName: string;
}

/**
 * 保存ダイアログ。形式・ファイル名に加えて「どこに保存されるか」をはっきり示す。
 *  - canPick: 次の画面（OS の保存ダイアログ）でフォルダを選ぶ
 *  - それ以外: ブラウザの「ダウンロード」フォルダに入る
 */
export function SaveDialog({
  defaultName,
  defaultFormat,
  canPick,
  embedded,
  overwriteName,
  onSave,
  onCancel,
}: {
  defaultName: string;
  defaultFormat: SaveFormat;
  canPick: boolean;
  embedded: boolean;
  /** Ctrl+S で上書きできるファイル名（このドキュメントを保存先を選んで保存したことがあるとき） */
  overwriteName?: string;
  onSave: (r: SaveRequest) => void;
  onCancel: () => void;
}) {
  const [format, setFormat] = useState<SaveFormat>(defaultFormat);
  const [name, setName] = useState(defaultName);
  const nameRef = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    nameRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const submit = () => onSave({ format, baseName: name });
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="modal dialog save-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 id={`${id}-title`}>保存</h2>

        <fieldset className="save-formats">
          <legend className="field-label">形式</legend>
          {FORMAT_CHOICES.map((c) => (
            <label key={c.value} className={`format-choice${format === c.value ? " checked" : ""}`}>
              <input type="radio" name={`${id}-format`} value={c.value} checked={format === c.value} onChange={() => setFormat(c.value)} />
              <span>
                <span className="format-title">{c.title}</span>
                <span className="format-note">{c.note}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="field-label" htmlFor={`${id}-name`}>
          ファイル名
        </label>
        <div className="name-field">
          <input id={`${id}-name`} ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} autoComplete="off" />
          <span className="name-ext">{FORMAT_INFO[format].ext}</span>
        </div>

        <div className="field-label">保存先</div>
        <div className="save-location" data-testid="save-location">
          {canPick ? <FolderOpen size={18} /> : <Download size={18} />}
          <div>
            {canPick ? (
              <>
                <strong>自分で選んだフォルダ</strong>
                <span>「保存」を押すと保存の画面が開くので、保存するフォルダを選んでください。次回は前回選んだフォルダから始まります。</span>
              </>
            ) : (
              <>
                <strong>「ダウンロード」フォルダ</strong>
                <span>
                  {isMac ? "Finder のサイドバーの「ダウンロード」、または Dock のダウンロードスタックから開けます。" : "ブラウザのダウンロード一覧から開けます。"}
                  ブラウザの設定でダウンロード先を変えている場合はその場所です。同じ名前のファイルがあると、名前に番号が付きます。
                </span>
              </>
            )}
          </div>
        </div>

        {embedded && (
          <p className="save-note warn">
            <TriangleAlert size={15} />
            <span>この画面（claude.ai 上のプレビュー）では、ブラウザの制限で保存できないことがあります。確実に保存するには、Dock に追加したアプリ版（GitHub Pages）を使ってください。</span>
          </p>
        )}
        {overwriteName && (
          <p className="save-note">
            <Info size={15} />
            <span>
              {isMac ? "⌘S" : "Ctrl+S"} で「{overwriteName}」に上書き保存できます。ここからは別のファイルとして保存します。
            </span>
          </p>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            キャンセル
          </button>
          <button type="submit" className="btn primary">
            {canPick ? "保存先を選んで保存…" : "ダウンロードに保存"}
          </button>
        </div>
      </form>
    </div>
  );
}
