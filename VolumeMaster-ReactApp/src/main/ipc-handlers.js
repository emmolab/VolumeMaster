const util = require('util');
const { SerialPort } = require('serialport');
const portAudio = require('naudiodon');

const { loadConfig, saveConfig, cloneConfigSnapshot } = require('./config-store');
const { getAppIcon } = require('./icon-service');
const { startBackendWithRetry, killBackendByName } = require('./backend-process');

const exec = util.promisify(require('child_process').exec);

function registerIpcHandlers() {
  const { ipcMain, dialog, app } = require('electron');

  ipcMain.handle('load-config', () => cloneConfigSnapshot(loadConfig()));

  ipcMain.handle('save-config', (_, data) => {
    const existing = loadConfig();
    const incoming = data && typeof data === 'object' ? data : {};
    const merged = { ...existing };
    for (const [key, val] of Object.entries(incoming)) {
      if (val !== undefined) merged[key] = val;
    }
    merged.vm = existing.vm;
    merged.vmversion = existing.vmversion;
    merged.presets = existing.presets;
    saveConfig(merged);
    return cloneConfigSnapshot(loadConfig());
  });

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
      const { stdout } = await exec(
        `powershell -NoProfile -Command "Get-Process | Select-Object ProcessName, MainWindowTitle"`,
        { encoding: 'utf8' }
      );

      const seen = new Map();

      stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(2)
        .forEach((line) => {
          const parts = line.split(/\s{2,}/);
          const name = parts[0];
          const windowTitle = parts[1] || '';
          const exeName = name.endsWith('.exe') ? name : `${name}.exe`;

          const existing = seen.get(exeName);
          if (!existing || (!existing.isGUI && windowTitle !== '')) {
            seen.set(exeName, { name: exeName, isGUI: windowTitle !== '' });
          }
        });

      return [...seen.values()];
    } catch (err) {
      console.error('Failed to list processes:', err);
      return [];
    }
  });

  ipcMain.handle('list-serial-ports', async () => {
    try {
      const ports = await SerialPort.list();
      return ports.map((port) => ({
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
    return config.comport || null;
  });

  ipcMain.handle('set-com-port', (_, port) => {
    const config = loadConfig();
    config.comport = port;
    saveConfig(config);
  });

  ipcMain.handle('save-and-run', async () => {
    console.log('[IPC] save-and-run triggered');
    try {
      await killBackendByName('VolumeMaster-Headless.exe');
      await startBackendWithRetry();
    } catch (err) {
      console.error('Error during save-and-run:', err);
    }
  });

  ipcMain.handle('enable-vm', async () => {
    const config = loadConfig();
    config.vm = true;
    saveConfig(config);
  });

  ipcMain.handle('disable-vm', async () => {
    const config = loadConfig();
    config.vm = false;
    saveConfig(config);
  });

  ipcMain.handle('get-vm-enabled', () => {
    const config = loadConfig();
    const vmEnabled =
      config.vm === true || (typeof config.vm === 'string' && config.vm.toLowerCase() === 'true');
    return vmEnabled;
  });

  ipcMain.handle('set-vm-version', async (_, version) => {
    const config = loadConfig();
    config.vmversion = version;
    saveConfig(config);
  });

  ipcMain.handle('get-vm-version', () => {
    const config = loadConfig();
    return config.vmversion || 'banana';
  });

  ipcMain.handle('get-auto-start', () => {
    return app.getLoginItemSettings({
      path: app.getPath('exe'),
      args: ['--hidden'],
    }).openAtLogin;
  });

  ipcMain.handle('set-auto-start', (event, enabled) => {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: app.getPath('exe'),
      args: ['--hidden'],
    });
    console.log('[AutoStart] set:', app.getPath('exe'), enabled);
    return true;
  });

  ipcMain.handle('list-input-devices', async () => {
    const devices = portAudio.getDevices();
    const cleanDevices = devices
      .filter((d) => d.maxInputChannels > 0 && d.hostAPIName === 'Windows WASAPI')
      .map((d) => d.name);
    return [...new Set(cleanDevices)];
  });

  ipcMain.handle('list-presets', () => {
    const config = loadConfig();
    return Object.keys(config.presets || {});
  });

  ipcMain.handle('save-preset', (_, name, mappings) => {
    if (!name || typeof name !== 'string') return;
    const config = loadConfig();
    if (!config.presets || typeof config.presets !== 'object') config.presets = {};
    config.presets[name] = JSON.parse(JSON.stringify(mappings));
    saveConfig(config);
  });

  ipcMain.handle('load-preset', (_, name) => {
    const config = loadConfig();
    const preset = config.presets?.[name];
    if (!preset) return null;
    return JSON.parse(JSON.stringify(preset));
  });

  ipcMain.handle('delete-preset', (_, name) => {
    const config = loadConfig();
    if (config.presets?.[name] !== undefined) {
      delete config.presets[name];
      saveConfig(config);
    }
  });
}

module.exports = { registerIpcHandlers };
