const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const http = require('http');
const { fork } = require('child_process');
const { resolveClaudeBinary, getClaudeVersion, clearCache } = require('./claude-resolver');
const log = require('./logger');

let mainWindow;
let serverProcess;
let intentionalQuit = false;

const PORT = process.env.PORT || 3847;

const SPLASH_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: #FAF9F6; color: #2D2D2D;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100vh; -webkit-app-region: drag;
  }
  .icon { font-size: 48px; margin-bottom: 16px; }
  .title { font-size: 22px; font-weight: 600; margin-bottom: 8px; }
  .status { font-size: 14px; color: #8C877D; }
  .spinner { margin-top: 24px; width: 24px; height: 24px; border: 3px solid #EAE8E4;
    border-top-color: #D97757; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head><body>
  <div class="icon">&#9998;</div>
  <div class="title">DocGen</div>
  <div class="status">Starting up...</div>
  <div class="spinner"></div>
</body></html>`;

function startServer() {
  serverProcess = fork(path.join(__dirname, 'server-headless.js'), [], {
    env: { ...process.env, PORT: String(PORT), NO_OPEN: '1' },
    stdio: 'pipe',
  });

  serverProcess.stdout.on('data', (data) => {
    log.info('electron', 'server stdout: ' + data.toString().trim());
  });

  serverProcess.stderr.on('data', (data) => {
    log.warn('electron', 'server stderr: ' + data.toString().trim());
  });

  serverProcess.on('exit', (code, signal) => {
    log.warn('electron', 'server process exited', { code, signal, intentionalQuit });
    if (!intentionalQuit && mainWindow) {
      log.info('electron', 'attempting server restart');
      try {
        startServer();
        waitForServer(10000)
          .then(() => {
            if (mainWindow) mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
          })
          .catch(() => {
            dialog.showErrorBox('DocGen', 'The server crashed and could not be restarted. The app will now close.');
            app.quit();
          });
      } catch {
        dialog.showErrorBox('DocGen', 'The server crashed and could not be restarted. The app will now close.');
        app.quit();
      }
    }
  });
}

function waitForServer(maxWaitMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://127.0.0.1:${PORT}/api/status`, (res) => {
        if (res.statusCode === 200) {
          res.resume();
          return resolve();
        }
        res.resume();
        retry();
      });
      req.on('error', retry);
      req.setTimeout(1000, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - start > maxWaitMs) return reject(new Error('Server failed to start'));
      setTimeout(check, 250);
    };
    check();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#FAF9F6',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    title: 'DocGen',
    show: false,
  });

  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC handlers
ipcMain.handle('get-claude-status', () => {
  const resolved = resolveClaudeBinary();
  const version = resolved.path ? getClaudeVersion(resolved.path) : null;
  return { found: !!resolved.path, path: resolved.path, version, error: resolved.error };
});

ipcMain.handle('refresh-claude-status', () => {
  clearCache();
  const resolved = resolveClaudeBinary();
  const version = resolved.path ? getClaudeVersion(resolved.path) : null;
  return { found: !!resolved.path, path: resolved.path, version, error: resolved.error };
});

process.on('uncaughtException', (err) => {
  log.error('electron', 'uncaught exception', err);
});

process.on('unhandledRejection', (reason) => {
  log.error('electron', 'unhandled rejection', reason instanceof Error ? reason : { reason: String(reason) });
});

app.on('ready', async () => {
  log.info('electron', 'app ready', {
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.version,
    logDir: log.logDir,
  });

  createWindow();
  startServer();

  try {
    await waitForServer();
    log.info('electron', 'server healthy, loading UI');
    mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  } catch (err) {
    log.error('electron', 'server failed to start', err);
    dialog.showErrorBox('DocGen', `Failed to start the server.\n\nCheck logs at: ${log.logDir}`);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  log.info('electron', 'all windows closed, quitting');
  intentionalQuit = true;
  if (serverProcess) serverProcess.kill();
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

app.on('will-quit', () => {
  log.info('electron', 'will-quit');
  intentionalQuit = true;
  if (serverProcess) serverProcess.kill();
});
