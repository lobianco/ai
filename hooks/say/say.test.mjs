import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createServer, request, handleHook } from './say.mjs';

test('remember and read only the requested conversation, preserving literal text', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'say-'));
  const address = path.join(temporary, 's.sock');
  const played = [];
  const server = createServer(text => played.push(text));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, resolve);
  });
  const send = message => request(message, address);
  try {
    const text = 'Quotes: "hello", it\'s 100%. Literal: $(touch /never-run), `date`, $HOME.\nSecond line.';
    await handleHook({ hook_event_name: 'Stop', session_id: 'a', last_assistant_message: 'old' }, send);
    await handleHook({ hook_event_name: 'Stop', session_id: 'b', last_assistant_message: 'other chat' }, send);
    await handleHook({ hook_event_name: 'Stop', session_id: 'a', last_assistant_message: text }, send);
    assert.deepEqual(await handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'a', prompt: '$say' }, send),
      { continue: false, stopReason: 'Reading aloud.' });
    assert.deepEqual(played, [text]);
    await handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'b', prompt: ' $say\n' }, send);
    assert.deepEqual(played, [text, 'other chat']);
    const missing = await handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'missing', prompt: '$say' }, send);
    assert.equal(missing.continue, false);
    assert.match(missing.stopReason, /No response saved/);
    assert.equal(played.length, 2);
    await assert.rejects(send({ action: 'say' }), /Missing conversation ID/);
    await assert.rejects(send({ action: 'remember', session: 'a', text: ' ' }), /No response text/);
    await assert.rejects(send({ action: 'unknown', session: 'a' }), /Unknown speech request/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('ordinary prompts never contact the speech service', async () => {
  const forbidden = () => { throw new Error('must not contact helper'); };
  for (const prompt of ['hello', 'Please change $say', '$say extra', '']) {
    assert.deepEqual(await handleHook({ hook_event_name: 'UserPromptSubmit', prompt }, forbidden), {});
  }
});

test('service failure still stops the prompt before model inference', async () => {
  const result = await handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'a', prompt: '$say' },
    () => Promise.reject(new Error('connection refused')));
  assert.equal(result.continue, false);
  assert.match(result.stopReason, /connection refused/);
});

test('empty completion does not erase the last response', async () => {
  assert.deepEqual(await handleHook({ hook_event_name: 'Stop', session_id: 'a', last_assistant_message: '' },
    () => { throw new Error('must not erase response'); }), {});
});

test('socket replies preserve split Unicode and propagate protocol and connection failures', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'say-'));
  const address = path.join(temporary, 's.sock');
  const reply = { ok: true, text: 'Hello, 世界 🌍' };
  const bytes = Buffer.from(JSON.stringify(reply));
  const split = bytes.indexOf(Buffer.from('🌍')) + 1;
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', chunk => {
      const { action } = JSON.parse(chunk);
      if (action === 'malformed') socket.end('invalid JSON');
      if (action === 'fragmented') {
        socket.write(bytes.subarray(0, split));
        setImmediate(() => socket.end(bytes.subarray(split)));
      }
      // Leave timeout requests unanswered to exercise the client's deadline.
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, resolve);
    });
    assert.deepEqual(await request({ action: 'fragmented' }, address), reply);
    await assert.rejects(request({ action: 'malformed' }, address), SyntaxError);
    await assert.rejects(request({ action: 'timeout' }, address), /Local speech helper timed out/);
    await assert.rejects(request({}, path.join(temporary, 'missing.sock')), { code: 'ENOENT' });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
