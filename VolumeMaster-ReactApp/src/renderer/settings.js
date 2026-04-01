import { showAlert } from './alerts.js';

export function setupSettingsListeners() {
  document.getElementById('saveAndRunBtn')?.addEventListener('click', async () => {
    await window.api.saveAndRun();
  });

  document.getElementById('vmEnableButton')?.addEventListener('click', async () => {
    const button = document.getElementById('vmEnableButton');
    const isOn = button.textContent.trim().toLowerCase() === 'enabled';
    const newState = !isOn;
    button.dataset.enabled = newState;
    button.textContent = newState ? 'Enabled' : 'Disabled';

    if (newState) {
      button.classList.remove('bg-red-500', 'hover:bg-red-600');
      button.classList.add('bg-green-500', 'hover:bg-green-600');
      await window.api.enableVM();
    } else {
      button.classList.remove('bg-green-500', 'hover:bg-green-600');
      button.classList.add('bg-red-500', 'hover:bg-red-600');
      await window.api.disableVM();
    }
  });

  document.getElementById('vmVersionSelect')?.addEventListener('change', async (e) => {
    await window.api.setVMVersion(e.target.value);
  });

  window.api.onBackendStatus(({ type, message }) => {
    if (type === 'success') {
      document.getElementById('saveAndRunBtn').textContent = 'Stop';
    } else if (type === 'warning') {
      document.getElementById('saveAndRunBtn').textContent = 'Run';
    }
    showAlert(type, message);
  });
}

export async function applyInitialBackendStatus() {
  const running = await window.api.getBackendStatus();
  const btn = document.getElementById('saveAndRunBtn');
  if (btn) btn.textContent = running ? 'Stop' : 'Run';
}

export async function applyVoiceMeeterUiFromMain() {
  const vmEnabled = await window.api.getVMEnabled();
  const vmBtn = document.getElementById('vmEnableButton');
  if (vmBtn) {
    vmBtn.textContent = vmEnabled ? 'Enabled' : 'Disabled';
  }

  const version = await window.api.getVMVersion();
  const vmVersionSelect = document.getElementById('vmVersionSelect');
  if (vmVersionSelect) {
    vmVersionSelect.value = version || 'banana';
  }
}
