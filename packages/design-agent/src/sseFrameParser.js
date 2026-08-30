/**
 * Minimal, defensive SSE frame parser for consuming the controlled Design
 * Agent conversation stream in the browser.
 *
 * Guarantees:
 * - Handles frames split across network reads (stateful buffer).
 * - Handles multiple frames arriving in a single read.
 * - Handles CRLF ("\r\n\r\n") as well as LF ("\n\n") frame separators,
 *   including separators split across reads.
 * - flush() processes a final unterminated "data:" frame left in the buffer
 *   when the connection closes without a trailing blank line, and clears all
 *   buffered state.
 * - Malformed or non-JSON payloads are skipped silently; callers never see
 *   raw provider metadata because the server only emits app-derived events.
 */
export function createSseFrameParser() {
  let buffer = '';

  function extractEvents(frame) {
    const events = [];
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        events.push(JSON.parse(payload));
      } catch {
        // Malformed frame: skip safely without surfacing provider data.
      }
    }
    return events;
  }

  return {
    push(chunk) {
      if (typeof chunk !== 'string' || !chunk) return [];
      buffer += chunk;
      const events = [];
      const separator = /(?:\r\n\r\n|\n\n)/;
      let match;
      while ((match = separator.exec(buffer)) !== null) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        events.push(...extractEvents(frame));
      }
      return events;
    },
    flush() {
      const events = extractEvents(buffer);
      buffer = '';
      return events;
    },
  };
}
