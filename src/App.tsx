import { useEffect, useRef, useState } from 'react'
import { checkWhatsapp, enableIncomingNotifications, getNotificationSettings, getStateInstance, GreenApiHttpError, sendMessage } from './api/greenApi'
import type { Credentials, IncomingText, NotificationSettings } from './api/greenApi'
import { useNotifications } from './hooks/useNotifications'
import { clearSession, readChatView, readSession, saveChatView, saveSession } from './session'

type Chat = { id: string; label: string }
type Message = { id: string; chatId: string; text: string; direction: 'incoming' | 'outgoing'; timestamp: number }
const DEFAULT_API_URL = 'https://api.green-api.com'

const normalizeRecipient = (value: string) => value.replace(/[\s()+-]/g, '')
const validRecipient = (value: string) => /^[1-9]\d{10,15}$/.test(value)
const messageTime = (timestamp: number) => new Date(timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

class InstanceNotAuthorizedError extends Error {}

async function retryRateLimit<T>(request: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request()
    } catch (error) {
      if (!(error instanceof GreenApiHttpError) || error.status !== 429 || attempt >= 2) throw error
      await new Promise((resolve) => window.setTimeout(resolve, 1500 * (attempt + 1)))
    }
  }
}

async function inspectInstance(credentials: Credentials): Promise<{ settings: NotificationSettings | null; settingsError: string }> {
  const state = await retryRateLimit(() => getStateInstance(credentials))
  if (state === 'starting') throw new Error('Инстанс запускается. Подождите несколько минут и попробуйте снова.')
  if (state === 'notAuthorized') throw new InstanceNotAuthorizedError('Инстанс не авторизован в WhatsApp. Подключите аккаунт в личном кабинете GREEN-API.')
  if (state !== 'authorized') throw new Error(`Инстанс недоступен: ${state}. Проверьте его состояние в GREEN-API.`)
  try {
    return { settings: await retryRateLimit(() => getNotificationSettings(credentials)), settingsError: '' }
  } catch (error) {
    return { settings: null, settingsError: error instanceof Error ? error.message : 'Не удалось проверить настройки уведомлений.' }
  }
}

