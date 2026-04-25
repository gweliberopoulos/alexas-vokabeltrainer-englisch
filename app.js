'use strict';

// ===== CONSTANTS =====
const SRS_INTERVALS = [0, 1440, 4320, 10080]; // minutes per level

// ===== STATE =====
let indexData   = [];
let chapterData = {}; // { id: parsed JSON }
let selectedIds = new Set();
let direction   = 'EN-DE';
let currentMode = null;

// Session state
let sessionCards   = [];
let sessionIdx     = 0;
let sessionTotal   = 0;
let sessionCorrect = 0;
let sessionWrong   = 0;
let cardState      = {}; // per-card rendering state
let allPool        = []; // flat list of all cards from selected chapters (for MC distractors)
let sessionType    = 'alles'; // 'alles' | 'kurztest' | 'schwach'

// Stats state
let statsWorstWords = [];

// ===== SRS FUNCTIONS =====

function srsKey(chapterId, type, id) {
  if (type === 'verbs') return `srs_${chapterId}_verbs_${id}`;
  return `srs_${chapterId}_${direction}_${id}`;
}

function getSRS(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function setSRS(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch {}
}

function updateSRS(key, rating) {
  const srs = getSRS(key) || { level: 0, nextReview: 0 };
  const now = Date.now();
  if (rating === 0) {
    srs.level = 0;
    srs.nextReview = now;
  } else if (rating === 1) {
    // Schwer: half the current interval
    srs.nextReview = now + (SRS_INTERVALS[srs.level] || 0) * 30000;
  } else if (rating === 2) {
    srs.level = Math.min(srs.level + 1, 3);
    srs.nextReview = now + SRS_INTERVALS[srs.level] * 60000;
  } else { // Perfekt
    srs.level = Math.min(srs.level + 2, 3);
    srs.nextReview = now + SRS_INTERVALS[srs.level] * 60000;
  }
  srs.lastPracticed = now;
  setSRS(key, srs);
}

function isLearned(key) {
  const s = getSRS(key);
  return !!(s && s.level >= 2);
}

function getLearnedCount(chapterId, type, entries) {
  return entries.filter(e => {
    const id = type === 'verbs' ? e.base : e.en;
    return isLearned(srsKey(chapterId, type, id));
  }).length;
}

function getLastPracticed(chapterId, type, entries) {
  let max = 0;
  for (const e of entries) {
    const id = type === 'verbs' ? e.base : e.en;
    const s = getSRS(srsKey(chapterId, type, id));
    if (s && s.lastPracticed > max) max = s.lastPracticed;
  }
  return max;
}

function formatDate(ts) {
  if (!ts) return 'Noch nie';
  const diff = Math.floor((Date.now() - ts) / 86400000);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Gestern';
  if (diff < 7)  return `vor ${diff} Tagen`;
  return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

// ===== WEAK SCORE =====

function weakKey(chapterId, type, id) {
  if (type === 'verbs') return `weak_${chapterId}_verbs_${id}`;
  return `weak_${chapterId}_${direction}_${id}`;
}

function getWeak(key) {
  return parseInt(localStorage.getItem(key) || '0', 10) || 0;
}

function setWeak(key, val) {
  try { localStorage.setItem(key, String(Math.max(0, val))); } catch {}
}

function applyWeakUpdate(card, isCorrect) {
  if (sessionType === 'alles') return;
  const id = card.type === 'verbs' ? card.entry.base : card.entry.en;
  const wk = weakKey(card.chapterId, card.type, id);
  const cur = getWeak(wk);
  if (sessionType === 'kurztest') {
    setWeak(wk, isCorrect ? Math.max(0, cur - 1) : cur + 1);
  } else if (sessionType === 'schwach' && isCorrect) {
    setWeak(wk, Math.max(0, cur - 1));
  }
}

function getWeakCount(chapterId, type, entries) {
  return entries.filter(e => {
    const id = type === 'verbs' ? e.base : e.en;
    return getWeak(weakKey(chapterId, type, id)) >= 1;
  }).length;
}

function getTotalWeakCount() {
  let count = 0;
  for (const info of indexData) {
    if (!selectedIds.has(info.id) || !chapterData[info.id]) continue;
    const data = chapterData[info.id];
    const entries = data.type === 'verbs' ? data.verbs : data.vocab;
    for (const entry of entries) {
      const id = data.type === 'verbs' ? entry.base : entry.en;
      if (getWeak(weakKey(info.id, data.type, id)) >= 1) count++;
    }
  }
  return count;
}

// ===== STATISTICS =====

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function yesterdayDateStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getStatsTotal() {
  try {
    return JSON.parse(localStorage.getItem('stats_total')) ||
      { totalAnswered: 0, totalCorrect: 0, currentStreak: 0, lastLearnedDate: '', longestStreak: 0 };
  } catch {
    return { totalAnswered: 0, totalCorrect: 0, currentStreak: 0, lastLearnedDate: '', longestStreak: 0 };
  }
}

function recordAnswer(card, isCorrect) {
  const today = todayDateStr();

  // a) Day log
  const dayKey = `stats_day_${today}`;
  let dayData;
  try { dayData = JSON.parse(localStorage.getItem(dayKey)) || { correct: 0, wrong: 0, total: 0 }; }
  catch { dayData = { correct: 0, wrong: 0, total: 0 }; }
  if (isCorrect) dayData.correct++; else dayData.wrong++;
  dayData.total++;
  try { localStorage.setItem(dayKey, JSON.stringify(dayData)); } catch {}

  pruneOldDayStats();

  // b) Word tracking
  const wordId = card.type === 'verbs' ? card.entry.base : card.entry.en;
  const wordKey = `stats_word_${card.chapterId}_${wordId}`;
  let wordData;
  try { wordData = JSON.parse(localStorage.getItem(wordKey)) || { correct: 0, wrong: 0 }; }
  catch { wordData = { correct: 0, wrong: 0 }; }
  if (isCorrect) wordData.correct++; else wordData.wrong++;
  try { localStorage.setItem(wordKey, JSON.stringify(wordData)); } catch {}

  // c) Total stats + streak
  const total = getStatsTotal();
  total.totalAnswered++;
  if (isCorrect) total.totalCorrect++;

  const yesterday = yesterdayDateStr();
  if (total.lastLearnedDate === yesterday) {
    total.currentStreak = (total.currentStreak || 0) + 1;
  } else if (total.lastLearnedDate !== today) {
    total.currentStreak = 1;
  }
  total.lastLearnedDate = today;
  if (total.currentStreak > (total.longestStreak || 0)) total.longestStreak = total.currentStreak;

  try { localStorage.setItem('stats_total', JSON.stringify(total)); } catch {}
}

function pruneOldDayStats() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('stats_day_')) keys.push(k);
  }
  if (keys.length <= 30) return;
  keys.sort();
  keys.slice(0, keys.length - 30).forEach(k => localStorage.removeItem(k));
}

function getDayRange(days) {
  const dayNames = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const str = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    let dayData;
    try { dayData = JSON.parse(localStorage.getItem(`stats_day_${str}`)) || { correct: 0, wrong: 0, total: 0 }; }
    catch { dayData = { correct: 0, wrong: 0, total: 0 }; }
    result.push({ str, label: dayNames[d.getDay()], ...dayData });
  }
  return result;
}

