#!/usr/bin/env tsx
/**
 * Local CLI chat for NanoClaw
 * Runs the agent locally (no Docker) with an interactive terminal interface.
 *
 * The agent-runner process stays alive across turns. The first message is sent
 * via stdin; follow-up messages are piped via IPC files (same protocol as the
 * container model). Typing "exit" writes the _close sentinel to shut it down.
 *
 * Usage:
 *   npx tsx scripts/local-chat.ts                  # Interactive mode
 *   npx tsx scripts/local-chat.ts "Your message"   # Single-shot mode
 *   npm run chat                                    # Interactive (via package.json)
 *   npm run chat -- "Your message"                  # Single-shot
 */

// Force local runtime before any imports
process.env.AGENT_RUNTIME = 'local';

import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { ContainerOutput } from '../src/container-runner.js';
import {
  CONTAINER_MAX_OUTPUT_SIZE,
  DATA_DIR,
  GROUPS_DIR,
  TIMEZONE,
} from '../src/config.js';
import { readEnvFile } from '../src/env.js';
import { resolveGroupIpcPath } from '../src/group-folder.js';

const GROUP_FOLDER = 'cli-local';
const CHAT_JID = 'local:cli';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Ensure group directory and CLAUDE.md exist
const groupDir = path.join(GROUPS_DIR, GROUP_FOLDER);
fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
if (!fs.existsSync(claudeMdPath)) {
  fs.writeFileSync(
    claudeMdPath,
    `# Local CLI Session\n\nYou are running in a local CLI environment. The user is interacting with you directly via the terminal.\n`,
  );
}

// Prepare IPC directories
const groupIpcDir = resolveGroupIpcPath(GROUP_FOLDER);
const ipcInputDir = path.join(groupIpcDir, 'input');
const ipcMessagesDir = path.join(groupIpcDir, 'messages');
fs.mkdirSync(ipcInputDir, { recursive: true });
fs.mkdirSync(ipcMessagesDir, { recursive: true });
fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });

// Clean stale _close sentinel
try { fs.unlinkSync(path.join(ipcInputDir, '_close')); } catch { /* ignore */ }

// Prepare sessions dir
const sessionsDir = path.join(DATA_DIR, 'sessions', GROUP_FOLDER, '.claude');
fs.mkdirSync(sessionsDir, { recursive: true });
const settingsFile = path.join(sessionsDir, 'settings.json');
if (!fs.existsSync(settingsFile)) {
  fs.writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        env: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
        },
      },
      null,
      2,
    ) + '\n',
  );
}

// Sync skills
const projectRoot = process.cwd();
const skillsSrc = path.join(projectRoot, 'container', 'skills');
const skillsDst = path.join(sessionsDir, 'skills');
if (fs.existsSync(skillsSrc)) {
  for (const skillDir of fs.readdirSync(skillsSrc)) {
    const srcDir = path.join(skillsSrc, skillDir);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    fs.cpSync(srcDir, path.join(skillsDst, skillDir), { recursive: true });
  }
}

let sessionId: string | undefined;
let agentProcess: ChildProcess | null = null;
let queryResolve: (() => void) | null = null;

function readSecrets(): Record<string, string> {
  return readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_CUSTOM_HEADERS',
  ]);
}

/**
 * Poll the IPC messages directory for send_message calls from the agent.
 */
