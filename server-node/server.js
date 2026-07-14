#!/usr/bin/env node
// humd-editor local server — Node.js implementation

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import { createServer } from 'http';
import { URL, URLSearchParams } from 'url';
import { execSync } from 'child_process';
import yargs from 'yargs';
import open from 'open';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..', 'src');
const SETTINGS_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '/', '.humd-editor', 'settings.json');

// Ensure settings directory exists
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}
ensureDir(path.dirname(SETTINGS_PATH));

// Server version
function computeVersion() {
  try {
    const h = crypto.createHash('sha1');
    h.update(fs.readFileSync(fileURLToPath(import.meta.url)));
    
    function collectFiles(dir, files = []) {
      if (fs.existsSync(dir)) {
        fs.readdirSync(dir).forEach(file => {
          const fullPath = path.join(dir, file);
          if (fs.statSync(fullPath).isDirectory()) {
            collectFiles(fullPath, files);
          } else if (['.html', '.js', '.css', '.txt'].includes(path.extname(file))) {
            files.push(fullPath);
          }
        });
      }
      return files;
    }
    
    collectFiles(SRC_DIR).sort().forEach(file => {
      try { h.update(fs.readFileSync(file)); } catch (e) {}
    });
    return h.digest('hex').substring(0, 12);
  } catch (e) {
    return 'dev';
  }
}

const SERVER_VERSION = computeVersion();
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

// Settings helpers
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveSettings(data) {
  ensureDir(path.dirname(SETTINGS_PATH));
  const tmpPath = SETTINGS_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, SETTINGS_PATH);
}

// Vault root
function vaultRoot() {
  const vp = loadSettings().vaultPath;
  if (!vp) return null;
  try { return path.resolve(vp); } catch (e) { return null; }
}

// Path confinement
function safePath(p, mustExist = false) {
  const root = vaultRoot();
  if (!root) throw new Error('No vault configured');
  const resolved = path.resolve(p);
  const rootStr = root.toString();
  const resolvedStr = resolved.toString();
  const isInside = resolvedStr === rootStr || 
                  resolvedStr.startsWith(rootStr + path.sep) || 
                  resolvedStr.startsWith(rootStr + '/');
  if (!isInside) throw new Error('Path is outside the vault');
  if (mustExist && !fs.existsSync(resolved)) throw new Error(`Path does not exist: ${p}`);
  return resolved;
}

function safePathHome(p, mustExist = false) {
  const resolved = path.resolve(p);
  const home = process.env.HOME || process.env.USERPROFILE || '/';
  const homeStr = home.toString();
  const resolvedStr = resolved.toString();
  const isInside = resolvedStr === homeStr || 
                  resolvedStr.startsWith(homeStr + path.sep) || 
                  resolvedStr.startsWith(homeStr + '/');
  if (!isInside) throw new Error(`Path is outside home directory: ${p}`);
  if (mustExist && !fs.existsSync(resolved)) throw new Error(`Path does not exist: ${p}`);
  return resolved;
}

// File system utilities
function listDirInternal(dirPath, isRoot) {
  const p = path.resolve(dirPath);
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) 
    throw new Error(`${dirPath} is not a directory`);
  
  const entries = [];
  try {
    fs.readdirSync(p).forEach(childName => {
      if (childName.startsWith('.')) return;
      const childPath = path.join(p, childName);
      const isDir = fs.statSync(childPath).isDirectory();
      if (isRoot && !isDir) {
        const ext = path.extname(childName).toLowerCase();
        if (!['.md', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf'].includes(ext)) return;
      }
      entries.push({ name: childName, path: childPath, is_dir: isDir, children: isDir ? [] : null });
    });
  } catch (e) {}
  
  entries.sort((a, b) => a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1);
  return entries;
}

function collectMdFiles(dirPath) {
  const result = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        result.push(...collectMdFiles(fullPath));
      } else if (entry.name.endsWith('.md')) {
        result.push(fullPath);
      }
    }
  } catch (e) {}
  return result;
}

function getVaultHash(vaultPath) {
  const h = crypto.createHash('sha1');
  for (const f of collectMdFiles(vaultPath).sort()) {
    try {
      const mtime = fs.statSync(f).mtime.getTime();
      h.update(`${f}:${mtime}`);
    } catch (e) {}
  }
  return h.digest('hex');
}

