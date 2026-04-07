import { state } from './state.js';
import { cloneConfig } from './config-sync.js';
import { setupTabs, setupSubTabs } from './tabs.js';
import { refreshComPortListPreservingSelection, setupComPortListeners } from './com-port.js';
import { loadAutoStartState, setupAutoStartListener } from './autostart.js';
import { setupSettingsListeners, applyVoiceMeeterUiFromMain, applyInitialBackendStatus } from './settings.js';
import {
  loadProcessList,
  loadInputDevices,
  setupProcessSearchFocus,
} from './sources.js';
import { renderAllKnobsAndApps } from './mappings.js';
import { setupPresets } from './presets.js';
import { setupDeviceHeader, setupNewDeviceButton, setupRemoveDeviceButton } from './device.js';

function setupGlobalFileDropGuards() {
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  document.addEventListener('drop', (e) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
}

function setupMappingDragGlobalDragOver() {
  document.addEventListener(
    'dragover',
    (e) => {
      if (!state.mappingDragActive) return;
      e.preventDefault();
      try {
        e.dataTransfer.dropEffect = 'copy';
      } catch {
        /* ignore */
      }
    },
    true
  );
}

async function bootstrapFromConfig() {
  const data = await window.api.loadConfig();
  state.config = cloneConfig(data || { Mappings: {} });

  await Promise.all([loadProcessList(), loadInputDevices()]);
  await renderAllKnobsAndApps();
  await applyVoiceMeeterUiFromMain();
  await applyInitialBackendStatus();
  await setupDeviceHeader();
}

function init() {
  setupTabs();
  setupSubTabs();
  setupComPortListeners();
  refreshComPortListPreservingSelection();
  setupAutoStartListener();
  loadAutoStartState();
  setupSettingsListeners();
  setupProcessSearchFocus();
  setupGlobalFileDropGuards();
  setupMappingDragGlobalDragOver();
  setupPresets();
  setupNewDeviceButton();
  setupRemoveDeviceButton();
  bootstrapFromConfig();
}

init();
