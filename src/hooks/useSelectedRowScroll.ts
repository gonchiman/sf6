import { useEffect, useRef } from 'react'

/** Keep a selected table row visible below its sticky column headings. */
export function useSelectedRowScroll(
  rows: readonly unknown[],
  selectedKey: string | null,
  resetOnRowsChange = false,
) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const selectedRowRef = useRef<HTMLTableRowElement>(null)
  const previousRowsRef = useRef<readonly unknown[] | null>(null)

  useEffect(() => {
    const viewport = scrollRef.current
    const rowsChanged = previousRowsRef.current !== rows
    previousRowsRef.current = rows
    if (!viewport) return

    // Reset and reveal in one effect so a data refresh cannot hide the selection.
    if (resetOnRowsChange && rowsChanged) {
      viewport.scrollTop = 0
      viewport.scrollLeft = 0
    }

    const row = selectedRowRef.current
    if (!row) return
    const viewportBounds = viewport.getBoundingClientRect()
    const rowBounds = row.getBoundingClientRect()
    const headingHeight = viewport.querySelector('thead')?.getBoundingClientRect().height ?? 0
    const visibleTop = viewportBounds.top + viewport.clientTop + headingHeight
    const visibleBottom = viewportBounds.top + viewport.clientTop + viewport.clientHeight
    if (rowBounds.top < visibleTop) viewport.scrollTop += rowBounds.top - visibleTop
    else if (rowBounds.bottom > visibleBottom) viewport.scrollTop += rowBounds.bottom - visibleBottom
  }, [rows, selectedKey, resetOnRowsChange])

  return { scrollRef, selectedRowRef }
}
