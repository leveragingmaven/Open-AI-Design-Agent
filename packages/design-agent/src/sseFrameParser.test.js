import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseFrameParser } from './sseFrameParser.js';

function collect(chunks) {
  const parser = createSseFrameParser();
  const events = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  events.push(...parser.flush());
  return events;
}

test('parses frames split across network reads', () => {
  const events = collect([
    'data: {"type":"delta","te',
    'xt":"Hel"}\n\ndata: {"type":"delta","text":"lo"}',
    '\n\ndata: {"type":"done","reply":"Hello"}\n\n',
  ]);
  assert.deepEqual(events.map((e) => e.type), ['delta', 'delta', 'done']);
  assert.equal(events[2].reply, 'Hello');
});

test('parses multiple frames arriving in a single read', () => {
  const events = collect([
    'data: {"type":"delta","text":"a"}\n\ndata: {"type":"delta","text":"b"}\n\ndata: {"type":"done","reply":"ab"}\n\n',
  ]);
  assert.equal(events.length, 3);
  assert.equal(events[2].reply, 'ab');
});

test('flush processes a final frame without a trailing blank line', () => {
  // Connection closed right after the final frame, before its trailing CRLF
  // was delivered. Without flush() the done event would be lost.
  const parser = createSseFrameParser();
  let events = parser.push('data: {"type":"delta","text":"Hi"}\n\n');
  assert.equal(events.length, 1);
  events = parser.push('data: {"type":"done","reply":"Hi"}\n\n'.replace(/\n+$/, ''));
  assert.equal(events.length, 0, 'unterminated frame waits in the buffer');
  events = parser.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'done');
});

test('handles CRLF frame separators including ones split across reads', () => {
  const events = collect([
    'data: {"type":"delta","text":"x"}\r\n\r\ndata: {"type":"do',
    'ne","reply":"x"}\r\n',
    '\r\n',
  ]);
  assert.deepEqual(events.map((e) => e.type), ['delta', 'done']);
});

test('final decoder bytes and residual buffer are flushed together', () => {
  const parser = createSseFrameParser();
  assert.deepEqual(parser.push('data: {"type":"delta","text":"ok"}\n\n'), [
    { type: 'delta', text: 'ok' },
  ]);
  assert.deepEqual(parser.push('da'), []);
  assert.deepEqual(parser.push('ta: {"type":"done","reply":"ok"}'), []);
  const finalEvents = [...parser.push(''), ...parser.flush()];
  assert.deepEqual(finalEvents.map((e) => e.type), ['done']);
});

test('malformed chunks are skipped without leaking provider data', () => {
  const events = collect([
    ': keep-alive\n\n',
    'event: ping\n\n',
    'data: not-json {"model":"secret-model"}\n\n',
    'data: [DONE]\n\n',
    'data: {"type":"done","reply":"ok"}\n\n',
  ]);
  assert.deepEqual(events, [{ type: 'done', reply: 'ok' }]);
  assert.equal(JSON.stringify(events).includes('secret-model'), false);
});

test('flush is idempotent and resets state', () => {
  const parser = createSseFrameParser();
  parser.push('data: {"type":"done","reply":"once"}');
  assert.equal(parser.flush().length, 1);
  assert.deepEqual(parser.flush(), []);
});
