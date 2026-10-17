// Language servers (the Language Server Protocol): completions, hover, parameter hints, go to
// definition, references, rename, formatting, quick fixes, inlay hints and problems for the
// languages Monaco only colors. They come from the server programs people already install
// (clangd, pyright, rust-analyzer, gopls...). One server runs per kind and project folder; it is
// started the first time a file it understands is opened.
import * as monaco from 'monaco-editor';
import { bus, el, icon, basename, dirname, extname, join, isInside } from './util.js';
import * as settings from './settings.js';
import { workspace, env } from './workspace.js';
import { notify, showMenu } from './ui.js';
import { appendOutput, showOutput } from './panel.js';
import { openFile, loadDocument, getDocument, saveDocument, activeDoc, isDocumentOpen, handleRename, handleDelete, languageFor } from './editors.js';
import { openSettings } from './pages.js';

const LOG = 'Language Servers';

/**
 * The servers it knows. `commands` are tried in order (the first one installed wins); `markers`
 * are files that mark a project's top folder, where the server is started.
 */
const SERVERS = [
  { id: 'python', name: 'Python', exts: ['.py', '.pyi', '.pyw'], lang: 'python',
    commands: [['basedpyright-langserver', '--stdio'], ['pyright-langserver', '--stdio'], ['pylsp'], ['jedi-language-server']],
    markers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'], hint: 'pip install python-lsp-server   (or: npm install -g pyright)' },
  { id: 'rust', name: 'Rust', exts: ['.rs'], lang: 'rust', commands: [['rust-analyzer']], markers: ['Cargo.toml'], hint: 'rustup component add rust-analyzer' },
  { id: 'go', name: 'Go', exts: ['.go'], lang: 'go', commands: [['gopls']], markers: ['go.work', 'go.mod'], hint: 'go install golang.org/x/tools/gopls@latest' },
  { id: 'c', name: 'C/C++', exts: ['.c', '.h', '.cc', '.cpp', '.cxx', '.c++', '.hh', '.hpp', '.hxx', '.h++', '.inl', '.ipp', '.ino', '.m', '.mm', '.cu'],
    lang: (ext) => ({ '.c': 'c', '.m': 'objective-c', '.mm': 'objective-cpp', '.cu': 'cuda-cpp' })[ext] || 'cpp',
    commands: [['clangd']], markers: ['compile_commands.json', 'compile_flags.txt', '.clangd', 'CMakeLists.txt', 'meson.build'], hint: 'install clangd (it comes with clang / LLVM)' },
  { id: 'shell', name: 'Shell', exts: ['.sh', '.bash', '.ksh'], names: ['.bashrc', '.bash_profile', '.profile', 'pkgbuild'], lang: 'shellscript',
    commands: [['bash-language-server', 'start']], hint: 'npm install -g bash-language-server' },
  { id: 'lua', name: 'Lua', exts: ['.lua'], lang: 'lua', commands: [['lua-language-server']], markers: ['.luarc.json'], hint: 'install lua-language-server' },
  { id: 'php', name: 'PHP', exts: ['.php', '.phtml'], lang: 'php', commands: [['intelephense', '--stdio'], ['phpactor', 'language-server']], markers: ['composer.json'], hint: 'npm install -g intelephense' },
  { id: 'ruby', name: 'Ruby', exts: ['.rb', '.rake', '.gemspec', '.ru'], names: ['gemfile', 'rakefile'], lang: 'ruby', commands: [['ruby-lsp'], ['solargraph', 'stdio']], markers: ['Gemfile'], hint: 'gem install ruby-lsp' },
  { id: 'java', name: 'Java', exts: ['.java'], lang: 'java', commands: [['jdtls']], markers: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'], hint: 'install Eclipse JDT Language Server (jdtls)' },
  { id: 'kotlin', name: 'Kotlin', exts: ['.kt', '.kts'], lang: 'kotlin', commands: [['kotlin-lsp'], ['kotlin-language-server']], markers: ['build.gradle.kts', 'build.gradle', 'settings.gradle.kts'], hint: 'install kotlin-lsp' },
  { id: 'csharp', name: 'C#', exts: ['.cs', '.csx'], lang: 'csharp', commands: [['csharp-ls']], hint: 'dotnet tool install --global csharp-ls' },
  { id: 'dart', name: 'Dart', exts: ['.dart'], lang: 'dart', commands: [['dart', 'language-server', '--protocol=lsp']], markers: ['pubspec.yaml'], hint: 'install the Dart or Flutter SDK' },
  { id: 'swift', name: 'Swift', exts: ['.swift'], lang: 'swift', commands: [['sourcekit-lsp']], markers: ['Package.swift'], hint: 'install Swift (it includes sourcekit-lsp)' },
  { id: 'zig', name: 'Zig', exts: ['.zig', '.zon'], lang: 'zig', commands: [['zls']], markers: ['build.zig'], hint: 'install zls' },
  { id: 'haskell', name: 'Haskell', exts: ['.hs', '.lhs'], lang: 'haskell', commands: [['haskell-language-server-wrapper', '--lsp']], markers: ['stack.yaml', 'cabal.project'], hint: 'install haskell-language-server (ghcup install hls)' },
  { id: 'elixir', name: 'Elixir', exts: ['.ex', '.exs'], lang: 'elixir', commands: [['elixir-ls'], ['language_server.sh']], markers: ['mix.exs'], hint: 'install elixir-ls' },
  { id: 'ocaml', name: 'OCaml', exts: ['.ml', '.mli'], lang: 'ocaml', commands: [['ocamllsp']], markers: ['dune-project'], hint: 'opam install ocaml-lsp-server' },
  { id: 'nix', name: 'Nix', exts: ['.nix'], lang: 'nix', commands: [['nixd'], ['nil']], markers: ['flake.nix'], hint: 'install nixd' },
  { id: 'yaml', name: 'YAML', exts: ['.yml', '.yaml'], lang: 'yaml', commands: [['yaml-language-server', '--stdio']], hint: 'npm install -g yaml-language-server' },
  { id: 'toml', name: 'TOML', exts: ['.toml'], lang: 'toml', commands: [['taplo', 'lsp', 'stdio']], hint: 'cargo install taplo-cli --features lsp' },
  { id: 'cmake', name: 'CMake', exts: ['.cmake'], names: ['cmakelists.txt'], lang: 'cmake', commands: [['neocmakelsp', '--stdio'], ['cmake-language-server']], hint: 'pip install cmake-language-server' },
  { id: 'latex', name: 'LaTeX', exts: ['.tex', '.bib'], lang: (ext) => (ext === '.bib' ? 'bibtex' : 'latex'), commands: [['texlab']], hint: 'install texlab' },
  { id: 'dockerfile', name: 'Dockerfile', exts: ['.dockerfile'], names: ['dockerfile', 'containerfile'], lang: 'dockerfile', commands: [['docker-langserver', '--stdio']], hint: 'npm install -g dockerfile-language-server-nodejs' },
];

const servers = new Map(); // `${def.id}@${root}` -> Server
const byProcess = new Map(); // process id from the main process -> Server
const attached = new Map(); // model uri string -> Server the document is open in
const borrowed = new Map(); // uri string -> time: models read only to show a peek view
const missing = new Set(); // def ids with no program installed (asked once per session)
let statusNode = null;
const inlayChanged = new monaco.Emitter(); // asks editors for inlay hints again

const enabled = () => settings.get('languageServers.enabled') !== false;
const key = (uri) => monaco.Uri.parse(uri).toString();
const log = (text) => appendOutput(LOG, text);

// ---------------------------------------------------------------------------
// Which server for which file
// ---------------------------------------------------------------------------
function splitArgs(s) {
  const out = [];
  for (const m of s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** languageServers.custom: "python=pylsp; .nim=nimlangserver" — pick a program, or add a file type. */
function customServers() {
  const out = [];
  for (const part of String(settings.get('languageServers.custom') || '').split(';')) {
    const m = /^\s*([^=]+?)\s*=\s*(.+?)\s*$/.exec(part);
    if (!m) continue;
    const command = splitArgs(m[2]);
    if (!command.length) continue;
    const names = m[1].split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const known = SERVERS.find((d) => names.includes(d.id));
    if (known) {
      out.push({ ...known, commands: [command], hint: `check languageServers.custom: ${command[0]} was not found` });
    } else {
      const exts = names.map((n) => (n.startsWith('.') ? n : '.' + n));
      out.push({ id: 'custom' + exts.join(''), name: exts.join(' '), exts, lang: (ext) => ext.slice(1), commands: [command], hint: `check languageServers.custom: ${command[0]} was not found` });
    }
  }
  return out;
}

function defFor(path) {
  if (!path) return null;
  const name = basename(path).toLowerCase();
  const ext = extname(name);
  const matches = (d) => d.exts.includes(ext) || d.names?.includes(name) || (d.id === 'dockerfile' && /^(docker|container)file/.test(name));
  return customServers().find(matches) || SERVERS.find(matches) || null;
}

function languageIdFor(def, path) {
  return typeof def.lang === 'function' ? def.lang(extname(path).toLowerCase()) : def.lang;
}

/** The folder a file's server works in: its project's top folder (by marker files), else the open folder. */
async function rootFor(def, path) {
  const top = workspace.root && isInside(workspace.root, path) ? workspace.root : null;
  let dir = dirname(path);
  for (let i = 0; def.markers && i < 40; i++) {
    for (const m of def.markers) {
      if ((await window.snake.fs.stat(join(dir, m))).exists) return dir;
    }
    if (dir === top) break;
    const up = dirname(dir);
    if (!up || up === dir) break;
    dir = up;
  }
  return top || dirname(path);
}

// ---------------------------------------------------------------------------
// Conversions between LSP (0-based) and Monaco (1-based)
// ---------------------------------------------------------------------------
const toRange = (r) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const fromPosition = (p) => ({ line: p.lineNumber - 1, character: p.column - 1 });
const fromRange = (r) => ({ start: { line: r.startLineNumber - 1, character: r.startColumn - 1 }, end: { line: r.endLineNumber - 1, character: r.endColumn - 1 } });
const docParams = (model, position) => ({ textDocument: { uri: model.uri.toString() }, position: fromPosition(position) });
const toTextEdit = (e) => ({ range: toRange(e.range), text: e.newText });

function markdown(value) {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  if (value.kind === 'markdown') return { value: value.value, isTrusted: false };
  return value.value;
}

function hoverParts(contents) {
  const list = Array.isArray(contents) ? contents : [contents];
  return list.filter(Boolean).map((c) => {
    if (typeof c === 'string') return { value: c };
    if (c.language) return { value: '```' + c.language + '\n' + c.value + '\n```' };
    return { value: c.kind === 'plaintext' ? c.value.replace(/[\\`*_{}[\]()#+\-.!<>]/g, '\\$&') : c.value };
  }).filter((c) => c.value.trim());
}

const COMPLETION_KINDS = ['', 'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum',
  'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'];
const SEVERITY = [0, monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint];

function markerOf(d, source) {
  const code = d.code == null ? undefined : d.codeDescription?.href ? { value: String(d.code), target: monaco.Uri.parse(d.codeDescription.href) } : String(d.code);
  return {
    severity: SEVERITY[d.severity || 1] || monaco.MarkerSeverity.Error,
    message: d.message,
    source: d.source || source,
    code,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    tags: (d.tags || []).filter((t) => t === 1 || t === 2),
    relatedInformation: (d.relatedInformation || []).map((r) => ({
      resource: monaco.Uri.parse(r.location.uri), message: r.message,
      startLineNumber: r.location.range.start.line + 1, startColumn: r.location.range.start.character + 1,
      endLineNumber: r.location.range.end.line + 1, endColumn: r.location.range.end.character + 1,
    })),
  };
}

// ---------------------------------------------------------------------------
// A running server
// ---------------------------------------------------------------------------
class Server {
  constructor(def, root) {
    this.def = def;
    this.root = root;
    this.key = `${def.id}@${root}`;
    this.state = 'starting'; // starting | ready | failed | stopped
    this.caps = {};
    this.pending = new Map();
    this.nextId = 1;
    this.docs = new Map(); // uri -> { model, listener }
    this.diagnostics = new Map(); // uri -> LSP diagnostics (kept for code actions)
    this.progress = new Map(); // token -> { title, message, percentage }
    this.crashes = [];
    this.ready = this.start();
  }

  get owner() {
    return `lsp:${this.def.id}`;
  }

  get program() {
    return this.command ? basename(this.command[0]) : this.def.commands[0][0];
  }

  async start() {
    const which = await window.snake.lsp.which(this.def.commands.map((c) => c[0]));
    this.command = this.def.commands.find((c) => which[c[0]]);
    if (!this.command) {
      this.state = 'missing';
      missing.add(this.def.id);
      renderStatus();
      return false;
    }
    log(`[${this.def.name}] starting ${which[this.command[0]]} ${this.command.slice(1).join(' ')} in ${this.root}`);
    const res = await window.snake.lsp.start({ command: this.command[0], args: this.command.slice(1), cwd: this.root });
    if (!res.ok) return this.fail(res.error);
    this.pid = res.id;
    byProcess.set(res.id, this);
    if (this.state === 'stopped') { // stopped while it was being started
      window.snake.lsp.stop(res.id);
      return false;
    }
    try {
      const rootUri = monaco.Uri.file(this.root).toString();
      const result = await this.request('initialize', {
        processId: null,
        clientInfo: { name: "Snake's Code", version: env.versions?.app },
        locale: navigator.language,
        rootPath: this.root,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: basename(this.root) }],
        capabilities: CLIENT_CAPABILITIES,
      });
      this.caps = result?.capabilities || {};
      this.info = result?.serverInfo;
    } catch (err) {
      return this.fail(err.message);
    }
    if (this.state !== 'starting') return false;
    this.notify('initialized', {});
    this.state = 'ready';
    log(`[${this.def.name}] ${this.info?.name || this.program} ${this.info?.version || ''} is ready`);
    registerTriggers();
    renderStatus();
    setTimeout(() => inlayChanged.fire(), 300); // the documents waiting for it are open by then
    return true;
  }

  fail(message) {
    if (this.state === 'stopped') return false;
    this.state = 'failed';
    this.error = message;
    log(`[${this.def.name}] ${message}`);
    renderStatus();
    return false;
  }

  send(msg) {
    if (this.pid) window.snake.lsp.send(this.pid, { jsonrpc: '2.0', ...msg });
  }

  notify(method, params) {
    this.send({ method, params });
  }

  request(method, params, token) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, method });
      this.send({ id, method, params });
      token?.onCancellationRequested?.(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.notify('$/cancelRequest', { id });
        resolve(null);
      });
    });
  }

  /** Ask, but give up quietly: a provider that throws shows an error in the editor. */
  async ask(method, params, token) {
    if (this.state !== 'ready') return null;
    try {
      return await this.request(method, params, token);
    } catch (err) {
      log(`[${this.def.name}] ${method}: ${err.message}`);
      return null;
    }
  }

  receive(msg) {
    if (msg.id != null && msg.method == null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (!msg.error) p.resolve(msg.result ?? null);
      else if (msg.error.code === -32800) p.resolve(null); // cancelled
      else p.reject(new Error(msg.error.message || `error ${msg.error.code}`));
    } else if (msg.id != null) {
      Promise.resolve()
        .then(() => this.onRequest(msg.method, msg.params))
        .then(
          (result) => this.send({ id: msg.id, result: result ?? null }),
          (err) => this.send({ id: msg.id, error: { code: err.code || -32603, message: err.message } }),
        );
    } else {
      this.onNotification(msg.method, msg.params);
    }
  }

  async onRequest(method, params) {
    switch (method) {
      case 'workspace/configuration': return (params.items || []).map(() => null);
      case 'workspace/workspaceFolders': return [{ uri: monaco.Uri.file(this.root).toString(), name: basename(this.root) }];
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
      case 'workspace/semanticTokens/refresh':
      case 'workspace/codeLens/refresh':
      case 'workspace/diagnostic/refresh':
        return null;
      case 'workspace/inlayHint/refresh':
        inlayChanged.fire();
        return null;
      case 'workspace/applyEdit':
        try {
          await applyWorkspaceEdit(params.edit);
          return { applied: true };
        } catch (err) {
          return { applied: false, failureReason: err.message };
        }
      case 'window/showDocument': {
        if (params.external) { window.snake.shell?.openExternal?.(params.uri); return { success: true }; }
        const uri = monaco.Uri.parse(params.uri);
        await openFile(uri.fsPath, { pinned: true, selection: params.selection ? toRange(params.selection) : undefined, focus: params.takeFocus !== false });
        return { success: true };
      }
      case 'window/showMessageRequest':
        return new Promise((resolve) => {
          const actions = (params.actions || []).map((a) => ({ label: a.title, run: () => resolve(a) }));
          notify({ type: params.type === 1 ? 'error' : params.type === 2 ? 'warning' : 'info', message: `${this.def.name}: ${params.message}`,
            actions: [...actions, { label: 'Dismiss', secondary: true, run: () => resolve(null) }] });
        });
      default: {
        const err = new Error(`${method} is not supported`);
        err.code = -32601;
        throw err;
      }
    }
  }

  onNotification(method, params) {
    switch (method) {
      case 'textDocument/publishDiagnostics': this.setDiagnostics(params.uri, params.diagnostics || []); break;
      case 'window/showMessage':
        if (params.type === 4) log(`[${this.def.name}] ${params.message}`);
        else notify({ type: params.type === 1 ? 'error' : params.type === 2 ? 'warning' : 'info', message: `${this.def.name}: ${params.message}`, transient: params.type === 3 });
        break;
      case 'window/logMessage':
      case '$/logTrace':
        log(`[${this.def.name}] ${params.message}`);
        break;
      case '$/progress': {
        const v = params.value || {};
        if (v.kind === 'end') this.progress.delete(params.token);
        else if (v.kind) this.progress.set(params.token, { ...this.progress.get(params.token), ...v });
        renderStatus();
        break;
      }
      default: break;
    }
  }

  setDiagnostics(uri, list) {
    const k = key(uri);
    if (list.length) this.diagnostics.set(k, list);
    else this.diagnostics.delete(k);
    // Markers belong to the file, open or not, so the Problems panel lists every file the server checked.
    monaco.editor.setModelMarkers({ uri: monaco.Uri.parse(k) }, this.owner, list.map((d) => markerOf(d, this.program)));
  }

  // ---- documents ----
  open(model, path) {
    const uri = model.uri.toString();
    if (this.docs.has(uri) || model.isDisposed()) return;
    const sync = this.caps.textDocumentSync;
    const change = typeof sync === 'number' ? sync : sync?.change ?? 0;
    const listener = model.onDidChangeContent((e) => {
      if (change === 0) return;
      const contentChanges = change === 2 && !e.isFlush
        ? e.changes.map((c) => ({ range: fromRange(c.range), rangeLength: c.rangeLength, text: c.text }))
        : [{ text: model.getValue() }];
      this.notify('textDocument/didChange', { textDocument: { uri, version: model.getVersionId() }, contentChanges });
    });
    this.docs.set(uri, { model, listener });
    attached.set(uri, this);
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId: languageIdFor(this.def, path), version: model.getVersionId(), text: model.getValue() } });
  }

  close(uri) {
    const d = this.docs.get(uri);
    if (!d) return;
    d.listener.dispose();
    this.docs.delete(uri);
    if (attached.get(uri) === this) attached.delete(uri);
    if (this.state === 'ready') this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  saved(model) {
    const uri = model.uri.toString();
    if (!this.docs.has(uri) || this.state !== 'ready') return;
    const sync = this.caps.textDocumentSync;
    const save = typeof sync === 'object' ? sync.save : null;
    if (!save) return;
    this.notify('textDocument/didSave', { textDocument: { uri }, text: save.includeText ? model.getValue() : undefined });
  }

  exited(code, stderr) {
    byProcess.delete(this.pid);
    this.pid = null;
    for (const p of this.pending.values()) p.reject(new Error('the language server stopped'));
    this.pending.clear();
    for (const uri of [...this.docs.keys()]) this.close(uri);
    monaco.editor.removeAllMarkers(this.owner);
    this.diagnostics.clear();
    this.progress.clear();
    if (this.state === 'stopped') return;
    servers.delete(this.key);
    log(`[${this.def.name}] ${this.program} exited (code ${code})${stderr ? `:\n${stderr}` : ''}`);
    // Restart after a crash, unless it keeps crashing.
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < 180000), now];
    if (this.crashes.length <= 3 && enabled()) {
      getServer(this.def, this.root).crashes = this.crashes;
      for (const m of monaco.editor.getModels()) {
        if (m.uri.scheme === 'file' && defFor(m.uri.fsPath)?.id === this.def.id) attachModel(m);
      }
    } else {
      this.fail(`${this.program} stopped working${stderr ? `: ${stderr.split('\n').pop()}` : ''}`);
      servers.set(this.key, this);
      notify({ type: 'error', message: `The ${this.def.name} language server (${this.program}) keeps stopping.`, detail: stderr || undefined,
        actions: [{ label: 'Restart', run: () => restartServer(this) }, { label: 'Show Log', secondary: true, run: () => showOutput(LOG) }] });
    }
    renderStatus();
  }

  async stop() {
    if (this.state === 'stopped') return;
    const wasReady = this.state === 'ready';
    this.state = 'stopped';
    servers.delete(this.key);
    for (const uri of [...this.docs.keys()]) {
      const d = this.docs.get(uri);
      d.listener.dispose();
      this.docs.delete(uri);
      if (attached.get(uri) === this) attached.delete(uri);
    }
    monaco.editor.removeAllMarkers(this.owner);
    const pid = this.pid;
    if (!pid) return;
    if (wasReady) {
      // Ask politely, then end it whatever it says.
      await Promise.race([this.request('shutdown', null).catch(() => null), new Promise((r) => setTimeout(r, 1500))]);
      this.notify('exit', null);
    }
    setTimeout(() => window.snake.lsp.stop(pid), 300);
  }
}

const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  workspace: {
    applyEdit: true,
    workspaceEdit: { documentChanges: true, resourceOperations: ['create', 'rename', 'delete'] },
    configuration: true,
    workspaceFolders: true,
    symbol: { symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) } },
    executeCommand: {},
    inlayHint: { refreshSupport: true },
  },
  textDocument: {
    synchronization: { didSave: true, willSave: false, willSaveWaitUntil: false },
    completion: {
      completionItem: {
        snippetSupport: true, commitCharactersSupport: true, documentationFormat: ['markdown', 'plaintext'], deprecatedSupport: true,
        preselectSupport: true, insertReplaceSupport: true, labelDetailsSupport: true, tagSupport: { valueSet: [1] },
        resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
      },
      completionItemKind: { valueSet: Array.from({ length: 25 }, (_, i) => i + 1) },
      contextSupport: true,
      completionList: { itemDefaults: ['commitCharacters', 'editRange', 'insertTextFormat', 'data'] },
    },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true }, contextSupport: true },
    declaration: { linkSupport: true },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    documentHighlight: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true, symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) }, tagSupport: { valueSet: [1] } },
    codeAction: {
      codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports', 'source.fixAll'] } },
      isPreferredSupport: true, disabledSupport: true, resolveSupport: { properties: ['edit'] },
    },
    formatting: {},
    rangeFormatting: {},
    rename: { prepareSupport: true },
    publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, codeDescriptionSupport: true },
    inlayHint: {},
  },
  window: { workDoneProgress: true, showMessage: { messageActionItem: { additionalPropertiesSupport: false } }, showDocument: { support: true } },
};

// ---------------------------------------------------------------------------
// Documents in and out
// ---------------------------------------------------------------------------
function getServer(def, root) {
  const k = `${def.id}@${root}`;
  let s = servers.get(k);
  if (!s) {
    s = new Server(def, root);
    servers.set(k, s);
  }
  return s;
}

async function attachModel(model) {
  if (!enabled() || model.uri.scheme !== 'file' || borrowed.has(model.uri.toString())) return;
  const path = model.uri.fsPath;
  const def = defFor(path);
  if (!def || model.getValueLength() > 20_000_000) return;
  const root = await rootFor(def, path);
  if (model.isDisposed() || !enabled()) return;
  const server = getServer(def, root);
  renderStatus();
  if (await server.ready) server.open(model, path);
  renderStatus();
}

function detachModel(model) {
  const uri = model.uri.toString();
  borrowed.delete(uri);
  attached.get(uri)?.close(uri);
}

/** Models for files a result points into, so peek views can show them (read only, dropped later). */
async function ensureModels(uris) {
  const wanted = [...new Set(uris.filter((u) => u.scheme === 'file' && !monaco.editor.getModel(u)).map((u) => u.toString()))].slice(0, 80);
  await Promise.all(wanted.map(async (u) => {
    const uri = monaco.Uri.parse(u);
    const res = await window.snake.fs.readFile(uri.fsPath).catch(() => null);
    if (!res || res.binary || res.tooLarge || monaco.editor.getModel(uri)) return;
    borrowed.set(u, Date.now());
    monaco.editor.createModel(res.content, languageFor(uri.fsPath), uri);
  }));
}

setInterval(() => {
  for (const [u, t] of borrowed) {
    const m = monaco.editor.getModel(monaco.Uri.parse(u));
    if (!m) borrowed.delete(u);
    else if (Date.now() - t > 120000 && !m.isAttachedToEditor()) m.dispose();
  }
}, 60000);

/** Apply a WorkspaceEdit: text edits (undoable) and file creations, renames and deletions. */
async function applyWorkspaceEdit(edit) {
  if (!edit) return;
  const perFile = new Map();
  const add = (uri, edits) => {
    const k = key(uri);
    perFile.set(k, [...(perFile.get(k) || []), ...edits]);
  };
  if (edit.documentChanges) {
    for (const c of edit.documentChanges) {
      if (c.kind === 'create') {
        const p = monaco.Uri.parse(c.uri).fsPath;
        if (!(await window.snake.fs.stat(p)).exists) await window.snake.fs.createFile(p);
      } else if (c.kind === 'rename') {
        const from = monaco.Uri.parse(c.oldUri).fsPath;
        const to = monaco.Uri.parse(c.newUri).fsPath;
        await window.snake.fs.rename(from, to);
        handleRename(from, to);
      } else if (c.kind === 'delete') {
        const p = monaco.Uri.parse(c.uri).fsPath;
        await window.snake.fs.trash(p);
        handleDelete(p);
      } else if (c.textDocument) {
        add(c.textDocument.uri, c.edits || []);
      }
    }
  } else {
    for (const [uri, edits] of Object.entries(edit.changes || {})) add(uri, edits);
  }
  const loaded = [];
  for (const [uri, edits] of perFile) {
    const path = monaco.Uri.parse(uri).fsPath;
    let doc = getDocument(path);
    const wasOpen = doc && isDocumentOpen(doc);
    if (!doc) doc = await loadDocument(path);
    if (!doc?.model) continue;
    const wasDirty = doc.dirty;
    doc.model.pushStackElement();
    doc.model.pushEditOperations([], edits.map((e) => ({ range: toRange(e.range), text: e.newText })), () => null);
    doc.model.pushStackElement();
    if (!wasOpen && !wasDirty) loaded.push(doc);
  }
  // Like other editors: files changed that were not open are saved straight away
  // (nobody would see their unsaved changes); open ones are left for you to save.
  for (const doc of loaded) {
    await saveDocument(doc, { skipParticipants: true });
    if (!isDocumentOpen(doc)) doc.dispose();
  }
}

// ---------------------------------------------------------------------------
// Editor features
// ---------------------------------------------------------------------------
const RUN = 'snake.lsp.run';

function serverFor(model) {
  const s = attached.get(model.uri.toString());
  return s?.state === 'ready' ? s : null;
}

function toCommand(server, c) {
  if (!c) return undefined;
  if (c.command === 'editor.action.triggerParameterHints' || c.command === 'editor.action.triggerSuggest') return { id: c.command, title: c.title };
  return { id: RUN, title: c.title, arguments: [server.key, { command: c }] };
}

async function runAction(serverKey, { action, command }) {
  const s = servers.get(serverKey);
  if (!s || s.state !== 'ready') return;
  try {
    if (action && !action.edit && !action.command && s.caps.codeActionProvider?.resolveProvider) {
      action = (await s.request('codeAction/resolve', action)) || action;
    }
    if (action?.edit) await applyWorkspaceEdit(action.edit);
    const c = command || action?.command;
    if (c) await s.request('workspace/executeCommand', { command: c.command, arguments: c.arguments });
  } catch (err) {
    notify({ type: 'error', message: `${s.def.name}: ${err.message}` });
  }
}

function toLocations(res) {
  if (!res) return [];
  return (Array.isArray(res) ? res : [res]).map((l) => (l.targetUri
    ? { uri: monaco.Uri.parse(l.targetUri), range: toRange(l.targetRange), targetSelectionRange: toRange(l.targetSelectionRange || l.targetRange), originSelectionRange: l.originSelectionRange && toRange(l.originSelectionRange) }
    : { uri: monaco.Uri.parse(l.uri), range: toRange(l.range) }));
}

function locationProvider(capability, method) {
  return async (model, position, token) => {
    const s = serverFor(model);
    if (!s?.caps[capability]) return null;
    const list = toLocations(await s.ask(method, docParams(model, position), token));
    await ensureModels(list.map((l) => l.uri));
    return list;
  };
}

let triggerRegistrations = [];

/** Completion and parameter hints need their trigger characters up front: those of every running server. */
function registerTriggers() {
  const ready = [...servers.values()].filter((s) => s.state === 'ready');
  const completionChars = [...new Set(ready.flatMap((s) => s.caps.completionProvider?.triggerCharacters || []))];
  const signatureChars = [...new Set(ready.flatMap((s) => s.caps.signatureHelpProvider?.triggerCharacters || []))];
  const retriggerChars = [...new Set(ready.flatMap((s) => s.caps.signatureHelpProvider?.retriggerCharacters || []))];
  for (const d of triggerRegistrations) d.dispose();
  triggerRegistrations = [
    monaco.languages.registerCompletionItemProvider('*', {
      triggerCharacters: completionChars,
      async provideCompletionItems(model, position, context, token) {
        const s = serverFor(model);
        const cp = s?.caps.completionProvider;
        if (!cp) return null;
        if (context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter && !(cp.triggerCharacters || []).includes(context.triggerCharacter)) return null;
        const res = await s.ask('textDocument/completion', { ...docParams(model, position), context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter } }, token);
        if (!res) return null;
        const items = Array.isArray(res) ? res : res.items || [];
        const defaults = (!Array.isArray(res) && res.itemDefaults) || {};
        const word = model.getWordUntilPosition(position);
        const end = model.getWordAtPosition(position)?.endColumn ?? position.column;
        const wordRange = {
          insert: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column),
          replace: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, end),
        };
        const rangeOf = (r) => (r.start ? toRange(r) : { insert: toRange(r.insert), replace: toRange(r.replace) });
        return {
          incomplete: !Array.isArray(res) && !!res.isIncomplete,
          suggestions: items.map((it) => {
            let range = wordRange;
            let text = it.insertText ?? it.label;
            if (it.textEdit) {
              range = rangeOf(it.textEdit);
              text = it.textEdit.newText;
            } else if (defaults.editRange) {
              range = rangeOf(defaults.editRange);
              text = it.textEditText ?? it.insertText ?? it.label;
            }
            if (it.data === undefined && defaults.data !== undefined) it.data = defaults.data;
            const snippet = (it.insertTextFormat ?? defaults.insertTextFormat) === 2;
            return {
              label: it.labelDetails ? { label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description } : it.label,
              kind: monaco.languages.CompletionItemKind[COMPLETION_KINDS[it.kind]] ?? monaco.languages.CompletionItemKind.Property,
              detail: it.detail,
              documentation: markdown(it.documentation),
              sortText: it.sortText,
              filterText: it.filterText,
              preselect: it.preselect,
              insertText: text,
              insertTextRules: snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              range,
              commitCharacters: it.commitCharacters ?? defaults.commitCharacters,
              additionalTextEdits: it.additionalTextEdits?.map(toTextEdit),
              tags: it.deprecated || it.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
              command: toCommand(s, it.command),
              lsp: it,
              server: s,
            };
          }),
        };
      },
      async resolveCompletionItem(item, token) {
        const s = item.server;
        if (!s?.caps.completionProvider?.resolveProvider || s.state !== 'ready') return item;
        const r = await s.ask('completionItem/resolve', item.lsp, token);
        if (!r) return item;
        if (r.documentation) item.documentation = markdown(r.documentation);
        if (r.detail) item.detail = r.detail;
        if (r.additionalTextEdits) item.additionalTextEdits = r.additionalTextEdits.map(toTextEdit);
        if (r.command) item.command = toCommand(s, r.command);
        return item;
      },
    }),
    monaco.languages.registerSignatureHelpProvider('*', {
      signatureHelpTriggerCharacters: signatureChars,
      signatureHelpRetriggerCharacters: retriggerChars,
      async provideSignatureHelp(model, position, token, context) {
        const s = serverFor(model);
        if (!s?.caps.signatureHelpProvider) return null;
        const res = await s.ask('textDocument/signatureHelp', { ...docParams(model, position), context: { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter, isRetrigger: context.isRetrigger } }, token);
        if (!res?.signatures?.length) return null;
        return {
          value: {
            signatures: res.signatures.map((sig) => ({
              label: sig.label,
              documentation: markdown(sig.documentation),
              parameters: (sig.parameters || []).map((p) => ({ label: p.label, documentation: markdown(p.documentation) })),
              activeParameter: sig.activeParameter,
            })),
            activeSignature: res.activeSignature ?? 0,
            activeParameter: res.activeParameter ?? 0,
          },
          dispose() {},
        };
      },
    }),
  ];
}

function registerProviders() {
  const L = monaco.languages;
  L.registerHoverProvider('*', {
    async provideHover(model, position, token) {
      const s = serverFor(model);
      if (!s?.caps.hoverProvider) return null;
      const res = await s.ask('textDocument/hover', docParams(model, position), token);
      const contents = res ? hoverParts(res.contents) : [];
      return contents.length ? { contents, range: res.range && toRange(res.range) } : null;
    },
  });
  L.registerDefinitionProvider('*', { provideDefinition: locationProvider('definitionProvider', 'textDocument/definition') });
  L.registerDeclarationProvider('*', { provideDeclaration: locationProvider('declarationProvider', 'textDocument/declaration') });
  L.registerTypeDefinitionProvider('*', { provideTypeDefinition: locationProvider('typeDefinitionProvider', 'textDocument/typeDefinition') });
  L.registerImplementationProvider('*', { provideImplementation: locationProvider('implementationProvider', 'textDocument/implementation') });
  L.registerReferenceProvider('*', {
    async provideReferences(model, position, context, token) {
      const s = serverFor(model);
      if (!s?.caps.referencesProvider) return null;
      const list = toLocations(await s.ask('textDocument/references', { ...docParams(model, position), context: { includeDeclaration: context.includeDeclaration } }, token));
      await ensureModels(list.map((l) => l.uri));
      return list;
    },
  });
  L.registerDocumentHighlightProvider('*', {
    async provideDocumentHighlights(model, position, token) {
      const s = serverFor(model);
      if (!s?.caps.documentHighlightProvider) return null;
      const res = await s.ask('textDocument/documentHighlight', docParams(model, position), token);
      return res?.map((h) => ({ range: toRange(h.range), kind: (h.kind || 1) - 1 })) || null;
    },
  });
  L.registerDocumentSymbolProvider('*', {
    displayName: 'Language server',
    async provideDocumentSymbols(model, token) {
      const s = serverFor(model);
      if (!s?.caps.documentSymbolProvider) return null;
      const res = await s.ask('textDocument/documentSymbol', { textDocument: { uri: model.uri.toString() } }, token);
      if (!res?.length) return [];
      const symbol = (d) => ({
        name: d.name, detail: d.detail || '', kind: (d.kind || 13) - 1, tags: d.tags?.includes(1) || d.deprecated ? [1] : [],
        range: toRange(d.range), selectionRange: toRange(d.selectionRange || d.range), children: (d.children || []).map(symbol),
      });
      if (res[0].location) {
        return res.map((x) => ({ name: x.name, detail: x.containerName || '', kind: (x.kind || 13) - 1, tags: [], range: toRange(x.location.range), selectionRange: toRange(x.location.range) }));
      }
      return res.map(symbol);
    },
  });
  const formattingOptions = (model, options) => ({
    tabSize: options.tabSize, insertSpaces: options.insertSpaces,
    trimTrailingWhitespace: settings.get('files.trimTrailingWhitespace'), insertFinalNewline: settings.get('files.insertFinalNewline'),
  });
  L.registerDocumentFormattingEditProvider('*', {
    displayName: 'Language server',
    async provideDocumentFormattingEdits(model, options, token) {
      const s = serverFor(model);
      if (!s?.caps.documentFormattingProvider) return null;
      const res = await s.ask('textDocument/formatting', { textDocument: { uri: model.uri.toString() }, options: formattingOptions(model, options) }, token);
      return res?.map(toTextEdit) || null;
    },
  });
  L.registerDocumentRangeFormattingEditProvider('*', {
    displayName: 'Language server',
    async provideDocumentRangeFormattingEdits(model, range, options, token) {
      const s = serverFor(model);
      if (!s?.caps.documentRangeFormattingProvider) return null;
      const res = await s.ask('textDocument/rangeFormatting', { textDocument: { uri: model.uri.toString() }, range: fromRange(range), options: formattingOptions(model, options) }, token);
      return res?.map(toTextEdit) || null;
    },
  });
  L.registerRenameProvider('*', {
    async resolveRenameLocation(model, position, token) {
      const s = serverFor(model);
      if (!s?.caps.renameProvider) return null;
      const word = model.getWordAtPosition(position);
      const wordRange = word && new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      if (!s.caps.renameProvider.prepareProvider) return wordRange ? { range: wordRange, text: word.word } : null;
      const r = await s.ask('textDocument/prepareRename', docParams(model, position), token);
      if (!r) return { range: wordRange || new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: '', rejectReason: 'This element can’t be renamed.' };
      if (r.defaultBehavior) return wordRange ? { range: wordRange, text: word.word } : null;
      const range = toRange(r.range || r);
      return { range, text: r.placeholder ?? model.getValueInRange(range) };
    },
    async provideRenameEdits(model, position, newName, token) {
      const s = serverFor(model);
      if (!s?.caps.renameProvider) return null;
      let edit;
      try {
        edit = await s.request('textDocument/rename', { ...docParams(model, position), newName }, token);
      } catch (err) {
        return { edits: [], rejectReason: err.message };
      }
      if (!edit) return { edits: [], rejectReason: 'Nothing to rename here.' };
      await applyWorkspaceEdit(edit);
      return { edits: [] };
    },
  });
  L.registerCodeActionProvider('*', {
    async provideCodeActions(model, range, context, token) {
      const s = serverFor(model);
      if (!s?.caps.codeActionProvider) return null;
      const diagnostics = (s.diagnostics.get(model.uri.toString()) || []).filter((d) => monaco.Range.areIntersectingOrTouching(toRange(d.range), range));
      const res = await s.ask('textDocument/codeAction', {
        textDocument: { uri: model.uri.toString() }, range: fromRange(range),
        context: { diagnostics, only: context.only ? [context.only] : undefined, triggerKind: context.trigger === 1 ? 1 : 2 },
      }, token);
      if (!res?.length) return null;
      const actions = res.map((a) => (typeof a.command === 'string'
        ? { title: a.title, command: { id: RUN, title: a.title, arguments: [s.key, { command: a }] } }
        : {
          title: a.title, kind: a.kind, isPreferred: a.isPreferred, disabled: a.disabled?.reason,
          diagnostics: a.diagnostics?.map((d) => markerOf(d, s.program)),
          command: { id: RUN, title: a.title, arguments: [s.key, { action: a }] },
        }));
      return { actions, dispose() {} };
    },
  }, { providedCodeActionKinds: ['quickfix', 'refactor', 'source'] });
  L.registerInlayHintsProvider('*', {
    onDidChangeInlayHints: inlayChanged.event,
    async provideInlayHints(model, range, token) {
      const s = serverFor(model);
      if (!s?.caps.inlayHintProvider) return null;
      const res = await s.ask('textDocument/inlayHint', { textDocument: { uri: model.uri.toString() }, range: fromRange(range) }, token);
      const text = (t) => (t == null ? undefined : typeof t === 'string' ? t : markdown(t));
      return {
        hints: (res || []).map((h) => ({
          position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
          label: typeof h.label === 'string' ? h.label : h.label.map((p) => ({ label: p.value, tooltip: text(p.tooltip) })),
          kind: h.kind, paddingLeft: h.paddingLeft, paddingRight: h.paddingRight, tooltip: text(h.tooltip),
        })),
        dispose() {},
      };
    },
  });
  monaco.editor.registerCommand(RUN, (_accessor, serverKey, payload) => runAction(serverKey, payload));
  // Go to Definition (and friends) into another file opens it in a tab.
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      // The same file: the editor moves there itself.
      if (resource.scheme !== 'file' || source.getModel()?.uri.toString() === resource.toString()) return false;
      const sel = selectionOrPosition && ('startLineNumber' in selectionOrPosition
        ? selectionOrPosition
        : new monaco.Range(selectionOrPosition.lineNumber, selectionOrPosition.column, selectionOrPosition.lineNumber, selectionOrPosition.column));
      openFile(resource.fsPath, { pinned: true, selection: sel });
      return true;
    },
  });
}

/** Symbols across the project (Go to Symbol in Workspace), from every running server. */
export async function workspaceSymbols(query) {
  const ready = [...servers.values()].filter((s) => s.state === 'ready' && s.caps.workspaceSymbolProvider);
  const lists = await Promise.all(ready.map(async (s) => ((await s.ask('workspace/symbol', { query })) || []).map((x) => ({ ...x, server: s }))));
  return lists.flat().map((x) => {
    const uri = monaco.Uri.parse(x.location.uri);
    return { name: x.name, container: x.containerName || '', kind: (x.kind || 13) - 1, path: uri.fsPath, range: x.location.range ? toRange(x.location.range) : null };
  });
}

export function hasWorkspaceSymbols() {
  return [...servers.values()].some((s) => s.state === 'ready' && s.caps.workspaceSymbolProvider);
}

// ---------------------------------------------------------------------------
// Status bar, commands, start and stop
// ---------------------------------------------------------------------------
function activeServer() {
  const doc = activeDoc();
  if (!doc?.path || !enabled()) return { def: null };
  const def = defFor(doc.path);
  if (!def) return { def: null };
  const s = attached.get(monaco.Uri.file(doc.path).toString())
    || [...servers.values()].find((x) => x.def.id === def.id && (x.state !== 'ready' || isInside(x.root, doc.path)));
  return { def, server: s };
}

function renderStatus() {
  if (!statusNode) return;
  const { def, server } = activeServer();
  statusNode.style.display = def ? '' : 'none';
  if (!def) return;
  statusNode.classList.toggle('sb-dim', !server || server.state === 'missing');
  if (!server || server.state === 'missing') {
    statusNode.replaceChildren(icon('circle-slash'), el('span', {}, ` ${def.name}`));
    statusNode.title = missing.has(def.id) ? `No ${def.name} language server is installed. Click for how to add one.` : `${def.name} language server`;
    return;
  }
  const busy = [...server.progress.values()].pop();
  if (server.state === 'starting') {
    statusNode.replaceChildren(icon('sync', 'spin'), el('span', {}, ` ${server.program}`));
    statusNode.title = `${server.program} is starting`;
  } else if (server.state === 'failed') {
    statusNode.replaceChildren(icon('error'), el('span', {}, ` ${server.program}`));
    statusNode.title = `${server.program}: ${server.error || 'stopped'}. Click for options.`;
  } else if (busy) {
    const pct = busy.percentage != null ? ` ${Math.round(busy.percentage)}%` : '';
    statusNode.replaceChildren(icon('sync', 'spin'), el('span', {}, ` ${server.program}: ${busy.title || busy.message || 'working'}${pct}`));
    statusNode.title = [busy.title, busy.message].filter(Boolean).join(' — ');
  } else {
    statusNode.replaceChildren(icon('json'), el('span', {}, ` ${server.program}`));
    const name = server.info?.name || server.program;
    const version = server.info?.version || '';
    statusNode.title = `${def.name} language server: ${version.includes(name) ? version : `${name} ${version}`}\nin ${server.root}\nClick for options.`;
  }
}

function statusMenu(e) {
  const { def, server } = activeServer();
  if (!def) return;
  const r = e.currentTarget.getBoundingClientRect();
  if (!server || server.state === 'missing') {
    notify({
      message: `No ${def.name} language server found. Install one to get completions, errors and go to definition: \`${def.hint}\`. ${def.commands.length > 1 ? `Any of: ${def.commands.map((c) => c[0]).join(', ')}.` : ''}`,
      actions: [
        { label: 'Check Again', run: () => restartAll() },
        { label: 'Settings', secondary: true, run: () => openSettings('languageServers') },
      ],
    });
    return;
  }
  const items = [
    { label: `Restart ${server.program}`, run: () => restartServer(server) },
    { label: 'Show Log', run: () => showOutput(LOG) },
    { separator: true },
    { label: 'Language Server Settings', run: () => openSettings('languageServers') },
  ];
  showMenu(items, { x: r.left, y: r.top - 8 - items.length * 26 });
}

async function restartServer(server) {
  const models = [...server.docs.values()].map((d) => d.model);
  await server.stop();
  servers.delete(server.key);
  missing.delete(server.def.id);
  const doc = activeDoc();
  if (doc?.model && !models.includes(doc.model)) models.push(doc.model);
  for (const m of models) if (!m.isDisposed()) attachModel(m);
  renderStatus();
}

async function restartAll() {
  missing.clear();
  await Promise.all([...servers.values()].map((s) => s.stop()));
  servers.clear();
  if (enabled()) for (const m of monaco.editor.getModels()) attachModel(m);
  renderStatus();
}

/** The running servers (for tests and the log). */
export function runningServers() {
  return [...servers.values()];
}

export function lspCommands() {
  return [
    { id: 'languageServers.restart', title: 'Restart Language Server', category: 'Language Servers', run: () => { const { server } = activeServer(); return server ? restartServer(server) : restartAll(); } },
    { id: 'languageServers.restartAll', title: 'Restart All Language Servers', category: 'Language Servers', run: () => restartAll() },
    { id: 'languageServers.showLog', title: 'Show Log', category: 'Language Servers', run: () => showOutput(LOG) },
  ];
}

export function initLsp(status) {
  // The browser and phone versions cannot run programs: no language servers there.
  if (!window.snake.lsp) {
    status.style.display = 'none';
    return;
  }
  statusNode = status;
  statusNode.classList.add('clickable');
  statusNode.addEventListener('click', statusMenu);
  statusNode.style.display = 'none';
  registerProviders();
  registerTriggers();
  window.snake.lsp.onMessage((pid, msg) => byProcess.get(pid)?.receive(msg));
  window.snake.lsp.onExit((pid, code, stderr) => byProcess.get(pid)?.exited(code, stderr));
  window.snake.lsp.onStderr?.((pid, text) => {
    const s = byProcess.get(pid);
    if (s) log(`[${s.def.name}] ${text.replace(/\s+$/, '')}`);
  });
  monaco.editor.onDidCreateModel((m) => attachModel(m));
  monaco.editor.onWillDisposeModel((m) => detachModel(m));
  for (const m of monaco.editor.getModels()) attachModel(m);
  bus.on('doc:saved', (doc) => attached.get(doc.model?.uri.toString())?.saved(doc.model));
  bus.on('editor:activeChanged', renderStatus);
  bus.on('workspace:changed', () => restartAll());
  settings.onChange(['languageServers.enabled', 'languageServers.custom'], () => restartAll());
}
