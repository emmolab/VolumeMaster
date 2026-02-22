
let config = { Mappings: {}, exePaths: {} };
let runningProcesses = [];
let inputDevices = [];

let iconCache = new Map();

// --- Entry Point ---
window.api.loadConfig().then(async (data) => {
  config = data || { Mappings: {}};
  
  await Promise.all([loadProcessList(), loadInputDevices()]);
  renderAllKnobsAndApps();

  window.api.getVMEnabled().then(enabled => {
    document.getElementById('vmEnableButton').textContent = enabled ? "Enabled" : "Disabled";
  });

  window.api.getVMVersion().then(version => {
    const vmVersionSelect = document.getElementById('vmVersionSelect');
    if (vmVersionSelect) {
      vmVersionSelect.value = version || 'banana';
    }
  });
});


// --- Data Loading ---
async function loadProcessList() {
  runningProcesses = await window.api.listProcesses();
  renderProcessSearch();
}

async function loadInputDevices() {
  inputDevices = await window.api.getInputDevices();
  renderInputDeviceList();
}



document.getElementById('processSearch')?.addEventListener('focus', async () => {
  await loadProcessList();
  document.getElementById('processSearch').value = '';
});

// --- Rendering ---
async function renderAllKnobsAndApps() {
  const container = document.getElementById('knobsAppsContainer');
  container.innerHTML = '';

  const knobIds = Object.keys(config.Mappings);
  if (knobIds.length === 0) {
    container.textContent = 'No knobs configured.';
    container.className = 'text-gray-400';
    return;
  }

  container.className = 'flex space-x-4 overflow-x-auto pb-2 mb-4';
  
  // Remove existing listeners before adding new ones
  container.removeEventListener('dragover', containerDragOver);
  container.removeEventListener('drop', containerDrop);
  
  // Add clean event listeners
  container.addEventListener('dragover', containerDragOver);
  container.addEventListener('drop', containerDrop);

  for (const knobId of knobIds) {
    const section = createKnobSection(knobId);
    container.appendChild(section);
  }
}

// Extract handlers to prevent memory leaks
function containerDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
}

function containerDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  // Find the closest knob section
  const target = e.target.closest('section[id^="knob-section-"]');
  if (target) {
    const knobId = target.id.replace('knob-section-', '');
    handleDrop(e, knobId);
  }
}

function createKnobSection(knobId) {
  const section = document.createElement('section');
  section.id = `knob-section-${knobId}`;
  section.className = "bg-slate-800 rounded-lg shadow p-4 m-4 flex flex-col w-64 border border-slate-700 grow overflow-y-auto";
  
  // Use proper event handler functions to prevent duplicates
  const sectionHandlers = {
    dragover: (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      section.style.backgroundColor = 'rgba(99, 102, 241, 0.1)';
    },
    
    dragenter: (e) => {
      e.preventDefault();
      e.stopPropagation();
    },
    
    dragleave: (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!section.contains(e.relatedTarget)) {
        section.style.backgroundColor = '';
      }
    },
    
    drop: (e) => {
      e.preventDefault();
      e.stopPropagation();
      section.style.backgroundColor = '';
      handleDrop(e, knobId);
    }
  };
  
  // Add all handlers
  Object.entries(sectionHandlers).forEach(([event, handler]) => {
    section.addEventListener(event, handler);
  });

  section.appendChild(createKnobHeader(knobId));
  
  // Add Master Volume button to each knob section
  section.appendChild(createMasterVolumeButton(knobId));
  const apps = config.Mappings[knobId]?.ProcessNames || [];
  
  if (apps.length === 0) {
    section.appendChild(createEmptyMessage());
  } else {
    apps.forEach(app => {
      if (app === 'master') {
        // Show master volume card for 'master' entry
        section.appendChild(createVolumeCard(knobId, "🔊", "Master Volume"));
      } else if (inputDevices.includes(app)) {
        section.appendChild(createInputDeviceCard(app, knobId));
      } else {
        section.appendChild(createAppCard(app, knobId));
      }
    });
  }

  return section;
}

