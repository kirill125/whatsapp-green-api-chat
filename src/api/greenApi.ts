export type Credentials = {
  apiUrl: string
  idInstance: string
  apiTokenInstance: string
}

export type Notification = {
  receiptId: number
  body: unknown
}

export class GreenApiHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'GreenApiHttpError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function apiErrorDetail(data: unknown): string {
  if (!isRecord(data)) return ''
  // GREEN-API может вернуть ошибку в разных полях. Не показываем `path`:
  // в URL запроса содержится apiTokenInstance, который может попасть в это поле.
  for (const field of ['message', 'reason', 'error']) {
    const value = data[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function endpoint(credentials: Credentials, method: string): string {
  const base = credentials.apiUrl.replace(/\/+$/, '')
  return `${base}/waInstance${encodeURIComponent(credentials.idInstance)}/${method}/${encodeURIComponent(credentials.apiTokenInstance)}`
}

async function request(url: string, init: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) throw error
    throw new Error('Не удалось связаться с GREEN-API. Проверьте сеть и доступность API из браузера.')
  }

  const raw = await response.text()
  let data: unknown = null
  if (raw) {
    try {
      data = JSON.parse(raw)
    } catch {
      if (response.ok) throw new Error(`GREEN-API вернул некорректный ответ (HTTP ${response.status}).`)
    }
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new GreenApiHttpError(response.status, 'Проверьте apiUrl, idInstance и apiTokenInstance в личном кабинете GREEN-API.')
    }
    const detail = apiErrorDetail(data)
    const hint = response.status === 400 && !detail
      ? ' Проверьте данные получателя и состояние инстанса в личном кабинете.' : ''
    throw new GreenApiHttpError(response.status, `Ошибка GREEN-API (HTTP ${response.status})${detail ? `: ${detail}` : '.'}${hint}`)
  }
  return data
}

export async function checkWhatsapp(credentials: Credentials, recipient: string, signal?: AbortSignal): Promise<string> {
  const data = await request(endpoint(credentials, 'checkWhatsapp'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: `${recipient}@c.us` }),
    signal,
  })
  if (isRecord(data) && data.existsWhatsapp === true && typeof data.chatId === 'string' && data.chatId) return data.chatId
  if (isRecord(data) && data.existsWhatsapp === false) throw new Error('На этом номере WhatsApp не найден.')
  if (isRecord(data) && data.status === false) {
    const reason = apiErrorDetail(data) || (isRecord(data.data) ? apiErrorDetail(data.data) : '')
    throw new Error(`Не удалось проверить получателя: ${reason || 'инстанс недоступен'}.`)
  }
  throw new Error('GREEN-API вернул неожиданный ответ при проверке получателя.')
}

export async function getStateInstance(credentials: Credentials): Promise<string> {
  const data = await request(endpoint(credentials, 'getStateInstance'), { method: 'GET' })
  if (isRecord(data) && typeof data.stateInstance === 'string') return data.stateInstance
  throw new Error('GREEN-API вернул неожиданный ответ о состоянии инстанса.')
}

export type NotificationSettings = { incomingWebhook: string; webhookUrl: string }

export async function getNotificationSettings(credentials: Credentials): Promise<NotificationSettings> {
  const data = await request(endpoint(credentials, 'getSettings'), { method: 'GET' })
  if (!isRecord(data) || typeof data.incomingWebhook !== 'string' || typeof data.webhookUrl !== 'string') {
    throw new Error('GREEN-API вернул неожиданный ответ о настройках уведомлений.')
  }
  return { incomingWebhook: data.incomingWebhook, webhookUrl: data.webhookUrl }
}

export async function enableIncomingNotifications(credentials: Credentials): Promise<void> {
  const data = await request(endpoint(credentials, 'setSettings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ incomingWebhook: 'yes' }),
  })
  if (!isRecord(data) || data.saveSettings !== true) {
    throw new Error('GREEN-API не подтвердил сохранение настройки входящих сообщений.')
  }
}

export async function sendMessage(credentials: Credentials, chatId: string, message: string): Promise<string> {
  const data = await request(endpoint(credentials, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, message }),
  })
  if (isRecord(data) && typeof data.idMessage === 'string' && data.idMessage) return data.idMessage
  throw new Error('GREEN-API не подтвердил постановку сообщения в очередь.')
}

export async function receiveNotification(credentials: Credentials, signal: AbortSignal): Promise<Notification | null> {
  const data = await request(`${endpoint(credentials, 'receiveNotification')}?receiveTimeout=5`, { method: 'GET', signal })
  if (data === null) return null
  if (isRecord(data) && Number.isSafeInteger(data.receiptId) && data.body !== undefined) {
    return { receiptId: data.receiptId as number, body: data.body }
  }
  throw new Error('GREEN-API вернул уведомление в неожиданном формате.')
}

export async function deleteNotification(credentials: Credentials, receiptId: number, signal: AbortSignal): Promise<void> {
  const data = await request(`${endpoint(credentials, 'deleteNotification')}/${receiptId}`, { method: 'DELETE', signal })
  if (!isRecord(data) || data.result !== true) throw new Error('Не удалось подтвердить обработку уведомления.')
}

export type IncomingText = { id: string; chatId: string; text: string; timestamp: number; phone?: string }

export function parseIncomingText(body: unknown): IncomingText | null {
  if (!isRecord(body) || body.typeWebhook !== 'incomingMessageReceived') return null
  const messageData = body.messageData
  if (!isRecord(messageData) || !['textMessage', 'extendedTextMessage', 'quotedMessage'].includes(String(messageData.typeMessage))) return null
  const senderData = body.senderData
  const textData = messageData.typeMessage === 'textMessage' ? messageData.textMessageData : messageData.extendedTextMessageData
  if (!isRecord(senderData)) return null
  if (typeof senderData.chatId === 'string' && !/@(?:c\.us|lid|id)$/.test(senderData.chatId)) return null
  const text = isRecord(textData)
    ? messageData.typeMessage === 'textMessage' ? textData.textMessage : textData.text
    : undefined
  if (messageData.typeMessage === 'quotedMessage' && text === undefined) return null
  if (!isRecord(textData) ||
      typeof senderData.chatId !== 'string' || !senderData.chatId ||
      typeof body.idMessage !== 'string' || !body.idMessage ||
      typeof text !== 'string' || !Number.isFinite(body.timestamp)) {
    throw new Error('Входящее текстовое уведомление содержит неполные данные.')
  }
  return {
    id: body.idMessage,
    chatId: senderData.chatId,
    text,
    timestamp: body.timestamp as number,
    phone: typeof senderData.chatId === 'string' && senderData.chatId.endsWith('@c.us')
      ? senderData.chatId.slice(0, -5)
      : typeof senderData.sender === 'string' && senderData.sender.endsWith('@c.us')
        ? senderData.sender.slice(0, -5) : undefined,
  }
}