// Link index functions
const WIKILINK_RE = /\[\[([^\]|+)(?:\|[^\]]*)?\]\]/g;
const INLINE_TAG_RE = /(?<![\w&#(])#([A-Za-z][\w/-]*)/g;
const CODE_SPAN_RE = /```.*?```|~~~.*?~~~|`[^`\n]+`/gs;
const FRONTMATTER_RE = /^---\n.*?\n(?:---|\.\.\.)[ \t]*\n?/s;

function cleanTag(t) {
  return t.trim().replace(/^['"]+|['"]+$/g, '').replace(/^#+/, '').trim();
}

function extractYamlTags(content) {
  const lines = content.split('\n');
  if (!lines.length || lines[0].trim() !== '---') return [];
  
  let end = null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---' || lines[i].trim() === '...') {
      end = i;
      break;
    }
  }
  if (end === null) return [];
  
  const fm = lines.slice(1, end);
  for (let i = 0; i < fm.length; i++) {
    const line = fm[i];
    if (!line.match(/^tags\s*:/)) continue;
    const remainder = line.split(':', 1)[1].trim();
    if (remainder.startsWith('[')) {
      const m = remainder.match(/\[([^\]]*)\]/);
      const inner = m ? m[1] : '';
      return inner.split(',').map(cleanTag).filter(Boolean);
    }
    if (remainder) {
      return remainder.split(',').map(cleanTag).filter(Boolean);
    }
    // Block sequence
    const out = [];
    for (let j = i + 1; j < fm.length; j++) {
      const bl = fm[j];
      const m = bl.match(/^\s*-\s*(.+?)\s*$/);
      if (!m) break;
      const cleaned = cleanTag(m[1]);
      if (cleaned) out.push(cleaned);
    }
    return out;
  }
  return [];
}

function extractInlineTags(content) {
  let text = content.replace(CODE_SPAN_RE, '');
  text = text.replace(/https?:\/\/\S+/g, '');
  return text.match(INLINE_TAG_RE) || [];
}

function parseMdFile(fpath) {
  const content = fs.readFileSync(fpath, 'utf8');
  const targets = [];
  for (const m of content.matchAll(WIKILINK_RE)) {
    const target = m[1].trim();
    if (target) targets.push(target);
  }
  return {
    content,
    stem: path.basename(fpath, '.md'),
    yaml_tags: extractYamlTags(content),
    inline_tags: extractInlineTags(content),
    wikilinks: targets
  };
}

// File cache for link index
const fileCache = new Map();
const lastIndexJson = new Map();

function refreshFileCache(vaultPath) {
  const files = collectMdFiles(vaultPath);
  const fileSet = new Set(files);
  
  for (const fpath of files) {
    try {
      const mtime = fs.statSync(fpath).mtime.getTime();
      const cached = fileCache.get(fpath);
      if (cached && cached.mtime === mtime) continue;
      
      const parsed = parseMdFile(fpath);
      parsed.mtime = mtime;
      fileCache.set(fpath, parsed);
    } catch (e) {}
  }
  
  const prefix = path.normalize(vaultPath) + path.sep;
  for (const fpath of [...fileCache.keys()]) {
    if (!fileSet.has(fpath) && fpath.startsWith(prefix)) {
      fileCache.delete(fpath);
    }
  }
  
  return files;
}

function buildLinkIndex(vaultPath) {
  const files = refreshFileCache(vaultPath);
  const items = [...fileCache.entries()]
    .filter(([f]) => files.includes(f))
    .map(([f, data]) => ({ fpath: f, data }));

  const backlinks = {};
  const tags = {};
  const notes = {};
  const tagIndex = {};
  const taggedFiles = new Set();

  function addTag(raw, fpath) {
    const key = raw.toLowerCase();
    let entry = tagIndex[key];
    if (!entry) {
      entry = { name: raw, count: 0, files: [] };
      tagIndex[key] = entry;
    }
    entry.count++;
    if (!entry.files.includes(fpath)) {
      entry.files.push(fpath);
    }
    taggedFiles.add(fpath);
  }

  for (const { fpath, data } of items) {
    const stem = data.stem;
    notes[stem.toLowerCase()] = fpath;
    
    if (data.yaml_tags && data.yaml_tags.length) {
      tags[fpath] = data.yaml_tags;
    }
    
    for (const t of data.yaml_tags) addTag(t, fpath);
    for (const t of data.inline_tags) addTag(t, fpath);

    for (const target of data.wikilinks) {
      if (target && target !== stem) {
        if (!backlinks[target]) backlinks[target] = [];
        if (!backlinks[target].includes(stem)) {
          backlinks[target].push(stem);
        }
      }
    }
  }

  for (const sources of Object.values(backlinks)) sources.sort();
  for (const entry of Object.values(tagIndex)) entry.files.sort();

  const untagged = files.filter(f => !taggedFiles.has(f)).sort();

  const index = { backlinks, tags, notes, tag_index: tagIndex, untagged };
  const serialized = JSON.stringify(index);
  if (lastIndexJson.get(vaultPath) !== serialized) {
    const indexPath = path.join(vaultPath, '.link-index.json');
    const tmpPath = indexPath + '.tmp';
    fs.writeFileSync(tmpPath, serialized, 'utf8');
    fs.renameSync(tmpPath, indexPath);
    lastIndexJson.set(vaultPath, serialized);
  }
  
  return index;
}

function getLinkIndex(vaultPath) {
  const indexPath = path.join(vaultPath, '.link-index.json');
  if (fs.existsSync(indexPath)) {
    try {
      return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch (e) {}
  }
  return { backlinks: {}, tags: {}, notes: {}, tag_index: {}, untagged: [] };
}

// Search vault
function searchVault(vaultPath, query, maxFiles = 200, maxPerFile = 5) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  
  const files = refreshFileCache(vaultPath);
  const items = [...fileCache.entries()]
    .filter(([f]) => files.includes(f))
    .map(([f, data]) => ({ fpath: f, content: data.content }));
  
  items.sort((a, b) => a.fpath.localeCompare(b.fpath));
  
  const results = [];
  for (const { fpath, content } of items) {
    if (!content.toLowerCase().includes(q)) continue;
    
    const matches = [];
    const lines = content.split('\n');
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];
      const low = line.toLowerCase();
      if (!low.includes(q)) continue;
      
      let snippet = line.trim();
      if (snippet.length > 160) {
        const idx = low.indexOf(q);
        const start = Math.max(0, idx - 40);
        snippet = (start > 0 ? '...' : '') + 
                  line.substring(start, start + 160).trim() + 
                  '...';
      }
      matches.push({ line: n + 1, text: snippet });
      if (matches.length >= maxPerFile) break;
    }
    
    if (matches.length) {
      results.push({ path: fpath, name: path.basename(fpath, '.md'), matches });
    }
    if (results.length >= maxFiles) break;
  }
  return results;
}

// Wikilink maintenance
function renameWikilinkTargets(vaultPath, oldStem, newStem) {
  if (!oldStem || oldStem === newStem) return 0;
  
  const pattern = new RegExp(
    '(\[\[)\s*' + oldStem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\s*(\||\]\])',
    'gi'
  );
  
  let changed = 0;
  for (const fpath of collectMdFiles(vaultPath)) {
    try {
      let content = fs.readFileSync(fpath, 'utf8');
      const newContent = content.replace(pattern, (match, p1, p2) => p1 + newStem + p2);
      if (newContent !== content) {
        fs.writeFileSync(fpath, newContent, 'utf8');
        changed++;
      }
    } catch (e) {}
  }
  return changed;
}

// AI functions
const DEFAULT_MISTRAL_MODEL = 'mistral-large-latest';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

class OllamaUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'OllamaUnavailable';
  }
}

// System prompts
function readPromptFile(name) {
  try {
    return fs.readFileSync(path.join(SRC_DIR, name), 'utf8').trim();
  } catch (e) {
    return null;
  }
}

const PROOFREAD_FALLBACK = 'Proofread the following Markdown text for grammar, punctuation, clarity and British spelling, ignoring Markdown syntax. Return a JSON array of objects with string fields original, suggestion and comment (an empty array if there are no changes).';
const PROOFREAD_SYSTEM = readPromptFile('PROOFREAD_SYSTEM.md') || PROOFREAD_FALLBACK;

const TRANSLATE_FALLBACK = 'You are a scholarly translator. Translate the supplied Markdown text into {{TARGET_LANGUAGE}} using a formal, academic register, leaving Markdown syntax, wikilinks, footnote markers, citation keys and frontmatter unchanged. Break the text into natural units and return a JSON array of objects with string fields original (the source passage, verbatim), suggestion (its academic {{TARGET_LANGUAGE}} translation) and comment (an alternative phrasing or note, or an empty string). Return an empty array if the text is already in {{TARGET_LANGUAGE}}.';
const TRANSLATE_SYSTEM = readPromptFile('TRANSLATE_SYSTEM.md') || TRANSLATE_FALLBACK;

const SUGGEST_TAGS_SYSTEM = 'You are a librarian tagging an article for a personal notes vault. You are given the document text and a list of tags already used elsewhere in the vault. Choose the tags from that list that best describe this document. Only return tags that appear verbatim in the provided list — never invent new tags. Return a JSON array of tag strings (without a leading #), most relevant first, at most 3. If none of the existing tags fit, return an empty array.';

const PROOFREAD_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      original: { type: 'STRING' },
      suggestion: { type: 'STRING' },
      comment: { type: 'STRING' }
    },
    required: ['original', 'suggestion', 'comment']
  }
};

const PROOFREAD_JSON_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      original: { type: 'string' },
      suggestion: { type: 'string' },
      comment: { type: 'string' }
    },
    required: ['original', 'suggestion', 'comment']
  }
};

const TAGS_SCHEMA = { type: 'ARRAY', items: { type: 'STRING' } };
const TAGS_JSON_SCHEMA = { type: 'array', items: { type: 'string' } };

async function aiComplete(system, user, mistralSchema, jsonSchema, settings) {
  const provider = settings.proofreadProvider || 'mistral';
  
  if (provider === 'ollama') {
    try {
      const result = await ollamaComplete(system, user, jsonSchema, settings);
      return { raw: result, warning: null };
    } catch (e) {
      if (e instanceof OllamaUnavailable) {
        try {
          const result = await mistralComplete(system, user, mistralSchema, settings);
          return { raw: result, warning: 'Ollama not running — used Mistral instead.' };
        } catch (me) {
          throw new Error(`Ollama is not running, and the Mistral fallback failed: ${me.message}`);
        }
      }
      throw e;
    }
  }
  
  const result = await mistralComplete(system, user, mistralSchema, settings);
  return { raw: result, warning: null };
}

async function mistralComplete(system, user, schema, settings) {
  const apiKey = settings.mistralApiKey;
  if (!apiKey) {
    throw new Error('No Mistral API key set. Add one under Settings -> Proofreading.');
  }
  
  const model = settings.mistralModel || DEFAULT_MISTRAL_MODEL;
  const url = 'https://api.mistral.ai/v1/chat/completions';
  
  const payload = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7
  };
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });
  
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Mistral API error ${response.status}: ${detail.substring(0, 500)}`);
  }
  
  const data = await response.json();
  const choices = data.choices || [];
  if (!choices.length) {
    throw new Error(`Mistral returned no result: ${JSON.stringify(data).substring(0, 400)}`);
  }
  
  let out = (choices[0].message?.content || '').trim();
  if (!out) {
    throw new Error('Mistral returned an empty response.');
  }
  
  return out;
}

