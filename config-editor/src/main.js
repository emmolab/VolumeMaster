

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');

const fs = require('fs');
const yaml = require('yaml');
const crypto = require('crypto');
const sharp = require('sharp');
const { execSync } = require('child_process');
const { exec } = require('child_process');
const extractIcon = require('extract-file-icon');
const psList = require('ps-list').default;
const kill = require('tree-kill');
const path = require('path');

let mainWindow;
let tray;

// --- Constants & Globals ---
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.yaml');
//fs.mkdirSync(CONFIG_PATH, { recursive: true });

const CACHE_DIR = path.join(app.getPath('userData'), 'iconCache');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'assets','config.yaml');

const exePath = path.join(process.resourcesPath,  'VolumeMaster-Headless.exe');
const exePathCache = new Map();
let configCache = null;
const { SerialPort } = require('serialport');

const iconPathNormal = path.join(__dirname, 'assets', 'icons', 'icongreen.ico');
const iconPathCrashed = path.join(__dirname, 'assets', 'icons', 'iconred.ico');

const trayIconNormal = nativeImage.createFromPath(iconPathNormal);
const trayIconCrashed = nativeImage.createFromPath(iconPathCrashed);

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// --- Utility Functions ---
function cacheFilenameForProgram(programName) {
  const hash = crypto.createHash('sha256').update(programName.trim().toLowerCase()).digest('hex');
  return path.join(CACHE_DIR, `${hash}.png`);
}

function normalizePath(p) {
  try {
    return path.normalize(p).toLowerCase();
  } catch {
    return p.trim().toLowerCase();
  }
}

// --- Config Functions ---
function loadConfig() {
  
  if (!configCache) {
    try {
      const file = fs.readFileSync(CONFIG_PATH, 'utf8');
      configCache = yaml.parse(file);
    } catch {
      const file = fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8')
      configCache = yaml.parse(file);
    }
  }
  return configCache;
}


function saveConfig(data) {
  configCache = data;
  fs.writeFileSync(CONFIG_PATH, yaml.stringify(data), 'utf8');
}

// --- EXE Resolution ---
function findRunningProcessExePath(exeName) {
  try {
    const baseName = path.basename(exeName, '.exe');
    const cmd = `powershell -Command "Get-Process -Name '${baseName}' | Select-Object -ExpandProperty Path"`;
    const output = execSync(cmd, { encoding: 'utf8' }).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    return output[0] || null;
  } catch {
    return null;
  }
}

function findExePath(exeName) {
  if (exePathCache.has(exeName)) return exePathCache.get(exeName);

  const config = loadConfig();
 

  try {
    const output = execSync(`where ${exeName}`, { encoding: 'utf8' })
      .split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (output.length > 0) {
      exePathCache.set(exeName, output[0]);
      return output[0];
    }
  } catch {}

  exePathCache.set(exeName, null);
  return null;
}

// --- Icon Handling ---
async function saveIconToCache(programName, buffer) {
  const filename = cacheFilenameForProgram(programName);
  try {
    await sharp(buffer).png().toFile(filename);
    return filename;
  } catch (err) {
    console.error('Failed to save icon to cache:', err);
    return null;
  }
}

