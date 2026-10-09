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

test('lists only the sessions the ownership-filtered proxy returned', async () => {
  const calls = [];
  const client = createDesignAgentConversationClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ sessions: [{ id: 'session-1', name: 'Launch' }, { id: '' }, { name: 'no id' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const sessions = await client.listSessions();
  assert.equal(calls[0].url, '/api/v1/creative-agent/sessions');
  assert.equal(calls[0].options.method, 'GET');
  assert.deepEqual(sessions, [{ id: 'session-1', name: 'Launch' }]);
});

test('rename patches the session name through the ownership-checked proxy', async () => {
  const calls = [];
  const client = createDesignAgentConversationClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  assert.equal(await client.renameSession('session-1', '  Campaign recap  '), 'Campaign recap');
  assert.equal(calls[0].url, '/api/v1/creative-agent/sessions/session-1');
  assert.equal(calls[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].options.body), { name: 'Campaign recap' });
});

test('rename and delete reject a blank id or name before issuing any request', async () => {
  let requests = 0;
  const client = createDesignAgentConversationClient({
    fetchImpl: async () => {
      requests += 1;
      return new Response('{}', { status: 200 });
    },
  });

  await assert.rejects(() => client.renameSession('', 'name'), (error) => error.code === 'session_id_required');
  await assert.rejects(() => client.renameSession('session-1', '   '), (error) => error.code === 'session_name_required');
  await assert.rejects(() => client.deleteSession(''), (error) => error.code === 'session_id_required');
  assert.equal(requests, 0);
});

test('delete issues exactly one session DELETE and never touches session assets', async () => {
  const calls = [];
  const client = createDesignAgentConversationClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response('{}', { status: 200 });
    },
  });

  assert.equal(await client.deleteSession('session-1'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/creative-agent/sessions/session-1');
  assert.equal(calls[0].options.method, 'DELETE');
  assert.equal(calls[0].options.body, undefined);
  assert.ok(!calls[0].url.includes('/assets'));
});

test('a session the proxy cannot verify surfaces as session_unavailable', async () => {
  const client = createDesignAgentConversationClient({
    fetchImpl: async () => new Response(JSON.stringify({ error: 'design_session_ownership_unverified' }), { status: 403 }),
  });

  await assert.rejects(
    () => client.renameSession('someone-elses', 'Mine'),
    (error) => error.code === 'session_unavailable' && error.status === 403,
  );
  await assert.rejects(
    () => client.deleteSession('someone-elses'),
    (error) => error.code === 'session_unavailable' && error.status === 403,
  );
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