function startIpcPoller(): () => void {
  let active = true;

  const poll = () => {
    if (!active) return;
    try {
      const files = fs
        .readdirSync(ipcMessagesDir)
        .filter((f) => f.endsWith('.json'))
        .sort();
      for (const file of files) {
        const filePath = path.join(ipcMessagesDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          fs.unlinkSync(filePath);
          if (data.type === 'message' && data.text) {
            const sender = data.sender ? `[${data.sender}] ` : '';
            process.stdout.write(`\n${sender}${data.text}\n`);
          }
        } catch {
          try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    if (active) setTimeout(poll, 500);
  };
  poll();

  return () => { active = false; };
}

/**
 * Spawn the agent-runner process. It stays alive across conversation turns.
 * First message goes via stdin; follow-ups go via IPC files.
 */
function spawnAgent(firstPrompt: string): ChildProcess {
  const agentRunnerDir = path.join(projectRoot, 'container', 'agent-runner');

  if (!fs.existsSync(path.join(agentRunnerDir, 'node_modules'))) {
    console.error(
      'agent-runner node_modules not found. Run: cd container/agent-runner && npm install',
    );
    process.exit(1);
  }

  const globalDir = path.join(GROUPS_DIR, 'global');

  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NANOCLAW_WORKSPACE_GROUP: groupDir,
    NANOCLAW_WORKSPACE_IPC: groupIpcDir,
    NANOCLAW_WORKSPACE_EXTRA: path.join(projectRoot, 'groups', 'extra'),
    HOME: path.join(DATA_DIR, 'sessions', GROUP_FOLDER),
    TZ: TIMEZONE,
    IS_SANDBOX: '1',
  };
  if (fs.existsSync(globalDir)) {
    childEnv.NANOCLAW_WORKSPACE_GLOBAL = globalDir;
  }
  delete (childEnv as Record<string, string | undefined>).CLAUDECODE;

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(agentRunnerDir, 'src', 'index.ts')],
    {
      cwd: agentRunnerDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    },
  );

  // Send first message via stdin (agent-runner protocol)
  const input = {
    prompt: firstPrompt,
    sessionId,
    groupFolder: GROUP_FOLDER,
    chatJid: CHAT_JID,
    isMain: true,
    assistantName: 'Assistant',
    secrets: readSecrets(),
  };
  child.stdin.write(JSON.stringify(input));
  child.stdin.end();

  // Parse stdout for output markers
  let parseBuffer = '';
  let stdout = '';
  let stdoutTruncated = false;

  child.stdout.on('data', (data) => {
    const chunk = data.toString();

    if (!stdoutTruncated) {
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
      if (chunk.length > remaining) {
        stdout += chunk.slice(0, remaining);
        stdoutTruncated = true;
      } else {
        stdout += chunk;
      }
    }

    parseBuffer += chunk;
    let startIdx: number;
    while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
      const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
      if (endIdx === -1) break;

      const jsonStr = parseBuffer
        .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
        .trim();
      parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

      try {
        const parsed: ContainerOutput = JSON.parse(jsonStr);

        if (parsed.newSessionId) {
          sessionId = parsed.newSessionId;
        }

        if (parsed.result) {
          const text =
            typeof parsed.result === 'string'
              ? parsed.result
              : JSON.stringify(parsed.result);
          const clean = text
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          if (clean) {
            process.stdout.write(`\n${clean}\n`);
          }
          // Result with text means the agent finished this query.
          // (The session-update marker with result:null may never arrive
          // because runQuery() keeps the MessageStream open for agent teams.)
          if (queryResolve) {
            queryResolve();
            queryResolve = null;
          }
        }

        if (parsed.status === 'error') {
          console.error(`Agent error: ${parsed.error}`);
          if (queryResolve) {
            queryResolve();
            queryResolve = null;
          }
        }
      } catch {
        // malformed marker, skip
      }
    }
  });

  child.stderr.on('data', (data) => {
    const text = data.toString();
    // Only show actual errors, suppress SDK debug noise
    if (
      text.includes('Agent error') ||
      text.includes('FATAL') ||
      text.includes('Failed')
    ) {
      process.stderr.write(text);
    }
  });

  child.on('close', (code) => {
    agentProcess = null;
    if (queryResolve) {
      queryResolve();
      queryResolve = null;
    }
    if (code && code !== 0) {
      console.error(`Agent process exited with code ${code}`);
    }
  });

  child.on('error', (err) => {
    agentProcess = null;
    console.error(`Agent spawn error: ${err.message}`);
    if (queryResolve) {
      queryResolve();
      queryResolve = null;
    }
  });

  return child;
}

/**
 * Send a follow-up message via IPC file (agent-runner polls these).
 */
function sendIpcMessage(text: string): void {
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(ipcInputDir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
  fs.renameSync(tempPath, filepath);
}

/**
 * Write _close sentinel to shut down the agent-runner.
 */
function sendClose(): void {
  fs.writeFileSync(path.join(ipcInputDir, '_close'), '');
}

/**
 * Wait for the current query to produce a result.
 * Resolves when the agent emits a session-update marker (result: null)
 * indicating it's idle and ready for the next IPC message.
 */
function waitForQueryResult(): Promise<void> {
  return new Promise((resolve) => {
    queryResolve = resolve;
  });
}

async function interactiveMode(): Promise<void> {
  const stopPoller = startIpcPoller();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n> ',
  });

  console.log('NanoClaw Local Chat');
  console.log('Type your messages. Use "exit" or Ctrl+C to quit.\n');

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    console.log('\nGoodbye!');
    if (agentProcess) sendClose();
    setTimeout(() => process.exit(0), 500);
  });

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      continue;
    }

    if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
      console.log('Goodbye!');
      if (agentProcess) sendClose();
      stopPoller();
      setTimeout(() => process.exit(0), 500);
      return;
    }

    if (!agentProcess) {
      // First message: spawn the agent-runner, send prompt via stdin
      console.log('Thinking...');
      agentProcess = spawnAgent(input);
    } else {
      // Follow-up messages: pipe via IPC file
      console.log('Thinking...');
      sendIpcMessage(input);
    }

    // Wait for the agent to finish processing and become idle
    await waitForQueryResult();

    // If agent died (e.g. error), it will be re-spawned on next message
    rl.prompt();
  }

  // stdin closed (e.g. piped input ended)
  if (agentProcess) sendClose();
  stopPoller();
}

async function oneShotMode(message: string): Promise<void> {
  const stopPoller = startIpcPoller();

  agentProcess = spawnAgent(message);
  await waitForQueryResult();

  // Got result, shut down
  sendClose();
  stopPoller();

  // Give agent-runner time to exit cleanly
  await new Promise<void>((resolve) => {
    if (!agentProcess) {
      resolve();
      return;
    }
    agentProcess.on('close', () => resolve());
    setTimeout(() => resolve(), 3000);
  });
}

// Main
const args = process.argv.slice(2);

if (args.length === 0) {
  interactiveMode().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
} else {
  oneShotMode(args.join(' ')).catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
