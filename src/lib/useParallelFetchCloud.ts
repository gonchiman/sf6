import { useEffect, useRef, useState } from 'react'
import { parseCloudServiceStatus } from './parallelFetchCloud'
import { CLOUD_ERRORS } from '../types/parallelFetchCloud'
import type { CloudError, CloudMode, CloudServiceStatus } from '../types/parallelFetchCloud'

const serviceUrl = `${import.meta.env.BASE_URL}__parallel-fetch-cloud`

/** Only the local bridge can dispatch. Changing pages cancels polling, never the Actions run. */
export function useParallelFetchCloud(enabled: boolean) {
  const [status, setStatus] = useState<CloudServiceStatus | null>(null)
  const [connection, setConnection] = useState<'checking' | 'connected' | 'unavailable' | 'static'>(import.meta.env.DEV ? 'checking' : 'static')
  const [pending, setPending] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [commandErrorCode, setCommandErrorCode] = useState<CloudError | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const generation = useRef(0)
  const mounted = useRef(false)
  const commandPending = useRef(false)
  const commandController = useRef<AbortController | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current += 1
      commandController.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!import.meta.env.DEV || !enabled) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | null = null
    const poll = async () => {
      if (!active) return
      if (!commandPending.current) {
        const requestGeneration = generation.current
        controller = new AbortController()
        const timeout = setTimeout(() => controller?.abort(), 30_000)
        try {
          const response = await fetch(`${serviceUrl}/status`, { cache: 'no-store', signal: controller.signal })
          if (!response.ok) throw new Error('service-unavailable')
          const next = parseCloudServiceStatus(await response.json())
          if (active && requestGeneration === generation.current) {
            setStatus(next)
            setConnection(next.available ? 'connected' : 'unavailable')
            setUnconfirmed(false)
          }
        } catch {
          if (active && requestGeneration === generation.current) setConnection('unavailable')
        } finally {
          clearTimeout(timeout)
          controller = null
        }
      }
      if (active) timer = setTimeout(() => { void poll() }, 15_000)
    }
    void poll()
    return () => { active = false; clearTimeout(timer); controller?.abort() }
  }, [enabled, refreshVersion])

  const command = async (action: 'run' | 'stop' | 'retry', payload: { mode: CloudMode } | { requestId: string }): Promise<CloudServiceStatus | null> => {
    if (!import.meta.env.DEV || !enabled || commandPending.current || !status?.token || connection !== 'connected') return null
    commandPending.current = true
    const requestGeneration = ++generation.current
    setPending(true)
    setCommandError(null)
    setCommandErrorCode(null)
    const controller = new AbortController()
    commandController.current = controller
    const timeout = setTimeout(() => controller.abort(), 45_000)
    try {
      const response = await fetch(`${serviceUrl}/${action}`, { method: 'POST', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Parallel-Fetch-Token': status.token }, body: JSON.stringify(payload) })
      if (!response.ok) {
        const body: unknown = await response.json()
        const code = body && typeof body === 'object' && 'error' in body ? body.error : null
        if (typeof code !== 'string' || !CLOUD_ERRORS.includes(code as CloudError)) throw new Error('command-failed')
        if (mounted.current && requestGeneration === generation.current) {
          setCommandErrorCode(code as CloudError)
          setUnconfirmed(code === 'dispatch-uncertain')
        }
        return null
      }
      const next = parseCloudServiceStatus(await response.json())
      if (!mounted.current || requestGeneration !== generation.current) return null
      setStatus(next)
      setConnection(next.available ? 'connected' : 'unavailable')
      setUnconfirmed(false)
      return next
    } catch {
      if (mounted.current && requestGeneration === generation.current) {
        setUnconfirmed(true)
        setCommandError(action === 'run' ? '受付を確認できません。実行状況を再確認しています。'
          : action === 'stop' ? '取消の完了を確認できません。実行状況を再確認しています。' : '結果を再確認できませんでした。')
      }
      return null
    } finally {
      clearTimeout(timeout)
      commandController.current = null
      commandPending.current = false
      if (mounted.current && requestGeneration === generation.current) {
        setPending(false)
        setRefreshVersion(value => value + 1)
      }
    }
  }
  return { status, connection, pending, unconfirmed, commandError, commandErrorCode, command,
    refresh: () => setRefreshVersion(value => value + 1) }
}
