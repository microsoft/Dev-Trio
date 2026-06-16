const vscode = acquireVsCodeApi();
const __rawData = document.getElementById('__INIT_DATA__');
const DATA = __rawData ? JSON.parse(__rawData.textContent) : { entries: [], emptyMessage: null, cleared: false, errorDetail: null, logPath: 'not configured', entryCount: 0 };
const root = document.getElementById('root');
const BODY_FIELDS = ['PROMPT', 'PLANNER', 'IMPLEMENTER', 'CRITIC', 'PLANNER (close)'];
let viewData = DATA;
let creditsState = [];
let visibleCount = 20;
let totalNumberEl = null;
let estimatedNoteEl = null;
let lastSnapshotMaxMs = null;

function resultLabel(cat) {
  if (cat === 'complete') return 'Complete';
  if (cat === 'error') return 'Error';
  if (cat === 'progress') return 'Decision needed';
  return 'Logged';
}

function buildTierRow(entry) {
  const f = (entry.fields || []).find((x) => x.label === 'TIERS');
  if (!f || !f.value) { return null; }
  const tiers = [];
  for (const t of ['T1', 'T2', 'T3']) {
    const start = f.value.indexOf(t + '[');
    if (start === -1) { continue; }
    const end = f.value.indexOf(']', start);
    if (end === -1) { continue; }
    tiers.push({ tier: t, desc: f.value.slice(start + t.length + 1, end).trim() });
  }
  if (!tiers.length) { return null; }
  const row = document.createElement('div'); row.className = 'tier-row';
  for (const item of tiers) {
    const wrap = document.createElement('span'); wrap.className = 'tier-item';
    const badge = document.createElement('span'); badge.className = 'tier-badge tier-badge-' + item.tier.toLowerCase(); badge.textContent = item.tier;
    const desc = document.createElement('span'); desc.className = 'tier-desc'; desc.textContent = item.desc;
    wrap.appendChild(badge); wrap.appendChild(desc); row.appendChild(wrap);
  }
  return row;
}