function App() {
  const [savedSession] = useState<Credentials | null>(readSession)
  const [savedChatView] = useState(() => savedSession ? readChatView(savedSession) : null)
  const [apiUrl, setApiUrl] = useState(savedSession?.apiUrl ?? DEFAULT_API_URL)
  const [idInstance, setIdInstance] = useState(savedSession?.idInstance ?? '')
  const [apiTokenInstance, setApiTokenInstance] = useState('')
  const [rememberSession, setRememberSession] = useState(Boolean(savedSession))
  const [restoringSession, setRestoringSession] = useState(Boolean(savedSession))
  const [storageNotice, setStorageNotice] = useState('')
  const [loginError, setLoginError] = useState('')
  const [checkingInstance, setCheckingInstance] = useState(false)
  const [credentials, setCredentials] = useState<Credentials | null>(null)
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings | null>(null)
  const [settingsError, setSettingsError] = useState('')
  const [settingsNotice, setSettingsNotice] = useState('')
  const [enablingNotifications, setEnablingNotifications] = useState(false)
  const [chats, setChats] = useState<Chat[]>(savedChatView?.chats ?? [])
  const [activeChatId, setActiveChatId] = useState<string | null>(savedChatView?.activeChatId ?? null)
  const [messages, setMessages] = useState<Message[]>([])
  const [recipientInput, setRecipientInput] = useState('')
  const [draft, setDraft] = useState('')
  const [chatError, setChatError] = useState('')
  const [sendError, setSendError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [sending, setSending] = useState(false)
  const seenIds = useRef(new Set<string>())
  const session = useRef(0)
  const restorePromise = useRef<Promise<{ settings: NotificationSettings | null; settingsError: string }> | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const messageInputRef = useRef<HTMLTextAreaElement>(null)

  function onIncoming(incoming: IncomingText) {
    setSettingsNotice('')
    if (seenIds.current.has(incoming.id)) return
    seenIds.current.add(incoming.id)
    const chatId = chats.find((chat) => chat.id === incoming.chatId || (incoming.phone && chat.label === incoming.phone))?.id ?? incoming.chatId
    setChats((current) => current.some((chat) => chat.id === chatId)
      ? current : [...current, { id: incoming.chatId, label: incoming.phone ?? incoming.chatId }])
    setMessages((current) => [...current, {
      id: incoming.id, chatId, text: incoming.text,
      direction: 'incoming', timestamp: incoming.timestamp * 1000,
    }])
  }

  const canPoll = !notificationSettings || (notificationSettings.incomingWebhook === 'yes' && !notificationSettings.webhookUrl)
  const { error: pollingError, lastCheck, received, ignored, lastEvent } = useNotifications(canPoll ? credentials : null, onIncoming)
  const activeChat = chats.find((chat) => chat.id === activeChatId)
  const visibleMessages = messages.filter((message) => message.chatId === activeChatId)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [visibleMessages.length, activeChatId])

  useEffect(() => {
    if (credentials && rememberSession) saveChatView(credentials, { chats, activeChatId })
  }, [credentials, rememberSession, chats, activeChatId])

  useEffect(() => {
    if (!savedSession) return
    let cancelled = false
    if (!restorePromise.current) restorePromise.current = inspectInstance(savedSession)
    async function restore() {
      try {
        const inspection = await restorePromise.current!
        if (cancelled) return
        setNotificationSettings(inspection.settings)
        setSettingsError(inspection.settingsError)
        setCredentials(savedSession)
      } catch (error) {
        if (cancelled) return
        if (error instanceof InstanceNotAuthorizedError || (error instanceof GreenApiHttpError && (error.status === 401 || error.status === 403))) {
          clearSession()
          setRememberSession(false)
          setChats([])
          setActiveChatId(null)
          setLoginError(error.message)
        } else {
          setSettingsError(`Не удалось проверить сохранённый вход: ${error instanceof Error ? error.message : 'неизвестная ошибка'}. Вход сохранён; запросы сообщений продолжаются.`)
          setCredentials(savedSession)
        }
      } finally {
        if (!cancelled) setRestoringSession(false)
      }
    }
    void restore()
    return () => { cancelled = true }
  }, [savedSession])

  async function connect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (checkingInstance) return
    const url = (apiUrl.trim() || DEFAULT_API_URL).replace(/\/+$/, '')
    if (!/^https:\/\/[^/?#]+(?::\d+)?$/.test(url)) {
      setLoginError('Укажите корректный HTTPS-адрес API или оставьте поле пустым для универсального адреса.')
      return
    }
    if (!/^\d+$/.test(idInstance.trim()) || !apiTokenInstance.trim()) return
    const nextCredentials = { apiUrl: url, idInstance: idInstance.trim(), apiTokenInstance: apiTokenInstance.trim() }
    setCheckingInstance(true)
    setLoginError('')
    try {
      const inspection = await inspectInstance(nextCredentials)
      setNotificationSettings(inspection.settings)
      setSettingsError(inspection.settingsError)
      if (rememberSession) {
        const saved = saveSession(nextCredentials)
        setStorageNotice(saved ? '' : 'Браузер не разрешил сохранить вход. После обновления потребуется войти снова.')
        if (!saved) setRememberSession(false)
      } else {
        clearSession()
        setStorageNotice('')
      }
      setCredentials(nextCredentials)
      setApiTokenInstance('')
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Не удалось проверить инстанс.')
    } finally {
      setCheckingInstance(false)
    }
  }

  function disconnect() {
    session.current += 1
    clearSession()
    seenIds.current.clear()
    setCredentials(null)
    setRememberSession(false)
    setStorageNotice('')
    setNotificationSettings(null)
    setSettingsError('')
    setSettingsNotice('')
    setEnablingNotifications(false)
    setChats([])
    setMessages([])
    setActiveChatId(null)
    setDraft('')
    setRecipientInput('')
    setChatError('')
    setSendError('')
    setSending(false)
    setConnecting(false)
  }

  async function turnOnIncomingNotifications() {
    if (!credentials || enablingNotifications) return
    setEnablingNotifications(true)
    setSettingsError('')
    const currentSession = session.current
    try {
      await enableIncomingNotifications(credentials)
      if (currentSession !== session.current) return
      setNotificationSettings((current) => current ? { ...current, incomingWebhook: 'yes' } : current)
      setSettingsNotice('Получение ответов включено. Настройка GREEN-API может применяться до 5 минут; новые ответы появятся автоматически.')
    } catch (error) {
      if (currentSession === session.current) setSettingsError(error instanceof Error ? error.message : 'Не удалось включить уведомления.')
    } finally {
      if (currentSession === session.current) setEnablingNotifications(false)
    }
  }

  async function openChat(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!credentials || connecting) return
    const recipient = normalizeRecipient(recipientInput)
    if (!validRecipient(recipient)) {
      setChatError('Введите номер WhatsApp в международном формате: от 11 до 16 цифр, без плюса.')
      return
    }
    const existing = chats.find((chat) => chat.label === recipient)
    if (existing) {
      setActiveChatId(existing.id)
      setChatError('')
      return
    }
    setConnecting(true)
    setChatError('')
    const currentSession = session.current
    try {
      const chatId = await checkWhatsapp(credentials, recipient)
      if (currentSession !== session.current) return
      setChats((current) => current.some((chat) => chat.id === chatId) ? current : [...current, { id: chatId, label: recipient }])
      setActiveChatId(chatId)
      setRecipientInput('')
    } catch (error) {
      if (currentSession === session.current) setChatError(error instanceof Error ? error.message : 'Не удалось создать чат.')
    } finally {
      if (currentSession === session.current) setConnecting(false)
    }
  }

  async function submitMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = draft.trim()
    if (!credentials || !activeChatId || sending || !text) return
    messageInputRef.current?.focus()
    if (text.length > 20000) {
      setSendError('Сообщение не должно быть длиннее 20000 символов.')
      return
    }
    setSending(true)
    setSendError('')
    const currentSession = session.current
    const chatId = activeChatId
    try {
      const id = await sendMessage(credentials, chatId, text)
      if (currentSession !== session.current) return
      if (!seenIds.current.has(id)) {
        seenIds.current.add(id)
        setMessages((current) => [...current, { id, chatId, text, direction: 'outgoing', timestamp: Date.now() }])
      }
      setDraft((current) => current === draft ? '' : current)
    } catch (error) {
      if (currentSession === session.current) setSendError(error instanceof Error ? error.message : 'Не удалось отправить сообщение.')
    } finally {
      if (currentSession === session.current) setSending(false)
    }
  }

  if (restoringSession) return <main className="login-page"><section className="login-card" role="status">Проверяем сохранённый вход…</section></main>

  if (!credentials) return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand-mark">W</div>
        <p className="eyebrow">GREEN-API · WHATSAPP</p>
        <h1 id="login-title">Текстовый чат</h1>
        <p className="muted">Подключите свой инстанс GREEN-API WhatsApp, чтобы отправлять и получать текстовые сообщения.</p>
        <form onSubmit={connect} className="stack">
          <label>idInstance<input inputMode="numeric" pattern="[0-9]+" required value={idInstance} onChange={(event) => setIdInstance(event.target.value)} placeholder="Номер инстанса" autoComplete="off" /></label>
          <label>apiTokenInstance<input type="password" required value={apiTokenInstance} onChange={(event) => setApiTokenInstance(event.target.value)} placeholder="Токен инстанса" autoComplete="off" /></label>
          <details className="api-settings"><summary>Дополнительно: адрес API</summary><label>apiUrl <span className="hint">адрес из карточки инстанса</span><input type="text" value={apiUrl} onChange={(event) => setApiUrl(event.target.value)} autoComplete="off" /></label><p>По умолчанию используется универсальный адрес. Адрес вашего инстанса может работать быстрее.</p></details>
          <label className="remember-session"><input type="checkbox" checked={rememberSession} onChange={(event) => setRememberSession(event.target.checked)} />Запомнить вход до закрытия вкладки</label>
          {loginError && <p className="error" role="alert">{loginError}</p>}
          <button className="primary" type="submit" disabled={checkingInstance}>{checkingInstance ? 'Проверяем инстанс…' : <>Продолжить <span aria-hidden="true">→</span></>}</button>
        </form>
        <p className="footnote">При запоминании токен сохраняется в хранилище этой вкладки. «Выйти» удаляет его.</p>
      </section>
    </main>
  )

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Чаты">
        <header className="sidebar-header"><div className="brand-mark small">W</div><div><strong>WhatsApp чат</strong><span>GREEN-API</span></div><button className="text-button" onClick={disconnect} type="button">Выйти</button></header>
        <div className="sidebar-content">
          <h2>Новый чат</h2>
          <form onSubmit={openChat} className="phone-form">
            <label htmlFor="recipient">Номер WhatsApp</label>
            <input id="recipient" type="tel" value={recipientInput} onChange={(event) => setRecipientInput(event.target.value)} placeholder="79991234567" autoComplete="off" />
            <button type="submit" disabled={connecting}>{connecting ? 'Проверяем…' : 'Открыть чат'}</button>
          </form>
          {chatError && <p className="error" role="alert">{chatError}</p>}
          <p className="section-caption">ЧАТЫ <span>{chats.length}</span></p>
          {chats.length === 0 && <p className="sidebar-empty">Здесь появятся ваши чаты.</p>}
          <nav aria-label="Список чатов" className="chat-list">
            {chats.map((chat) => <button key={chat.id} type="button" className={`chat-item ${chat.id === activeChatId ? 'selected' : ''}`} onClick={() => { setActiveChatId(chat.id); setSendError('') }}><span className="avatar">{chat.label.slice(-2)}</span><span className="chat-title"><strong>{chat.label}</strong><small>Личный чат</small></span></button>)}
          </nav>
        </div>
        <p className="sidebar-footer">Получение: {canPoll ? lastCheck ? `проверено в ${messageTime(lastCheck)}` : 'ожидание ответа API' : 'не настроено'}<br />Событий с текстом: {received}; пропущено: {ignored}{lastEvent && <><br />Последний тип: {lastEvent}</>}</p>
      </aside>
      <section className="conversation" aria-label="Переписка">
        {notificationSettings?.incomingWebhook !== 'yes' && notificationSettings && <div className="polling-error" role="status">Входящие ответы пока не поступают: в инстансе выключен incomingWebhook. <button type="button" onClick={turnOnIncomingNotifications} disabled={enablingNotifications}>{enablingNotifications ? 'Включаем…' : 'Включить получение ответов'}</button></div>}
        {notificationSettings?.webhookUrl && <div className="polling-error" role="status">В инстансе задан webhookUrl. Для получения ответов через это приложение очистите его в кабинете GREEN-API.</div>}
        {settingsError && <div className="polling-error" role="status">{settingsError}</div>}
        {storageNotice && <div className="polling-error" role="status">{storageNotice}</div>}
        {settingsNotice && <div className="polling-error" role="status">{settingsNotice}</div>}
        {activeChat ? <>
          <header className="conversation-header"><span className="avatar">{activeChat.label.slice(-2)}</span><div><h2>{activeChat.label}</h2><p>Чат в WhatsApp</p></div></header>
          {pollingError && <div className="polling-error" role="status">Ошибка получения: {pollingError} Повторяем запрос…</div>}
          <div className="message-area" role="log" aria-label="Сообщения">
            {visibleMessages.length === 0 && <div className="empty-conversation"><div className="empty-icon">✉</div><h3>Сообщений пока нет</h3><p>Отправьте текст получателю {activeChat.label}. Старая переписка здесь не загружается.</p></div>}
            <div className="messages">{visibleMessages.map((message) => <article key={message.id} className={`message ${message.direction}`}><p>{message.text}</p><time dateTime={new Date(message.timestamp).toISOString()}>{messageTime(message.timestamp)}</time></article>)}</div>
            <div ref={endRef} />
          </div>
          <div className="composer-wrap">
            {sendError && <p className="error" role="alert">{sendError}</p>}
            <form className="composer" onSubmit={submitMessage}>
              <label className="sr-only" htmlFor="message">Сообщение</label>
              <textarea
                ref={messageInputRef}
                id="message"
                rows={1}
                maxLength={20000}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
                placeholder="Напишите сообщение…"
              />
              <button className="send-button" type="submit" disabled={sending || !draft.trim()} aria-label="Отправить сообщение">{sending ? '…' : '➤'}</button>
            </form>
            <p className="composer-hint">Enter — отправить · Shift+Enter — новая строка</p>
          </div>
        </> : <div className="no-chat"><div className="empty-icon">✉</div><h2>Выберите чат</h2><p>Введите номер WhatsApp слева, чтобы начать переписку.</p>{pollingError && <p className="error" role="status">Ошибка получения: {pollingError} Повторяем запрос…</p>}</div>}
      </section>
    </main>
  )
}

export default App
