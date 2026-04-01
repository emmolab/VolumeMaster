const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'assets', 'config.yaml');

const STRINGIFY_OPTIONS = {
  lineWidth: 0,
  aliasDuplicateObjects: false,
};

let configCache = null;

function configPath() {
  return path.join(require('electron').app.getPath('userData'), 'config.yaml');
}

/**
 * YAML may parse merge keys / aliases so multiple knobs share one ProcessNames or MicNames array.
 * That breaks drag/drop (includes()/DOM get out of sync). Force independent arrays per knob.
 */
function coerceNameList(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (x == null ? '' : String(x).trim()))
    .filter(Boolean);
}

function detachMappingArrays(cfg) {
  if (!cfg || typeof cfg !== 'object' || !cfg.Mappings || typeof cfg.Mappings !== 'object') {
    return cfg;
  }
  for (const key of Object.keys(cfg.Mappings)) {
    const m = cfg.Mappings[key];
    if (!m || typeof m !== 'object') {
      cfg.Mappings[key] = { ProcessNames: [], MicNames: [] };
      continue;
    }
    const pn = m.ProcessNames;
    const mn = m.MicNames;
    m.ProcessNames = coerceNameList(pn);
    m.MicNames = coerceNameList(mn);
  }
  return cfg;
}

function loadConfig() {
  if (!configCache) {
    const cfgFile = configPath();
    try {
      const file = fs.readFileSync(cfgFile, 'utf8');
      configCache = yaml.parse(file);
    } catch {
      const file = fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8');
      configCache = yaml.parse(file);
    }

    detachMappingArrays(configCache);

    let dirty = false;
    if (configCache.vm === undefined) {
      configCache.vm = false;
      dirty = true;
    }
    if (configCache.vmversion === undefined) {
      configCache.vmversion = 'banana';
      dirty = true;
    }
    if (dirty) saveConfig(configCache);
  }
  return configCache;
}

function saveConfig(data) {
  if (!data || typeof data !== 'object') return;
  detachMappingArrays(data);
  configCache = data;
  fs.writeFileSync(configPath(), yaml.stringify(data, STRINGIFY_OPTIONS), 'utf8');
}

function cloneConfigSnapshot(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  try {
    return JSON.parse(JSON.stringify(cfg));
  } catch {
    return null;
  }
}

module.exports = {
  loadConfig,
  saveConfig,
  cloneConfigSnapshot,
  DEFAULT_CONFIG_PATH,
};
