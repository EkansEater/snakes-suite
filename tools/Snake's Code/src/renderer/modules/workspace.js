// Workspace state: environment info, the open folder, recent list and persisted session state.
import { bus, basename } from './util.js';

export const env = {
  platform: 'linux',
  homeDir: '',
  sep: '/',
  storePaths: {},
  versions: {},
  ptyAvailable: true,
  shell: '/bin/bash',
};

export const workspace = {
  root: null,
  get name() {
    return this.root ? basename(this.root) : null;
  },
};

let state = {};

export async function loadState() {
  state = (await window.snake.store.get('state')) || {};
  state.recent ||= [];
  state.sessions ||= {};
  return state;
}

export function getState() {
  return state;
}

let saveTimer;
export function saveState(immediate = false) {
  clearTimeout(saveTimer);
  const doSave = async () => {
    // merge with what is on disk so concurrent windows don't clobber each other's recents
    const disk = (await window.snake.store.get('state')) || {};
    const merged = { ...disk, ...state, sessions: { ...(disk.sessions || {}), ...(state.sessions || {}) } };
    await window.snake.store.set('state', merged);
  };
  if (immediate) return doSave();
  saveTimer = setTimeout(doSave, 400);
}

export function addRecent(path, type = 'folder') {
  state.recent = [{ path, type, time: Date.now() }, ...state.recent.filter((r) => r.path !== path)].slice(0, 30);
  saveState();
  bus.emit('recent:changed');
}

export function removeRecent(path) {
  state.recent = state.recent.filter((r) => r.path !== path);
  saveState();
  bus.emit('recent:changed');
}

export function clearRecent() {
  state.recent = [];
  saveState();
  bus.emit('recent:changed');
}

export function setRoot(root) {
  workspace.root = root;
  state.lastRoot = root;
  if (root) addRecent(root, 'folder');
  saveState();
  invalidateFileList();
  bus.emit('workspace:changed', root);
}

// ---- cached file list for quick open ----
let fileListPromise = null;
export function invalidateFileList() {
  fileListPromise = null;
}

export function listWorkspaceFiles(excludes = []) {
  if (!workspace.root) return Promise.resolve([]);
  if (!fileListPromise) {
    const root = workspace.root;
    fileListPromise = window.snake.fs.listFiles(root, excludes).catch(() => []);
    // refresh periodically so new files show up
    setTimeout(() => { if (workspace.root === root) fileListPromise = null; }, 15000);
  }
  return fileListPromise;
}
