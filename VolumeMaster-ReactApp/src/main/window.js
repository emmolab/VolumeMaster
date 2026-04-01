const path = require('path');
const { BrowserWindow } = require('electron');

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    icon: path.join(__dirname, '..', 'assets', 'icons', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('src/renderer.html');

  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });

  return mainWindow;
}

module.exports = { createWindow };