// Create Master Volume button
function createMasterVolumeButton(knobId) {
  const button = document.createElement('button');
  const apps = config.Mappings[knobId]?.ProcessNames || [];
  const hasMasterVolume = apps.includes('master');
  
  button.textContent = 'Add Master Volume';
  button.className = 'w-full mb-3 py-2 px-3 text-sm font-medium rounded transition bg-indigo-600 hover:bg-indigo-700 text-white';
  
  // Hide button if master volume already exists
  if (hasMasterVolume) {
    button.style.display = 'none';
  }
  
  button.onclick = async () => {
    await addMasterVolume(knobId);
  };
  
  return button;
}

// Create Master Volume indicator card
function createVolumeCard(knobId, iconText, labelTest) {
  const card = document.createElement('div');
  card.className = "flex items-center gap-4 mb-3 p-3 rounded border border-indigo-400 bg-indigo-900 bg-opacity-30 cursor-pointer transition overflow-hidden";
  card.setAttribute('data-appname', 'master'); // Use data-appname like regular apps
  
  const icon = document.createElement('div');
  icon.className = "w-10 h-10 rounded bg-indigo-500 flex items-center justify-center text-white font-bold text-lg";
  icon.textContent = iconText;
  
  const label = document.createElement('div');
  label.textContent = labelTest;
  label.className = "text-lg font-medium text-indigo-300";

  card.append(icon, label);

  // Remove master volume on click (same as regular apps)
  card.onclick = async () => {
    console.log(`[createVolumeCard] Removing master volume from knob ${knobId}`);
    await removeAppFromKnob(knobId, 'master');
    card.remove();
  };

  return card;
}






// Add Master Volume function
async function addMasterVolume(knobId) {
  try {
    // Ensure mapping structure exists
    if (!config.Mappings[knobId]) {
      config.Mappings[knobId] = { ProcessNames: [] };
    }

    const mapping = config.Mappings[knobId];
    
    if (!Array.isArray(mapping.ProcessNames)) {
      mapping.ProcessNames = [];
    }

    // Check if master volume already exists
    if (mapping.ProcessNames.includes('master')) {
      console.warn(`[addMasterVolume] Master volume already exists for knob ${knobId}`);
      return;
    }
    
    // Add master to ProcessNames
    mapping.ProcessNames.push('master');
    
    console.log(`[addMasterVolume] Added master volume to knob ${knobId}`);
    
    // Update UI
    const knobSection = document.getElementById(`knob-section-${knobId}`);
    if (!knobSection) {
      console.warn(`[addMasterVolume] No section found for knob ${knobId}`);
      return;
    }

    // Hide the Add Master Volume button
    const button = knobSection.querySelector('button');
    if (button) {
      button.style.display = 'none';
    }

    // Remove empty message if it exists
    const emptyMsg = knobSection.querySelector('p');
    if (emptyMsg?.textContent === 'No apps mapped.') {
      emptyMsg.remove();
    }

    // Add master volume card
    const masterVolumeCard = createVolumeCard(knobId, "🔊", "Master Volume");
    const button_element = knobSection.querySelector('button');
    button_element.parentNode.insertBefore(masterVolumeCard, button_element.nextSibling);

    // Save config
    await window.api.saveConfig(config);
    
    console.log(`[addMasterVolume] Master volume added for knob ${knobId}`);
    
  } catch (err) {
    console.error('[addMasterVolume] Error:', err);
  }
}

function createKnobHeader(knobId) {
  const header = document.createElement('h2');
  header.textContent = `Knob ${knobId}`;
  header.className = "text-indigo-400 text-xl font-bold mb-4";
  return header;
}

function createEmptyMessage() {
  const msg = document.createElement('p');
  msg.textContent = 'No apps mapped.';
  msg.className = "text-slate-400 italic";
  return msg;
}

function sanitizeAppName(name) {
  return name.replace(/([A-Z]+)/g, ' $1').replace('.exe', '').trim();
}

