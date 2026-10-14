import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { json } from 'node:stream/consumers';
import { setTimeout as delay } from 'node:timers/promises';

const directory = import.meta.dirname;
const socketPath = path.join(directory, 'say.sock');
let playback;

function stopPlayback() {
  // Stop the previous reader before starting another one, including its pipeline.
  if (playback) {
    try { process.kill(-playback.pid, 'SIGTERM'); } catch {}
  }
}

function play(text) {
  stopPlayback();
  const child = spawn('/bin/bash', [path.join(directory, 'speak.sh')], {
    detached: true,
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  playback = child;
  child.stdin.on('error', error => console.error(`Playback input: ${error.code}`));
  child.on('error', error => console.error(`Playback failed: ${error.message}`));
  child.on('exit', code => {
    if (playback === child) playback = undefined;
    if (code) console.error(`Playback exited with status ${code}`);
  });
  child.stdin.end(text);
}

export function createServer(playText = play) {
  const responses = new Map();
  return net.createServer(socket => {
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('error', () => {});
    let input = '';
    socket.on('data', chunk => {
      input += chunk;
      if (!input.includes('\n')) return;
      try {
        const message = JSON.parse(input.slice(0, input.indexOf('\n')));
        input = '';
        if (typeof message.session !== 'string' || !message.session) {
          throw new Error('Missing conversation ID.');
        }
        if (message.action === 'remember') {
          if (typeof message.text !== 'string' || !message.text.trim()) {
            throw new Error('No response text to remember.');
          }
          responses.set(message.session, message.text);
        } else if (message.action === 'say') {
          const text = responses.get(message.session);
          if (!text) throw new Error('No response saved for this conversation yet. Ask Codex for a response, then use $say.');
          playText(text);
        } else {
          throw new Error('Unknown speech request.');
        }
        socket.end(JSON.stringify({ ok: true }) + '\n');
      } catch (error) {
        socket.end(JSON.stringify({ error: error.message }) + '\n');
      }
    });
  });
}

export async function request(message, address = socketPath) {
  const socket = net.createConnection(address);
  socket.setTimeout(2000, () => socket.destroy(new Error('Local speech helper timed out.')));
  socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'));
  const reply = await json(socket);
  if (reply.error) throw new Error(reply.error);
  return reply;
}

async function remember(message) {
  for (let attempt = 0; attempt <= 10; attempt++) {
    if (attempt) await delay(50);
    try { return await request(message); } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
    }
    if (attempt === 0) {
      // Start after login without requiring ~/Library/LaunchAgents to be writable.
      spawnSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`,
        path.join(directory, 'local.codex.say.plist')], { stdio: 'ignore', timeout: 1000 });
    }
  }
  throw new Error('Local speech helper did not start.');
}

export async function handleHook(event, send = request) {
  if (event.hook_event_name === 'UserPromptSubmit') {
    if (typeof event.prompt !== 'string' || event.prompt.trim() !== '$say') return {};
    try {
      await send({ action: 'say', session: event.session_id });
      return { continue: false, stopReason: 'Reading aloud.' };
    } catch (error) {
      // A failed local command must not fall through to a model turn.
      return { continue: false, stopReason: `Say: ${error.message}` };
    }
  }
  if (event.hook_event_name === 'Stop' && event.last_assistant_message?.trim()) {
    try {
      const save = send === request ? remember : send;
      await save({ action: 'remember', session: event.session_id, text: event.last_assistant_message });
    } catch (error) {
      return { systemMessage: `Say could not remember this response: ${error.message}` };
    }
  }
  return {};
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  if (process.argv[2] === 'serve') {
    fs.rmSync(socketPath, { force: true });
    const server = createServer();
    server.on('error', error => { console.error(error.message); process.exit(1); });
    server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
    process.on('SIGTERM', () => {
      stopPlayback();
      server.close();
      fs.rmSync(socketPath, { force: true });
      process.exit(0);
    });
  } else if (process.argv[2] === 'hook') {
    console.log(JSON.stringify(await handleHook(await json(process.stdin))));
  } else {
    console.error('Usage: say.mjs serve|hook');
    process.exitCode = 2;
  }
}
