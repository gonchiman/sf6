import type { HistoryControlType } from '../types/winRateHistory.ts'

/** Stable control-type styles shared by bars and their legends. */
const CONTROL_TYPE_BAR_STYLES = Object.freeze({
  combined: Object.freeze({ label: '合算', shortLabel: '', fill: '#8c8c8c', ink: '#727272', hatch: false }),
  classic: Object.freeze({ label: 'クラシック', shortLabel: 'C', fill: '#777777', ink: '#727272', hatch: false }),
  modern: Object.freeze({ label: 'モダン', shortLabel: 'M', fill: '#f0f0f0', ink: '#727272', hatch: true }),
})

export function controlTypeBarStyle(controlType: HistoryControlType) {
  return CONTROL_TYPE_BAR_STYLES[controlType]
}
