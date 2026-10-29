import { useCallback, useEffect, useRef, useState } from 'react'
import { parseSampleSurveyStatus } from './sampleSurvey'
import type { SampleSurveyConfig, SampleSurveyServiceStatus } from '../types/sampleSurvey'

export type SampleSurveyCommand = 'plan' | 'run' | 'resume' | 'stop'
type CommandBody = SampleSurveyConfig | { planId: string } | { runId: string }
const serviceUrl = `${import.meta.env.BASE_URL}__sample-survey`
const commandMessages: Record<SampleSurveyCommand, string> = {
  plan: '計画の保存を確認できません。取得状況を再確認してください。',
  run: '開始の受付を確認できません。取得状況を再確認してください。',
  resume: '再開の受付を確認できません。取得状況を再確認してください。',
  stop: '停止の受付を確認できません。取得状況を再確認してください。',
}
const serviceMessages: Readonly<Record<string, string>> = {
  'invalid-request': '調査条件・実行番号が不正です。',
  forbidden: '同じPCのアプリ画面から操作してください。',
  'already-running': '標本調査を取得中です。',
  'service-closed': '取得サービスは終了しています。',
  'storage-error': '調査記録の保存・読み込みに失敗しました。',
  'session-unavailable': '保存済みログイン情報がありません。',
  'not-found': '保存済みの計画・観測回がありません。',
  'not-resumable': 'この観測回は再開できません。',
  'already-started': '実行済みの計画です。新しい調査は計画を保存してください。',
  'body-too-large': 'リクエストが上限を超えています。',
}

/** Commands are never replayed after an uncertain response. Only status reads are retried. */
export function useSampleSurvey() {
  const [status, setStatus] = useState<SampleSurveyServiceStatus | null>(null)
  const [connection, setConnection] = useState<'checking' | 'connected' | 'unavailable' | 'static'>(import.meta.env.DEV ? 'checking' : 'static')
  const [pending, setPending] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
  const statusRef = useRef<SampleSurveyServiceStatus | null>(null)
  const mounted = useRef(false)
  const generation = useRef(0)
  const commandPending = useRef(false)
  const readPending = useRef(false)
  const controllers = useRef(new Set<AbortController>())

  const apply = useCallback((next: SampleSurveyServiceStatus) => {
    statusRef.current = next
    setStatus(next)
    setConnection(next.available ? 'connected' : 'unavailable')
  }, [])

  const refresh = useCallback(async (): Promise<SampleSurveyServiceStatus | null> => {
    if (!import.meta.env.DEV || commandPending.current || readPending.current || !mounted.current) return null
    readPending.current = true
    const version = generation.current
    const controller = new AbortController()
    controllers.current.add(controller)
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch(`${serviceUrl}/status`, { signal: controller.signal, cache: 'no-store' })
      if (!response.ok) throw new Error('unavailable')
      const next = parseSampleSurveyStatus(await response.json())
      if (!mounted.current || version !== generation.current) return null
      apply(next)
      return next
    } catch {
      if (mounted.current && version === generation.current) setConnection('unavailable')
      return null
    } finally {
      clearTimeout(timer)
      controllers.current.delete(controller)
      readPending.current = false
    }
  }, [apply])

  useEffect(() => {
    mounted.current = true
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      await refresh()
      if (active) timer = setTimeout(() => { void poll() }, 2_000)
    }
    if (import.meta.env.DEV) void poll()
    const ownedControllers = controllers.current
    return () => {
      active = false
      mounted.current = false
      generation.current++
      clearTimeout(timer)
      for (const controller of ownedControllers) controller.abort()
      ownedControllers.clear()
    }
  }, [refresh])

  const command = useCallback(async (action: SampleSurveyCommand, body: CommandBody): Promise<SampleSurveyServiceStatus | null> => {
    const current = statusRef.current
    const stopKnownRun = action === 'stop' && 'runId' in body && body.runId === current?.activeRunId
    if (!import.meta.env.DEV || !mounted.current || commandPending.current || !current?.token || (!current.available && !stopKnownRun)) return null
    commandPending.current = true
    const version = ++generation.current
    setPending(true)
    setCommandError(null)
    const controller = new AbortController()
    controllers.current.add(controller)
    const timer = setTimeout(() => controller.abort(), 15_000)
    let failureMessage = commandMessages[action]
    try {
      const response = await fetch(`${serviceUrl}/${action}`, {
        method: 'POST', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Parallel-Fetch-Token': current.token },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const error: unknown = await response.json().catch(() => null)
        if (error && typeof error === 'object' && 'error' in error && typeof error.error === 'string'
          && Object.hasOwn(serviceMessages, error.error)) failureMessage = serviceMessages[error.error]
        throw new Error('command-failed')
      }
      const next = parseSampleSurveyStatus(await response.json())
      if (!mounted.current || version !== generation.current) return null
      apply(next)
      return next
    } catch {
      if (mounted.current && version === generation.current) setCommandError(failureMessage)
      return null
    } finally {
      clearTimeout(timer)
      controllers.current.delete(controller)
      commandPending.current = false
      if (mounted.current && version === generation.current) setPending(false)
    }
  }, [apply])

  return { status, connection, pending, commandError, command, refresh }
}
