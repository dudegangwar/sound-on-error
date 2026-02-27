const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const vscode = require('vscode');

const CONFIG_NAMESPACE = 'faah';
const DEFAULT_SOUND_FILE = 'error.mp3';
const MAX_CAPTURE_CHARS = 8 * 1024;
const MAX_TERMINAL_TAIL_CHARS = 1024;
const TERMINAL_TRIGGER_TOKENS = [
  'error:',
  'fail:',
  'failed',
  'fatal:',
  'exception',
  'traceback',
  'Cannot find path',
  'no such file or directory',
  'command not found',
  'not recognized as an internal or external command',
  'because it does not exist'
];

let lastPlayedAt = 0;
let warnedInvalidCustomPath = false;
let warnedMissingPlayer = false;
let outputChannel;
const triggeredExecutions = new WeakSet();

function activate(context) {
  outputChannel = vscode.window.createOutputChannel('Faah');
  context.subscriptions.push(outputChannel);
  logToOutput('Extension activated.');
  registerTerminalListener(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('faah.selectCustomSound', async () => {
      await selectCustomSound();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('faah.clearCustomSound', async () => {
      await clearCustomSound();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('faah.playTestSound', async () => {
      const soundPath = await resolveSoundPath(context);
      if (!soundPath) {
        return;
      }

      playSound(soundPath);
      vscode.window.showInformationMessage('Faah: test sound triggered.');
    })
  );
}

function deactivate() {
  outputChannel = undefined;
}

function registerTerminalListener(context) {
  const onDidStartTerminalShellExecution = getWindowFunction('onDidStartTerminalShellExecution');
  const onDidEndTerminalShellExecution = getWindowFunction('onDidEndTerminalShellExecution');
  if (!onDidStartTerminalShellExecution && !onDidEndTerminalShellExecution) {
    logToOutput('Terminal shell execution API is unavailable in this VS Code version.');
    return;
  }

  if (onDidStartTerminalShellExecution) {
    context.subscriptions.push(
      onDidStartTerminalShellExecution.call(vscode.window, async (event) => {
        try {
          await handleTerminalExecutionStartEvent(context, event);
        } catch (error) {
          const details = error instanceof Error ? (error.stack ?? error.message) : String(error);
          logToOutput(`Failed to handle terminal execution start event: ${details}`);
        }
      })
    );
    logToOutput('Terminal shell start listener registered.');
  }

  if (onDidEndTerminalShellExecution) {
    context.subscriptions.push(
      onDidEndTerminalShellExecution.call(vscode.window, async (event) => {
        try {
          await handleTerminalExecutionEndEvent(context, event);
        } catch (error) {
          const details = error instanceof Error ? (error.stack ?? error.message) : String(error);
          logToOutput(`Failed to handle terminal execution end event: ${details}`);
        }
      })
    );
    logToOutput('Terminal shell end listener registered.');
  }
}

async function handleTerminalExecutionStartEvent(context, event) {
  const execution = event?.execution;
  if (execution && triggeredExecutions.has(execution)) {
    return;
  }

  const matchedToken = await findTriggerTokenInExecution(execution);
  if (!matchedToken) {
    return;
  }

  const terminalName = event?.terminal?.name ?? 'unknown terminal';
  await triggerTerminalMatch(context, {
    matchedToken,
    terminalName,
    source: 'terminal output',
    execution
  });
}

async function handleTerminalExecutionEndEvent(context, event) {
  const execution = event?.execution;
  if (execution && triggeredExecutions.has(execution)) {
    return;
  }

  const commandLine = normalizeTerminalData(getExecutionCommandLine(execution));
  const commandLineToken = findTerminalTriggerToken(commandLine);
  const terminalName = event?.terminal?.name ?? 'unknown terminal';
  if (commandLineToken) {
    await triggerTerminalMatch(context, {
      matchedToken: commandLineToken,
      terminalName,
      source: 'command line',
      execution
    });
    return;
  }

  const exitCode = typeof event?.exitCode === 'number' ? event.exitCode : null;
  if (exitCode === null || exitCode === 0) {
    return;
  }

  if (!isDirectoryChangeCommand(commandLine)) {
    return;
  }

  await triggerTerminalMatch(context, {
    matchedToken: 'directory change failed',
    terminalName,
    source: `failed command fallback (exitCode=${exitCode})`,
    execution
  });
}

async function triggerTerminalMatch(context, details) {
  const config = getConfig();
  if (!config.get('enabled', true)) {
    return;
  }

  const cooldownMs = Math.max(0, Number(config.get('cooldownMs', 1200)) || 0);
  if (Date.now() - lastPlayedAt < cooldownMs) {
    logToOutput(`Terminal trigger matched "${details.matchedToken}" but skipped due to cooldown.`);
    return;
  }

  const soundPath = await resolveSoundPath(context);
  if (!soundPath) {
    return;
  }

  logToOutput(`Terminal trigger matched "${details.matchedToken}" from terminal "${details.terminalName}" (${details.source}).`);
  playSound(soundPath);
  lastPlayedAt = Date.now();
  if (details.execution) {
    triggeredExecutions.add(details.execution);
  }
}

function getConfig() {
  return vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
}

function findTerminalTriggerToken(text) {
  const normalizedText = normalizeForTokenMatch(text);
  let earliestIndex = Number.POSITIVE_INFINITY;
  let earliestToken = null;

  for (const token of TERMINAL_TRIGGER_TOKENS) {
    const normalizedToken = normalizeForTokenMatch(token);
    if (!normalizedToken) {
      continue;
    }

    const foundIndex = normalizedText.indexOf(normalizedToken);
    if (foundIndex >= 0 && foundIndex < earliestIndex) {
      earliestIndex = foundIndex;
      earliestToken = token;
    }
  }

  return earliestToken;
}

async function findTriggerTokenInExecution(execution) {
  const commandLine = normalizeTerminalData(getExecutionCommandLine(execution));
  let textTail = commandLine.slice(-MAX_TERMINAL_TAIL_CHARS);
  let matchedToken = findTerminalTriggerToken(textTail);
  if (matchedToken) {
    return matchedToken;
  }

  const readFn = getExecutionReadFunction(execution);
  if (!readFn) {
    logToOutput('execution.read is unavailable; token matching only used command line text.');
    return null;
  }

  try {
    for await (const chunk of readFn.call(execution)) {
      const normalizedChunk = normalizeTerminalData(chunk);
      if (!normalizedChunk) {
        continue;
      }

      const candidateText = `${textTail}${normalizedChunk}`;
      matchedToken = findTerminalTriggerToken(candidateText);
      if (matchedToken) {
        return matchedToken;
      }

      textTail = candidateText.slice(-MAX_TERMINAL_TAIL_CHARS);
    }
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    logToOutput(`Terminal execution read failed: ${details}`);
  }

  return null;
}

function getWindowFunction(name) {
  try {
    const value = vscode.window[name];
    return typeof value === 'function' ? value : null;
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    logToOutput(`Unable to access vscode.window.${name}: ${details}`);
    return null;
  }
}

function getExecutionReadFunction(execution) {
  if (!execution || typeof execution !== 'object') {
    return null;
  }

  try {
    const value = execution.read;
    return typeof value === 'function' ? value : null;
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    logToOutput(`Unable to access execution.read: ${details}`);
    return null;
  }
}

function getExecutionCommandLine(execution) {
  if (!execution || typeof execution !== 'object') {
    return '';
  }

  try {
    const commandLine = execution.commandLine;
    if (typeof commandLine === 'string') {
      return commandLine;
    }

    if (commandLine && typeof commandLine.value === 'string') {
      return commandLine.value;
    }
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    logToOutput(`Unable to access execution.commandLine: ${details}`);
  }

  return '';
}

function normalizeTerminalData(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }

  let normalized = value;
  normalized = normalized.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  normalized = normalized.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
  normalized = normalized.replace(/\x1b[@-_]/g, '');
  normalized = normalized.replace(/\r/g, '\n');
  return normalized;
}

function normalizeForTokenMatch(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }

  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isDirectoryChangeCommand(commandLine) {
  const normalizedCommand = normalizeForTokenMatch(commandLine);
  return (
    normalizedCommand === 'cd' ||
    normalizedCommand.startsWith('cd ') ||
    normalizedCommand === 'chdir' ||
    normalizedCommand.startsWith('chdir ') ||
    normalizedCommand === 'set-location' ||
    normalizedCommand.startsWith('set-location ')
  );
}

async function selectCustomSound() {
  const files = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectMany: false,
    canSelectFolders: false,
    title: 'Select a sound file for Faah',
    filters: {
      Audio: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']
    }
  });

  if (!files || files.length === 0) {
    return;
  }

  await getConfig().update('customSoundPath', files[0].fsPath, vscode.ConfigurationTarget.Global);
  warnedInvalidCustomPath = false;
  vscode.window.showInformationMessage('Faah: custom sound saved.');
}

async function clearCustomSound() {
  await getConfig().update('customSoundPath', '', vscode.ConfigurationTarget.Global);
  warnedInvalidCustomPath = false;
  vscode.window.showInformationMessage('Faah: custom sound cleared (using default).');
}

async function resolveSoundPath(context) {
  const customPathValue = String(getConfig().get('customSoundPath', '')).trim();
  logToOutput(`Resolving sound path. customSoundPath=${customPathValue ? `"${customPathValue}"` : '<empty>'}.`);

  if (customPathValue.length > 0) {
    const resolvedCustomPath = resolveConfiguredPath(customPathValue);
    if (resolvedCustomPath && fs.existsSync(resolvedCustomPath)) {
      warnedInvalidCustomPath = false;
      logToOutput(`Using custom sound file: "${resolvedCustomPath}".`);
      return resolvedCustomPath;
    }

    logToOutput(`Custom sound path not found. configured="${customPathValue}", resolved="${resolvedCustomPath ?? 'n/a'}".`);
    if (!warnedInvalidCustomPath) {
      warnedInvalidCustomPath = true;
      vscode.window.showWarningMessage(`Faah: custom sound not found at "${customPathValue}". Using default sound.`);
    }
  }

  const defaultPath = context.asAbsolutePath(DEFAULT_SOUND_FILE);
  if (fs.existsSync(defaultPath)) {
    logToOutput(`Using default sound file: "${defaultPath}".`);
    return defaultPath;
  }

  logToOutput(`Default sound file missing at "${defaultPath}".`);
  vscode.window.showErrorMessage(`Faah: default sound file is missing (${DEFAULT_SOUND_FILE}).`);
  return null;
}

function resolveConfiguredPath(rawPath) {
  let candidate = rawPath;

  if (candidate.startsWith('~')) {
    candidate = path.join(os.homedir(), candidate.slice(1));
  }

  if (path.isAbsolute(candidate)) {
    return path.normalize(candidate);
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceFolder) {
    return path.normalize(path.join(workspaceFolder, candidate));
  }

  return path.normalize(path.resolve(candidate));
}

function playSound(soundPath) {
  logToOutput(`Attempting playback on ${process.platform} with "${soundPath}".`);

  if (process.platform === 'win32') {
    playOnWindows(soundPath);
    return;
  }

  if (process.platform === 'darwin') {
    spawnWithFallback(
      [{ label: 'afplay', command: 'afplay', args: [soundPath] }],
      'Faah: no compatible audio player found (expected: afplay).'
    );
    return;
  }

  spawnWithFallback(
    [
      { label: 'paplay', command: 'paplay', args: [soundPath] },
      { label: 'aplay', command: 'aplay', args: [soundPath] },
      { label: 'ffplay', command: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', soundPath] },
      { label: 'mpg123', command: 'mpg123', args: [soundPath] },
      { label: 'mpg321', command: 'mpg321', args: [soundPath] },
      { label: 'play', command: 'play', args: ['-q', soundPath] }
    ],
    'Faah: no compatible audio player found (tried paplay/aplay/ffplay/mpg123/mpg321/play).'
  );
}

function playOnWindows(soundPath) {
  const escapedPath = escapePowerShellLiteral(soundPath);
  const extension = path.extname(soundPath).toLowerCase();

  const wpfScript = buildWpfMediaPlayerScript(escapedPath);
  const wmpScript = buildWmpComScript(escapedPath);
  const soundPlayerScript = buildSoundPlayerScript(escapedPath);

  const candidates = [
    createWindowsShellCandidate('powershell.exe', 'WPF MediaPlayer', wpfScript),
    createWindowsShellCandidate('powershell.exe', 'WMPlayer.OCX', wmpScript),
    createWindowsShellCandidate('pwsh.exe', 'WPF MediaPlayer', wpfScript),
    createWindowsShellCandidate('pwsh.exe', 'WMPlayer.OCX', wmpScript)
  ];

  if (extension === '.wav') {
    candidates.push(
      createWindowsShellCandidate('powershell.exe', 'System.Media.SoundPlayer', soundPlayerScript),
      createWindowsShellCandidate('pwsh.exe', 'System.Media.SoundPlayer', soundPlayerScript)
    );
  }

  logToOutput(`Windows playback candidates prepared: ${candidates.map((candidate) => candidate.label).join(', ')}.`);

  spawnWithFallback(
    candidates,
    'Faah: audio playback failed on Windows.'
  );
}

function spawnWithFallback(candidates, failureMessage) {
  const attempt = (index) => {
    if (index >= candidates.length) {
      logToOutput(`All playback candidates failed (${candidates.length} attempted).`);
      void warnMissingPlayerOnce(failureMessage);
      return;
    }

    const candidate = candidates[index];
    logToOutput(`Attempt ${index + 1}/${candidates.length}: ${candidate.label}`);

    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;

    try {
      child = spawn(candidate.command, candidate.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      logToOutput(`Attempt failed before spawn (${candidate.label}): ${details}`);
      attempt(index + 1);
      return;
    }

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout = appendCapturedOutput(stdout, chunk);
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr = appendCapturedOutput(stderr, chunk);
      });
    }

    child.once('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      const details = error instanceof Error ? error.message : String(error);
      logToOutput(`Spawn error for ${candidate.label}: ${details}`);
      attempt(index + 1);
    });

    child.once('close', (code, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      const trimmedStdout = stdout.trim();
      const trimmedStderr = stderr.trim();

      if (code === 0) {
        logToOutput(`Playback succeeded via ${candidate.label}.`);
        if (trimmedStdout.length > 0) {
          logToOutput(`stdout (${candidate.label}): ${trimmedStdout}`);
        }
        if (trimmedStderr.length > 0) {
          logToOutput(`stderr (${candidate.label}): ${trimmedStderr}`);
        }
        return;
      }

      const codeLabel = code === null ? 'null' : String(code);
      const signalLabel = signal ?? 'none';
      logToOutput(`Playback failed via ${candidate.label} (exitCode=${codeLabel}, signal=${signalLabel}).`);
      if (trimmedStdout.length > 0) {
        logToOutput(`stdout (${candidate.label}): ${trimmedStdout}`);
      }
      if (trimmedStderr.length > 0) {
        logToOutput(`stderr (${candidate.label}): ${trimmedStderr}`);
      }
      attempt(index + 1);
    });
  };

  attempt(0);
}

