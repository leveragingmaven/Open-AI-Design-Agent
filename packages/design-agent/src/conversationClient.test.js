import assert from 'node:assert/strict';
import test from 'node:test';
import { createDesignAgentConversationClient } from './conversationClient.js';

function streamResponse(payload) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', reply: 'I see the avatar.', persistedMessages: payload.persistedMessages || [] })}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('sends trusted selected attachment IDs alongside the existing conversation fields', async () => {
  const calls = [];
  const client = createDesignAgentConversationClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return streamResponse({});
    },
  });

  await client.send({
    conversationId: 'session-1',
    message: 'Use this avatar to create a video.',
    attachments: ['asset_7'],
  });

  assert.equal(calls[0].url, '/api/design-agent/conversation');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    conversationId: 'session-1',
    message: 'Use this avatar to create a video.',
    attachments: ['asset_7'],
  });
});

test('sends an empty attachment list for text-only conversations', async () => {
  let body;
  const client = createDesignAgentConversationClient({
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return streamResponse({});
    },
  });

  await client.send({ conversationId: 'session-2', message: 'Hello Maven.' });
  assert.deepEqual(body, { conversationId: 'session-2', message: 'Hello Maven.', attachments: [] });
});
