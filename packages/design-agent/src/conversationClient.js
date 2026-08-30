import { createSseFrameParser } from './sseFrameParser.js';

export const MAVEN_DASHBOARD_SESSION_STORAGE_KEY = 'mavensync_dashboard_maven_session';
export const DEFAULT_API_BASE = '/api/v1/creative-agent';
export const DEFAULT_CONVERSATION_ENDPOINT = '/api/design-agent/conversation';
export const DEFAULT_CONFIG_ENDPOINT = '/api/design-agent/config';

function conversationError(message, code = 'conversation_failed', status) {
  const error = new Error(message);
  error.code = code;
  if (status != null) error.status = status;
  return error;
}

/**
 * Shared Design Agent conversation client used by both the existing
 * CreativeCanvas surface and the Creator OS Dashboard Maven conversation.
 *
 * Encapsulates ONLY the existing controlled conversation mechanics:
 * - owned session creation/selection
 * - loading/restoring conversation history
 * - POST /api/design-agent/conversation with the existing body shape
 * - consuming the existing SSE stream with the existing createSseFrameParser
 * - streaming delta updates
 * - done handling
 * - typed error handling
 * - persisting ONLY server-sanitized persistedMessages
 *
 * The SSE contract, parser, and server endpoint are unchanged. Callers own
 * optimistic UI state; this module owns the wire behavior.
 */
export function createDesignAgentConversationClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiBase = DEFAULT_API_BASE,
  conversationEndpoint = DEFAULT_CONVERSATION_ENDPOINT,
  configEndpoint = DEFAULT_CONFIG_ENDPOINT,
} = {}) {
  async function createSession(headers = {}) {
    const response = await fetchImpl(`${apiBase}/sessions`, {
      method: 'POST',
      headers: { ...headers },
    });
    if (!response.ok) {
      throw conversationError('Failed to establish session', 'session_creation_failed', response.status);
    }
    const data = await response.json().catch(() => null);
    if (!data || typeof data.id !== 'string' || !data.id) {
      throw new Error('Failed to establish session');
    }
    return data.id;
  }

  async function loadMessages(sessionId, headers = {}) {
    const response = await fetchImpl(`${apiBase}/sessions/${sessionId}/messages`, {
      method: 'GET',
      headers: { ...headers },
    });
    if (!response.ok) {
      throw conversationError(
        'Unable to load conversation history.',
        response.status === 404 || response.status === 403 ? 'session_unavailable' : 'history_unavailable',
        response.status,
      );
    }
    const data = await response.json().catch(() => null);
    return Array.isArray(data) ? data : [];
  }

  async function send({ conversationId, message, headers = {}, onDelta } = {}) {
    const response = await fetchImpl(conversationEndpoint, {
      method: 'POST',
      headers: { ...headers, Accept: 'text/event-stream' },
      body: JSON.stringify({ conversationId, message }),
    });

    if (!response.ok || !response.body) {
      let safeError = 'Unable to continue this conversation right now.';
      let code = 'conversation_failed';
      try {
        const errorBody = await response.json();
        if (errorBody?.error && typeof errorBody.error === 'string') {
          safeError = errorBody.error;
        }
        if (errorBody?.code && typeof errorBody.code === 'string') code = errorBody.code;
      } catch {
        // Keep the generic safe message when the error body is not parseable.
      }
      throw conversationError(safeError, code, response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseFrameParser();
    let donePayload = null;

    const handleEvent = (event) => {
      if (event?.type === 'delta' && typeof event.text === 'string' && event.text) {
        if (typeof onDelta === 'function') onDelta(event.text);
      } else if (event?.type === 'done') {
        donePayload = event;
      } else if (event?.type === 'error') {
        throw conversationError(
          typeof event.error === 'string' && event.error
            ? event.error
            : 'Conversation failed.',
          typeof event.code === 'string' && event.code ? event.code : 'conversation_failed',
        );
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true })).forEach(handleEvent);
      }
      // Flush any bytes the decoder still holds, then process a final frame
      // that arrived without its trailing blank line before the connection
      // closed. Without this, a completed conversation could surface as
      // "Conversation ended without a final response."
      parser.push(decoder.decode()).forEach(handleEvent);
      parser.flush().forEach(handleEvent);
    } finally {
      try {
        reader.cancel();
      } catch {
        // Ignore cancellation errors.
      }
    }

    if (!donePayload) {
      throw new Error('Conversation ended without a final response.');
    }

    return {
      reply: typeof donePayload.reply === 'string' ? donePayload.reply : '',
      persistedMessages: Array.isArray(donePayload.persistedMessages)
        ? donePayload.persistedMessages
        : [],
    };
  }

  async function persist(sessionId, messages, headers = {}) {
    return fetchImpl(`${apiBase}/sessions/${sessionId}/messages`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: Array.isArray(messages) ? messages : [] }),
    });
  }

  async function fetchControlledExecutionFlag() {
    try {
      const response = await fetchImpl(configEndpoint);
      if (!response.ok) return false;
      const data = await response.json().catch(() => null);
      return Boolean(data?.controlledExecution);
    } catch {
      return false;
    }
  }

  return {
    createSession,
    loadMessages,
    send,
    persist,
    fetchControlledExecutionFlag,
  };
}

export function readStoredDashboardSessionId(storage) {
  try {
    const value = storage?.getItem?.(MAVEN_DASHBOARD_SESSION_STORAGE_KEY);
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function storeDashboardSessionId(storage, sessionId) {
  try {
    if (typeof sessionId === 'string' && sessionId.trim()) {
      storage?.setItem?.(MAVEN_DASHBOARD_SESSION_STORAGE_KEY, sessionId.trim());
    }
  } catch {
    // Storage can be unavailable (e.g. privacy modes); the session still works
    // for the current visit and will be created again on the next one.
  }
}

export function clearStoredDashboardSessionId(storage) {
  try {
    storage?.removeItem?.(MAVEN_DASHBOARD_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage failures; the conversation still continues in memory.
  }
}