function createAppCard(app, knobId) {
  console.log(`[createAppCard] Creating card for app: ${app} on knob ${knobId}`);

  const card = document.createElement('div');
  card.className = "flex items-center gap-4 mb-3 p-3 rounded border border-gray-300 hover:bg-red-100 cursor-pointer transition overflow-hidden";
  card.setAttribute('data-appname', app);
  
  const icon = document.createElement('img');
  icon.alt = app;
  icon.className = "w-10 h-10 rounded sm:hidden md:block";
  card.classList.add('app-card');
  
  const label = document.createElement('div');
  label.id = app;
  label.textContent = sanitizeAppName(app);
  label.className = "text-lg font-medium shrink capitalize text-wrap";

  card.append(icon, label);

  // Remove app on click, then remove card DOM node only
  card.onclick = async () => {
    console.log(`[createAppCard] Removing app ${app} from knob ${knobId}`);
    await removeAppFromKnob(knobId, app);
    card.remove();
  };

  if (iconCache.has(app)) {
    icon.src = iconCache.get(app);
  } else {
    getAppIconForApp(app).then(src => {
      const finalSrc = src || 'assets/icons/default.png';
      iconCache.set(app, finalSrc);
      icon.src = finalSrc;
      console.log(`[createAppCard] Icon loaded for ${app}`);
    }).catch(() => {
      icon.src = 'assets/icons/default.png';
      console.warn(`[createAppCard] Failed to load icon for ${app}`);
    });
  }

  return card;
}

// --- Event Handlers ---
async function handleDrop(event, knobId) {
  event.preventDefault();
  event.stopPropagation();
  console.log(`[handleDrop] Dropping on knob ${knobId}`);

  // Safety check
  if (!knobId) {
    console.warn('[handleDrop] knobId is undefined or invalid');
    return;
  }

  let droppedApp;
  try {
    droppedApp = event.dataTransfer.getData('text/plain');
    console.log(`[handleDrop] droppedApp: "${droppedApp}"`);
  } catch (err) {
    console.error('[handleDrop] Failed to read dropped data:', err);
    return;
  }

  if (!droppedApp) {
    console.warn('[handleDrop] No app data found in drop');
    return;
  }

  try {
    // Ensure mapping structure exists
    if (!config.Mappings[knobId]) {
      config.Mappings[knobId] = { ProcessNames: [] };
    }

    const mapping = config.Mappings[knobId];

    if (!Array.isArray(mapping.ProcessNames)) {
      mapping.ProcessNames = [];
    }

    // Avoid duplicate
    if (mapping.ProcessNames.includes(droppedApp)) {
      console.warn(`[handleDrop] "${droppedApp}" already mapped to knob ${knobId}`);
      return;
    }

    // Don't allow dropping 'master' - use the button instead
    if (droppedApp === 'master') {
      console.warn(`[handleDrop] Cannot drop 'master' - use Add Master Volume button`);
      return;
    }

    // Update config
    mapping.ProcessNames.push(droppedApp);
    console.log(`[handleDrop] Updated config:`, mapping.ProcessNames);
  } catch (err) {
    console.error('[handleDrop] Error updating config:', err);
    return;
  }

  try {
    // Update UI
    const knobSection = document.getElementById(`knob-section-${knobId}`);
    if (!knobSection) {
      console.warn(`[handleDrop] No section found for knob ${knobId}`);
      return;
    }

    const existingCard = knobSection.querySelector(`[data-appname="${droppedApp}"]`);
    if (existingCard) {
      console.warn(`[handleDrop] Card for "${droppedApp}" already exists in DOM`);
      return;
    }

    const emptyMsg = knobSection.querySelector('p');
    if (emptyMsg?.textContent === 'No apps mapped.') {
      emptyMsg.remove();
      console.log('[handleDrop] Removed empty message');
    }

    // Append new app card
    // Append new app card
    const isInputDevice = inputDevices.includes(droppedApp);
    const card = isInputDevice
      ? createInputDeviceCard(droppedApp, knobId)
      : createAppCard(droppedApp, knobId);
    knobSection.appendChild(card);
    console.log('[handleDrop] App card created and added');
  } catch (err) {
    console.error('[handleDrop] Error updating UI:', err);
    return;
  }

  // Save config async
  window.api.saveConfig(config).catch(err => {
    console.error('[handleDrop] Failed to save config:', err);
  });
}

// --- Helpers ---
async function getAppIconForApp(app) {
  if (!app) return 'assets/icons/default.png';

  const userPath = config.exePaths?.[app.toLowerCase()];
  if (userPath) {
    const icon = await window.api.getAppIcon(userPath);
    if (icon) return icon;
  }

  const fallback = await window.api.getAppIcon(app);
  return fallback || 'assets/icons/default.png';
}

