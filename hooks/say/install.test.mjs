import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hookCommand, installFiles, uninstallFiles, servicePlist, updateHooks } from './install.mjs';

test('install, repeat install, upgrade, and uninstall preserve unrelated hooks', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'say-install-'));
  const codexHome = path.join(temporary, "example's codex home");
  fs.mkdirSync(codexHome);
  const original = {
    metadata: 'preserve',
    hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'other-stop', timeout: 10 }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: 'other-tool' }] }],
    },
  };
  const hooksFile = path.join(codexHome, 'hooks.json');
  const read = () => JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  fs.writeFileSync(hooksFile, JSON.stringify(original));
  try {
    const directory = installFiles(codexHome, '/example/node', '/example/ffplay');
    const first = read();
    assert.deepEqual(first.hooks.PreToolUse, original.hooks.PreToolUse);
    assert.deepEqual(first.hooks.Stop[0], original.hooks.Stop[0]);
    assert.equal(first.metadata, 'preserve');
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(directory, 'say.mjs'), 'utf8'),
      fs.readFileSync(new URL('./say.mjs', import.meta.url), 'utf8'));
    installFiles(codexHome, '/example/node', '/example/ffplay');
    assert.deepEqual(read(), first);
    installFiles(codexHome, '/new/node', '/new/ffplay');
    assert.equal(read().hooks.Stop.length, 2);
    assert.equal(read().hooks.UserPromptSubmit.length, 1);
    assert.equal(read().hooks.Stop[1].hooks[0].command, hookCommand('/new/node', directory));
    uninstallFiles(codexHome);
    assert.deepEqual(read(), original);
    assert.equal(fs.existsSync(directory), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('removal preserves other handlers within the same group', () => {
  const other = { type: 'command', command: 'other' };
  const existing = { hooks: { Stop: [{ matcher: 'keep', hooks: [
    { type: 'command', command: 'say-command' }, other,
  ] }] } };
  assert.deepEqual(updateHooks(existing, 'say-command', true), {
    hooks: { Stop: [{ matcher: 'keep', hooks: [other] }] },
  });
  assert.equal(existing.hooks.Stop[0].hooks.length, 2);
});

test('generated shell command preserves special characters as literal arguments', () => {
  const directory = "/example/a'b $(printf unsafe) `printf unsafe` $HOME";
  const command = hookCommand('/bin/echo', directory);
  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, path.join(directory, 'say.mjs') + ' hook\n');
});

test('generated launchd plist escapes user paths and includes the player directory', () => {
  const plist = servicePlist('/example/Node & Tools/node', "/example/a'b <say>", '/example/player/ffplay');
  assert.match(plist, /Node &amp; Tools/);
  assert.match(plist, /a&apos;b &lt;say&gt;/);
  assert.match(plist, /\/example\/player/);
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/bin/plutil', ['-lint', '-'], { input: plist, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});
