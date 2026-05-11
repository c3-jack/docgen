const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

let mainWindow;

const PORT = process.env.PORT || 3847;

function startServer() {
  return new Promise((resolve) => {
    // Run server in-process (fork doesn't work inside asar)
    process.env.PORT = String(PORT);
    process.env.NO_OPEN = '1';
    require('./server.js');

    // Poll until the server is listening
    const check = () => {
      const http = require('http');
      const req = http.get(`http://localhost:${PORT}`, () => {
        resolve();
      });
      req.on('error', () => setTimeout(check, 100));
      req.end();
    };
    setTimeout(check, 200);

    // Fallback resolve after 5s
    setTimeout(resolve, 5000);
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
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