async function removeAppFromKnob(knobId, appName) {
  const mapping = config.Mappings[knobId];
  if (!mapping || !Array.isArray(mapping.ProcessNames)) return;

  const idx = mapping.ProcessNames.indexOf(appName);
  if (idx === -1) return;

  // Remove from config and persist
  mapping.ProcessNames.splice(idx, 1);
  await window.api.saveConfig(config);

  try {
    const knobSection = document.getElementById(`knob-section-${knobId}`);
    if (!knobSection) {
      console.warn(`[removeAppFromKnob] No section for knob ${knobId}`);
      return;
    }

    const card = knobSection.querySelector(`[data-appname="${appName}"]`);
    if (card) {
      card.remove();
      console.log(`[removeAppFromKnob] Removed card for "${appName}"`);
    }

    // Show Add Master Volume button if master was removed
    if (appName === 'master') {
      const button = knobSection.querySelector('button');
      if (button) {
        button.style.display = 'block';
      }
    }

    // Show empty message if no apps left
    if (mapping.ProcessNames.length === 0) {
      knobSection.appendChild(createEmptyMessage());
      console.log(`[removeAppFromKnob] No apps left, added empty message`);
    }
  } catch (err) {
    console.error('[removeAppFromKnob] UI update failed:', err);
  }
}

// --- Process Search ---
// Global reference to current search input to prevent duplicate listeners
let currentSearchInput = null;
function renderProcessSearch() {
  const searchInput = document.getElementById('processSearch');
  const filterSelect = document.getElementById('processFilter');
  const list = document.getElementById('processList');
  if (!searchInput || !list || !filterSelect) return;
  function applyFilters() {
    const searchValue = searchInput.value.toLowerCase();
    const filterValue = filterSelect.value;
    updateList(searchValue, filterValue);
  }
  applyProcessFilters = applyFilters; // expose globally
  searchInput.oninput = applyFilters;
  filterSelect.onchange = applyFilters;
  applyFilters();
  function updateList(searchFilter, typeFilter) {
    while (list.firstChild) list.removeChild(list.firstChild);
    runningProcesses
      .filter(proc => {
        if (!proc || !proc.name) return false;
        const matchesSearch =
          proc.name.toLowerCase().includes(searchFilter);
        const matchesType =
          typeFilter === 'all' ||
          (typeFilter === 'gui' && proc.isGUI);
        return matchesSearch && matchesType;
      })
      .forEach(proc => {
        const item = document.createElement('div');
        item.textContent = sanitizeAppName(proc.name);
        item.id = `process-item-${proc.name}`;
        item.className =
          'px-2 py-1 bg-slate-700 text-indigo-200 rounded cursor-move hover:bg-indigo-600 transition whitespace-nowrap capitalize max-h-8';
        item.setAttribute('draggable', 'true');
        item.addEventListener('dragstart', (e) => {
          e.dataTransfer.clearData();
          e.dataTransfer.setData('text/plain', proc.name);
          e.dataTransfer.effectAllowed = 'copy';
          item.style.opacity = '0.5';
          setTimeout(() => (item.style.opacity = '1'), 100);
        });
        list.appendChild(item);
      });
  }
}

function renderInputDeviceList() {
  const list = document.getElementById('inputDeviceList');
  if (!list) return;
  while (list.firstChild) list.removeChild(list.firstChild);
  if (!inputDevices || !inputDevices.length) return;

  inputDevices.forEach((name, index) => {
    const card = document.createElement('div');
    card.id = `input-device-${index}`;
    card.className = 'flex items-center gap-3 px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg cursor-move hover:bg-indigo-600 hover:border-indigo-500 transition group';
    card.setAttribute('draggable', 'true');

    const icon = document.createElement('div');
    icon.className = 'w-8 h-8 rounded-md bg-slate-600 group-hover:bg-indigo-500 flex items-center justify-center text-lg shrink-0 transition';
    icon.textContent = '🎤';

    const label = document.createElement('div');
    label.className = 'text-sm text-indigo-200 group-hover:text-white truncate transition';
    label.textContent = name;

    card.append(icon, label);

    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.clearData();
      e.dataTransfer.setData('text/plain', name);
      e.dataTransfer.effectAllowed = 'copy';
      card.style.opacity = '0.5';
      setTimeout(() => card.style.opacity = '1', 100);
    });

    list.appendChild(card);
  });
}

