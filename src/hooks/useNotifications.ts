import { useEffect, useRef, useState } from 'react'
import { deleteNotification, parseIncomingText, receiveNotification } from '../api/greenApi'
import type { Credentials, IncomingText } from '../api/greenApi'

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve()
  const timer = window.setTimeout(done, ms)
  function done() {
    window.clearTimeout(timer)
    signal.removeEventListener('abort', done)
    resolve()
  }
  signal.addEventListener('abort', done, { once: true })
})

export function useNotifications(credentials: Credentials | null, onIncoming: (message: IncomingText) => void) {
  const [error, setError] = useState('')
  const [lastCheck, setLastCheck] = useState<number | null>(null)
  const [received, setReceived] = useState(0)
  const [ignored, setIgnored] = useState(0)
  const [lastEvent, setLastEvent] = useState('')
  const onIncomingRef = useRef(onIncoming)
  onIncomingRef.current = onIncoming

  useEffect(() => {
    if (!credentials) return
    const controller = new AbortController()
    const signal = controller.signal

    async function poll() {
      while (!signal.aborted) {
        try {
          const notification = await receiveNotification(credentials!, signal)
          if (signal.aborted) break
          setLastCheck(Date.now())
          if (notification) {
            const incoming = parseIncomingText(notification.body)
            if (incoming) {
              setReceived((value) => value + 1)
              onIncomingRef.current(incoming)
            } else {
              setIgnored((value) => value + 1)
              const body = notification.body
              const kind = typeof body === 'object' && body !== null && 'typeWebhook' in body
                ? String(body.typeWebhook) : 'неизвестный тип'
              const messageData = typeof body === 'object' && body !== null && 'messageData' in body
                ? body.messageData : null
              const messageKind = typeof messageData === 'object' && messageData !== null && 'typeMessage' in messageData
                ? String(messageData.typeMessage) : ''
              setLastEvent(messageKind ? `${kind} / ${messageKind}` : kind)
            }
            // Подтверждаем уведомление после обработки. Неизвестные типы событий пропускаем.
            await deleteNotification(credentials!, notification.receiptId, signal)
          }
          if (!signal.aborted) setError('')
          await pause(notification ? 500 : 1000, signal)
        } catch (cause) {
          if (signal.aborted) break
          setError(cause instanceof Error ? cause.message : 'Не удалось получить сообщения.')
          await pause(3000, signal)
        }
      }
    }

    void poll()
    return () => controller.abort()
  }, [credentials])

  return { error, lastCheck, received, ignored, lastEvent }
}
