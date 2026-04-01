const path = require('path');
const { Tray, Menu, app } = require('electron');

const iconPathNormal = path.join(__dirname, '..', 'assets', 'icons', 'icongreen.ico');
const iconPathCrashed = path.join(__dirname, '..', 'assets', 'icons', 'iconred.ico');

let tray = null;

function createTray(mainWindow) {
  tray = new Tray(iconPathNormal);

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

  tray.on('click', () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });

  return tray;
}

function getTray() {
  return tray;
}

function setTrayImageNormal() {
  if (tray) tray.setImage(iconPathNormal);
}

function setTrayImageCrashed() {
  if (tray) tray.setImage(iconPathCrashed);
}

module.exports = {
  createTray,
  getTray,
  setTrayImageNormal,
  setTrayImageCrashed,
  iconPathNormal,
};