function createInputDeviceCard(name, knobId) {
  const card = document.createElement('div');
  card.className = "flex items-center gap-4 mb-3 p-3 rounded border border-gray-300 hover:bg-red-100 cursor-pointer transition overflow-hidden";
  card.setAttribute('data-appname', name);

  const icon = document.createElement('div');
  icon.className = "w-10 h-10 rounded bg-slate-600 flex items-center justify-center text-xl";
  icon.textContent = '🎤';

  const label = document.createElement('div');
  label.textContent = name;
  label.className = "text-lg font-medium shrink capitalize text-wrap";

  card.append(icon, label);

  card.onclick = async () => {
    await removeAppFromKnob(knobId, name);
    card.remove();
  };

  return card;
}
// --- COM Port Settings ---
async function refreshComPortListPreservingSelection() {
  const select = document.getElementById('comPortSelect');
  if (!select) return;

  const selectedValue = select.value;
  const [ports, savedPort] = await Promise.all([
    window.api.listSerialPorts(),
    window.api.getComPort(),
  ]);


  select.innerHTML = '';

  if (!ports || ports.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'No ports found';
    opt.disabled = true;
    select.appendChild(opt);
    return;
  }

   // Determine what should be selected
  let effectivePort = null;
  

  // Prefer saved config
  console.log(ports.some(p => p.path == savedPort), savedPort, selectedValue);
  if (ports.some(p => p.path == savedPort)) {
    effectivePort = savedPort;
 } 
  // Otherwise, prefer user’s current dropdown selection (if any)
  else if (ports.some(p => p.path == selectedValue)) {
    effectivePort = selectedValue;
  } 
  // Otherwise fallback
  else {
    effectivePort = ports[0].path;
    await window.api.setComPort(effectivePort);
    console.log('[COM port fallback]', effectivePort);
  }
  ports.forEach(port => {
    const opt = document.createElement('option');
    opt.value = port.path;
    opt.textContent = `${port.path}${port.manufacturer ? ` (${port.manufacturer})` : ''}`;
    if (port.path === effectivePort) opt.selected = true;
    select.appendChild(opt);
  });

 
}
// Set port on manual change
document.getElementById('comPortSelect')?.addEventListener('change', async (e) => {
  const newPort = e.target.value;
  await window.api.setComPort(newPort);
  console.log('[Renderer] COM port updated to:', newPort);
});

// Auto-refresh list when user focuses (clicks or tabs into) the dropdown
document.getElementById('comPortSelect')?.addEventListener('focus', () => {
  refreshComPortListPreservingSelection();
});


// --- Tabs ---
function setupTabs() {
  const tabs = {
    tabMappings: document.getElementById('tabContentMappings'),
    tabSettings: document.getElementById('tabContentSettings'),
  };

  const buttons = {
    tabMappings: document.getElementById('tabMappings'),
    tabSettings: document.getElementById('tabSettings'),
  };

  Object.entries(buttons).forEach(([id, btn]) => {
    btn.classList.add('cursor-pointer', 'text-gray-400', 'hover:text-indigo-400', 'transition');

    btn.addEventListener('click', () => {
      Object.entries(tabs).forEach(([tabId, content]) => {
        const isActive = tabId === id;
        content.classList.toggle('hidden', !isActive);
        buttons[tabId].classList.toggle('border-b-2', isActive);
        buttons[tabId].classList.toggle('border-indigo-400', isActive);
        buttons[tabId].classList.toggle('text-indigo-400', isActive);
        buttons[tabId].classList.toggle('text-gray-400', !isActive);
      });
    });
  });

  // Initialize to first tab active
  buttons.tabMappings.click();
}

function setupSubTabs() {
  const panels = {
    subTabApps: document.getElementById('subContentApps'),
    subTabDevices: document.getElementById('subContentDevices'),
  };

  const buttons = {
    subTabApps: document.getElementById('subTabApps'),
    subTabDevices: document.getElementById('subTabDevices'),
  };

  Object.entries(buttons).forEach(([id, btn]) => {
    btn.addEventListener('click', () => {
      Object.entries(panels).forEach(([panelId, content]) => {
        const isActive = panelId === id;
        content.classList.toggle('hidden', !isActive);
        buttons[panelId].classList.toggle('border-b-2', isActive);
        buttons[panelId].classList.toggle('border-indigo-400', isActive);
        buttons[panelId].classList.toggle('text-indigo-400', isActive);
        buttons[panelId].classList.toggle('text-slate-500', !isActive);
      });
    });
  });
}

document.getElementById('saveAndRunBtn')?.addEventListener('click', async () => {
  await window.api.saveAndRun();  
});