function loadIconFromCache(programName) {
  const filename = cacheFilenameForProgram(programName);
  if (!fs.existsSync(filename)) return null;

  try {
    const data = fs.readFileSync(filename);
    return `data:image/png;base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
}

async function getAppIcon(exeName) {
  if (!exeName || typeof exeName !== 'string') return null;
  const programName = exeName.toLowerCase();

  // Cache check
  const cached = loadIconFromCache(programName);
  if (cached) return cached;

  // Path resolution
  let exePath = findRunningProcessExePath(exeName) || findExePath(exeName);
  if (!exePath) return null;

  exePath = normalizePath(exePath).replace(/\//g, '\\');
  if (!fs.existsSync(exePath)) return null;

  try {
    const buffer = extractIcon(exePath);
    if (!buffer?.length) return null;

    const cachedFile = await saveIconToCache(programName, buffer);
    if (cachedFile && fs.existsSync(cachedFile)) {
      const data = fs.readFileSync(cachedFile);
      return `data:image/png;base64,${data.toString('base64')}`;
    }

    // Fallback to direct buffer
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch (err) {
    console.error('Icon extraction failed:', err);
    return null;
  }
}

// --- IPC Handlers ---
ipcMain.handle('load-config', () => loadConfig());
ipcMain.handle('save-config', (_, data) => saveConfig(data));

ipcMain.handle('open-exe-dialog', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select Executable',
    filters: [{ name: 'Executables', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('get-app-icon', async (_, exeName) => getAppIcon(exeName));

ipcMain.handle('list-processes', async () => {
  try {
    const processes = await psList();
    const exeNames = new Set();
    for (const p of processes) {
      if (p.name.toLowerCase().endsWith('.exe')) {
        exeNames.add(p.name);
      }
    }
    return Array.from(exeNames).sort((a, b) => a.localeCompare(b));
  } catch (err) {
    console.error('Failed to list processes:', err);
    return [];
  }
});

// Serial Port Handling

ipcMain.handle('list-serial-ports', async () => {
  try {
    const ports = await SerialPort.list();
    return ports.map(port => ({
      path: port.path,
      manufacturer: port.manufacturer || 'Unknown',
    }));
  } catch (err) {
    console.error('Failed to list serial ports:', err);
    return [];
  }
});

ipcMain.handle('get-com-port', () => {
  const config = loadConfig();
  return config.comPort || null;
});

ipcMain.handle('set-com-port', (_, port) => {
  const config = loadConfig();
  config.comport = port;
  saveConfig(config);
});


// Backend Process Management
const { spawn } = require('child_process');

let backendProcess = null;


let retryTimeout = null;

function startBackendWithRetry() {
  if (backendProcess) {
    console.log('Backend already running');
    return;
  }

  console.log('Attempting to start backend...');
  backendProcess = spawn(exePath, [], {
  detached: false, 
  stdio: 'pipe',   
  shell: false,  
  cwd: app.getPath('userData')    
});
  if (backendProcess) {
     if (tray) tray.setImage(trayIconNormal);
     console.log('Backend running...');
     sendStatusToRenderer('success', 'Backend started successfully.');
  }
  backendProcess.stdout.on('data', data => {
    console.log(`[Backend stdout] ${data}`);
    sendStatusToRenderer('info', `[Backend stdout] ${data}`);
  });

  backendProcess.stderr.on('data', data => {
    console.error(`[Backend stderr] ${data}`);
    sendStatusToRenderer('error', `[Backend stderr] ${data}`);
  });

  backendProcess.on('error', err => {
    console.error('[Backend error]', err);
    sendStatusToRenderer('error', `Backend error: ${err.message}`);
    scheduleRetry();
  });

  backendProcess.on('close', code => {
    console.log(`[Backend exited with code ${code}]`);
     sendStatusToRenderer('warning', `Backend exited with code ${code}`);
    backendProcess = null;
    scheduleRetry();
  });
}
function sendStatusToRenderer(type, message) {
  const window = BrowserWindow.getAllWindows()[0];
  if (window) {
    window.webContents.send('backend-status', { type, message });
  }
}
function scheduleRetry() {
  if (tray) tray.setImage(trayIconCrashed);

  if (retryTimeout) return; // Already waiting
  console.log('Retrying backend in 5 seconds...');
  retryTimeout = setTimeout(() => {
    retryTimeout = null;
    startBackendWithRetry();
  }, 5000);
}

// Handle manual start via renderer
ipcMain.handle('save-and-run', async () => {
  console.log('[IPC] save-and-run triggered');
  try {
    await killBackendByName("VolumeMaster-Headless.exe");
    await startBackendWithRetry();
  } catch (err) {
    console.error('Error during save-and-run:', err);
  }
});

ipcMain.handle('enable-vm', async () => {
  const config = loadConfig();
  config.VM = true;
  
  saveConfig(config);  
});

ipcMain.handle('disable-vm', async () => {
  const config = loadConfig();
  config.VM = false;
  
  saveConfig(config);  
});

ipcMain.handle('set-vm-version', async (_, version) => {
  const config = loadConfig();
  config.vmversion = version;
  
  saveConfig(config);
});

// --- App Lifecycle ---


function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    icon: path.join(__dirname, 'assets', 'icons', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
     
    },
  });

  mainWindow.loadFile('src/renderer.html');

  // When minimized, hide the window instead of minimizing to taskbar
  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });

  // When user tries to close, hide instead (optional)
  // Uncomment if you want to hide on close instead of quit
  /*
  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  */
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icons', 'icongreen.ico'); // Use your tray icon path
  const trayIcon = nativeImage.createFromPath(iconPath);
  
  tray = new Tray(trayIcon);
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show App',
      click: () => {
        mainWindow.show();
      },
    },
    {
      label: 'Quit',
      click: () => {
        app.isQuiting = true;
        app.quit();
      },
    },
  ]);
  
  tray.setToolTip('VolumeMaster');
  tray.setContextMenu(contextMenu);

  // Restore window on tray icon click
  tray.on('click', () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}

app.whenReady().then(() => {
  
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- Hot Reload ---
try {
	require('electron-reloader')(module);
} catch {}



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



app.on('before-quit', () => {
  killBackendByName("VolumeMaster-Headless.exe");
});