function getAllWordStats() {
  const results = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith('stats_word_')) continue;
    const rest = k.slice('stats_word_'.length);
    for (const info of indexData) {
      const prefix = info.id + '_';
      if (rest.startsWith(prefix)) {
        const wordId = rest.slice(prefix.length);
        const d = chapterData[info.id];
        if (!d) break;
        const entries = d.type === 'verbs' ? d.verbs : d.vocab;
        const entry = entries.find(e => (d.type === 'verbs' ? e.base : e.en) === wordId);
        if (entry) {
          let data;
          try { data = JSON.parse(localStorage.getItem(k)) || { correct: 0, wrong: 0 }; }
          catch { data = { correct: 0, wrong: 0 }; }
          results.push({ entry, chapterId: info.id, type: d.type, correct: data.correct, wrong: data.wrong });
        }
        break;
      }
    }
  }
  return results;
}

// ===== LEVENSHTEIN =====

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i;
    for (let j = 1; j <= n; j++) {
      const val = a[i-1] === b[j-1] ? row[j-1] : 1 + Math.min(prev, row[j], row[j-1]);
      row[j-1] = prev;
      prev = val;
    }
    row[n] = prev;
  }
  return row[n];
}

function normalize(s) {
  return (s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[()[\]{}"']/g, '').trim();
}

function checkAnswer(input, correct) {
  const ni = normalize(input);
  if (!ni) return { ok: false };

  const normFull = normalize(correct);
  if (ni === normFull) return { ok: true, type: 'exact' };

  const parts     = correct.split(/[;\/]/).map(p => p.trim()).filter(Boolean);
  const normParts = parts.map(normalize);

  // Partial match: typed one of the semicolon-separated parts (min 3 chars)
  if (parts.length > 1) {
    for (let i = 0; i < normParts.length; i++) {
      if (ni === normParts[i] && ni.length >= 3) {
        return { ok: true, type: 'partial', full: correct.trim() };
      }
    }
  }

  // Typo tolerance
  const allForms = [normFull, ...normParts];
  const allOrig  = [correct.trim(), ...parts];
  for (let i = 0; i < allForms.length; i++) {
    const f    = allForms[i];
    const maxD = f.length >= 8 ? 2 : f.length >= 5 ? 1 : 0;
    if (maxD > 0) {
      const d = levenshtein(ni, f);
      if (d > 0 && d <= maxD) return { ok: true, type: 'typo', correct_form: allOrig[i] };
    }
  }

  return { ok: false };
}

// ===== DATA LOADING =====

async function loadChapterFile(info) {
  if (chapterData[info.id]) return chapterData[info.id];
  const resp = await fetch(info.file);
  const data = await resp.json();
  chapterData[info.id] = data;
  return data;
}

// ===== CHAPTER SELECTION SCREEN =====

async function renderChapterScreen() {
  document.getElementById('app').innerHTML = `
    <div class="screen active" id="screen-chapters">
      <div class="chapter-header">
        <div class="chapter-header-top">
          <h1>📚 Vokabeltrainer</h1>
        </div>
        <p class="chapter-header-subtitle">Kapitel und Lernrichtung wählen</p>
        <div class="direction-toggle">
          <button id="btn-en-de" class="${direction==='EN-DE'?'active':''}" onclick="setDirection('EN-DE')">🇬🇧 EN → 🇩🇪 DE</button>
          <button id="btn-de-en" class="${direction==='DE-EN'?'active':''}" onclick="setDirection('DE-EN')">🇩🇪 DE → 🇬🇧 EN</button>
        </div>
      </div>
      <div class="tab-bar">
        <button class="tab-btn tab-btn-active">🏠 Lernen</button>
        <button class="tab-btn" onclick="renderStatsScreen()">📊 Statistiken</button>
      </div>
      <div class="chapter-select-all" onclick="toggleSelectAll()">
        <span id="select-all-icon">${selectedIds.size === indexData.length && indexData.length > 0 ? '✓' : '☐'}</span>
        <span>Alle auswählen</span>
      </div>
      <div class="chapter-list" id="chapter-list">
        <div class="loading" style="min-height:200px">
          <div class="loading-spinner"></div>
        </div>
      </div>
      <div class="start-section">
        <button class="btn-primary" id="btn-start" ${selectedIds.size===0?'disabled':''} onclick="goToSessionTypePicker()">
          Jetzt lernen →
        </button>
      </div>
    </div>`;

  const list = document.getElementById('chapter-list');
  list.innerHTML = '';

  for (const info of indexData) {
    const data    = await loadChapterFile(info);
    const entries = data.type === 'verbs' ? data.verbs : data.vocab;
    const total   = entries.length;
    const learned = getLearnedCount(info.id, data.type, entries);
    const lastTs  = getLastPracticed(info.id, data.type, entries);
    const pct     = total > 0 ? Math.round((learned / total) * 100) : 0;
    const weak    = getWeakCount(info.id, data.type, entries);
    const sel     = selectedIds.has(info.id);
    const badge   = data.type === 'verbs'
      ? `<span class="badge badge-verbs">Verben</span>`
      : `<span class="badge badge-vocab">Vokabeln</span>`;

    const card = document.createElement('div');
    card.className = `chapter-card${sel ? ' selected' : ''}`;
    card.dataset.id = info.id;
    card.onclick = () => toggleChapter(info.id);
    card.innerHTML = `
      <div class="chapter-card-checkbox">${sel ? '✓' : ''}</div>
      <div class="chapter-card-body">
        <div class="chapter-card-title-row">
          <span class="chapter-card-title">${info.title}</span>
          ${badge}
        </div>
        <div class="chapter-card-desc">${info.description}</div>
        <div class="chapter-card-meta">
          <span>${learned}/${total} gelernt</span>
          <span>Zuletzt: ${formatDate(lastTs)}</span>
        </div>
        <div class="chapter-progress-wrap">
          <div class="chapter-progress-bar">
            <div class="chapter-progress-fill" style="width:${pct}%"></div>
          </div>
          ${weak > 0 ? `<div class="chapter-weak-hint">⚠️ ${weak} schwache Vokabeln</div>` : ''}
        </div>
      </div>`;
    list.appendChild(card);
  }
}

function toggleChapter(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);

  const card = document.querySelector(`.chapter-card[data-id="${id}"]`);
  if (card) {
    const sel = selectedIds.has(id);
    card.classList.toggle('selected', sel);
    card.querySelector('.chapter-card-checkbox').textContent = sel ? '✓' : '';
  }
  const btn = document.getElementById('btn-start');
  if (btn) btn.disabled = selectedIds.size === 0;
  updateSelectAllIcon();
}

function toggleSelectAll() {
  const allSelected = selectedIds.size === indexData.length;
  if (allSelected) selectedIds.clear();
  else indexData.forEach(i => selectedIds.add(i.id));

  document.querySelectorAll('.chapter-card').forEach(card => {
    const sel = selectedIds.has(card.dataset.id);
    card.classList.toggle('selected', sel);
    card.querySelector('.chapter-card-checkbox').textContent = sel ? '✓' : '';
  });
  const btn = document.getElementById('btn-start');
  if (btn) btn.disabled = selectedIds.size === 0;
  updateSelectAllIcon();
}

function updateSelectAllIcon() {
  const el = document.getElementById('select-all-icon');
  if (el) el.textContent = (selectedIds.size === indexData.length && indexData.length > 0) ? '✓' : '☐';
}

function setDirection(dir) {
  direction = dir;
  const enBtn = document.getElementById('btn-en-de');
  const deBtn = document.getElementById('btn-de-en');
  if (enBtn) enBtn.classList.toggle('active', dir === 'EN-DE');
  if (deBtn) deBtn.classList.toggle('active', dir === 'DE-EN');
}

// ===== SESSION TYPE PICKER =====

function goToSessionTypePicker() {
  if (selectedIds.size === 0) return;
  const totalWeak = getTotalWeakCount();

  document.getElementById('app').innerHTML = `
    <div class="screen active">
      <div class="screen-header">
        <button class="btn-back" onclick="renderChapterScreen()">‹</button>
        <h2>Wie möchtest du lernen?</h2>
      </div>
      <div style="padding:16px;display:flex;flex-direction:column;gap:12px;flex:1;overflow-y:auto">
        <div class="session-type-card" onclick="startAllesLernen()">
          <div class="session-type-title">📚 Alles lernen</div>
          <div class="session-type-desc">Alle fälligen Karten (SM-2) – Modus frei wählbar</div>
        </div>
        <div class="session-type-card" onclick="startKurztest()">
          <div class="session-type-title">⚡ Kurztest — 20 Karten</div>
          <div class="session-type-desc">Schneller Multiple-Choice-Mix, merkt Schwächen</div>
        </div>
        <div class="session-type-card${totalWeak === 0 ? ' session-type-disabled' : ''}"
             ${totalWeak > 0 ? 'onclick="openWeakModeScreen()"' : ''}>
          <div class="session-type-title">⚠️ Schwache Vokabeln — ${totalWeak} Karten</div>
          <div class="session-type-desc">${totalWeak > 0
            ? 'Nur was beim Kurztest falsch war – Modus frei wählbar'
            : 'Keine schwachen Vokabeln vorhanden – erst Kurztest machen!'}</div>
        </div>
      </div>
    </div>`;
}

function startAllesLernen() {
  sessionType = 'alles';
  goToModeScreen();
}

function openWeakModeScreen() {
  sessionType = 'schwach';
  goToModeScreen();
}

async function startKurztest() {
  sessionType = 'kurztest';
  for (const info of indexData) {
    if (selectedIds.has(info.id) && !chapterData[info.id]) {
      await loadChapterFile(info);
    }
  }
  await startSession('mc');
}

// ===== MODE SELECTION SCREEN =====

function goToModeScreen() {
  if (selectedIds.size === 0) return;

  const selectedTypes = new Set(
    indexData
      .filter(i => selectedIds.has(i.id))
      .map(i => (chapterData[i.id] ? chapterData[i.id].type : i.type))
  );
  const hasVocab = selectedTypes.has('vocab');
  const hasVerbs = selectedTypes.has('verbs');
  const mixed    = hasVocab && hasVerbs;

  const vocabModes = [
    { id: 'flashcard',    icon: '🃏', name: 'Karteikarten',   desc: 'Umdrehen & bewerten' },
    { id: 'mc',           icon: '✅', name: 'Multiple Choice', desc: '4 Antwortmöglichkeiten' },
    { id: 'typing',       icon: '⌨️', name: 'Tippen',          desc: 'Übersetzung eintippen' },
    { id: 'pronunciation',icon: '🔊', name: 'Aussprache',      desc: 'Hören & erkennen' },
    { id: 'gap',          icon: '📝', name: 'Lückentext',      desc: 'Wort im Satz ergänzen' },
  ];
  const verbModes = [
    { id: 'flashcard',    icon: '🃏', name: 'Karteikarten',   desc: 'Alle 3 Formen einprägen' },
    { id: 'mc',           icon: '✅', name: 'Multiple Choice', desc: '4 Antwortmöglichkeiten' },
    { id: 'gap',          icon: '📝', name: 'Lückentext',      desc: 'Fehlende Form ergänzen' },
    { id: 'chain',        icon: '⛓️', name: 'Kettentraining',  desc: 'Alle 3 Formen eintippen' },
    { id: 'pronunciation',icon: '🔊', name: 'Aussprache',      desc: 'Verb heraushören' },
  ];

  let modes;
  if (mixed) {
    const seen = new Set();
    modes = [...vocabModes, ...verbModes].filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  } else {
    modes = hasVerbs ? verbModes : vocabModes;
  }

  const totalEntries = indexData
    .filter(i => selectedIds.has(i.id) && chapterData[i.id])
    .reduce((sum, i) => {
      const d = chapterData[i.id];
      return sum + (d.type === 'verbs' ? d.verbs.length : d.vocab.length);
    }, 0);

  document.getElementById('app').innerHTML = `
    <div class="screen active" id="screen-modes">
      <div class="screen-header">
        <button class="btn-back" onclick="renderChapterScreen()">‹</button>
        <h2>Lernmodus wählen</h2>
      </div>
      <div class="mode-screen-body">
        <div class="mode-screen-info">
          <strong>${selectedIds.size} Kapitel</strong> · <strong>${totalEntries} Einträge</strong><br>
          Richtung: <strong>${direction === 'EN-DE' ? '🇬🇧 EN → 🇩🇪 DE' : '🇩🇪 DE → 🇬🇧 EN'}</strong>
          ${mixed ? ' · <em>Gemischte Auswahl</em>' : ''}
        </div>
        <div class="mode-grid">
          ${modes.map(m => `
            <div class="mode-card" onclick="startSession('${m.id}')">
              <div class="mode-icon">${m.icon}</div>
              <div class="mode-name">${m.name}</div>
              <div class="mode-desc">${m.desc}</div>
            </div>`).join('')}
        </div>
      </div>
    </div>`;
}

// ===== SESSION MANAGEMENT =====

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildSessionCards(mode) {
  const now = Date.now();
  const due = [], fresh = [], future = [];
  allPool = [];

  for (const info of indexData) {
    if (!selectedIds.has(info.id)) continue;
    const data = chapterData[info.id];
    if (!data) continue;
    const entries = data.type === 'verbs' ? data.verbs : data.vocab;

    for (const entry of entries) {
      const id  = data.type === 'verbs' ? entry.base : entry.en;
      const key = srsKey(info.id, data.type, id);
      const srs = getSRS(key) || { level: 0, nextReview: 0 };
      const card = { entry, chapterId: info.id, type: data.type, key, srs };

      allPool.push(card);

      // Gap text: skip vocab entries with no example sentence
      if (mode === 'gap' && data.type === 'vocab' && !entry.ex) continue;

      if (srs.nextReview <= now) {
        if (!srs.lastPracticed) fresh.push(card);
        else due.push(card);
      } else {
        future.push(card);
      }
    }
  }

  return [...shuffle(due), ...shuffle(fresh), ...shuffle(future)];
}

function buildKurztestCards() {
  allPool = [];
  for (const info of indexData) {
    if (!selectedIds.has(info.id)) continue;
    const data = chapterData[info.id];
    if (!data) continue;
    const entries = data.type === 'verbs' ? data.verbs : data.vocab;
    for (const entry of entries) {
      const id   = data.type === 'verbs' ? entry.base : entry.en;
      const key  = srsKey(info.id, data.type, id);
      const srs  = getSRS(key) || { level: 0, nextReview: 0 };
      const weak = getWeak(weakKey(info.id, data.type, id));
      allPool.push({ entry, chapterId: info.id, type: data.type, key, srs, weak });
    }
  }

  const seen   = new Set();
  const result = [];

  function addBatch(cards) {
    for (const c of shuffle(cards)) {
      if (!seen.has(c.key) && result.length < 20) {
        seen.add(c.key);
        result.push(c);
      }
    }
  }

  // Priority 1: high weak score (often wrong)
  addBatch(allPool.filter(c => c.weak >= 2));
  // Priority 2: never practiced
  addBatch(allPool.filter(c => c.srs.level === 0 && !c.srs.lastPracticed));
  // Priority 3: level 1 (unsicher)
  addBatch(allPool.filter(c => c.srs.level === 1));
  // Priority 4: oldest reviewed
  const oldest = allPool
    .filter(c => !seen.has(c.key))
    .sort((a, b) => (a.srs.lastPracticed || 0) - (b.srs.lastPracticed || 0));
  for (const c of oldest) {
    if (!seen.has(c.key) && result.length < 20) { seen.add(c.key); result.push(c); }
  }
  // Priority 5: random fill
  addBatch(allPool.filter(c => !seen.has(c.key)));

  return result;
}

function buildWeakCards(mode) {
  allPool = [];
  const weak = [];
  for (const info of indexData) {
    if (!selectedIds.has(info.id)) continue;
    const data = chapterData[info.id];
    if (!data) continue;
    const entries = data.type === 'verbs' ? data.verbs : data.vocab;
    for (const entry of entries) {
      const id  = data.type === 'verbs' ? entry.base : entry.en;
      const key = srsKey(info.id, data.type, id);
      const srs = getSRS(key) || { level: 0, nextReview: 0 };
      const wk  = getWeak(weakKey(info.id, data.type, id));
      const card = { entry, chapterId: info.id, type: data.type, key, srs, weak: wk };
      allPool.push(card);
      if (wk >= 1) {
        if (mode === 'gap' && data.type === 'vocab' && !entry.ex) continue;
        weak.push(card);
      }
    }
  }
  return shuffle(weak);
}

async function startSession(mode) {
  currentMode = mode;

  // Ensure all selected chapter data is loaded
  for (const info of indexData) {
    if (selectedIds.has(info.id) && !chapterData[info.id]) {
      await loadChapterFile(info);
    }
  }

  if (sessionType === 'kurztest') {
    sessionCards = buildKurztestCards();
  } else if (sessionType === 'schwach') {
    sessionCards = buildWeakCards(mode);
  } else {
    sessionCards = buildSessionCards(mode);
  }
  sessionTotal   = sessionCards.length;
  sessionIdx     = 0;
  sessionCorrect = 0;
  sessionWrong   = 0;
  cardState      = {};

  if (sessionCards.length === 0) {
    alert('Keine Einträge für diesen Modus gefunden.');
    return;
  }

  let notice = '';
  if (mode === 'gap') {
    const allVocab    = allPool.filter(c => c.type === 'vocab').length;
    const withExample = allPool.filter(c => c.type === 'vocab' && c.entry.ex).length;
    if (allVocab > withExample) {
      notice = `${withExample} von ${allVocab} Vokabeln haben Beispielsätze. Verben werden als Lückentext angezeigt.`;
    }
  }

  renderSessionShell(notice);
  renderCurrentCard();
}

function renderSessionShell(notice) {
  document.getElementById('app').innerHTML = `
    <div class="screen active" id="screen-session">
      <div class="session-header">
        <button class="btn-back" onclick="confirmLeaveSession()">‹</button>
        <div class="progress-bar-wrap">
          <div class="progress-fill" id="session-progress" style="width:0%"></div>
        </div>
        <span class="progress-text" id="session-counter">0/${sessionTotal}</span>
      </div>
      ${notice ? `<div class="notice" style="margin:12px 12px 0;font-size:12px">${notice}</div>` : ''}
      <div id="session-content"></div>
    </div>`;
}

function updateProgress() {
  const pct = sessionTotal > 0 ? Math.round((sessionIdx / sessionTotal) * 100) : 0;
  const fill = document.getElementById('session-progress');
  const ctr  = document.getElementById('session-counter');
  if (fill) fill.style.width = pct + '%';
  if (ctr)  ctr.textContent = `${Math.min(sessionIdx, sessionTotal)}/${sessionTotal}`;
}

function confirmLeaveSession() {
  if (confirm('Session beenden?')) renderChapterScreen();
}

function renderCurrentCard() {
  if (sessionIdx >= sessionCards.length) { renderResults(); return; }
  updateProgress();
  cardState = {};
  const card = sessionCards[sessionIdx];

  // Mixed session mode mapping
  let mode = currentMode;
  if (mode === 'typing' && card.type === 'verbs') mode = 'chain';
  if (mode === 'chain'  && card.type === 'vocab') mode = 'typing';

  switch (mode) {
    case 'flashcard':     renderFlashcard(card);     break;
    case 'mc':            renderMC(card);            break;
    case 'typing':        renderTyping(card);        break;
    case 'pronunciation': renderPronunciation(card); break;
    case 'gap':           renderGap(card);           break;
    case 'chain':         renderChain(card);         break;
    default:              renderFlashcard(card);
  }
}

function doRateAndAdvance(rating) {
  const card = sessionCards[sessionIdx];
  applyWeakUpdate(card, rating >= 2);
  recordAnswer(card, rating >= 2);
  updateSRS(card.key, rating);

  if (rating === 0 && !card.requeued && sessionType !== 'kurztest') {
    const pos = Math.min(sessionIdx + 4, sessionCards.length);
    sessionCards.splice(pos, 0, { ...card, requeued: true });
    sessionTotal = sessionCards.length;
  }

  if (rating >= 2) sessionCorrect++;
  else if (rating === 0) sessionWrong++;

  sessionIdx++;
  renderCurrentCard();
}

// ===== FLASHCARD MODE =====

function renderFlashcard(card) {
  const e = card.entry;
  let front, back;

  if (card.type === 'vocab') {
    if (direction === 'EN-DE') {
      front = `<div class="flashcard-label">Englisch</div>
               <div class="flashcard-word">${e.en}</div>
               <div class="flashcard-phonetic">${e.ph}</div>`;
      back  = `<div class="flashcard-label">Deutsch</div>
               <div class="flashcard-translation">${e.de}</div>
               ${e.ex ? `<div class="flashcard-phonetic" style="font-size:13px;margin-top:12px">&ldquo;${e.ex}&rdquo;</div>` : ''}`;
    } else {
      front = `<div class="flashcard-label">Deutsch</div>
               <div class="flashcard-word">${e.de}</div>`;
      back  = `<div class="flashcard-label">Englisch</div>
               <div class="flashcard-translation">${e.en}</div>
               <div class="flashcard-phonetic">${e.ph}</div>`;
    }
  } else {
    front = `<div class="flashcard-label">Infinitiv</div>
             <div class="flashcard-word">${e.base}</div>
             <div class="flashcard-phonetic">${e.ph_base}</div>
             <div class="flashcard-de" style="margin-top:8px">${e.de}</div>`;
    back  = `<div class="flashcard-label">Alle 3 Formen</div>
             <div class="flashcard-forms">${e.base.toUpperCase()}<br>↓<br>${(e.past).toUpperCase()}<br>↓<br>${e.participle.toUpperCase()}</div>`;
  }

  document.getElementById('session-content').innerHTML = `
    <div class="flashcard-container">
      <div class="flashcard" id="flashcard" onclick="flipCard()">
        <div class="flashcard-face flashcard-front">${front}</div>
        <div class="flashcard-face flashcard-back">${back}</div>
      </div>
    </div>
    <div class="flashcard-tap-hint text-muted">Antippen zum Umdrehen</div>
    <div class="rating-section" id="rating-section">
      <div class="rating-label">Wie gut wusstest du es?</div>
      <div class="rating-buttons">
        <button class="btn-rate btn-rate-0" onclick="doRateAndAdvance(0)">
          <span class="btn-rate-emoji">😣</span>Nochmal
        </button>
        <button class="btn-rate btn-rate-1" onclick="doRateAndAdvance(1)">
          <span class="btn-rate-emoji">😐</span>Schwer
        </button>
        <button class="btn-rate btn-rate-2" onclick="doRateAndAdvance(2)">
          <span class="btn-rate-emoji">😊</span>Gut
        </button>
        <button class="btn-rate btn-rate-3" onclick="doRateAndAdvance(3)">
          <span class="btn-rate-emoji">🌟</span>Perfekt
        </button>
      </div>
    </div>`;
}

function flipCard() {
  const fc = document.getElementById('flashcard');
  if (!fc || fc.classList.contains('flipped')) return;
  fc.classList.add('flipped');
  fc.onclick = null;

  const rs   = document.getElementById('rating-section');
  const hint = document.querySelector('.flashcard-tap-hint');
  if (rs)   rs.classList.add('visible');
  if (hint) hint.style.visibility = 'hidden';
}

// ===== MULTIPLE CHOICE =====

function renderMC(card) {
  const e = card.entry;
  let questionHTML, options, correctAns;

  if (card.type === 'vocab') {
    correctAns = direction === 'EN-DE' ? e.de : e.en;
    const field = direction === 'EN-DE' ? 'de' : 'en';
    const distractors = shuffle(
      allPool
        .filter(p => p.type === 'vocab' && p.entry !== e)
        .map(p => p.entry[field])
        .filter((v, i, a) => v && a.indexOf(v) === i && v !== correctAns)
    ).slice(0, 3);

    options = shuffle([correctAns, ...distractors]);
    questionHTML = direction === 'EN-DE'
      ? `<div class="mc-question-sub">Englisch → Deutsch</div>
         <div class="mc-question-word">${e.en}</div>
         <div class="mc-question-phonetic">${e.ph}</div>`
      : `<div class="mc-question-sub">Deutsch → Englisch</div>
         <div class="mc-question-word">${e.de}</div>`;

  } else {
    const askPast = Math.random() < 0.5;
    const label   = askPast ? 'Simple Past' : 'Past Participle';
    const field   = askPast ? 'past' : 'participle';
    correctAns    = e[field].split('/')[0].trim();

    const distractors = shuffle(
      allPool
        .filter(p => p.type === 'verbs' && p.entry !== e)
        .map(p => p.entry[field].split('/')[0].trim())
        .filter((v, i, a) => v && a.indexOf(v) === i && v !== correctAns)
    ).slice(0, 3);

    options = shuffle([correctAns, ...distractors]);
    questionHTML = `<div class="mc-question-sub">${label} von:</div>
                    <div class="mc-question-word">${e.base.toUpperCase()}</div>
                    <div class="mc-question-phonetic">${e.ph_base} · ${e.de}</div>`;
  }

  cardState.mcOptions  = options;
  cardState.mcCorrect  = correctAns;
  cardState.mcSelected = null;

  document.getElementById('session-content').innerHTML = `
    <div class="mc-question">${questionHTML}</div>
    <div class="mc-options">
      ${options.map((opt, i) =>
        `<button class="mc-option" id="mc-opt-${i}" onclick="selectMCOption(${i})">${opt}</button>`
      ).join('')}
    </div>
    <div id="mc-feedback" class="hidden"></div>`;
}

function selectMCOption(idx) {
  if (cardState.mcSelected !== null) return;
  cardState.mcSelected = idx;

  const correct = cardState.mcCorrect;
  const chosen  = cardState.mcOptions[idx];
  const isRight = chosen === correct || checkAnswer(chosen, correct).ok;

  cardState.mcOptions.forEach((opt, i) => {
    const btn = document.getElementById(`mc-opt-${i}`);
    if (!btn) return;
    btn.disabled = true;
    if (opt === correct || checkAnswer(opt, correct).ok) btn.classList.add('correct');
    else if (i === idx) btn.classList.add('wrong');
  });

  const rating = isRight ? 2 : 0;
  const curCard = sessionCards[sessionIdx];
  applyWeakUpdate(curCard, isRight);
  recordAnswer(curCard, isRight);
  updateSRS(curCard.key, rating);
  if (rating === 0 && !curCard.requeued && sessionType !== 'kurztest') {
    const pos = Math.min(sessionIdx + 4, sessionCards.length);
    sessionCards.splice(pos, 0, { ...curCard, requeued: true });
    sessionTotal = sessionCards.length;
  }
  if (isRight) sessionCorrect++; else sessionWrong++;

  const fb = document.getElementById('mc-feedback');
  if (fb) {
    fb.className = `feedback-box ${isRight ? 'ok' : 'fail'} mt-8`;
    fb.textContent = isRight ? '✓ Richtig!' : `✗ Richtig wäre: ${correct}`;
  }

  setTimeout(() => { sessionIdx++; renderCurrentCard(); }, isRight ? 1200 : 2400);
}

// ===== TYPING MODE =====

function renderTyping(card) {
  const e = card.entry;
  const label = direction === 'EN-DE' ? 'Englisch → Deutsch' : 'Deutsch → Englisch';
  const word  = direction === 'EN-DE' ? e.en : e.de;
  const ph    = (direction === 'EN-DE' && e.ph) ? `<div class="typing-phonetic">${e.ph}</div>` : '';
  const placeholder = direction === 'EN-DE' ? 'Deutsche Übersetzung…' : 'Englisches Wort…';

  document.getElementById('session-content').innerHTML = `
    <div class="typing-question">
      <div class="typing-question-sub">${label}</div>
      <div class="typing-word">${word}</div>
      ${ph}
    </div>
    <div class="typing-input-row">
      <input type="text" class="typing-input" id="typing-input"
             placeholder="${placeholder}" autocorrect="off" autocapitalize="none" spellcheck="false"
             onkeydown="if(event.key==='Enter')submitTyping()">
      <button class="btn-submit" id="typing-submit" onclick="submitTyping()">→</button>
    </div>
    <div id="typing-feedback" class="hidden"></div>
    <div id="typing-continue" class="hidden"></div>`;

  document.getElementById('typing-input').focus();
}

function submitTyping() {
  const input = document.getElementById('typing-input');
  const fb    = document.getElementById('typing-feedback');
  const cont  = document.getElementById('typing-continue');
  if (!input || input.disabled) return;

  const card    = sessionCards[sessionIdx];
  const correct = direction === 'EN-DE' ? card.entry.de : card.entry.en;
  const result  = checkAnswer(input.value, correct);

  input.disabled = true;
  const submitBtn = document.getElementById('typing-submit');
  if (submitBtn) submitBtn.disabled = true;

  let rating;
  if (result.ok) {
    input.classList.add('correct');
    let msg = '✓ Richtig!';
    if (result.type === 'partial') msg = `✓ Richtig! Vollständig: ${result.full}`;
    if (result.type === 'typo')    msg = `✓ Fast perfekt! Richtig: ${result.correct_form}`;
    fb.className = 'feedback-box ok mt-8';
    fb.textContent = msg;
    rating = result.type === 'exact' ? 3 : 2;
    sessionCorrect++;
  } else {
    input.classList.add('wrong');
    fb.className = 'feedback-box fail mt-8';
    fb.textContent = `✗ Richtig: ${correct}`;
    rating = 0;
    sessionWrong++;
  }

  applyWeakUpdate(card, result.ok);
  recordAnswer(card, result.ok);
  updateSRS(card.key, rating);
  if (rating === 0 && !card.requeued && sessionType !== 'kurztest') {
    const pos = Math.min(sessionIdx + 4, sessionCards.length);
    sessionCards.splice(pos, 0, { ...card, requeued: true });
    sessionTotal = sessionCards.length;
  }

  cont.innerHTML = `<button class="btn-continue mt-12" onclick="sessionIdx++;renderCurrentCard()">Weiter →</button>`;
  cont.className = '';
}

// ===== PRONUNCIATION MODE =====

function speak(text, lang, rate) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = lang || 'en-GB';
  utt.rate = rate || 0.85;
  window.speechSynthesis.speak(utt);
}

