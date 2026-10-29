# テーブルの表示方針

このアプリのテーブルを新規作成・修正するときは [共通のテーブル表示方針](shared/table-ui.md) を読む。最大値・同率の強調、共通部分の結合、転置や分割を扱う場合は [共通の比較表ルール](shared/comparison-table.md) も読む。

## SF6の基準となる実装と集計

- 共通の外枠・縦横罫線、見出し背景、セル余白、数字の配置は [table.css](../src/table.css) を使用する。
- 表示とスクロールの参照は [WinRateTable.tsx](../src/components/WinRateTable.tsx)、勝率表固有の固定列・セル選択は [win-rates.css](../src/win-rates.css) を確認する。
- 勝率・使用率の集計には [勝率・使用率分析のルール](statistics.md) も適用する。系列色の定義には [比較系列の配色方針](../docs/series-colors/README.md) を使う。
