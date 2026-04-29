#!/usr/bin/env node
// PostToolUse hook: runs `eslint --fix` on TS/JS files just edited.
// Non-blocking — exits 0 even if lint fails so the agent can keep going.
// Skips: non-JS/TS files, files outside the project, files in ignore globs.

import { spawnSync } from 'node:child_process';
import { resolve, relative, sep } from 'node:path';
import { existsSync } from 'node:fs';

const projectRoot = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([a-zA-Z]):/, '$1:'));

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(raw || '{}');
    const filePath = data?.tool_input?.file_path;
    if (!filePath) return process.exit(0);
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) return process.exit(0);

    const abs = resolve(filePath);
    const rel = relative(projectRoot, abs);
    if (rel.startsWith('..') || rel.startsWith('node_modules' + sep)) return process.exit(0);
    if (!existsSync(abs)) return process.exit(0);
    // Strict allow-list to prevent shell metachar / flag injection through file paths.
    if (!/^[\w./\\:\-+ ]+$/.test(abs)) return process.exit(0);

    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const result = spawnSync(npxCmd, ['eslint', '--fix', '--', abs], {
      stdio: 'pipe',
      shell: false,
      cwd: projectRoot,
      timeout: 25_000,
      encoding: 'utf8',
    });

    if (result.status !== 0 && result.stdout) {
      // Sanitize stdout — strip control chars to prevent terminal injection.
      const safeOut = String(result.stdout).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      process.stderr.write(`[eslint] ${rel}:\n${safeOut}\n`);
    }
    process.exit(0);
  } catch (err) {
    // L15/L16: log root cause briefly so silent failures aren't invisible.
    process.stderr.write(`[lint-on-edit] ${err && err.message ? err.message : 'error'}\n`);
    process.exit(0);
  }
});