async function ollamaComplete(system, user, jsonSchema, settings) {
  const model = settings.ollamaModel;
  if (!model) {
    throw new Error('No Ollama model set. Add one under Settings -> Proofreading.');
  }
  
  const base = (settings.ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  const url = `${base}/api/chat`;
  
  const payload = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    stream: false,
    format: jsonSchema
  };
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    if (response.status === 0) {
      throw new OllamaUnavailable(`Could not reach Ollama at ${base} — is ollama serve running?`);
    }
    throw new Error(`Ollama API error ${response.status}: ${detail.substring(0, 500)}`);
  }
  
  const data = await response.json();
  let out = (data.message?.content || '').trim();
  if (!out) {
    throw new Error('Ollama returned an empty response.');
  }
  
  return out;
}

async function proofreadText(text) {
  const settings = loadSettings();
  const result = await aiComplete(PROOFREAD_SYSTEM, text, PROOFREAD_SCHEMA, PROOFREAD_JSON_SCHEMA, settings);
  return result;
}

async function translateText(text, targetLang) {
  const settings = loadSettings();
  const target = (targetLang || '').trim() || 'English';
  const system = TRANSLATE_SYSTEM.replace(/\{\{TARGET_LANGUAGE\}\}/g, target);
  const result = await aiComplete(system, text, PROOFREAD_SCHEMA, PROOFREAD_JSON_SCHEMA, settings);
  return result;
}

