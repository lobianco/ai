# say

Read Codex's last response aloud with local [Pocket TTS](https://github.com/kyutai-labs/pocket-tts). Type `$say` in your Codex conversation to start playback without another model request or temporary text/audio files.

This is a macOS hook, not a Codex skill. It caches the last completed response in memory and streams speech through your speakers. Pocket TTS still needs time to synthesize audio. Keeping its model loaded avoids loading it on every request.

## Requirements

- macOS with [Homebrew](https://brew.sh/).
- Node.js 22 or newer.
- Codex CLI with `Stop` and `UserPromptSubmit` hooks. The hook workflow was tested with Codex CLI 0.162.1.
- Pocket TTS and FFmpeg (`ffplay`).

## Install

1. Install the dependencies:

   ```sh
   brew install node pocket-tts ffmpeg
   ```

2. Start Pocket TTS in a separate terminal and leave it running:

   ```sh
   pocket-tts serve --host 127.0.0.1 --port 8000 --default-voice alba
   ```

   The first startup downloads the model and voice data. Wait for the server to finish loading before trying playback. Subsequent speech requests run locally. See the [Pocket TTS server documentation](https://kyutai-labs.github.io/pocket-tts/CLI%20Commands/serve/) for voice options.

3. Open a terminal in this directory and install the hook:

   ```sh
   node install.mjs
   ```

   The installer copies the runtime into `~/.codex/hooks/say`, adds two entries to `~/.codex/hooks.json`, and starts a local helper through macOS `launchd`. It preserves unrelated hooks. If you already use `CODEX_HOME`, it installs under that directory instead.

4. Enable Codex hooks if they are disabled:

   ```sh
   codex features enable hooks
   ```

5. Restart Codex. Open `/hooks`, review the new `Stop` and `UserPromptSubmit` command hooks pointing to `hooks/say/say.mjs`, and trust them. Codex skips untrusted hooks. See the [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks) for the approval flow.

6. Ask Codex for a new response, then submit this as your entire message:

   ```text
   $say
   ```

There is no npm installation step. This package uses only Node.js built-in modules.

## Use

`$say` reads the latest completed response in the current conversation. It does not read responses that finished before the hook was installed or before the helper last restarted. Ask for a new response to populate the cache.

Submit `$say` as plain text in Codex, not as a shell command or a skill attachment. `/say` is not supported by the tested Codex CLI, which rejects unknown slash commands before hooks run.

Each conversation has its own cached response. Starting another playback interrupts the previous playback, even when it comes from a different conversation. Codex can display “Reading aloud.” while the audio plays.

Keep Pocket TTS running. After a login or reboot, start Pocket TTS again. The hook starts its own helper when Codex next completes a response. The installer does not configure Pocket TTS to start automatically.

## How it works

1. The `Stop` hook sends `last_assistant_message` and the conversation ID to a local Unix socket. The helper remembers the text in memory.
2. The `UserPromptSubmit` hook recognizes an exact `$say` message, requests playback for that conversation, and stops the prompt before model inference.
3. The helper pipes the cached text to Pocket TTS at `127.0.0.1:8000/tts`. `ffplay` plays the streamed WAV audio.

Response text travels through standard input, not shell interpolation. The hook does not write response text or audio to files, request an API key, or send speech requests to a cloud service. Codex's own transcript storage is separate and unchanged. Pocket TTS downloads model assets on first use and manages its own cache.

The installed directory has owner-only permissions, and the socket is accessible only to its owner. Technical playback errors go to `service.log` in that directory. The helper retains one response per conversation until it restarts.

## Update or uninstall

After updating this checkout, rerun `node install.mjs`. Restart Codex and review any changed hooks in `/hooks`. Reinstalling restarts the helper and clears its in-memory responses.

To remove the installed helper and its hook entries:

```sh
node install.mjs --uninstall
```

Use the same `CODEX_HOME` setting used during installation. Restart Codex afterward. Uninstalling preserves unrelated hooks, Pocket TTS, FFmpeg, and their caches.

## Troubleshooting

- **Codex responds to `$say` as a normal request:** Confirm hooks are enabled, restart Codex, and trust both say hooks in `/hooks`. Remove any older `$say` skill or hook installation before installing this package to avoid duplicate handlers.
- **“No response saved”:** Ask Codex for a new response in this conversation, then try `$say` again.
- **“Reading aloud” appears, but no audio plays:** Check that Pocket TTS is ready at port 8000 and that your Mac's output volume is audible. The status confirms the helper accepted the request, not that audio synthesis succeeded. Inspect playback errors with:

  ```sh
  tail -n 30 "${CODEX_HOME:-$HOME/.codex}/hooks/say/service.log"
  ```

- **The helper needs a restart:** Rerun `node install.mjs`, then get a new Codex response. If the Node.js or FFmpeg executable moved after a Homebrew upgrade, reinstalling refreshes their paths too.

## Development

Run the tests from this directory:

```sh
node --test *.test.mjs
```

Tests cover conversation isolation, literal text handling, prompt interception, failure handling, and installation/removal without altering your real Codex setup. They use temporary test directories and a mock audio callback. They do not require a running Pocket TTS server or play sound.
