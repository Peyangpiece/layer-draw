# layer-draw

画像を読み込むだけで「線画レイヤー」と「パーツ（塗り）レイヤー」に自動分解し、レイヤー単位で描き足し・塗り直しができるペイントアプリ。

- 仕様書: [docs/SPEC.md](docs/SPEC.md)
- 対応入力形式: PNG / JPEG / SVG

## 開発

Node.js 22 以上を想定しています。

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run build
```

## 現在の実装範囲

- PNG / JPEG / SVG の読み込み（形式はファイル先頭のバイト列で判定）
- 線画抽出（明度 → アルファ変換）を Web Worker で実行
- レイヤーパネル: 表示/非表示、不透明度、合成モード、クリッピング、並べ替え、削除
- 取り消し / やり直し（Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z）

パーツ分割（領域分割・線下補完）は未実装です。詳細は仕様書 10.1 節を参照してください。