function createWindowsShellCandidate(shellCommand, backendLabel, script) {
  return {
    label: `${shellCommand} ${backendLabel}`,
    command: shellCommand,
    args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', script]
  };
}

function buildWpfMediaPlayerScript(escapedPath) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$path = '${escapedPath}'`,
    'Add-Type -AssemblyName presentationCore',
    '$player = New-Object System.Windows.Media.MediaPlayer',
    'try { $player.Open([Uri] $path); $deadline = [DateTime]::UtcNow.AddSeconds(3); while (-not $player.NaturalDuration.HasTimeSpan -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }; $player.Volume = 1.0; $player.Play(); $durationMs = if ($player.NaturalDuration.HasTimeSpan) { [Math]::Max(500, [int]$player.NaturalDuration.TimeSpan.TotalMilliseconds) } else { 2500 }; Start-Sleep -Milliseconds ([Math]::Min($durationMs, 4000)) } finally { if ($player) { $player.Stop(); $player.Close() } }'
  ].join('; ');
}

function buildWmpComScript(escapedPath) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$path = '${escapedPath}'`,
    '$wmp = $null',
    'try { $wmp = New-Object -ComObject WMPlayer.OCX; $media = $wmp.newMedia($path); $null = $wmp.currentPlaylist.appendItem($media); $wmp.controls.play(); Start-Sleep -Milliseconds 2500; $wmp.controls.stop() } finally { if ($wmp) { $wmp.close() } }'
  ].join('; ');
}

function buildSoundPlayerScript(escapedPath) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$path = '${escapedPath}'`,
    '$player = $null',
    'try { $player = New-Object System.Media.SoundPlayer $path; $player.Load(); $player.PlaySync() } finally { if ($player) { $player.Dispose() } }'
  ].join('; ');
}

async function warnMissingPlayerOnce(message) {
  if (warnedMissingPlayer) {
    return;
  }

  warnedMissingPlayer = true;
  const action = await vscode.window.showWarningMessage(message, 'Show Logs');
  if (action === 'Show Logs') {
    showLogs();
  }
}

function appendCapturedOutput(currentValue, chunk) {
  if (currentValue.length >= MAX_CAPTURE_CHARS) {
    return currentValue;
  }

  const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  const remainingChars = MAX_CAPTURE_CHARS - currentValue.length;
  return currentValue + value.slice(0, remainingChars);
}

function escapePowerShellLiteral(value) {
  return value.replace(/'/g, "''");
}

function logToOutput(message) {
  if (!outputChannel) {
    return;
  }

  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function showLogs() {
  if (!outputChannel) {
    return;
  }

  outputChannel.show(true);
}

module.exports = {
  activate,
  deactivate
};