async function suggestTagsText(text, existingTags) {
  const settings = loadSettings();
  const tagList = existingTags && existingTags.length ? existingTags.join(', ') : '(none)';
  const user = `Existing tags:\n${tagList}\n\n---\n\nDocument:\n${text}`;
  const result = await aiComplete(SUGGEST_TAGS_SYSTEM, user, TAGS_SCHEMA, TAGS_JSON_SCHEMA, settings);
  return result;
}

// Git integration
function findGit() {
  const search = process.env.PATH || '';
  const extraDirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin', 
    '/opt/local/bin',
    path.join(process.env.HOME || '/', '.local', 'bin'),
    '/usr/bin'
  ];
  
  let fullPath = search;
  for (const d of extraDirs) {
    if (!fullPath.split(path.delimiter).includes(d)) {
      fullPath += path.delimiter + d;
    }
  }
  
  return whichSync('git', fullPath);
}

function whichSync(cmd, searchPath) {
  const dirs = searchPath.split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      const fullPath = path.join(dir, cmd);
      const stats = fs.statSync(fullPath);
      if (stats.isFile() && (stats.mode & 0o111)) {
        return fullPath;
      }
    } catch (e) {}
  }
  return null;
}

function _git(args, vault, timeout = 60) {
  const git = findGit();
  if (!git) {
    return { returncode: 127, stdout: '', stderr: 'git not found' };
  }
  
  try {
    const result = execSync(
      [git, '-C', vault, ...args].join(' '),
      { encoding: 'utf8', timeout: timeout * 1000, stdio: 'pipe' }
    );
    return { returncode: 0, stdout: result, stderr: '' };
  } catch (e) {
    return { 
      returncode: e.status || 1, 
      stdout: e.stdout || '', 
      stderr: e.stderr || String(e.message) 
    };
  }
}

function isGitRepo(vault) {
  const r = _git(['rev-parse', '--is-inside-work-tree'], vault, 10);
  return r.returncode === 0 && r.stdout.trim() === 'true';
}

function gitHasRemote(vault) {
  const r = _git(['remote'], vault, 10);
  return r.returncode === 0 && Boolean(r.stdout.trim());
}

function commitMessage(vault) {
  const r = _git(['diff', '--cached', '--name-status'], vault, 30);
  const entries = [];
  
  for (const line of r.stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const code = parts[0][0];
    if (code === 'R' && parts.length >= 3) {
      entries.push({ code, path: parts[2], old: parts[1] });
    } else {
      entries.push({ code, path: parts[1], old: null });
    }
  }
  
  const verb = { A: 'Add', M: 'Update', D: 'Delete', R: 'Rename', C: 'Copy' };
  if (!entries.length) return 'Update vault';
  if (entries.length === 1) {
    const { code, path, old } = entries[0];
    if (code === 'R') return `Rename ${old} -> ${path}`;
    return `${verb[code] || 'Update'} ${path}`;
  }
  
  const header = `Update ${entries.length} files`;
  const body = entries.map(e => e.code === 'R' ? `R ${e.old} -> ${e.path}` : `${e.code} ${e.path}`).join('\n');
  return `${header}\n\n${body}`;
}

function gitCommitAll(vault, message = null) {
  if (!isGitRepo(vault)) {
    return { is_repo: false };
  }
  
  let add = _git(['add', '-A'], vault);
  if (add.returncode !== 0) {
    return { is_repo: true, committed: false, error: add.stderr.trim() };
  }
  
  if (_git(['diff', '--cached', '--quiet'], vault).returncode === 0) {
    return { is_repo: true, committed: false, reason: 'clean' };
  }
  
  const msg = message || commitMessage(vault);
  const commit = _git(['commit', '-m', msg], vault);
  if (commit.returncode !== 0) {
    return { is_repo: true, committed: false, error: commit.stderr.trim() };
  }
  
  const result = { is_repo: true, committed: true, message: msg.split('\n')[0] };
  
  if (!gitHasRemote(vault)) {
    result.pushed = false;
    result.reason = 'no-remote';
    return result;
  }
  
  const push = _git(['push'], vault, 120);
  if (push.returncode !== 0) {
    result.pushed = false;
    result.error = (push.stderr || push.stdout).trim();
    result.needs_auth = true;
  } else {
    result.pushed = true;
  }
  return result;
}