function render(data) {
  root.textContent = '';
  if (data.errorDetail) {
    const e = document.createElement('div'); e.className = 'log-error-state';
    const t = document.createElement('p'); t.className = 'log-error-title'; t.textContent = 'Could not load session log';
    const d = document.createElement('p'); d.className = 'log-error-detail'; d.id = 'logErrorDetail'; d.textContent = data.errorDetail;
    const h = document.createElement('p'); h.className = 'log-error-hint'; h.textContent = 'Check the Dev-Trio Credits output channel for details. If the problem persists, verify the backup log path in your workspace settings under dev-trio.backupLog.defaultPath.';
    e.appendChild(t); e.appendChild(d); e.appendChild(h); root.appendChild(e);
    return;
  }
  if (data.emptyMessage) {
    const e = document.createElement('div'); e.className = 'empty';
    const ico = document.createElement('i'); ico.className = 'codicon codicon-output empty-icon';
    const m = document.createElement('div'); m.className = 'empty-msg'; m.textContent = data.emptyMessage;
    e.appendChild(ico); e.appendChild(m); root.appendChild(e);
    return;
  }
  if (data.cleared) {
    const e = document.createElement('div'); e.className = 'empty log-cleared-state';
    const ico = document.createElement('i'); ico.className = 'codicon codicon-check-all empty-icon';
    const t = document.createElement('div'); t.className = 'cleared-title'; t.textContent = 'Log view cleared';
    const s = document.createElement('div'); s.className = 'cleared-subtitle'; s.textContent = 'New sessions will appear here automatically. Your full history is preserved in the backup log.';
    const link = document.createElement('a'); link.className = 'restore-entries-link'; link.textContent = 'Restore all entries';
    link.addEventListener('click', () => vscode.postMessage({ type: 'restoreEntries' }));
    e.appendChild(ico); e.appendChild(t); e.appendChild(s); e.appendChild(link); root.appendChild(e);
    return;
  }
  const shown = data.entries.slice(0, visibleCount);
  for (const entry of shown) {
    const card = document.createElement('div'); card.className = 'card entry-card';
    const head = document.createElement('div'); head.className = 'card-head entry-header';
    const meta = document.createElement('div'); meta.className = 'card-meta';
    const proj = document.createElement('div'); proj.className = 'card-proj'; proj.textContent = entry.title; proj.title = entry.title;
    const sub = document.createElement('div'); sub.className = 'card-sub'; sub.textContent = entry.project + ' · ' + entry.timestamp;
    meta.appendChild(proj); meta.appendChild(sub);
    const right = document.createElement('div'); right.className = 'card-head-right';
    const badge = document.createElement('span'); badge.className = 'badge ' + entry.category + ' result-badge'; badge.textContent = resultLabel(entry.category);
    const chev = document.createElement('i'); chev.className = 'codicon codicon-chevron-right card-chev';
    const pillBox = document.createElement('span'); pillBox.className = 'credits-pills'; pillBox.setAttribute('data-ts', entry.timestamp);
    const loading = document.createElement('span'); loading.className = 'credits-pill-loading'; loading.textContent = '· · ·';
    pillBox.appendChild(loading);
    right.appendChild(pillBox); right.appendChild(badge); right.appendChild(chev);
    head.appendChild(meta); head.appendChild(right);
    const body = document.createElement('div'); body.className = 'card-body entry-body';
    for (const f of entry.fields) {
      if (BODY_FIELDS.indexOf(f.label) === -1) { continue; }
      const field = document.createElement('div'); field.className = 'field';
      const label = document.createElement('div'); label.className = 'field-label'; label.textContent = f.label;
      const value = document.createElement('div'); value.className = 'field-value'; value.textContent = f.value;
      field.appendChild(label); field.appendChild(value); body.appendChild(field);
    }
    head.addEventListener('click', () => {
      const expanded = body.classList.toggle('expanded');
      chev.className = 'codicon card-chev ' + (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right');
    });
    card.appendChild(head);
    const tierRow = buildTierRow(entry);
    if (tierRow) { card.appendChild(tierRow); }
    card.appendChild(body); root.appendChild(card);
  }
  if (data.entries.length > visibleCount) {
    const more = document.createElement('button');
    more.className = 'expand-entries-btn';
    more.textContent = 'Show 20 more  \u25BC';
    more.addEventListener('click', () => {
      visibleCount += 20;
      render(viewData);
      if (creditsState.length) { applyCredits(creditsState, lastSnapshotMaxMs); }
    });
    root.appendChild(more);
  }
}

render(viewData);

function recomputeTotals() {
  if (!totalNumberEl) { return; }
  let verified = 0; let estTotal = 0; let estCount = 0; let verCount = 0;
  for (const x of creditsState) {
    if (!x.credits) { continue; }
    const c = x.credits;
    if (c.source === 'verified' && c.totalCredits != null) {
      verified += c.totalCredits; verCount += 1;
    } else if (c.source === 'estimated') {
      estTotal += Number(c.totalCredits) || 0;
      estCount += 1;
    }
  }
  const total = verified + estTotal;
  const sessions = verCount + estCount;
  totalNumberEl.textContent = (estTotal > 0 ? '~' : '') + total.toLocaleString();
  if (estimatedNoteEl) {
    let breakdown = '';
    if (sessions > 0) {
      if (verified === 0) {
        breakdown = 'all estimated across ' + sessions + ' sessions';
      } else if (estTotal === 0) {
        breakdown = 'all verified across ' + sessions + ' sessions';
      } else {
        breakdown = verified.toLocaleString() + ' verified · ' + estTotal.toLocaleString() + ' estimated across ' + sessions + ' sessions';
      }
    }
    estimatedNoteEl.textContent = breakdown;
  }
}

function renderSummaryCard() {
  const host = document.getElementById('creditsSummaryCard');
  if (!host) { return; }
  host.textContent = '';
  totalNumberEl = null; estimatedNoteEl = null;
  const hasData = creditsState.some((x) => x.credits && (x.credits.source === 'verified' || x.credits.source === 'estimated') && x.credits.totalCredits != null);
  if (!hasData) { return; }
  const card = document.createElement('div'); card.className = 'credits-summary-card';
  const left = document.createElement('div'); left.className = 'credits-summary-left';
  const num = document.createElement('div'); num.className = 'credits-total-number'; num.textContent = '0';
  const lbl = document.createElement('div'); lbl.className = 'credits-total-label'; lbl.textContent = 'credits';
  const note = document.createElement('div'); note.className = 'credits-estimated-note';
  left.appendChild(num); left.appendChild(lbl); left.appendChild(note);
  totalNumberEl = num; estimatedNoteEl = note;
  card.appendChild(left);
  host.appendChild(card);
  recomputeTotals();
}

function applyCredits(list, snapshotMaxMs) {
  for (const item of list) {
    const box = root.querySelector('[data-ts="' + CSS.escape(item.timestamp) + '"]');
    if (!box) { continue; }
    box.textContent = '';
    const c = item.credits;
    const pills = [];
    if (c) {
      // GHCP pill — unchanged label/style/title. CLI = exact "N credits"; chatSessions = "~N credits".
      if (c.source === 'verified' && c.totalCredits != null) {
        const p = document.createElement('span'); p.className = 'credits-pill';
        p.textContent = c.totalCredits.toLocaleString() + ' credits';
        if (c.models && Object.keys(c.models).length) {
          p.setAttribute('title', Object.entries(c.models).map(([m, cr]) => m + ': ' + Number(cr).toLocaleString()).join('\n'));
        } else {
          p.setAttribute('title', 'Exact billing from Copilot CLI session usage in this time window.');
        }
        pills.push(p);
      } else if (c.source === 'estimated' && c.totalCredits != null) {
        const p = document.createElement('span'); p.className = 'credits-pill-estimated';
        p.textContent = '~' + c.totalCredits.toLocaleString() + ' credits';
        p.setAttribute('title', 'Estimated from VS Code Copilot chat token usage in this time window.');
        pills.push(p);
      }
      // Claude Code token pill.
      if (c.claudeCodeTokens != null && Number(c.claudeCodeTokens) > 0) {
        const p = document.createElement('span'); p.className = 'credit-pill-cc';
        p.textContent = '~' + Number(c.claudeCodeTokens).toLocaleString() + ' tok (CC)';
        p.setAttribute('title', 'Estimated Claude Code token usage (input + output) in this time window.');
        pills.push(p);
      }
      // Codex token pill.
      if (c.codexTokens != null && Number(c.codexTokens) > 0) {
        const p = document.createElement('span'); p.className = 'credit-pill-cx';
        p.textContent = '~' + Number(c.codexTokens).toLocaleString() + ' tok (CX)';
        p.setAttribute('title', 'Estimated Codex token usage (input + output) in this time window.');
        pills.push(p);
      }
    }
    if (pills.length === 0) {
      if (snapshotMaxMs != null && isAfterSnapshot(item.timestamp, snapshotMaxMs)) {
        const p = document.createElement('span'); p.className = 'credit-pill-pending';
        p.textContent = 'pending';
        p.setAttribute('title', 'No credit data yet \u2014 this entry is newer than the latest Copilot chat snapshot. Credits appear once Copilot writes an updated snapshot.');
        box.appendChild(p);
      } else {
        box.remove();
      }
      continue;
    }
    for (const p of pills) { box.appendChild(p); }
  }
  creditsState = list;
  lastSnapshotMaxMs = snapshotMaxMs != null ? snapshotMaxMs : lastSnapshotMaxMs;
  renderSummaryCard();
}

function entryMsFromTs(ts) {
  const d = new Date(String(ts).replace(' ', 'T'));
  const ms = d.getTime();
  return isNaN(ms) ? null : ms;
}

function isAfterSnapshot(ts, snapshotMaxMs) {
  const ms = entryMsFromTs(ts);
  return ms != null && ms > snapshotMaxMs;
}

document.getElementById('restoreLogBtn').addEventListener('click', () => vscode.postMessage({ type: 'restoreLog' }));
document.getElementById('exportBtn').addEventListener('click', () => vscode.postMessage({ type: 'exportLog' }));
document.getElementById('clearLogBtn').addEventListener('click', () => {
  const timestamps = (viewData.entries || []).map((e) => e.timestamp);
  vscode.postMessage({ type: 'clearLog', timestamps });
});
document.getElementById('refreshLink').addEventListener('click', () => vscode.postMessage({ type: 'refreshLog' }));
document.getElementById('openLogFileBtn').addEventListener('click', () => vscode.postMessage({ type: 'openLogFile' }));
document.querySelectorAll('.attribution-link').forEach((el) => el.addEventListener('click', () => vscode.postMessage({ type: 'openExternal', url: 'https://github.com/microsoft/what-i-did-copilot' })));
window.addEventListener('message', (ev) => {
  if (!ev.data) { return; }
  if (ev.data.type === 'exportPdf') { window.print(); }
  else if (ev.data.type === 'creditsReady') { applyCredits(ev.data.entries, ev.data.snapshotMaxMs); }
});

vscode.postMessage({ type: 'webviewReady', generation: RENDER_GENERATION });
