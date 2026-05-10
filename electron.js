const { app, BrowserWindow, globalShortcut, shell } = require('electron');
const path = require('path');
const { fork } = require('child_process');

let mainWindow;
let serverProcess;

const PORT = 3847;

function startServer() {
  return new Promise((resolve) => {
    // Start the express server as a child process
    serverProcess = fork(path.join(__dirname, 'server-headless.js'), [], {
      env: { ...process.env, PORT: String(PORT), NO_OPEN: '1' },
      stdio: 'pipe',
    });

    serverProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      console.log('[server]', msg.trim());
      if (msg.includes('running at')) resolve();
    });

    serverProcess.stderr.on('data', (data) => {
      console.error('[server]', data.toString().trim());
    });

    // Fallback resolve after 3s
    setTimeout(resolve, 3000);
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
    },
    title: 'DocGen',
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Open external links in default browser, not in Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('ready', async () => {
  await startServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

app.on('will-quit', () => {
  if (serverProcess) serverProcess.kill();
});