// Folder/file picker (macOS osascript)
function pickFolder(prompt = 'Select your Markdown vault folder') {
  try {
    const script = `on run argv\n  POSIX path of (choose folder with prompt (item 1 of argv))\nend run`;
    const result = execSync(['osascript', '-e', script, prompt].join(' '), { encoding: 'utf8' });
    return result.trim().replace(/\/$/, '');
  } catch (e) {
    return null;
  }
}

function pickFile(extensions = [], prompt = 'Select a file') {
  try {
    const extToUti = {
      json: 'public.json',
      bib: 'public.plain-text',
      csl: 'public.item',
      docx: 'org.openxmlformats.wordprocessingml.document',
      xml: 'public.xml'
    };
    
    const safeExts = extensions.map(e => e.replace(/[^A-Za-z0-9]/g, '').toLowerCase()).filter(Boolean);
    const utis = safeExts.map(e => extToUti[e] || `public.${e}`);
    
    let typeClause = '';
    if (utis.length) {
      const utiList = utis.map(u => `"${u}"`).join(', ');
      typeClause = ` of type {${utiList}}`;
    }
    
    const script = `on run argv\n  POSIX path of (choose file with prompt (item 1 of argv)${typeClause})\nend run`;
    const result = execSync(['osascript', '-e', script, prompt].join(' '), { encoding: 'utf8' });
    return result.trim();
  } catch (e) {
    return null;
  }
}

// Markdown / Pandoc rendering
function findPandoc() {
  const search = process.env.PATH || '';
  const extraDirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/local/bin',
    path.join(process.env.HOME || '/', '.local', 'bin'),
    '/usr/bin'
  ];
  
  let fullPath = search;
  for (const d of extraDirs) {
    if (!fullPath.split(path.delimiter).includes(d)) {
      fullPath += path.delimiter + d;
    }
  }
  
  return whichSync('pandoc', fullPath);
}

function renderPandoc(markdown, filePath) {
  const pandoc = findPandoc();
  if (!pandoc) {
    throw new Error('pandoc not found. Install it (e.g. `brew install pandoc`) or turn off Pandoc rendering in Settings.');
  }
  
  const args = [
    pandoc,
    '--from=markdown+footnotes+wikilinks_title_after_pipe+strikeout+pipe_tables+lists_without_preceding_blankline+hard_line_breaks',
    '--to=html5',
    '--standalone=false',
    '--number-sections'
  ];
  
  try {
    const result = execSync(args.join(' '), { input: markdown, encoding: 'utf8' });
    return result;
  } catch (e) {
    throw new Error(e.stderr || String(e.message));
  }
}

function inlineWikilinks(markdown, vaultPath, sourcePath = null) {
  const notes = {};
  for (const f of collectMdFiles(vaultPath)) {
    notes[path.basename(f, '.md').toLowerCase()] = f;
  }
  
  function expand(text, stack) {
    let out = [];
    let pos = 0;
    
    for (const m of text.matchAll(CODE_SPAN_RE)) {
      out.push(expandSegment(text.substring(pos, m.index), stack));
      out.push(m[0]);
      pos = m.index + m[0].length;
    }
    out.push(expandSegment(text.substring(pos), stack));
    return out.join('');
  }
  
  function expandSegment(segment, stack) {
    return segment.replace(WIKILINK_RE, (match, p1) => {
      const name = p1.split('#')[0].trim().toLowerCase();
      const fpath = notes[name];
      if (!fpath || stack.has(name)) return match;
      
      try {
        let content = fs.readFileSync(fpath, 'utf8');
        content = content.replace(FRONTMATTER_RE, '').trim();
        return expand(content, new Set([...stack, name]));
      } catch (e) {
        return match;
      }
    });
  }
  
  let stack = new Set();
  if (sourcePath) {
    stack.add(path.basename(sourcePath, '.md').toLowerCase());
  }
  return expand(markdown, stack);
}

function exportDocx(markdown, sourcePath = null) {
  const settings = loadSettings();
  const bibPath = settings.cslJsonPath;
  const cslPath = settings.cslStylePath;
  const refDocPath = settings.pandocRefDocPath;
  
  if (!bibPath) throw new Error('Bibliography path not configured in settings');
  if (!cslPath) throw new Error('CSL style path not configured in settings');
  
  const vault = settings.vaultPath;
  let processedMarkdown = markdown;
  if (vault) {
    processedMarkdown = inlineWikilinks(markdown, vault, sourcePath);
  }
  
  const args = [
    findPandoc(),
    '-C',
    `--bibliography=${bibPath}`,
    `--csl=${cslPath}`,
    '--from=markdown+footnotes+wikilinks_title_after_pipe+strikeout+pipe_tables+lists_without_preceding_blankline+hard_line_breaks',
    '--to=docx'
  ];
  
  if (refDocPath) {
    args.push(`--reference-doc=${refDocPath}`);
  }
  
  try {
    const result = execSync(args.join(' '), { input: processedMarkdown, encoding: null });
    return result;
  } catch (e) {
    throw new Error(e.stderr || String(e.message));
  }
}

