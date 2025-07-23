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

  for (const knobId of knobIds) {
    const section = createKnobSection(knobId);
    container.appendChild(section);
  }
}

function createKnobSection(knobId) {
  const section = document.createElement('section');
  section.className = "bg-slate-800 rounded-lg shadow p-4 m-4 flex flex-col w-64 border border-slate-700 grow overflow-y-auto";
  
  section.addEventListener('dragover', e => e.preventDefault());
  section.addEventListener('drop', e => handleDrop(e, knobId));

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
  const card = document.createElement('div');
  card.className = "flex items-center gap-4 mb-3 p-3 rounded border border-gray-300 hover:bg-red-100 cursor-pointer transition overflow-hidden";

  const icon = document.createElement('img');
  icon.alt = app;
  icon.className = "w-10 h-10 rounded sm:hidden md:block";

  const label = document.createElement('div');
  label.id = app;
  label.textContent = sanitizeAppName(app);
  label.className = "text-lg font-medium shrink capitalize text-wrap";

  card.append(icon, label);

  // Remove app on click, then remove card DOM node only
  card.onclick = async () => {
    await removeAppFromKnob(knobId, app);
    card.remove();
  };

  // Use cached icon if available
  if (iconCache.has(app)) {    
    icon.src = iconCache.get(app);
  } else {
    // Fetch icon and cache it, update img src once ready
    getAppIconForApp(app).then(src => {
      const finalSrc = src || 'assets/icons/default.png';
      iconCache.set(app, finalSrc);
      icon.src = finalSrc;
    }).catch(() => {
      icon.src = 'assets/icons/default.png';
    });
  }

  return card;
}


// --- Event Handlers ---
async function handleDrop(event, knobId) {
  event.preventDefault();

  try {
    const droppedApp = event.dataTransfer.getData('text/plain');
    if (!droppedApp) return;

    if (!config.Mappings[knobId]) {
      config.Mappings[knobId] = { ProcessNames: [] };
    } else if (!Array.isArray(config.Mappings[knobId].ProcessNames)) {
      config.Mappings[knobId].ProcessNames = [];
    }

    if (config.Mappings[knobId].ProcessNames.includes(droppedApp)) return;

    // Update data model synchronously
    config.Mappings[knobId].ProcessNames.push(droppedApp);

    // Immediately update UI (append card)
    const container = document.getElementById('knobsAppsContainer');
    const knobSection = [...container.children].find(section =>
      section.querySelector('h2').textContent === `Knob ${knobId}`
    );

    if (!knobSection) return;

    const emptyMsg = knobSection.querySelector('p');
    if (emptyMsg && emptyMsg.textContent === 'No apps mapped.') {
      emptyMsg.remove();
    }

    knobSection.appendChild(createAppCard(droppedApp, knobId));

    // Now save config asynchronously, but don’t await here
    window.api.saveConfig(config).catch(err => {
      console.error('Failed to save config after drop:', err);
    });
  } catch (err) {
    console.error('Drop event failed:', err);
  }
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
  const apps = config.Mappings[knobId]?.ProcessNames;
  if (!apps) return;

  const idx = apps.indexOf(appName);
  if (idx !== -1) {
    apps.splice(idx, 1);
    await window.api.saveConfig(config);

    const container = document.getElementById('knobsAppsContainer');
    const knobSection = [...container.children].find(section => section.querySelector('h2').textContent === `Knob ${knobId}`);
    if (!knobSection) return;

    const card = [...knobSection.children].find(child => {
      const label = child.querySelector('div.text-lg');
      return label && label.id === appName;
    });
    if (card) card.remove();

    // If no apps left, show empty message
    if (apps.length === 0) {
      knobSection.appendChild(createEmptyMessage());
    }
  }
}

// --- Process Search ---


function renderProcessSearch() {
  
  const searchInput = document.getElementById('processSearch');  
  const list = document.getElementById('processList');
  if (!searchInput || !list) return;

  searchInput.oninput = () => updateList(searchInput.value.toLowerCase());
  
  updateList('');

  function updateList(filter) {
    // Replace innerHTML with safer removal
    while (list.firstChild) list.removeChild(list.firstChild);

    runningProcesses
      .filter(name => name.toLowerCase().includes(filter))
      .forEach(name => {
        const item = document.createElement('div');
        item.textContent = sanitizeAppName(name);
        item.id = name;
        item.className = 'px-2 py-1 bg-slate-700 text-indigo-200 rounded cursor-move hover:bg-indigo-600 transition whitespace-nowrap capitalize max-h-8';

        // Use setAttribute for "draggable" instead of property
        item.setAttribute('draggable', 'true');

        // Use addEventListener instead of direct assignment
        item.addEventListener('dragstart', (e) => {
          try {
            e.dataTransfer.setData('text/plain', name);
          } catch (err) {
            console.error('Failed to set drag data:', err);
          }
        });

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



setupTabs();
renderComPortSettings();


