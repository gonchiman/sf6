import type { ControlTypeRatioEstimate } from '../types/controlTypeRatio'
import { officialUsageRateLabel, ratioErrorLabel } from './controlTypeRatioFormatting'
import '../table.css'

type Props = { details: ControlTypeRatioEstimate['details'] }

export function ControlTypeRatioDetailsTable({ details }: Props) {
  return <div className="data-table-scroll control-ratio-details-scroll" role="region"
    tabIndex={0} aria-label="キャラクター別の計算根拠・スクロール領域">
    <table className="data-table control-ratio-details-table">
      <caption className="win-rates-visually-hidden">キャラクター別の公式使用率と推定比率から再現したALL使用率</caption>
      <colgroup><col className="control-ratio-character-column" /><col /><col /><col /><col /><col /></colgroup>
      <thead><tr>
        <th scope="col">キャラクター</th>
        <th scope="col">公式ALL</th>
        <th scope="col">公式CLASSIC</th>
        <th scope="col">公式MODERN</th>
        <th scope="col">再現ALL<span className="control-ratio-unit">（%）</span></th>
        <th scope="col">再現ALL − 公式ALL<span className="control-ratio-unit">（ポイント）</span></th>
      </tr></thead>
      <tbody>{details.map(detail => <tr key={detail.characterId}>
        <th scope="row">{detail.name}</th>
        <td>{officialUsageRateLabel(detail.allText)}</td>
        <td>{officialUsageRateLabel(detail.classicText)}</td>
        <td>{officialUsageRateLabel(detail.modernText)}</td>
        <td>{detail.reconstructedAllPercent.toFixed(5)}</td>
        <td>{ratioErrorLabel(detail.differencePoints, true)}</td>
      </tr>)}</tbody>
    </table>
  </div>
}