// HTTP server utilities
function requestAllowed(req) {
  const host = req.headers.host || '';
  const hostname = host.split(':')[0] || '';
  if (!ALLOWED_HOSTS.has(hostname)) {
    return false;
  }
  
  const origin = req.headers.origin;
  if (origin) {
    try {
      const o = new URL(origin).hostname;
      if (!ALLOWED_HOSTS.has(o) && !['::1', '127.0.0.1', 'localhost'].includes(o)) {
        return false;
      }
    } catch (e) {
      return false;
    }
  }
  return true;
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendErrorJson(res, msg, status = 400) {
  sendJson(res, { error: msg }, status);
}

function parseQuery(query) {
  const result = {};
  if (!query) return result;
  
  for (const pair of query.split('&')) {
    const [key, value] = pair.split('=');
    const decodedKey = decodeURIComponent(key || '');
    const decodedValue = decodeURIComponent(value || '');
    if (result[decodedKey]) {
      if (Array.isArray(result[decodedKey])) {
        result[decodedKey].push(decodedValue);
      } else {
        result[decodedKey] = [result[decodedKey], decodedValue];
      }
    } else {
      result[decodedKey] = decodedValue;
    }
  }
  return result;
}

// HTTP server
const server = createServer(async (req, res) => {
  try {
    if (!requestAllowed(req)) {
      sendErrorJson(res, 'Forbidden', 403);
      return;
    }
    
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    const requestPath = parsed.pathname;
    const qs = parseQuery(parsed.search.substring(1));
    
    if (!requestPath.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
    
    if (req.method === 'GET') {
      handleGet(req, res, requestPath, qs);
    } else if (req.method === 'POST') {
      const body = await readBody(req);
      handlePost(req, res, requestPath, body);
    } else {
      sendErrorJson(res, 'Method not allowed', 405);
    }
  } catch (e) {
    console.error('Request error:', e);
    sendErrorJson(res, String(e.message || e), 500);
  }
});

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

function handleGet(req, res, requestPath, qs) {
  try {
    switch (requestPath) {
      case '/api/settings':
        sendJson(res, loadSettings());
        break;
      case '/api/version':
        sendJson(res, { version: SERVER_VERSION });
        break;
      case '/api/list-vault':
        if (!qs.path) { sendErrorJson(res, 'path required'); return; }
        try { sendJson(res, listDirInternal(safePath(qs.path), true)); }
        catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/list-dir':
        if (!qs.path) { sendErrorJson(res, 'path required'); return; }
        try { sendJson(res, listDirInternal(safePath(qs.path), false)); }
        catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/read-file':
        if (!qs.path) { sendErrorJson(res, 'path required'); return; }
        try {
          let fpath;
          try { fpath = safePath(qs.path, true); }
          catch (e) {
            if (String(e).includes('outside the vault')) {
              fpath = safePathHome(qs.path, true);
            } else { throw e; }
          }
          sendJson(res, { content: fs.readFileSync(fpath, 'utf8') });
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/image':
        if (!qs.path) { sendErrorJson(res, 'path required'); return; }
        try {
          const fpath = safePath(qs.path, true);
          const data = fs.readFileSync(fpath);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': data.length,
            'Cache-Control': 'public, max-age=3600'
          });
          res.end(data);
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/vault-hash':
        if (!qs.path) { sendErrorJson(res, 'path required'); return; }
        sendJson(res, { hash: getVaultHash(qs.path) });
        break;
      case '/api/git-info':
        try {
          const root = vaultRoot();
          if (!root || !isGitRepo(root)) {
            sendJson(res, { is_repo: false });
          } else {
            sendJson(res, { is_repo: true, has_remote: gitHasRemote(root) });
          }
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/tags':
        if (!qs.vault_path || !qs.note_path) { sendJson(res, []); return; }
        try {
          const index = getLinkIndex(qs.vault_path);
          sendJson(res, index.tags?.[qs.note_path] || []);
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/link-index':
        if (!qs.path) { sendErrorJson(res, 'path required'); return; }
        try { sendJson(res, getLinkIndex(qs.path)); }
        catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/search':
        if (!qs.vault_path) { sendErrorJson(res, 'vault_path required'); return; }
        try { sendJson(res, searchVault(qs.vault_path, qs.q || '')); }
        catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/zotero-cayw':
        try {
          const fmt = qs.format || 'pandoc';
          const result = execSync(`curl -s "http://127.0.0.1:23119/better-bibtex/cayw?format=${fmt}"`, 
            { encoding: 'utf8', timeout: 300000 });
          sendJson(res, { citation: result });
        } catch (e) { sendErrorJson(res, `Zotero not available: ${e.message}`, 502); }
        break;
      default:
        try {
          // Map request path to file system path (like Python server's translate_path)
          let relPath = requestPath === '/' ? '' : requestPath.substring(1);
          let filePath = relPath ? path.join(SRC_DIR, relPath) : path.join(SRC_DIR, 'index.html');
          
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const content = fs.readFileSync(filePath);
            const ext = path.extname(filePath);
            const contentType = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.txt': 'text/plain' }[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
          } else {
            sendErrorJson(res, 'Not found', 404);
          }
        } catch (e) { sendErrorJson(res, 'Not found', 404); }
    }
  } catch (e) {
    sendErrorJson(res, String(e.message || e), 500);
  }
}

async function handlePost(req, res, requestPath, body) {
  try {
    switch (requestPath) {
      case '/api/settings':
        try {
          const existing = loadSettings();
          Object.assign(existing, body);
          saveSettings(existing);
          sendJson(res, { ok: true });
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/write-file':
        try {
          safePath(body.path);
          fs.writeFileSync(body.path, body.content, 'utf8');
          sendJson(res, { ok: true });
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/create-file':
        try {
          const name = body.name;
          if (name.includes('/') || name.includes('\\')) throw new Error('Name cannot contain path separators');
          let fileName = name;
          if (!fileName.endsWith('.md')) fileName += '.md';
          const filePath = safePath(path.join(body.vault_path, fileName));
          fs.writeFileSync(filePath, '', 'utf8');
          sendJson(res, { path: filePath });
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/create-folder':
        try {
          const name = body.name;
          if (name.includes('/') || name.includes('\\')) throw new Error('Name cannot contain path separators');
          const parent = body.parent_path || body.vault_path;
          const dirPath = safePath(path.join(parent, name));
          if (fs.existsSync(dirPath)) throw new Error(`'${name}' already exists`);
          fs.mkdirSync(dirPath);
          sendJson(res, { path: dirPath });
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/git-commit':
        try {
          const root = vaultRoot();
          if (!root) { sendJson(res, { is_repo: false }); }
          else { sendJson(res, gitCommitAll(root)); }
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/rename-file':
        try {
          const oldPath = safePath(body.old_path, true);
          const newName = body.new_name;
          if (newName.includes('/') || newName.includes('\\')) throw new Error('Name cannot contain path separators');
          const newPath = safePath(path.join(path.dirname(oldPath), newName));
          if (fs.existsSync(newPath)) throw new Error(`'${newName}' already exists`);
          
          const root = vaultRoot();
          const repo = root && isGitRepo(root);
          if (repo) {
            if (_git(['mv', oldPath, newPath], root).returncode !== 0) {
              fs.renameSync(oldPath, newPath);
            }
          } else {
            fs.renameSync(oldPath, newPath);
          }
          
          if (root && newPath.endsWith('.md')) {
            renameWikilinkTargets(root, path.basename(oldPath, '.md'), path.basename(newPath, '.md'));
          }
          
          const resp = { path: newPath };
          if (repo) {
            resp.git = gitCommitAll(root, `Rename ${path.basename(oldPath)} -> ${path.basename(newPath)}`);
          }
          sendJson(res, resp);
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/move-file':
        try {
          const src = safePath(body.src_path, true);
          const dest = safePath(path.join(body.dest_dir, path.basename(src)));
          if (fs.existsSync(dest)) throw new Error(`'${path.basename(src)}' already exists in destination`);
          if (fs.statSync(src).isDirectory() && (dest === src || src.includes(dest))) {
            throw new Error('Cannot move a folder into itself');
          }
          
          const root = vaultRoot();
          const repo = root && isGitRepo(root);
          if (repo) {
            if (_git(['mv', src, dest], root).returncode !== 0) {
              fs.renameSync(src, dest);
            }
          } else {
            fs.renameSync(src, dest);
          }
          
          const resp = { path: dest };
          if (repo) {
            resp.git = gitCommitAll(root, `Move ${path.basename(src)} to ${path.basename(body.dest_dir)}/`);
          }
          sendJson(res, resp);
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/trash-file':
        try {
          const filePath = String(safePath(body.path, true));
          const script = `function run(argv) {\n  ObjC.import('Foundation');\n  var fm = $.NSFileManager.defaultManager;\n  var url = $.NSURL.fileURLWithPath(argv[0]);\n  var err = Ref();\n  var ok = fm.trashItemAtURLResultingItemURLError(url, null, err);\n  if (!ok) throw new Error(ObjC.unwrap(err[0].localizedDescription) || 'trash failed');\n}`;
          execSync(['osascript', '-l', 'JavaScript', '-e', script, filePath].join(' '), { encoding: 'utf8' });
          sendJson(res, { ok: true });
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/build-link-index':
        try { sendJson(res, buildLinkIndex(body.vault_path)); }
        catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/pick-folder':
        try {
          const folder = pickFolder(body.prompt || 'Select your Markdown vault folder');
          sendJson(res, { path: folder });
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/pick-file':
        try {
          const fpath = pickFile(body.extensions || [], body.prompt || 'Select a file');
          sendJson(res, { path: fpath });
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/pandoc':
        try {
          sendJson(res, { html: renderPandoc(body.markdown, body.file_path) });
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/export-docx':
        try {
          const markdown = body.markdown || '';
          if (!markdown) throw new Error('No markdown content provided');
          const docxBytes = exportDocx(markdown, body.file_path);
          res.writeHead(200, {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'Content-Disposition': 'attachment; filename="document.docx"',
            'Content-Length': docxBytes.length
          });
          res.end(docxBytes);
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/proofread':
        try {
          const text = (body.text || '').trim();
          if (!text) throw new Error('Nothing to proofread');
          const result = await proofreadText(text);
          let stripped = result.raw.trim();
          if (stripped.startsWith('```')) {
            stripped = stripped.replace(/^```[a-zA-Z]*\n?/, '');
            stripped = stripped.replace(/\n?```$/, '').trim();
          }
          let resp;
          try {
            const suggestions = JSON.parse(stripped);
            if (!Array.isArray(suggestions)) throw new Error('not a list');
            resp = { suggestions };
          } catch (e) { resp = { result: result.raw }; }
          if (result.warning) resp.warning = result.warning;
          sendJson(res, resp);
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/translate':
        try {
          const text = (body.text || '').trim();
          if (!text) throw new Error('Nothing to translate');
          const targetLang = body.target_lang || loadSettings().documentLanguage || 'English';
          const result = await translateText(text, targetLang);
          let stripped = result.raw.trim();
          if (stripped.startsWith('```')) {
            stripped = stripped.replace(/^```[a-zA-Z]*\n?/, '');
            stripped = stripped.replace(/\n?```$/, '').trim();
          }
          let resp;
          try {
            const suggestions = JSON.parse(stripped);
            if (!Array.isArray(suggestions)) throw new Error('not a list');
            resp = { suggestions };
          } catch (e) { resp = { result: result.raw }; }
          if (result.warning) resp.warning = result.warning;
          sendJson(res, resp);
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/suggest-tags':
        try {
          const text = (body.text || '').trim();
          if (!text) throw new Error('Nothing to analyse');
          const existing = body.existing_tags || [];
          const result = await suggestTagsText(text, existing);
          let stripped = result.raw.trim();
          if (stripped.startsWith('```')) {
            stripped = stripped.replace(/^```[a-zA-Z]*\n?/, '');
            stripped = stripped.replace(/\n?```$/, '').trim();
          }
          let parsed;
          try {
            parsed = JSON.parse(stripped);
            if (!Array.isArray(parsed)) throw new Error('not a list');
          } catch (e) { parsed = []; }
          
          const canon = {};
          for (const t of existing) {
            const key = String(t).replace(/^#+/, '').toLowerCase();
            canon[key] = String(t).replace(/^#+/, '');
          }
          
          const seen = new Set();
          const tags = [];
          for (const t of parsed) {
            const key = String(t).replace(/^#+/, '').toLowerCase();
            if (key in canon && !seen.has(key)) {
              seen.add(key);
              tags.push(canon[key]);
            }
          }
          
          const resp = { tags };
          if (result.warning) resp.warning = result.warning;
          sendJson(res, resp);
        } catch (e) { sendErrorJson(res, String(e.message)); }
        break;
      case '/api/shutdown':
        sendJson(res, { ok: true });
        setTimeout(() => server.close(), 100);
        break;
      case '/api/quit':
        sendJson(res, { ok: true });
        setTimeout(() => process.exit(0), 100);
        break;
      default:
        sendErrorJson(res, 'Not found', 404);
    }
  } catch (e) {
    sendErrorJson(res, String(e.message || e), 500);
  }
}

// Main entry point
function main() {
  const args = yargs(process.argv.slice(2)).parse();
  const port = args.port || 8082;
  const openBrowser = args.open || false;
  
  server.listen(port, '127.0.0.1', () => {
    console.log(`humd-editor server running on http://127.0.0.1:${port}`);
    if (openBrowser) {
      open(`http://127.0.0.1:${port}`).catch(() => {});
    }
  });
  
  process.on('SIGINT', () => {
    console.log('Shutting down...');
    server.close(() => process.exit(0));
  });
  
  process.on('SIGTERM', () => {
    console.log('Shutting down...');
    server.close(() => process.exit(0));
  });
}

// Check if server is already running
function serverAlreadyRunning(port) {
  try {
    const result = execSync(`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/api/settings`, 
      { encoding: 'utf8', timeout: 500 });
    return result.trim() === '200';
  } catch (e) {
    return false;
  }
}

function runningServerVersion(port) {
  try {
    const result = execSync(`curl -s http://127.0.0.1:${port}/api/version`, 
      { encoding: 'utf8', timeout: 500 });
    return JSON.parse(result).version;
  } catch (e) {
    return null;
  }
}

async function shutdownRunning(port) {
  for (const endpoint of ['/api/quit', '/api/shutdown']) {
    try {
      execSync(`curl -s -X POST http://127.0.0.1:${port}${endpoint}`, { timeout: 2000 });
    } catch (e) {}
    
    for (let i = 0; i < 30; i++) {
      if (!serverAlreadyRunning(port)) return true;
      // Use setImmediate to avoid blocking
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  return !serverAlreadyRunning(port);
}

async function ensureOurServer(preferredPort) {
  if (serverAlreadyRunning(preferredPort)) {
    if (runningServerVersion(preferredPort) === SERVER_VERSION) {
      return { server: null, port: preferredPort };
    }
    await shutdownRunning(preferredPort);
  }
  return { server, port: preferredPort };
}

// Start the server
(async () => {
  const args = yargs(process.argv.slice(2)).parse();
  const preferredPort = args.port || 8082;
  const openBrowser = args.open || false;
  
  const result = await ensureOurServer(preferredPort);
  if (result.server === null) {
    console.log(`Reusing existing server on port ${result.port}`);
    if (openBrowser) {
      open(`http://127.0.0.1:${result.port}`).catch(() => {});
    }
  } else {
    main();
  }
})();

// Export for testing
export { server, SERVER_VERSION, loadSettings, saveSettings, vaultRoot, safePath, safePathHome };