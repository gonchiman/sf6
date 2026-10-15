import { MonthlyStatisticsTable, type MonthlyStatisticsTableProps } from './MonthlyStatisticsTable'

type Props = Omit<MonthlyStatisticsTableProps, 'regionLabel' | 'caption'>

/** Keep the existing win-rate API while sharing the table's layout and interactions. */
export function MonthlyWinRateStatisticsTable(props: Props) {
  return <MonthlyStatisticsTable {...props}
    regionLabel="月別勝率統計・スクロール領域"
    caption="各月・リーグのキャラ別公式Totalを百分率に換算した統計量" />
}
