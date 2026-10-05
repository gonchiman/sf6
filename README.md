# SF6 バランス分析

勝率を分析してStreet Fighter 6のゲームバランスを考察するためのアプリ。
現在はReact・TypeScript・Viteの初期構成のみで、データ取得・集計・分析の機能は未実装。

## 開発

Node.js 24とnpmを使用する。

```sh
npm ci
npm run dev
```

開発用URLはViteの起動時に表示される。公開先に合わせて `/sf6/` をベースパスにしている。

```sh
npm run typecheck
npm run build
npm run preview
```

`build` は型チェックと本番ビルドを行い、出力を `dist/` に生成する。

## 構成

| 場所 | 役割 |
| --- | --- |
| `src/App.tsx` | アプリの入口。現在はタイトルのみを表示 |
| `src/components/` | UIの共通部品 |
| `src/lib/` | 取得・正規化・集計などの処理 |
| `src/types/` | データの型 |
| `public/data/` | 配信用の事前生成データ |
| `scripts/` | 事前のデータ取得・生成スクリプト |
| `.github/workflows/pages.yml` | 型チェック・ビルドとGitHub Pagesへの配信 |

空のフォルダーは今後の追加先として用意しており、対応する処理やデータはまだ存在しない。

## GitHub Pages

Viteの `base` は `/sf6/`。配信を開始するときはリポジトリのSettings → PagesでSourceをGitHub Actionsに設定する。
Actionsはpull requestでビルドを確認し、mainへのpushまたはmain上での手動実行で `dist/` を配信する。

設定方法は [Viteの配信ガイド](https://vite.dev/guide/static-deploy.html#github-pages) を参照。
ローカルで初期構成を保存しただけでは公開されない。

## 前作からの継承

`arknights_2` の起動構成、TypeScriptの設定分割、基礎CSS、Pages配信の構成を参照している。
主要な依存バージョンは前作のlockfileに揃え、`package-lock.json` で固定する。
アークナイツ固有の処理や分析ページは移植していない。

作業時は [AGENTS.md](AGENTS.md) と該当する参照先を読む。
