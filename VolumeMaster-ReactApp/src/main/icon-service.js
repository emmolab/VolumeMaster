const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');
const sharp = require('sharp');
const extractIcon = require('extract-file-icon');

const exec = util.promisify(require('child_process').exec);

function cacheDir() {
  return path.join(require('electron').app.getPath('userData'), 'iconCache');
}

function ensureCacheDir() {
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const exePathCache = new Map();

function cacheFilenameForProgram(programName) {
  const hash = crypto.createHash('sha256').update(programName.trim().toLowerCase()).digest('hex');
  return path.join(ensureCacheDir(), `${hash}.png`);
}

function normalizePath(p) {
  try {
    return path.normalize(p).toLowerCase();
  } catch {
    return p.trim().toLowerCase();
  }
}

async function findRunningProcessExePath(exeName) {
  try {
    const baseName = path.basename(exeName, '.exe');
    const cmd = `powershell -NoProfile -Command "Get-Process -Name '${baseName}' | Select-Object -ExpandProperty Path"`;

    const { stdout } = await exec(cmd, { encoding: 'utf8' });
    const output = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    if (output[0]) {
      exePathCache.set(exeName, output[0]);
      return output[0];
    }
    return null;
  } catch (err) {
    console.error('findRunningProcessExePath failed:', err.message);
    return null;
  }
}

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

  const cached = loadIconFromCache(programName);
  if (cached) return cached;

  let resolvedExePath = await findRunningProcessExePath(exeName);
  if (!resolvedExePath) {
    console.log('No running process found for', exeName);
    return null;
  }

  resolvedExePath = normalizePath(resolvedExePath).replace(/\//g, '\\');
  if (!fs.existsSync(resolvedExePath)) return null;

  try {
    const buffer = extractIcon(resolvedExePath);
    if (!buffer?.length) return null;

    const cachedFile = await saveIconToCache(programName, buffer);
    if (cachedFile && fs.existsSync(cachedFile)) {
      const data = fs.readFileSync(cachedFile);
      return `data:image/png;base64,${data.toString('base64')}`;
    }

    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch (err) {
    console.error('Icon extraction failed:', err);
    return null;
  }
}

module.exports = {
  getAppIcon,
  findRunningProcessExePath,
};
