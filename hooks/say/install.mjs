import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source = import.meta.dirname;
const label = 'local.codex.say';

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function hookCommand(node, directory) {
  return `${shellQuote(node)} ${shellQuote(path.join(directory, 'say.mjs'))} hook`;
}

export function updateHooks(existing, command, remove = false) {
  const updated = structuredClone(existing);
  updated.hooks ??= {};
  const matches = hook => hook.type === 'command' && hook.command === command;
  for (const event of ['Stop', 'UserPromptSubmit']) {
    const groups = updated.hooks[event] ?? [];
    if (remove) {
      updated.hooks[event] = groups.flatMap(group => {
        const handlers = group.hooks.filter(hook => !matches(hook));
        return handlers.length ? [{ ...group, hooks: handlers }] : [];
      });
      if (!updated.hooks[event].length) delete updated.hooks[event];
    } else if (!groups.some(group => group.hooks.some(matches))) {
      updated.hooks[event] = [...groups, { hooks: [{ type: 'command', command, timeout: 3 }] }];
    }
  }
  return updated;
}

export function servicePlist(node, directory, ffplay) {
  const searchPath = [...new Set([path.dirname(node), path.dirname(ffplay), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(node)}</string>
    <string>${xml(path.join(directory, 'say.mjs'))}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(searchPath)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(directory, 'service.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(directory, 'service.log'))}</string>
</dict></plist>
`;
}

function readHooks(codexHome) {
  const hooksFile = path.join(codexHome, 'hooks.json');
  return fs.existsSync(hooksFile) ? JSON.parse(fs.readFileSync(hooksFile, 'utf8')) : {};
}

function writeHooks(codexHome, hooks) {
  const hooksFile = path.join(codexHome, 'hooks.json');
  const pending = `${hooksFile}.say-${process.pid}`;
  try {
    fs.writeFileSync(pending, JSON.stringify(hooks, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(pending, hooksFile);
  } finally { fs.rmSync(pending, { force: true }); }
}

export function installFiles(codexHome, node, ffplay) {
  const directory = path.join(codexHome, 'hooks', 'say');
  const metadataFile = path.join(directory, 'installation.json');
  const previous = fs.existsSync(metadataFile) ? JSON.parse(fs.readFileSync(metadataFile, 'utf8')) : null;
  let hooks = readHooks(codexHome);
  if (previous) hooks = updateHooks(hooks, previous.command, true);
  const command = hookCommand(node, directory);
  hooks = updateHooks(hooks, command);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  for (const name of ['say.mjs', 'speak.sh']) {
    fs.copyFileSync(path.join(source, name), path.join(directory, name));
  }
  fs.writeFileSync(path.join(directory, `${label}.plist`), servicePlist(node, directory, ffplay));
  fs.writeFileSync(metadataFile, JSON.stringify({ command }) + '\n', { mode: 0o600 });
  writeHooks(codexHome, hooks);
  return directory;
}

export function uninstallFiles(codexHome) {
  const directory = path.join(codexHome, 'hooks', 'say');
  const metadataFile = path.join(directory, 'installation.json');
  if (!fs.existsSync(metadataFile)) throw new Error('No say installation found in this Codex home.');
  const { command } = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  writeHooks(codexHome, updateHooks(readHooks(codexHome), command, true));
  fs.rmSync(directory, { recursive: true });
}

function main() {
  if (process.platform !== 'darwin') throw new Error('This installer supports macOS only.');
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--uninstall')) {
    throw new Error('Usage: node install.mjs [--uninstall]');
  }
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const domain = `gui/${process.getuid()}`;
  if (process.argv[2] === '--uninstall') {
    const metadata = path.join(codexHome, 'hooks', 'say', 'installation.json');
    if (!fs.existsSync(metadata)) throw new Error('No say installation found in this Codex home.');
    spawnSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
    uninstallFiles(codexHome);
    console.log('Removed say and its two hook entries. Restart Codex.');
    return;
  }
  const found = spawnSync('/usr/bin/which', ['ffplay'], { encoding: 'utf8' });
  if (found.status !== 0) throw new Error('ffplay is missing. Install it with: brew install ffmpeg');
  const directory = installFiles(codexHome, process.execPath, found.stdout.trim());
  spawnSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
  const started = spawnSync('/bin/launchctl', ['bootstrap', domain, path.join(directory, `${label}.plist`)], { encoding: 'utf8' });
  if (started.status !== 0) throw new Error(`Files installed, but the helper could not start: ${started.stderr || started.error?.message}`);
  console.log(`Installed say in ${directory}`);
  console.log('Restart Codex, open /hooks, and review and trust the two say hooks.');
  console.log('Keep Pocket TTS running. Get a new response, then type $say.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
