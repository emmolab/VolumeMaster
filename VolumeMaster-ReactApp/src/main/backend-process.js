const path = require('path');
const util = require('util');
const { spawn, exec } = require('child_process');
const { app, BrowserWindow } = require('electron');

const { setTrayImageNormal, setTrayImageCrashed } = require('./tray');

const headlessExePath = path.join(process.resourcesPath, 'VolumeMaster-Headless.exe');

let backendProcess = null;
let retryTimeout = null;

function sendStatusToRenderer(type, message) {
  const window = BrowserWindow.getAllWindows()[0];
  if (window) {
    window.webContents.send('backend-status', { type, message });
  }
}

function scheduleRetry() {
  setTrayImageCrashed();

  if (retryTimeout) return;
  console.log('Retrying backend in 5 seconds...');
  retryTimeout = setTimeout(() => {
    retryTimeout = null;
    startBackendWithRetry();
  }, 5000);
}

function startBackendWithRetry() {
  if (backendProcess) {
    console.log('Backend already running');
    return;
  }

  console.log('Attempting to start backend...');
  backendProcess = spawn(headlessExePath, [], {
    detached: false,
    stdio: 'pipe',
    shell: false,
    cwd: app.getPath('userData'),
  });

  if (backendProcess) {
    setTrayImageNormal();
    console.log('Backend running...');
    sendStatusToRenderer('success', 'Backend started successfully.');
  }

  backendProcess.stdout.on('data', (data) => {
    console.log(`[Backend stdout] ${data}`);
    sendStatusToRenderer('info', `[Backend stdout] ${data}`);
  });

  backendProcess.stderr.on('data', (data) => {
    console.error(`[Backend stderr] ${data}`);
    sendStatusToRenderer('error', `[Backend stderr] ${data}`);
    setTrayImageCrashed();
    scheduleRetry();
  });

  backendProcess.on('error', (err) => {
    console.error('[Backend error]', err);
    sendStatusToRenderer('error', `Backend error: ${err.message}`);
    setTrayImageCrashed();
    scheduleRetry();
  });

  backendProcess.on('close', (code) => {
    console.log(`[Backend exited with code ${code}]`);
    sendStatusToRenderer('warning', `Backend exited with code ${code}`);
    backendProcess = null;
    setTrayImageCrashed();
  });
}

function killBackendByName(name = 'VolumeMaster-Headless.exe') {
  return new Promise((resolve) => {
    exec(`taskkill /IM ${name} /F`, (err, stdout, stderr) => {
      if (err) {
        if (
          stderr.includes('not found') ||
          stderr.includes('No instance') ||
          stderr.includes('not running')
        ) {
          console.log(`No running ${name} processes found.`);
        } else {
          console.error(`Failed to kill ${name}:`, err);
        }
      } else {
        console.log(`${name} killed:`, stdout.trim());
      }
      resolve();
    });
  });
}

module.exports = {
  startBackendWithRetry,
  sendStatusToRenderer,
  killBackendByName,
  getBackendProcess: () => backendProcess,
};
