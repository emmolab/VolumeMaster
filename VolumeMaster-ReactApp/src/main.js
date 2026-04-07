'use strict';

// Electron must be required before any project module so `require('electron')` resolves to the API, not the npm path stub.
const { app, BrowserWindow } = require('electron');

if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'AllowNativeOleApiForDragDrop');
}

const { createWindow } = require('./main/window');
const { createTray } = require('./main/tray');
const { registerIpcHandlers } = require('./main/ipc-handlers');
const { startBackend, killAllBackends } = require('./main/backend-process');
const deviceManager = require('./main/device-manager');

app.whenReady().then(() => {
  deviceManager.migrateIfNeeded();
  registerIpcHandlers();

  const devices = deviceManager.getAllDevices();
  for (const device of devices) {
    createWindow(device.id);
    startBackend(device.id, deviceManager.getDeviceDir(device.id));
  }

  createTray();

  if (process.argv.includes('--hidden')) {
    for (const win of BrowserWindow.getAllWindows()) win.hide();
  }

  app.on('activate', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isVisible()) win.show();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  app.isQuiting = true;
});

app.on('will-quit', (event) => {
  event.preventDefault();
  killAllBackends().finally(() => app.exit(0));
});

try {
  require('electron-reloader')(module);
} catch {}
