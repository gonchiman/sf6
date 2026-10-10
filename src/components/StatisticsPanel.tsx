import { useId } from 'react'
import type { ReactNode } from 'react'
import '../statistics-panel.css'

type Props = {
  title: string
  headerContent?: ReactNode
  children: ReactNode
}

export function StatisticsPanel({ title, headerContent, children }: Props) {
  const titleId = useId()
  return <section className="monthly-statistics-panel" aria-labelledby={titleId}>
    <header className="monthly-statistics-panel-heading">
      <h2 id={titleId}>{title}</h2>
      {headerContent}
    </header>
    <div className="monthly-statistics-panel-body">{children}</div>
  </section>
}
