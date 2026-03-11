#!/usr/bin/env tsx
/**
 * CLI client for NanoClaw.
 * Connects to the running daemon via Unix domain socket (data/cli.sock).
 *
 * Usage:
 *   npm run cli                          # Interactive mode (session: "default")
 *   npm run cli -- --session work        # Interactive mode with named session
 *   npm run cli -- "What is 2+2?"        # One-shot mode
 */
import net from 'net';
import path from 'path';
import readline from 'readline';

const SOCKET_PATH = path.join(process.cwd(), 'data', 'cli.sock');

// Parse args
const args = process.argv.slice(2);
let sessionId = 'default';
let oneShotMessage: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--session' && args[i + 1]) {
    sessionId = args[++i];
  } else if (!args[i].startsWith('--')) {
    oneShotMessage = args.slice(i).join(' ');
    break;
  }
}

interface ServerMessage {
  type: 'response' | 'typing' | 'registered';
  text?: string;
  isTyping?: boolean;
  jid?: string;
  folder?: string;
}

const socket = net.createConnection(SOCKET_PATH);
let buffer = '';
let rl: readline.Interface | undefined;
let registered = false;

socket.on('connect', () => {
  socket.write(JSON.stringify({ type: 'hello', sessionId }) + '\n');
});

socket.on('data', (data) => {
  buffer += data.toString();
  let newlineIdx: number;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;
    try {
      const msg: ServerMessage = JSON.parse(line);
      handleMessage(msg);
    } catch {
      // ignore malformed messages
    }
  }
});

socket.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
    console.error('NanoClaw is not running. Start with: npm run dev');
  } else {
    console.error(`Connection error: ${err.message}`);
  }
  process.exit(1);
});

socket.on('close', () => {
  if (registered) {
    console.log('\nDisconnected from NanoClaw.');
  }
  process.exit(0);
});

function handleMessage(msg: ServerMessage): void {
  if (msg.type === 'registered') {
    registered = true;
    if (oneShotMessage) {
      sendMessage(oneShotMessage);
    } else {
      console.log(`Connected to NanoClaw (session: ${sessionId})`);
      console.log('Type your message, or "exit" to quit.\n');
      startRepl();
    }
    return;
  }

  if (msg.type === 'typing') {
    if (msg.isTyping) {
      process.stdout.write('Thinking...\r');
    } else {
      // Clear typing indicator
      process.stdout.write('           \r');
    }
    return;
  }

  if (msg.type === 'response') {
    // Clear any typing indicator
    process.stdout.write('           \r');
    console.log(msg.text || '');
    if (oneShotMessage) {
      socket.end();
      return;
    }
    if (rl) {
      rl.prompt();
    }
    return;
  }
}

function sendMessage(text: string): void {
  socket.write(JSON.stringify({ type: 'message', text }) + '\n');
}

function startRepl(): void {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  rl.prompt();

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) {
      rl!.prompt();
      return;
    }
    if (text === 'exit' || text === 'quit') {
      socket.end();
      return;
    }
    sendMessage(text);
  });

  rl.on('close', () => {
    socket.end();
  });
}
