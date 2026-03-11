/**
 * Local Agent Runner for NanoClaw
 * Runs agent-runner as a local child process instead of a Docker container.
 * Same interface as runContainerAgent() for drop-in substitution.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { ContainerInput, ContainerOutput } from './container-runner.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

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
 * Prepare the local directories that mirror what buildVolumeMounts() does
 * for Docker, but pointing at real host paths.
 */
function prepareLocalDirs(group: RegisteredGroup, isMain: boolean) {
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Per-group Claude sessions directory
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
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
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Per-group IPC namespace
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  // Global memory directory
  const globalDir = path.join(GROUPS_DIR, 'global');
  const globalPath = fs.existsSync(globalDir) ? globalDir : undefined;

  // Logs
  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return {
    groupDir,
    groupSessionsDir,
    groupIpcDir,
    globalPath,
    logsDir,
  };
}

export async function runLocalAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const isMain = input.isMain;

  const { groupDir, groupSessionsDir, groupIpcDir, globalPath, logsDir } =
    prepareLocalDirs(group, isMain);

  const projectRoot = process.cwd();
  const agentRunnerDir = path.join(projectRoot, 'container', 'agent-runner');

  // Verify agent-runner dependencies exist
  if (!fs.existsSync(path.join(agentRunnerDir, 'node_modules'))) {
    const errMsg =
      'agent-runner node_modules not found. Run: cd container/agent-runner && npm install';
    logger.error(errMsg);
    return { status: 'error', result: null, error: errMsg };
  }

  const processName = `local-${group.folder}-${Date.now()}`;

  logger.info(
    { group: group.name, processName, isMain },
    'Spawning local agent',
  );

  // Pass secrets via stdin
  input.secrets = readSecrets();

  // Build environment for the child process
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // Workspace path overrides for agent-runner
    NANOCLAW_WORKSPACE_GROUP: groupDir,
    NANOCLAW_WORKSPACE_IPC: groupIpcDir,
    NANOCLAW_WORKSPACE_EXTRA: path.join(projectRoot, 'groups', 'extra'),
    // HOME points to the sessions dir so .claude/ is found
    HOME: path.join(DATA_DIR, 'sessions', group.folder),
    TZ: TIMEZONE,
  };
  if (globalPath) {
    childEnv.NANOCLAW_WORKSPACE_GLOBAL = globalPath;
  }
  // Prevent "cannot launch inside another Claude Code session" error
  delete (childEnv as Record<string, string | undefined>).CLAUDECODE;
  // Allow running as root in local mode (Docker containers use non-root user,
  // but local mode may be invoked as root)
  childEnv.IS_SANDBOX = '1';

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', path.join(agentRunnerDir, 'src', 'index.ts')],
      {
        cwd: agentRunnerDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
      },
    );

    onProcess(child, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Send input via stdin (same protocol as Docker)
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
    // Remove secrets so they don't appear in logs
    delete input.secrets;

    // Streaming output parser (same as container-runner.ts)
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let hadStreamingOutput = false;

    child.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Local agent stdout truncated',
          );
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
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
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output from local agent',
            );
          }
        }
      }
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ local: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Local agent timeout, sending SIGTERM',
      );
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          logger.warn(
            { group: group.name, processName },
            'SIGTERM failed, sending SIGKILL',
          );
          child.kill('SIGKILL');
        }
      }, 15000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    child.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Write log
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `local-${ts}.log`);
      const logLines = [
        `=== Local Agent Run Log${timedOut ? ' (TIMEOUT)' : ''} ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `Process: ${processName}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Had Streaming Output: ${hadStreamingOutput}`,
      ];

      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';
      if (isVerbose || code !== 0) {
        logLines.push(
          '',
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          '',
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          '',
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      }
      fs.writeFileSync(logFile, logLines.join('\n'));

      if (timedOut) {
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processName, duration, code },
            'Local agent timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }
        resolve({
          status: 'error',
          result: null,
          error: `Local agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration },
          'Local agent exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Local agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Local agent completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy non-streaming: parse last output marker
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);
        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }
        const output: ContainerOutput = JSON.parse(jsonLine);
        logger.info(
          { group: group.name, duration, status: output.status },
          'Local agent completed',
        );
        resolve(output);
      } catch (err) {
        logger.error(
          { group: group.name, stdout, stderr, error: err },
          'Failed to parse local agent output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse local agent output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, processName, error: err },
        'Local agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Local agent spawn error: ${err.message}`,
      });
    });
  });
}
