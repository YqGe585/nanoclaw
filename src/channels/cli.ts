/**
 * CLI Channel for NanoClaw
 *
 * Unix domain socket server that lets CLI clients connect to the running daemon.
 * Protocol: newline-delimited JSON over data/cli.sock.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const SOCKET_PATH = path.join(DATA_DIR, 'cli.sock');

interface ClientMessage {
  type: 'hello' | 'message';
  sessionId?: string;
  text?: string;
}

interface ServerMessage {
  type: 'response' | 'typing' | 'registered';
  text?: string;
  isTyping?: boolean;
  jid?: string;
  folder?: string;
}

class CliChannel implements Channel {
  name = 'cli';
  private server: net.Server;
  private clients = new Map<string, net.Socket[]>();
  private opts: ChannelOpts;
  // Map socket → sessionId for cleanup on disconnect
  private socketSession = new WeakMap<net.Socket, string>();

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  async connect(): Promise<void> {
    // Remove stale socket file
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      /* ignore */
    }

    // Ensure data dir exists
    fs.mkdirSync(DATA_DIR, { recursive: true });

    return new Promise((resolve, reject) => {
      this.server.on('error', (err) => {
        logger.error({ err }, 'CLI socket server error');
        reject(err);
      });
      this.server.listen(SOCKET_PATH, () => {
        logger.info({ path: SOCKET_PATH }, 'CLI socket listening');
        resolve();
      });
    });
  }

  private onConnection(socket: net.Socket): void {
    logger.debug('CLI client connected');
    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          const msg: ClientMessage = JSON.parse(line);
          this.onClientMessage(socket, msg);
        } catch (err) {
          logger.warn({ err, line }, 'Invalid JSON from CLI client');
        }
      }
    });

    socket.on('close', () => {
      const sessionId = this.socketSession.get(socket);
      if (sessionId) {
        const sockets = this.clients.get(sessionId);
        if (sockets) {
          const idx = sockets.indexOf(socket);
          if (idx !== -1) sockets.splice(idx, 1);
          if (sockets.length === 0) this.clients.delete(sessionId);
        }
      }
      logger.debug({ sessionId }, 'CLI client disconnected');
    });

    socket.on('error', (err) => {
      logger.debug({ err }, 'CLI client socket error');
    });
  }

  private onClientMessage(socket: net.Socket, msg: ClientMessage): void {
    if (msg.type === 'hello') {
      const sessionId = msg.sessionId || 'default';
      this.socketSession.set(socket, sessionId);

      // Track socket
      const existing = this.clients.get(sessionId) || [];
      existing.push(socket);
      this.clients.set(sessionId, existing);

      // Auto-register group if new
      const jid = `cli:${sessionId}`;
      const folder = `cli-${sessionId}`;
      if (!this.opts.registeredGroups()[jid]) {
        this.opts.registerGroup?.(jid, {
          name: `CLI: ${sessionId}`,
          folder,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
          isMain: true,
        });
      }

      this.writeToSocket(socket, {
        type: 'registered',
        jid,
        folder,
      });
      logger.info({ sessionId, jid }, 'CLI client registered');
      return;
    }

    if (msg.type === 'message') {
      const sessionId = this.socketSession.get(socket);
      if (!sessionId) {
        logger.warn('CLI message before hello, ignoring');
        return;
      }

      const jid = `cli:${sessionId}`;
      const now = new Date().toISOString();
      const newMsg: NewMessage = {
        id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chat_jid: jid,
        sender: 'cli-user',
        sender_name: 'CLI User',
        content: msg.text || '',
        timestamp: now,
        is_from_me: true,
      };

      this.opts.onChatMetadata(jid, now, `CLI: ${sessionId}`, 'cli', true);
      this.opts.onMessage(jid, newMsg);
      this.opts.notifyNewMessage?.();
      return;
    }
  }

  private writeToSocket(socket: net.Socket, msg: ServerMessage): void {
    try {
      socket.write(JSON.stringify(msg) + '\n');
    } catch (err) {
      logger.debug({ err }, 'Failed to write to CLI socket');
    }
  }

  private getSocketsForJid(jid: string): net.Socket[] {
    // jid format: cli:<sessionId>
    const sessionId = jid.replace(/^cli:/, '');
    return this.clients.get(sessionId) || [];
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const sockets = this.getSocketsForJid(jid);
    const msg: ServerMessage = { type: 'response', text };
    for (const socket of sockets) {
      this.writeToSocket(socket, msg);
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const sockets = this.getSocketsForJid(jid);
    const msg: ServerMessage = { type: 'typing', isTyping };
    for (const socket of sockets) {
      this.writeToSocket(socket, msg);
    }
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('cli:');
  }

  isConnected(): boolean {
    return this.server.listening;
  }

  async disconnect(): Promise<void> {
    // Close all client sockets
    for (const sockets of this.clients.values()) {
      for (const socket of sockets) {
        socket.destroy();
      }
    }
    this.clients.clear();

    // Close server
    return new Promise((resolve) => {
      this.server.close(() => {
        // Clean up socket file
        try {
          fs.unlinkSync(SOCKET_PATH);
        } catch {
          /* ignore */
        }
        resolve();
      });
    });
  }
}

registerChannel('cli', (opts) => new CliChannel(opts));
