// Fixed version of your renderer.js with drag and drop issues resolved

let config = { Mappings: {}, exePaths: {} };
let runningProcesses = [];
let iconCache = new Map();

// --- Entry Point ---
window.api.loadConfig().then(data => {
  config = data || { Mappings: {}};
  renderAllKnobsAndApps();
});
loadProcessList();

// --- Data Loading ---
async function loadProcessList() {
  runningProcesses = await window.api.listProcesses();
  renderProcessSearch();
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
  
  // FIXED: Remove existing listeners before adding new ones
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

// FIXED: Extract handlers to prevent memory leaks
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
  
  // FIXED: Use proper event handler functions to prevent duplicates
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

  const apps = config.Mappings[knobId]?.ProcessNames || [];
  if (apps.length === 0) {
    section.appendChild(createEmptyMessage());
  } else {
    apps.forEach(app => {
      section.appendChild(createAppCard(app, knobId));
    });
  }

  return section;
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
    knobSection.appendChild(createAppCard(droppedApp, knobId));
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

    if (mapping.ProcessNames.length === 0) {
      knobSection.appendChild(createEmptyMessage());
      console.log(`[removeAppFromKnob] No apps left, added empty message`);
    }
  } catch (err) {
    console.error('[removeAppFromKnob] UI update failed:', err);
  }
}

// --- Process Search ---
// FIXED: Global reference to current search input to prevent duplicate listeners
let currentSearchInput = null;

function renderProcessSearch() {
  const searchInput = document.getElementById('processSearch');  
  const list = document.getElementById('processList');
  if (!searchInput || !list) return;

  // FIXED: Only replace if it's different to prevent infinite loops
  if (currentSearchInput !== searchInput) {
    // Remove old listener if exists
    if (currentSearchInput) {
      currentSearchInput.oninput = null;
    }
    
    currentSearchInput = searchInput;
    searchInput.oninput = () => updateList(searchInput.value.toLowerCase());
  }
  
  updateList('');

  function updateList(filter) {
    // Clear existing items
    while (list.firstChild) list.removeChild(list.firstChild);

    runningProcesses
      .filter(name => name && name.toLowerCase().includes(filter))
      .forEach(name => {
        const item = document.createElement('div');
        item.textContent = sanitizeAppName(name);
        item.id = `process-item-${name}`;
        item.className = 'px-2 py-1 bg-slate-700 text-indigo-200 rounded cursor-move hover:bg-indigo-600 transition whitespace-nowrap capitalize max-h-8';

        item.setAttribute('draggable', 'true');

        // FIXED: Use proper event handler function
        const dragStartHandler = (e) => {
          console.log("Dragging:", name);
          
          if (!name) {
            e.preventDefault();
            return;
          }
          
          // FIXED: Clear any existing data first
          e.dataTransfer.clearData();
          e.dataTransfer.setData('text/plain', name);
          e.dataTransfer.effectAllowed = 'copy';
          
          // FIXED: Add visual feedback
          item.style.opacity = '0.5';
          
          // Reset opacity after drag
          setTimeout(() => {
            item.style.opacity = '1';
          }, 100);
        };

        item.addEventListener('dragstart', dragStartHandler);

        list.appendChild(item);
      });
  }
}

// --- COM Port Settings ---
async function renderComPortSettings() {
  const select = document.getElementById('comPortSelect');
  if (!select) return;

  const [ports, current] = await Promise.all([
    window.api.listSerialPorts(),
    window.api.getComPort(),
  ]);

  select.className = "w-full p-2 text-sm bg-slate-700 text-indigo-200 rounded border border-slate-600 focus:outline-indigo-500 focus:ring-1 focus:ring-indigo-500";

  select.innerHTML = '';

  if (!ports || ports.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'No ports found';
    opt.disabled = true;
    select.appendChild(opt);
    return;
  }

  // Fix mismatched config port by defaulting to first detected port & update config
  let effectivePort = current;
  if (!current || !ports.some(p => p.path === current)) {
    effectivePort = ports[0].path;
    await window.api.setComPort(effectivePort);
    console.log('[COM port auto-updated to]', effectivePort);
  }

  ports.forEach(port => {
    const opt = document.createElement('option');
    opt.value = port.path;
    opt.textContent = `${port.path} (${port.manufacturer})`;
    if (port.path === effectivePort) opt.selected = true;
    select.appendChild(opt);
  });

  select.onchange = async () => {
    const newPort = select.value;
    await window.api.setComPort(newPort);
    alert(`COM port set to: ${newPort}`);
  };
}

document.getElementById('comPortSelect')?.addEventListener('click', async () => { 
  renderComPortSettings();
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
  showAlert(type, message);
});

function showAlert(type, message) {
  const alertContainer = document.getElementById('alertContainer');
  if (!alertContainer) return;

  const colorMap = {
    success: 'green',
    info: 'blue',
    warning: 'yellow',
    error: 'red'
  };

  const color = colorMap[type] || 'blue';
  const id = `alert-${Date.now()}`;

  const alert = document.createElement('div');
  alert.id = id;
  alert.className = `
    relative w-full max-w-sm px-4 py-2 pr-10
    bg-${color}-100 border border-${color}-200 text-${color}-800
    text-sm font-medium rounded shadow-sm
    opacity-0 translate-y-2
    transition-all duration-300 ease-out
  `.replace(/\s+/g, ' ').trim();

  alert.innerHTML = `
    <span class="block text-center truncate">${message}</span>
    <button onclick="document.getElementById('${id}').remove()"
            class="absolute top-2 right-2 text-${color}-500 hover:text-${color}-700 transition text-base leading-none">
      ×
    </button>
  `;

  alertContainer.appendChild(alert);

  // Trigger the animation on the next tick
  requestAnimationFrame(() => {
    alert.classList.remove('opacity-0', 'translate-y-2');
    alert.classList.add('opacity-100', 'translate-y-0');
  });

  // Auto-dismiss with fade-out
  setTimeout(() => {
    alert.classList.remove('opacity-100', 'translate-y-0');
    alert.classList.add('opacity-0', 'translate-y-2');

    // Remove from DOM after transition
    setTimeout(() => {
      document.getElementById(id)?.remove();
    }, 300);
  }, 4000);
}

// FIXED: Simplified global drag/drop handlers - only prevent file drops
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

// Initialize
setupTabs();
renderComPortSettings();