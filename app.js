'use strict';

const BASE = 'https://ootbingo.github.io/bingo';

// ── Cached text so repeated conversions don't re-fetch ──
const _textCache = new Map();

async function fetchText(url) {
  if (_textCache.has(url)) return _textCache.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching resource`);
  const text = await res.text();
  _textCache.set(url, text);
  return text;
}

// ── Script loading for seedrandom (modifies global Math) ──
let _seedrandomLoaded = false;

function loadScriptTag(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(el);
  });
}

// ── Status bar ──
function setStatus(html, type = '') {
  const bar = document.getElementById('status-bar');
  bar.innerHTML = html;
  bar.className = 'status-bar' + (type ? ' ' + type : '');
}

// ── Show / hide sections ──
function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }

// ── Parse the OoT Bingo URL ──
function parseOoTUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Please enter an OoT Bingo URL.');

  let url;
  try { url = new URL(trimmed.includes('://') ? trimmed : 'https://' + trimmed); }
  catch { throw new Error('That doesn\'t look like a valid URL.'); }

  if (!url.hostname.includes('ootbingo.github.io')) {
    throw new Error('URL must come from ootbingo.github.io.');
  }

  const version = url.searchParams.get('version');
  const seedStr = url.searchParams.get('seed');
  const mode = url.searchParams.get('mode') || 'normal';

  if (!version) throw new Error('URL is missing the "version" parameter.');
  if (!seedStr) throw new Error('URL is missing the "seed" parameter.');

  const seed = parseInt(seedStr, 10);
  if (!Number.isFinite(seed)) throw new Error('"seed" is not a valid number.');

  return { version, seed, mode };
}

// ── Fetch version → path mapping ──
async function getVersionPath(version) {
  const text = await fetchText(`${BASE}/api/v1/available_versions.json`);
  const data = JSON.parse(text);
  const path = data.versions[version];
  if (!path) {
    const available = Object.keys(data.versions).slice(0, 8).join(', ');
    throw new Error(`Version "${version}" was not found. Available versions include: ${available}…`);
  }
  return path;
}

// ── Execute a fetched script in a sandboxed Function and return a value ──
// This mirrors how generateBoard.js works on the official OoT Bingo site.
function execScript(scriptText, returnExpr) {
  // eslint-disable-next-line no-new-func
  return Function(`${scriptText}\n;\nreturn (${returnExpr});`)();
}

// ── Generate the board ──
async function generateBoard(version, seed, mode) {
  const versionPath = await getVersionPath(version);

  const goalListText = await fetchText(`${BASE}/${versionPath}/goal-list.js`);
  const goalList = execScript(goalListText, 'bingoList');
  if (!goalList) throw new Error('Goal list failed to load (bingoList is undefined).');

  // Ensure seedrandom is available in global scope for older generators
  if (!_seedrandomLoaded) {
    try {
      await loadScriptTag(`${BASE}/lib/seedrandom-min.js`);
      _seedrandomLoaded = true;
    } catch {
      // Non-fatal — modern generator bundles include seedrandom internally
    }
  }

  const generatorText = await fetchText(`${BASE}/${versionPath}/generator.js`);

  // The generator exposes either BingoLibrary.ootBingoGenerator (v9+)
  // or a bare ootBingoGenerator global (older versions).
  const generatorFn = execScript(
    generatorText,
    `typeof BingoLibrary !== "undefined" && typeof BingoLibrary.ootBingoGenerator === "function"
       ? BingoLibrary.ootBingoGenerator
       : typeof ootBingoGenerator !== "undefined"
         ? ootBingoGenerator
         : undefined`
  );

  if (typeof generatorFn !== 'function') {
    throw new Error('Could not find the generator function. This version may be unsupported.');
  }

  const board = generatorFn(goalList, { seed, mode, lang: 'name' });

  // The generator returns a 1-indexed array (index 0 is unused metadata).
  // Each element is a goal object with at least a .name property.
  if (!Array.isArray(board)) {
    throw new Error('Generator returned an unexpected result format.');
  }

  // Determine offset: some older versions are 0-indexed
  const startIdx = board[0] && board[0].name ? 0 : 1;
  const rawGoals = board.slice(startIdx, startIdx + 25);

  if (rawGoals.length !== 25) {
    throw new Error(`Expected 25 goals but found ${rawGoals.length}. The version format may be unsupported.`);
  }

  return rawGoals.map(g => ({ name: typeof g === 'string' ? g : g.name }));
}

// ── Render the 5×5 board preview ──
function renderBoard(goals) {
  const grid = document.getElementById('board-preview');
  grid.innerHTML = '';
  goals.forEach(goal => {
    const cell = document.createElement('div');
    cell.className = 'board-cell';
    cell.textContent = goal.name;
    cell.title = goal.name;
    grid.appendChild(cell);
  });
}

// ── Main convert handler ──
async function convert() {
  const rawUrl = document.getElementById('bingo-url').value;
  const btn = document.getElementById('convert-btn');

  hide('output-section');
  hide('instructions-section');

  let params;
  try {
    params = parseOoTUrl(rawUrl);
  } catch (err) {
    setStatus('❌ ' + err.message, 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Converting…';
  try {
    const goals = await generateBoard(params.version, params.seed, params.mode);

    // Render board
    renderBoard(goals);

    // Metadata strip
    const strip = document.getElementById('meta-strip');
    strip.innerHTML = `
      <span class="meta-item">Version <strong>${escHtml(params.version)}</strong></span>
      <span class="meta-item">Seed <strong>${params.seed}</strong></span>
      <span class="meta-item">Mode <strong>${escHtml(params.mode)}</strong></span>
    `;

    // JSON output
    const json = JSON.stringify(goals, null, 2);
    document.getElementById('json-output').value = json;
    document.getElementById('goal-count').textContent = `(${goals.length} goals)`;

    // Show sections
    show('output-section');
    show('instructions-section');
    setStatus('', '');

    // Scroll to results
    document.getElementById('output-section').scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Reflect params in URL so the page is shareable
    const pageUrl = new URL(window.location.href);
    pageUrl.searchParams.set('version', params.version);
    pageUrl.searchParams.set('seed', String(params.seed));
    pageUrl.searchParams.set('mode', params.mode);
    window.history.replaceState(null, '', pageUrl);

  } catch (err) {
    setStatus('❌ ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Convert';
  }
}

// ── Copy JSON to clipboard ──
async function copyJson() {
  const text = document.getElementById('json-output').value;
  const btn = document.getElementById('copy-btn');
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for browsers without clipboard API
    const ta = document.getElementById('json-output');
    ta.select();
    document.execCommand('copy');
  }

  const orig = btn.textContent;
  btn.textContent = '✓ Copied!';
  btn.classList.add('outline');
  setTimeout(() => {
    btn.textContent = orig;
    btn.classList.remove('outline');
  }, 2000);
}

// ── Copy JSON + open BingoSync in one click ──
async function openBingoSync() {
  const text = document.getElementById('json-output').value;
  if (!text) return;

  // Copy to clipboard first
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.getElementById('json-output');
    ta.select();
    document.execCommand('copy');
  }

  // Open BingoSync in a new tab
  window.open('https://bingosync.com', '_blank', 'noopener,noreferrer');

  // Update button temporarily
  const btn = document.getElementById('launch-btn');
  const orig = btn.textContent;
  btn.textContent = '✓ Opened! Paste the JSON on Bingosync';
  btn.classList.add('outline');
  setTimeout(() => {
    btn.innerHTML = 'Copy JSON &amp; Open Bingosync';
    btn.classList.remove('outline');
  }, 4000);
}

// ── Download JSON as a file ──
function downloadJson() {
  const text = document.getElementById('json-output').value;
  if (!text) return;

  const params = new URL(window.location.href).searchParams;
  const seed = params.get('seed') || 'unknown';
  const version = params.get('version') || 'unknown';
  const mode = params.get('mode') || 'normal';

  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `oot-bingo-${version}-${mode}-${seed}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Utility: escape HTML for safe insertion ──
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Auto-load from URL params on page load ──
function autoLoad() {
  const params = new URL(window.location.href).searchParams;
  const version = params.get('version');
  const seed = params.get('seed');
  const mode = params.get('mode') || 'normal';

  if (version && seed) {
    const syntheticUrl =
      `https://ootbingo.github.io/bingo/bingo.html?version=${encodeURIComponent(version)}&seed=${encodeURIComponent(seed)}&mode=${encodeURIComponent(mode)}`;
    document.getElementById('bingo-url').value = syntheticUrl;
    convert();
  }
}

// ── Allow Enter key to trigger conversion ──
document.getElementById('bingo-url').addEventListener('keydown', e => {
  if (e.key === 'Enter') convert();
});

// Run auto-load after DOM is ready
autoLoad();