document.getElementById('vmEnableButton')?.addEventListener('click', async () => {
  const button = document.getElementById('vmEnableButton');
  
  // Determine the current state from text or dataset
  const isOn = button.textContent.trim().toLowerCase() === "enabled";

  const newState = !isOn;
  button.dataset.enabled = newState;

  button.textContent = newState ? "Enabled" : "Disabled";

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
  const selectedVersion = e.target.value;
  await window.api.setVMVersion(selectedVersion);
});

window.api.onBackendStatus(({ type, message }) => {
  if (type == 'success') {
    document.getElementById('saveAndRunBtn').textContent = "Click to stop";
  } else if (type == 'warning') {
    document.getElementById('saveAndRunBtn').textContent = "Save and Run";
  }
  showAlert(type, message);
});

function showAlert(type, message) {
  const alertContainer = document.getElementById('alertContainer');
  if (!alertContainer) return;

  const colorStyles = {
    success: { bg: 'rgba(20, 83, 45, 0.8)',   border: '#15803d', text: '#bbf7d0' },
    info:    { bg: 'rgba(30, 58, 138, 0.8)',  border: '#1d4ed8', text: '#bfdbfe' },
    warning: { bg: 'rgba(113, 63, 18, 0.8)', border: '#b45309', text: '#fde68a' },
    error:   { bg: 'rgba(127, 29, 29, 0.8)', border: '#b91c1c', text: '#fecaca' },
  };

  const style = colorStyles[type] || colorStyles.info;
  const id = `alert-${Date.now()}`;

  const alert = document.createElement('div');
  alert.id = id;
  alert.className = `
    relative w-full px-4 py-2 pr-10
    text-sm font-medium rounded shadow-sm border
    opacity-0 translate-y-2
    transition-all duration-300 ease-out
  `.replace(/\s+/g, ' ').trim();

  alert.style.backgroundColor = style.bg;
  alert.style.borderColor = style.border;
  alert.style.color = style.text;
  alert.style.backdropFilter = 'blur(4px)';

  alert.innerHTML = `
    <span class="block text-center truncate">${message}</span>
    <button onclick="document.getElementById('${id}').remove()"
            class="absolute top-2 right-2 hover:opacity-70 transition text-base leading-none">
      ×
    </button>
  `;

  alert.style.cursor = 'pointer';
  let expanded = false;
  const messageSpan = alert.querySelector('span');
  alert.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') return; // don't trigger on close button
    expanded = !expanded;
    messageSpan.classList.toggle('truncate', !expanded);
    messageSpan.classList.toggle('whitespace-normal', expanded);
    messageSpan.classList.toggle('break-words', expanded);
  });

  alertContainer.appendChild(alert);

  requestAnimationFrame(() => {
    alert.classList.remove('opacity-0', 'translate-y-2');
    alert.classList.add('opacity-100', 'translate-y-0');
  });

  setTimeout(() => {
    alert.classList.remove('opacity-100', 'translate-y-0');
    alert.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => document.getElementById(id)?.remove(), 300);
  }, 4000);
}
// Simplified global drag/drop handlers - only prevent file drops
document.addEventListener('dragover', (e) => {
  // Only prevent if it's a file being dragged from outside
  if (e.dataTransfer.types.includes('Files')) {
    e.preventDefault();
    e.stopPropagation();
  }
});

document.addEventListener('drop', (e) => {
  // Only prevent if it's a file being dragged from outside
  if (e.dataTransfer.types.includes('Files')) {
    e.preventDefault();
    e.stopPropagation();
  }
});

//AutoStart
async function loadAutoStartState() {
  const autoStartCheckbox = document.getElementById('autoStartCheckbox');
  if (!autoStartCheckbox) return;

  try {
    const enabled = await window.api.getAutoStart();
    autoStartCheckbox.checked = enabled;
  } catch (err) {
    console.error('AutoStart load failed:', err);
  }
}

function setupAutoStartListener() {
  const autoStartCheckbox = document.getElementById('autoStartCheckbox');
  if (!autoStartCheckbox) return;

  autoStartCheckbox.addEventListener('change', async () => {
    try {
      await window.api.setAutoStart(autoStartCheckbox.checked);
    } catch (err) {
      console.error('AutoStart update failed:', err);
    }
  });
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupSubTabs()
  refreshComPortListPreservingSelection();
  setupAutoStartListener();
  loadAutoStartState();
  
});