function renderPronunciation(card) {
  const e = card.entry;
  let spokenText, correctAns, optField, optPool;

  if (card.type === 'vocab') {
    spokenText = e.en;
    correctAns = e.de;
    optField   = 'de';
    optPool    = allPool.filter(p => p.type === 'vocab' && p.entry !== e);
  } else {
    spokenText = e.base;
    correctAns = e.base;
    optField   = 'base';
    optPool    = allPool.filter(p => p.type === 'verbs' && p.entry !== e);
  }

  const distractors = shuffle(
    optPool
      .map(p => p.entry[optField])
      .filter((v, i, a) => v && a.indexOf(v) === i && v !== correctAns)
  ).slice(0, 3);

  const options = shuffle([correctAns, ...distractors]);
  cardState.pronOptions  = options;
  cardState.pronCorrect  = correctAns;
  cardState.pronSpoken   = spokenText;
  cardState.pronSelected = null;

  const label = card.type === 'vocab' ? 'Deutsche Bedeutung wählen:' : 'Welches Verb wurde gesprochen?';
  const safeText = spokenText.replace(/'/g, "\\'");

  document.getElementById('session-content').innerHTML = `
    <div class="pron-display">
      <button class="pron-play-btn" onclick="speak('${safeText}','en-GB',0.85)">🔊</button>
      <div class="pron-question">${label}</div>
      <div class="pron-hint">Zum Wiederholen auf 🔊 tippen</div>
    </div>
    <div class="mc-options">
      ${options.map((opt, i) =>
        `<button class="mc-option" id="pron-opt-${i}" onclick="selectPronOption(${i})">${opt}</button>`
      ).join('')}
    </div>
    <div id="pron-feedback" class="hidden"></div>`;

  setTimeout(() => speak(spokenText, 'en-GB', 0.85), 400);
}

function selectPronOption(idx) {
  if (cardState.pronSelected !== null) return;
  cardState.pronSelected = idx;

  const correct = cardState.pronCorrect;
  const chosen  = cardState.pronOptions[idx];
  const isRight = chosen === correct;

  cardState.pronOptions.forEach((opt, i) => {
    const btn = document.getElementById(`pron-opt-${i}`);
    if (!btn) return;
    btn.disabled = true;
    if (opt === correct) btn.classList.add('correct');
    else if (i === idx)  btn.classList.add('wrong');
  });

  const rating = isRight ? 2 : 0;
  const curCard2 = sessionCards[sessionIdx];
  applyWeakUpdate(curCard2, isRight);
  recordAnswer(curCard2, isRight);
  updateSRS(curCard2.key, rating);
  if (rating === 0 && !curCard2.requeued && sessionType !== 'kurztest') {
    const pos = Math.min(sessionIdx + 4, sessionCards.length);
    sessionCards.splice(pos, 0, { ...curCard2, requeued: true });
    sessionTotal = sessionCards.length;
  }
  if (isRight) sessionCorrect++; else sessionWrong++;

  const fb = document.getElementById('pron-feedback');
  if (fb) {
    fb.className = `feedback-box ${isRight ? 'ok' : 'fail'} mt-8`;
    fb.textContent = isRight ? '✓ Richtig!' : `✗ Richtig: ${correct}`;
  }

  setTimeout(() => { sessionIdx++; renderCurrentCard(); }, isRight ? 1200 : 2400);
}

// ===== GAP TEXT MODE =====

function makeGapSentence(ex, en) {
  // Extract the key word: strip "to ", take first part before separator
  const word    = en.replace(/^to\s+/i, '').split(/[;,\/]/)[0].trim();
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex   = new RegExp(`\\b${escaped}(?:s|es|ed|ing|'s)?\\b`, 'gi');
  const result  = ex.replace(regex, '<span class="gap-blank">___</span>');
  if (result !== ex) return result;
  // Fallback: replace first occurrence anywhere
  const idx = ex.toLowerCase().indexOf(word.toLowerCase());
  if (idx >= 0) {
    return ex.slice(0, idx) + '<span class="gap-blank">___</span>' + ex.slice(idx + word.length);
  }
  return ex;
}

function renderGap(card) {
  const e = card.entry;
  let displayHTML, correctAns, placeholder;

  if (card.type === 'vocab') {
    const gapped = makeGapSentence(e.ex, e.en);
    correctAns   = e.en.replace(/^to\s+/i, '').split(/[;,\/]/)[0].trim();
    placeholder  = 'Englisches Wort…';
    displayHTML  = `
      <div class="gap-display">
        <div class="gap-sentence">${gapped}</div>
        <div class="gap-hint mt-8">🇩🇪 ${e.de}</div>
      </div>`;
  } else {
    // Verb: blank either past or participle randomly
    const blankPast = Math.random() < 0.5;
    correctAns = blankPast
      ? e.past.split('/')[0].trim()
      : e.participle.split('/')[0].trim();
    placeholder  = blankPast ? 'Simple Past…' : 'Past Participle…';

    const pastHTML = blankPast
      ? '<span class="gap-verb-blank">___</span>'
      : `<span class="gap-verb-known">${e.past}</span>`;
    const partHTML = !blankPast
      ? '<span class="gap-verb-blank">___</span>'
      : `<span class="gap-verb-known">${e.participle}</span>`;

    displayHTML = `
      <div class="gap-display">
        <div class="gap-verb-display">
          <span class="gap-verb-known">${e.base}</span>
          <span class="gap-verb-arrow">→</span>
          ${pastHTML}
          <span class="gap-verb-arrow">→</span>
          ${partHTML}
        </div>
        <div class="gap-hint mt-8">🇩🇪 ${e.de}</div>
      </div>`;
  }

  cardState.gapCorrect = correctAns;

  document.getElementById('session-content').innerHTML = `
    ${displayHTML}
    <div class="typing-input-row">
      <input type="text" class="typing-input" id="gap-input"
             placeholder="${placeholder}" autocorrect="off" autocapitalize="none" spellcheck="false"
             onkeydown="if(event.key==='Enter')submitGap()">
      <button class="btn-submit" id="gap-submit" onclick="submitGap()">→</button>
    </div>
    <div id="gap-feedback" class="hidden"></div>
    <div id="gap-continue" class="hidden"></div>`;

  document.getElementById('gap-input').focus();
}

function submitGap() {
  const input = document.getElementById('gap-input');
  const fb    = document.getElementById('gap-feedback');
  const cont  = document.getElementById('gap-continue');
  if (!input || input.disabled) return;

  const card   = sessionCards[sessionIdx];
  const result = checkAnswer(input.value, cardState.gapCorrect);

  input.disabled = true;
  const submitBtn = document.getElementById('gap-submit');
  if (submitBtn) submitBtn.disabled = true;

  let rating;
  if (result.ok) {
    input.classList.add('correct');
    let msg = '✓ Richtig!';
    if (result.type === 'partial') msg = `✓ Richtig! Vollständig: ${result.full}`;
    if (result.type === 'typo')    msg = `✓ Fast perfekt! Richtig: ${result.correct_form}`;
    fb.className = 'feedback-box ok mt-8';
    fb.textContent = msg;
    rating = result.type === 'exact' ? 3 : 2;
    sessionCorrect++;
  } else {
    input.classList.add('wrong');
    fb.className = 'feedback-box fail mt-8';
    fb.textContent = `✗ Richtig: ${cardState.gapCorrect}`;
    rating = 0;
    sessionWrong++;
  }

  applyWeakUpdate(card, result.ok);
  recordAnswer(card, result.ok);
  updateSRS(card.key, rating);
  if (rating === 0 && !card.requeued && sessionType !== 'kurztest') {
    const pos = Math.min(sessionIdx + 4, sessionCards.length);
    sessionCards.splice(pos, 0, { ...card, requeued: true });
    sessionTotal = sessionCards.length;
  }

  cont.innerHTML = `<button class="btn-continue mt-12" onclick="sessionIdx++;renderCurrentCard()">Weiter →</button>`;
  cont.className = '';
}

// ===== CHAIN TRAINING (VERBS) =====

function renderChain(card) {
  const e = card.entry;

  // Initialize chain state on first render of this card
  if (cardState.chainInit !== card.key) {
    cardState.chainInit  = card.key;
    cardState.chainStep  = 0; // 0=ask past, 1=ask participle
    cardState.chainError = false;
    cardState.chainPast  = null;
  }

  const step   = cardState.chainStep;
  const isPast = step === 0;
  const label  = isPast ? 'Simple Past' : 'Past Participle';
  const placeholder = isPast ? 'Simple Past…' : 'Past Participle…';

  // Build the "go → ___ → gone" display
  const knownPast = cardState.chainPast;
  const pastHTML  = isPast
    ? '<span class="chain-blank">___</span>'
    : `<span class="chain-known">${knownPast || e.past}</span>`;
  const partHTML  = !isPast
    ? '<span class="chain-blank">___</span>'
    : `<span class="chain-known">${e.participle}</span>`;

  document.getElementById('session-content').innerHTML = `
    <div class="chain-display">
      <div class="chain-base">${e.base}</div>
      <div class="chain-base-phonetic">${e.ph_base}</div>
      <div class="chain-de">${e.de}</div>
      <div class="chain-forms-row">
        <span class="chain-known">${e.base}</span>
        <span class="chain-arrow">→</span>
        ${pastHTML}
        <span class="chain-arrow">→</span>
        ${partHTML}
      </div>
    </div>
    <div class="chain-step-label">${label} von „${e.base}"?</div>
    <div class="typing-input-row">
      <input type="text" class="typing-input" id="chain-input"
             placeholder="${placeholder}" autocorrect="off" autocapitalize="none" spellcheck="false"
             onkeydown="if(event.key==='Enter')submitChain()">
      <button class="btn-submit" id="chain-submit" onclick="submitChain()">→</button>
    </div>
    <div id="chain-feedback" class="hidden"></div>`;

  document.getElementById('chain-input').focus();
}

function submitChain() {
  const input = document.getElementById('chain-input');
  const fb    = document.getElementById('chain-feedback');
  if (!input || input.disabled) return;

  const card   = sessionCards[sessionIdx];
  const e      = card.entry;
  const isPast = cardState.chainStep === 0;
  const correct = isPast ? e.past : e.participle;
  const result  = checkAnswer(input.value, correct);

  input.disabled = true;
  const submitBtn = document.getElementById('chain-submit');
  if (submitBtn) submitBtn.disabled = true;

  if (result.ok) {
    input.classList.add('correct');
    let msg = '✓ Richtig!';
    if (result.type === 'typo') msg = `✓ Fast! Richtig: ${result.correct_form}`;
    fb.className = 'feedback-box ok mt-8';
    fb.textContent = msg;
    if (isPast) cardState.chainPast = (result.correct_form || input.value);
  } else {
    input.classList.add('wrong');
    fb.className = 'feedback-box fail mt-8';
    fb.textContent = `✗ Richtig: ${correct.split('/')[0].trim()}`;
    cardState.chainError = true;
    if (isPast) cardState.chainPast = e.past;
  }

  const delay = result.ok ? 900 : 1800;

  if (isPast) {
    // Move to participle step
    setTimeout(() => {
      cardState.chainStep = 1;
      renderChain(card);
    }, delay);
  } else {
    // Both steps done → rate and advance
    setTimeout(() => {
      const rating = cardState.chainError ? 2 : 3;
      applyWeakUpdate(card, !cardState.chainError);
      recordAnswer(card, !cardState.chainError);
      updateSRS(card.key, rating);
      if (rating >= 2) sessionCorrect++;
      sessionIdx++;
      renderCurrentCard();
    }, delay);
  }
}

// ===== RESULTS SCREEN =====

function renderResults() {
  const total = sessionCorrect + sessionWrong;
  const pct   = total > 0 ? Math.round((sessionCorrect / total) * 100) : 0;
  let emoji = '💪', title = 'Weiter üben!';
  if (pct >= 100 && total > 0) { emoji = '🏆'; title = 'Perfekt!'; }
  else if (pct >= 80)          { emoji = '🌟'; title = 'Fast perfekt!'; }
  else if (pct >= 60)          { emoji = '😊'; title = 'Gut gemacht!'; }
  else if (pct >= 40)          { emoji = '🎯'; title = 'Üb weiter!'; }

  const isKurztest  = sessionType === 'kurztest';
  const totalWeak   = getTotalWeakCount();
  const heading     = isKurztest ? 'Kurztest abgeschlossen!' : title;
  const headEmoji   = isKurztest ? (pct >= 80 ? '🌟' : '📊') : emoji;

  const weakBanner  = isKurztest && totalWeak > 0 ? `
    <div class="kurztest-weak-banner">
      <div class="kurztest-weak-text">
        Du hast <strong>${totalWeak}</strong> schwache ${totalWeak === 1 ? 'Vokabel' : 'Vokabeln'} gesammelt.
      </div>
      <button class="btn-primary" style="margin-top:10px" onclick="openWeakModeScreen()">
        🎯 Jetzt vertiefen
      </button>
    </div>` : '';

  const repeatLabel  = isKurztest ? '⚡ Nochmal Kurztest' : '🔄 Nochmal lernen';
  const repeatAction = isKurztest ? 'startKurztest()' : 'startSession(currentMode)';
  const modeBtn      = !isKurztest
    ? `<button class="btn-secondary" onclick="goToModeScreen()">← Anderen Modus wählen</button>` : '';

  document.getElementById('app').innerHTML = `
    <div class="screen active" id="screen-results">
      <div class="screen-header">
        <button class="btn-back" onclick="renderChapterScreen()">‹</button>
        <h2>${isKurztest ? 'Kurztest' : 'Ergebnis'}</h2>
      </div>
      <div class="results-body">
        <div class="results-header">
          <div class="results-emoji">${headEmoji}</div>
          <div class="results-title">${heading}</div>
          <div class="results-subtitle">${pct} % richtig · ${Math.min(sessionIdx, sessionTotal)} Karten</div>
        </div>
        <div class="results-stats">
          <div class="results-stat">
            <div class="results-stat-value green">${sessionCorrect}</div>
            <div class="results-stat-label">✅ Richtig</div>
          </div>
          <div class="results-stat">
            <div class="results-stat-value red">${sessionWrong}</div>
            <div class="results-stat-label">❌ Falsch</div>
          </div>
          <div class="results-stat">
            <div class="results-stat-value">${sessionTotal}</div>
            <div class="results-stat-label">Karten gesamt</div>
          </div>
          <div class="results-stat">
            <div class="results-stat-value">${pct}%</div>
            <div class="results-stat-label">Quote</div>
          </div>
        </div>
        ${weakBanner}
        <div class="results-actions">
          <button class="btn-primary" onclick="${repeatAction}">${repeatLabel}</button>
          ${modeBtn}
          <button class="btn-secondary" onclick="goToSessionTypePicker()">← Lernmodus wählen</button>
          <button class="btn-secondary" onclick="renderChapterScreen()">🏠 Kapitelauswahl</button>
        </div>
      </div>
    </div>`;
}

// ===== STATS SCREEN =====

function buildChartHTML(days) {
  const data = getDayRange(days);
  const CHART_H = 100;
  const maxTotal = Math.max(...data.map(d => d.total), 1);
  return `<div class="chart-bars">
    ${data.map(d => {
      const totalH = Math.round((d.total / maxTotal) * CHART_H);
      const correctH = d.total > 0 ? Math.round((d.correct / d.total) * totalH) : 0;
      const wrongH = totalH - correctH;
      return `<div class="chart-bar-wrap">
        <div class="chart-bar">
          <div class="chart-bar-inner" style="height:${totalH}px">
            <div class="chart-bar-correct" style="height:${correctH}px"></div>
            <div class="chart-bar-wrong" style="height:${wrongH}px"></div>
          </div>
        </div>
        <div class="chart-label">${d.label}</div>
      </div>`;
    }).join('')}
  </div>`;
}

function switchChart(days) {
  const container = document.getElementById('chart-container');
  if (container) container.innerHTML = buildChartHTML(days);
  document.querySelectorAll('.chart-toggle-btn').forEach(b => b.classList.remove('chart-toggle-active'));
  const activeBtn = document.getElementById(`btn-chart-${days}`);
  if (activeBtn) activeBtn.classList.add('chart-toggle-active');
}

function startDifficultWordSession() {
  if (!statsWorstWords.length) return;
  sessionType = 'alles';
  currentMode = 'typing';
  sessionCards = statsWorstWords.map(w => {
    const id = w.type === 'verbs' ? w.entry.base : w.entry.en;
    const key = srsKey(w.chapterId, w.type, id);
    return { entry: w.entry, chapterId: w.chapterId, type: w.type, key, srs: getSRS(key) || { level: 0, nextReview: 0 } };
  });
  allPool = [...sessionCards];
  sessionTotal = sessionCards.length;
  sessionIdx = 0;
  sessionCorrect = 0;
  sessionWrong = 0;
  cardState = {};
  renderSessionShell('');
  renderCurrentCard();
}

function renderStatsScreen() {
  const total = getStatsTotal();
  const today = todayDateStr();
  const yesterday = yesterdayDateStr();

  let streakClass, streakStatus;
  if (total.lastLearnedDate === today) {
    streakClass = 'streak-active';
    streakStatus = 'Heute gelernt 🔥';
  } else if (total.lastLearnedDate === yesterday) {
    streakClass = 'streak-yesterday';
    streakStatus = 'Gestern zuletzt gelernt';
  } else {
    streakClass = 'streak-inactive';
    streakStatus = total.lastLearnedDate ? `Zuletzt: ${total.lastLearnedDate}` : 'Noch nicht gelernt';
  }

  const wordStats = getAllWordStats();
  const qualified = wordStats.filter(w => w.correct + w.wrong >= 3);
  const bestWords  = [...qualified].sort((a, b) => (b.correct/(b.correct+b.wrong)) - (a.correct/(a.correct+a.wrong))).slice(0, 5);
  const worstWords = [...qualified].sort((a, b) => (a.correct/(a.correct+a.wrong)) - (b.correct/(b.correct+b.wrong))).slice(0, 5);
  statsWorstWords = worstWords;

  const pctCorrect = total.totalAnswered > 0 ? Math.round((total.totalCorrect / total.totalAnswered) * 100) : 0;
  const chaptersAvailable = indexData.length;

  const renderWordLine = (w, icon) => {
    const en  = w.type === 'verbs' ? w.entry.base : w.entry.en;
    const de  = w.entry.de;
    const tot = w.correct + w.wrong;
    return `<div class="stats-word-row">${icon} <span class="stats-word-en">${en}</span><span class="stats-word-arrow"> → </span><span class="stats-word-de">${de}</span><span class="stats-word-score">(${w.correct}/${tot} richtig)</span></div>`;
  };

  const emptyHint = '<div class="stats-empty">Noch keine Daten (mind. 3 Antworten pro Vokabel)</div>';
  const bestHTML  = bestWords.length  > 0 ? bestWords.map(w  => renderWordLine(w, '✅')).join('') : emptyHint;
  const worstHTML = worstWords.length > 0
    ? worstWords.map(w => renderWordLine(w, '❌')).join('') +
      `<button class="btn-secondary mt-12" style="font-size:13px;padding:10px 14px;width:auto" onclick="startDifficultWordSession()">🎯 Jetzt üben</button>`
    : emptyHint;

  document.getElementById('app').innerHTML = `
    <div class="screen active" id="screen-stats">
      <div class="chapter-header">
        <div class="chapter-header-top">
          <h1>📚 Vokabeltrainer</h1>
        </div>
        <p class="chapter-header-subtitle">Deine Lernstatistiken</p>
      </div>
      <div class="tab-bar">
        <button class="tab-btn" onclick="renderChapterScreen()">🏠 Lernen</button>
        <button class="tab-btn tab-btn-active">📊 Statistiken</button>
      </div>
      <div class="stats-body">

        <div class="stats-section">
          <div class="stats-section-title">🔥 Streak</div>
          <div class="stats-streak-value ${streakClass}">${total.currentStreak || 0} Tag${(total.currentStreak || 0) !== 1 ? 'e' : ''}</div>
          <div class="stats-streak-sub">${streakStatus}</div>
          <div class="stats-streak-sub mt-4">Längste Serie: ${total.longestStreak || 0} Tage</div>
        </div>

        <div class="stats-section">
          <div class="stats-section-header">
            <div class="stats-section-title">📈 Lernfortschritt</div>
            <div class="chart-toggle">
              <button class="chart-toggle-btn chart-toggle-active" id="btn-chart-14" onclick="switchChart(14)">14 Tage</button>
              <button class="chart-toggle-btn" id="btn-chart-30" onclick="switchChart(30)">30 Tage</button>
            </div>
          </div>
          <div class="chart-container" id="chart-container">
            ${buildChartHTML(14)}
          </div>
          <div class="chart-legend">
            <span class="chart-legend-item"><span class="chart-legend-dot correct"></span> Richtig</span>
            <span class="chart-legend-item"><span class="chart-legend-dot wrong"></span> Falsch</span>
          </div>
        </div>

        <div class="stats-section">
          <div class="stats-section-title">🎯 Gesamt</div>
          <div class="stats-tiles">
            <div class="stats-tile">
              <div class="stats-tile-value">${total.totalAnswered || 0}</div>
              <div class="stats-tile-label">Fragen<br>Gesamt</div>
            </div>
            <div class="stats-tile">
              <div class="stats-tile-value">${pctCorrect}%</div>
              <div class="stats-tile-label">Treffer-<br>quote</div>
            </div>
            <div class="stats-tile">
              <div class="stats-tile-value">${chaptersAvailable}</div>
              <div class="stats-tile-label">Kapitel<br>verfügbar</div>
            </div>
          </div>
        </div>

        <div class="stats-section">
          <div class="stats-section-title">⭐ Beste Vokabeln (Top 5)</div>
          ${bestHTML}
        </div>

        <div class="stats-section">
          <div class="stats-section-title">⚠️ Schwierigste Vokabeln (Top 5)</div>
          ${worstHTML}
        </div>

      </div>
    </div>`;
}

// ===== INIT =====

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.update();
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'activated') {
            location.reload();
          }
        });
      });
    }).catch(() => {});
  }

  try {
    const resp = await fetch('data/index.json');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    indexData = await resp.json();
  } catch {
    document.getElementById('app').innerHTML =
      '<div class="loading"><p style="color:#ef4444">❌ data/index.json konnte nicht geladen werden.</p></div>';
    return;
  }

  await renderChapterScreen();
}

init();
