const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let cached = null;

const COMMON_PATHS = [
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
  path.join(os.homedir(), 'node_modules', '.bin', 'claude'),
];

function resolveClaudeBinary() {
  if (cached) return cached;

  // 1. Explicit env override
  if (process.env.CLAUDE_PATH) {
    if (fs.existsSync(process.env.CLAUDE_PATH)) {
      cached = { path: process.env.CLAUDE_PATH, error: null };
      return cached;
    }
    cached = { path: null, error: `CLAUDE_PATH set to "${process.env.CLAUDE_PATH}" but file does not exist` };
    return cached;
  }

  // 2. which claude
  try {
    const found = execFileSync('which', ['claude'], { encoding: 'utf-8', timeout: 3000 }).trim();
    if (found && fs.existsSync(found)) {
      cached = { path: found, error: null };
      return cached;
    }
  } catch {}

  // 3. Common install locations
  for (const p of COMMON_PATHS) {
    if (fs.existsSync(p)) {
      cached = { path: p, error: null };
      return cached;
    }
  }

  // 4. npm global bin
  try {
    const npmBin = execFileSync('npm', ['bin', '-g'], { encoding: 'utf-8', timeout: 5000 }).trim();
    const npmClaude = path.join(npmBin, 'claude');
    if (fs.existsSync(npmClaude)) {
      cached = { path: npmClaude, error: null };
      return cached;
    }
  } catch {}

  cached = { path: null, error: 'Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code' };
  return cached;
}

function getClaudeVersion(binPath) {
  if (!binPath) return null;
  try {
    const out = execFileSync(binPath, ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function clearCache() {
  cached = null;
}

module.exports = { resolveClaudeBinary, getClaudeVersion, clearCache };
