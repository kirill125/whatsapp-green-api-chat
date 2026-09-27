import type { Credentials } from './api/greenApi'

const STORAGE_KEY = 'green-api-whatsapp-session'
const CHATS_KEY = 'green-api-whatsapp-chats'

export type SavedChat = { id: string; label: string }
export type SavedChatView = { chats: SavedChat[]; activeChatId: string | null }

export function readSession(): Credentials | null {
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY)
    if (!saved) return null
    const value: unknown = JSON.parse(saved)
    if (typeof value !== 'object' || value === null) {
      clearSession()
      return null
    }
    const credentials = value as Record<string, unknown>
    if (typeof credentials.apiUrl !== 'string' || !/^https:\/\/[^/?#]+$/.test(credentials.apiUrl) ||
        typeof credentials.idInstance !== 'string' || !/^\d+$/.test(credentials.idInstance) ||
        typeof credentials.apiTokenInstance !== 'string' || !credentials.apiTokenInstance) {
      clearSession()
      return null
    }
    return credentials as Credentials
  } catch {
    clearSession()
    return null
  }
}

export function saveSession(credentials: Credentials): boolean {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(credentials))
    return true
  } catch {
    clearSession()
    return false
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
    sessionStorage.removeItem(CHATS_KEY)
  } catch {
    // Хранилище может быть недоступно в приватном режиме или при ограничениях браузера.
  }
}

export function readChatView(credentials: Credentials): SavedChatView | null {
  try {
    const saved = sessionStorage.getItem(CHATS_KEY)
    if (!saved) return null
    const value: unknown = JSON.parse(saved)
    if (typeof value !== 'object' || value === null) return null
    const view = value as Record<string, unknown>
    if (view.apiUrl !== credentials.apiUrl || view.idInstance !== credentials.idInstance || !Array.isArray(view.chats)) return null
    const chats = view.chats.filter((chat): chat is SavedChat =>
      typeof chat === 'object' && chat !== null &&
      typeof chat.id === 'string' && chat.id.length > 0 &&
      typeof chat.label === 'string' && chat.label.length > 0)
    const activeChatId = typeof view.activeChatId === 'string' && chats.some((chat) => chat.id === view.activeChatId)
      ? view.activeChatId : null
    return { chats, activeChatId }
  } catch {
    return null
  }
}

export function saveChatView(credentials: Credentials, view: SavedChatView): void {
  try {
    sessionStorage.setItem(CHATS_KEY, JSON.stringify({
      apiUrl: credentials.apiUrl,
      idInstance: credentials.idInstance,
      ...view,
    }))
  } catch {
    // Если хранилище недоступно, текущая вкладка продолжает работать.
  }
}
