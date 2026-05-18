const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_DIR = path.join(os.homedir(), '.docgen', 'logs');
const MAX_LOG_FILES = 7;

let currentDate = null;
let logStream = null;

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogPath(date) {
  return path.join(LOG_DIR, `docgen-${date}.log`);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function rotateStream() {
  const d = today();
  if (d === currentDate && logStream) return;
  if (logStream) logStream.end();
  ensureDir();
  currentDate = d;
  logStream = fs.createWriteStream(getLogPath(d), { flags: 'a' });
  pruneOldLogs();
}

function pruneOldLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('docgen-') && f.endsWith('.log'))
      .sort()
      .reverse();
    for (const f of files.slice(MAX_LOG_FILES)) {
      fs.unlinkSync(path.join(LOG_DIR, f));
    }
  } catch {}
}

function write(level, component, message, data) {
  rotateStream();
  const ts = new Date().toISOString();
  let line = `${ts} [${level}] [${component}] ${message}`;
  if (data !== undefined) {
    try {
      const serialized = data instanceof Error
        ? { message: data.message, stack: data.stack }
        : data;
      line += ' ' + JSON.stringify(serialized);
    } catch {}
  }
  line += '\n';
  logStream.write(line);
  if (level === 'ERROR') {
    process.stderr.write(line);
  }
}

const logger = {
  info: (component, message, data) => write('INFO', component, message, data),
  warn: (component, message, data) => write('WARN', component, message, data),
  error: (component, message, data) => write('ERROR', component, message, data),
  logDir: LOG_DIR,
};

module.exports = logger;
