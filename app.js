'use strict';

// ===== CONSTANTS =====
const SRS_INTERVALS = [0, 1440, 4320, 10080]; // minutes per level

// ===== STATE =====
let indexData        = [];
let archivData       = []; // Klasse-7-Archiv (nur Englisch)
let grammatikData    = []; // Grammatik-Übungen (nur Englisch)
const sectionOpen    = { grammatik: true, archiv: false }; // einklappbare Bereiche der Kapitelliste
let chapterData      = {}; // { id: parsed JSON }
let selectedIds      = new Set();
let direction        = 'EN-DE';
let currentMode      = null;
let selectedLanguage = 'en'; // 'en' | 'es'

// Session state
let sessionCards   = [];
let sessionIdx     = 0;
let sessionTotal   = 0;
let sessionCorrect = 0;
let sessionWrong   = 0;
let cardState      = {};
let allPool        = [];
let sessionType    = 'alles'; // 'alles' | 'kurztest' | 'schwach'

// Stats state
let statsWorstWords = [];

// ===== LANGUAGE HELPERS =====

function getLangFlag() {
  return selectedLanguage === 'en' ? '🇬🇧' : '🇪🇸';
}

function getLangCode() {
  return selectedLanguage.toUpperCase(); // 'EN' | 'ES'
}

function getLangName() {
  return selectedLanguage === 'en' ? 'Englisch' : 'Spanisch';
}

function isForwardDirection() {
  return direction.startsWith(getLangCode() + '-');
}

function getWordField() {
  return selectedLanguage; // 'en' or 'es'
}

function getEntryId(entry, type) {
  if (type === 'verbs') return entry.base;
  if (type === 'conjugation') return `${entry.inf}_${entry.key}`;
  if (type === 'exercise') return entry.id;
  return entry[selectedLanguage]; // entry.en or entry.es
}

function getChapterEntries(data) {
  if (data.type === 'vocab') return data.vocab;
  if (data.type === 'exercise') return data.items;
  return data.verbs; // 'verbs' and 'conjugation'
}

// ===== LOCALSTORAGE MIGRATION =====
// Migrates old keys (without language prefix) to new keys with 'en_' prefix

function migrateLocalStorage() {
  if (localStorage.getItem('ls_migrated_v1')) return;
  const toMigrate = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (k.startsWith('srs_') && !k.startsWith('srs_en_') && !k.startsWith('srs_es_')) {
      toMigrate.push({ old: k, new_: 'srs_en_' + k.slice(4) });
    } else if (k.startsWith('weak_') && !k.startsWith('weak_en_') && !k.startsWith('weak_es_')) {
      toMigrate.push({ old: k, new_: 'weak_en_' + k.slice(5) });
    } else if (k.startsWith('stats_') && !k.startsWith('stats_en_') && !k.startsWith('stats_es_')) {
      toMigrate.push({ old: k, new_: 'stats_en_' + k.slice(6) });
    }
  }
  for (const { old, new_ } of toMigrate) {
    const val = localStorage.getItem(old);
    if (val !== null) {
      localStorage.setItem(new_, val);
      localStorage.removeItem(old);
    }
  }
  localStorage.setItem('ls_migrated_v1', '1');
}

// ===== SRS FUNCTIONS =====

function srsKey(chapterId, type, id) {
  if (type === 'verbs') return `srs_${selectedLanguage}_${chapterId}_verbs_${id}`;
  if (type === 'conjugation') return `srs_${selectedLanguage}_${chapterId}_conjug_${id}`;
  if (type === 'exercise') return `srs_${selectedLanguage}_${chapterId}_ex_${id}`;
  return `srs_${selectedLanguage}_${chapterId}_${direction}_${id}`;
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
    srs.nextReview = now + (SRS_INTERVALS[srs.level] || 0) * 30000;
  } else if (rating === 2) {
    srs.level = Math.min(srs.level + 1, 3);
    srs.nextReview = now + SRS_INTERVALS[srs.level] * 60000;
  } else {
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
    const id = getEntryId(e, type);
    return isLearned(srsKey(chapterId, type, id));
  }).length;
}

function getLastPracticed(chapterId, type, entries) {
  let max = 0;
  for (const e of entries) {
    const id = getEntryId(e, type);
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
  if (type === 'verbs') return `weak_${selectedLanguage}_${chapterId}_verbs_${id}`;
  if (type === 'conjugation') return `weak_${selectedLanguage}_${chapterId}_conjug_${id}`;
  if (type === 'exercise') return `weak_${selectedLanguage}_${chapterId}_ex_${id}`;
  return `weak_${selectedLanguage}_${chapterId}_${direction}_${id}`;
}

function getWeak(key) {
  return parseInt(localStorage.getItem(key) || '0', 10) || 0;
}

function setWeak(key, val) {
  try { localStorage.setItem(key, String(Math.max(0, val))); } catch {}
}

function applyWeakUpdate(card, isCorrect) {
  if (sessionType === 'alles') return;
  const id = getEntryId(card.entry, card.type);
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
    const id = getEntryId(e, type);
    return getWeak(weakKey(chapterId, type, id)) >= 1;
  }).length;
}

function getTotalWeakCount() {
  let count = 0;
  for (const info of getAllChapterInfos()) {
    if (!selectedIds.has(info.id) || !chapterData[info.id]) continue;
    const data = chapterData[info.id];
    const entries = getChapterEntries(data);
    for (const entry of entries) {
      const id = getEntryId(entry, data.type);
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
  const key = `stats_${selectedLanguage}_total`;
  try {
    return JSON.parse(localStorage.getItem(key)) ||
      { totalAnswered: 0, totalCorrect: 0, currentStreak: 0, lastLearnedDate: '', longestStreak: 0 };
  } catch {
    return { totalAnswered: 0, totalCorrect: 0, currentStreak: 0, lastLearnedDate: '', longestStreak: 0 };
  }
}

function recordAnswer(card, isCorrect) {
  const today = todayDateStr();

  const dayKey = `stats_${selectedLanguage}_day_${today}`;
  let dayData;
  try { dayData = JSON.parse(localStorage.getItem(dayKey)) || { correct: 0, wrong: 0, total: 0 }; }
  catch { dayData = { correct: 0, wrong: 0, total: 0 }; }
  if (isCorrect) dayData.correct++; else dayData.wrong++;
  dayData.total++;
  try { localStorage.setItem(dayKey, JSON.stringify(dayData)); } catch {}

  pruneOldDayStats();

  const wordId = getEntryId(card.entry, card.type);
  const wordKey = `stats_${selectedLanguage}_word_${card.chapterId}_${wordId}`;
  let wordData;
  try { wordData = JSON.parse(localStorage.getItem(wordKey)) || { correct: 0, wrong: 0 }; }
  catch { wordData = { correct: 0, wrong: 0 }; }
  if (isCorrect) wordData.correct++; else wordData.wrong++;
  try { localStorage.setItem(wordKey, JSON.stringify(wordData)); } catch {}

  const totalKey = `stats_${selectedLanguage}_total`;
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

  try { localStorage.setItem(totalKey, JSON.stringify(total)); } catch {}
}

function pruneOldDayStats() {
  const prefix = `stats_${selectedLanguage}_day_`;
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) keys.push(k);
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
    try { dayData = JSON.parse(localStorage.getItem(`stats_${selectedLanguage}_day_${str}`)) || { correct: 0, wrong: 0, total: 0 }; }
    catch { dayData = { correct: 0, wrong: 0, total: 0 }; }
    result.push({ str, label: dayNames[d.getDay()], ...dayData });
  }
  return result;
}

function getAllWordStats() {
  const prefix = `stats_${selectedLanguage}_word_`;
  const results = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(prefix)) continue;
    const rest = k.slice(prefix.length);
    for (const info of getAllChapterInfos()) {
      const pfx = info.id + '_';
      if (rest.startsWith(pfx)) {
        const wordId = rest.slice(pfx.length);
        const d = chapterData[info.id];
        if (!d) break;
        const entries = getChapterEntries(d);
        const entry = entries.find(e => getEntryId(e, d.type) === wordId);
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
    .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i').replace(/ó/g, 'o').replace(/ú/g, 'u')
    .replace(/ñ/g, 'n')
    .replace(/[()[\]{}"']/g, '').trim();
}

function checkAnswer(input, correct) {
  const ni = normalize(input);
  if (!ni) return { ok: false };

  const normFull = normalize(correct);
  if (ni === normFull) return { ok: true, type: 'exact' };

  const parts     = correct.split(/[;\/]/).map(p => p.trim()).filter(Boolean);
  const normParts = parts.map(normalize);

  if (parts.length > 1) {
    for (let i = 0; i < normParts.length; i++) {
      if (ni === normParts[i] && ni.length >= 3) {
        return { ok: true, type: 'partial', full: correct.trim() };
      }
    }
  }

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

async function loadIndexForLanguage(lang) {
  try {
    const resp = await fetch(`data/${lang}/index.json`);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    indexData = await resp.json();
  } catch {
    indexData = [];
  }
  archivData    = await loadOptionalIndex(lang, 'data/en/archiv/index.json');
  grammatikData = await loadOptionalIndex(lang, 'data/en/grammatik/index.json');
}

// Extra chapter lists that only exist for English.
async function loadOptionalIndex(lang, url) {
  if (lang !== 'en') return [];
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.json();
  } catch {
    return [];
  }
}

function getAllChapterInfos() {
  return [...indexData, ...grammatikData, ...archivData];
}

// ===== LANGUAGE SWITCH =====

async function setLanguage(lang) {
  if (lang === selectedLanguage) return;
  const wasForward = isForwardDirection();
  selectedLanguage = lang;
  localStorage.setItem('selected_language', lang);
  direction = wasForward ? `${getLangCode()}-DE` : `DE-${getLangCode()}`;
  selectedIds.clear();
  chapterData = {};
  await loadIndexForLanguage(lang);
  await renderChapterScreen();
}

// ===== CHAPTER SELECTION SCREEN =====

async function renderChapterScreen() {
  const langCode = getLangCode();
  const flag     = getLangFlag();
  const fwdDir   = `${langCode}-DE`;
  const bwdDir   = `DE-${langCode}`;

  document.getElementById('app').innerHTML = `
    <div class="screen active" id="screen-chapters">
      <div class="chapter-header">
        <div class="chapter-header-top">
          <h1>📚 Vokabeltrainer</h1>
        </div>
        <p class="chapter-header-subtitle">Kapitel und Lernrichtung wählen</p>
        <div class="language-selector">
          <button class="lang-btn${selectedLanguage==='en'?' lang-btn-active':''}" onclick="setLanguage('en')">🇬🇧 Englisch</button>
          <button class="lang-btn${selectedLanguage==='es'?' lang-btn-active':''}" onclick="setLanguage('es')">🇪🇸 Spanisch</button>
        </div>
        <div class="direction-toggle">
          <button id="btn-fwd" class="${direction===fwdDir?'active':''}" onclick="setDirection('${fwdDir}')">${flag} ${langCode} → 🇩🇪 DE</button>
          <button id="btn-bwd" class="${direction===bwdDir?'active':''}" onclick="setDirection('${bwdDir}')">🇩🇪 DE → ${flag} ${langCode}</button>
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

  if (getAllChapterInfos().length === 0) {
    list.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-muted)">Noch keine ${getLangName()}-Kapitel vorhanden.</div>`;
    return;
  }

  list.innerHTML = '';

  for (const info of indexData) {
    list.appendChild(await buildChapterCardEl(info));
  }

  const sections = [
    { key: 'grammatik', title: '📘 Grammatik',         infos: grammatikData },
    { key: 'archiv',    title: '📦 Archiv – Klasse 7', infos: archivData },
  ];
  for (const sec of sections) {
    if (sec.infos.length === 0) continue;
    const open = sectionOpen[sec.key];

    const toggleRow = document.createElement('div');
    toggleRow.className = 'section-toggle-row';
    toggleRow.onclick = () => toggleSection(sec.key);
    toggleRow.innerHTML = `
      <span>${sec.title}</span>
      <span id="section-icon-${sec.key}">${open ? '▲ verbergen' : '▼ anzeigen'}</span>`;
    list.appendChild(toggleRow);

    const secList = document.createElement('div');
    secList.className = 'section-list';
    secList.id = `section-list-${sec.key}`;
    if (!open) secList.style.display = 'none';
    for (const info of sec.infos) {
      secList.appendChild(await buildChapterCardEl(info));
    }
    list.appendChild(secList);
  }
}

async function buildChapterCardEl(info) {
  const data    = await loadChapterFile(info);
  const entries = getChapterEntries(data);
  const total   = entries.length;
  const learned = getLearnedCount(info.id, data.type, entries);
  const lastTs  = getLastPracticed(info.id, data.type, entries);
  const pct     = total > 0 ? Math.round((learned / total) * 100) : 0;
  const weak    = getWeakCount(info.id, data.type, entries);
  const sel     = selectedIds.has(info.id);
  const badge   = {
    verbs:       `<span class="badge badge-verbs">Verben</span>`,
    conjugation: `<span class="badge badge-conjug">Konjugation</span>`,
    exercise:    `<span class="badge badge-exercise">Grammatik</span>`,
  }[data.type] || `<span class="badge badge-vocab">Vokabeln</span>`;
  const weakNoun = data.type === 'exercise' ? 'Aufgaben' : 'Vokabeln';

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
        ${weak > 0 ? `<div class="chapter-weak-hint">⚠️ ${weak} schwache ${weakNoun}</div>` : ''}
      </div>
    </div>`;
  return card;
}

function toggleSection(key) {
  sectionOpen[key] = !sectionOpen[key];
  try { localStorage.setItem(`${key}_open`, sectionOpen[key] ? 'true' : 'false'); } catch {}
  const secList = document.getElementById(`section-list-${key}`);
  const icon = document.getElementById(`section-icon-${key}`);
  if (secList) secList.style.display = sectionOpen[key] ? '' : 'none';
  if (icon) icon.textContent = sectionOpen[key] ? '▲ verbergen' : '▼ anzeigen';
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
  const fwdDir = `${getLangCode()}-DE`;
  const fwdBtn = document.getElementById('btn-fwd');
  const bwdBtn = document.getElementById('btn-bwd');
  if (fwdBtn) fwdBtn.classList.toggle('active', dir === fwdDir);
  if (bwdBtn) bwdBtn.classList.toggle('active', dir !== fwdDir);
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
  for (const info of getAllChapterInfos()) {
    if (selectedIds.has(info.id) && !chapterData[info.id]) {
      await loadChapterFile(info);
    }
  }
  const selectedTypes = new Set(
    getAllChapterInfos()
      .filter(i => selectedIds.has(i.id) && chapterData[i.id])
      .map(i => chapterData[i.id].type)
  );
  const onlyType = selectedTypes.size === 1 ? [...selectedTypes][0] : null;
  const kurztestMode = { conjugation: 'mc-conjug', exercise: 'exercise-auto' }[onlyType] || 'mc';
  await startSession(kurztestMode);
}

// Which chapter types a given practice mode can render cards for.
function modeSupportsType(mode, type) {
  if (mode === 'mc-conjug' || mode === 'ending') return type === 'conjugation';
  if (mode.startsWith('exercise')) return type === 'exercise';
  return type !== 'conjugation' && type !== 'exercise';
}

// Grammar exercises can be limited to auto-checked kinds or to writing tasks.
function modeSupportsEntry(mode, type, entry) {
  if (type !== 'exercise') return true;
  if (mode === 'exercise-auto')  return entry.kind !== 'rewrite';
  if (mode === 'exercise-write') return entry.kind === 'rewrite';
  return true;
}

// ===== MODE SELECTION SCREEN =====

function goToModeScreen() {
  if (selectedIds.size === 0) return;

  const selectedTypes = new Set(
    getAllChapterInfos()
      .filter(i => selectedIds.has(i.id))
      .map(i => (chapterData[i.id] ? chapterData[i.id].type : i.type))
  );
  const hasVocab  = selectedTypes.has('vocab');
  const hasVerbs  = selectedTypes.has('verbs');
  const hasConjug = selectedTypes.has('conjugation');
  const hasExercise = selectedTypes.has('exercise');
  const mixed     = selectedTypes.size > 1;

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
  const conjugModes = [
    { id: 'mc-conjug',    icon: '✅', name: 'Multiple Choice', desc: 'Richtige Form auswählen' },
    { id: 'ending',       icon: '🔤', name: 'Endung eingeben', desc: 'Nur die richtige Endung tippen' },
  ];

  const exerciseModes = [
    { id: 'exercise',       icon: '🎲', name: 'Gemischt üben',     desc: 'Alle Aufgabenformen im Wechsel' },
    { id: 'exercise-auto',  icon: '✅', name: 'Auswählen & Ordnen', desc: 'Auswahl, Lücken, Ordnen, Zuordnen, Markieren' },
    { id: 'exercise-write', icon: '✍️', name: 'Sätze schreiben',    desc: 'Umformen & Korrigieren, automatisch geprüft' },
  ];

  const typeModeLists = [];
  if (hasVocab)    typeModeLists.push(vocabModes);
  if (hasVerbs)    typeModeLists.push(verbModes);
  if (hasConjug)   typeModeLists.push(conjugModes);
  if (hasExercise) typeModeLists.push(exerciseModes);

  let modes;
  if (typeModeLists.length > 1) {
    const seen = new Set();
    modes = typeModeLists.flat().filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  } else {
    modes = typeModeLists[0];
  }

  const totalEntries = getAllChapterInfos()
    .filter(i => selectedIds.has(i.id) && chapterData[i.id])
    .reduce((sum, i) => sum + getChapterEntries(chapterData[i.id]).length, 0);

  const langCode = getLangCode();
  const flag     = getLangFlag();
  const dirLabel = isForwardDirection()
    ? `${flag} ${langCode} → 🇩🇪 DE`
    : `🇩🇪 DE → ${flag} ${langCode}`;
  let directionInfo = `Richtung: <strong>${dirLabel}</strong>`;
  if (!hasVocab && !hasVerbs) {
    // Konjugation und Grammatik kennen keine Übersetzungsrichtung.
    directionInfo = hasConjug && hasExercise ? '<strong>Konjugation & Grammatik</strong>'
      : hasExercise ? '<strong>Grammatik-Übungen</strong>'
      : 'Richtung: <strong>Infinitiv → konjugierte Form</strong>';
  }

  document.getElementById('app').innerHTML = `
    <div class="screen active" id="screen-modes">
      <div class="screen-header">
        <button class="btn-back" onclick="renderChapterScreen()">‹</button>
        <h2>Lernmodus wählen</h2>
      </div>
      <div class="mode-screen-body">
        <div class="mode-screen-info">
          <strong>${selectedIds.size} Kapitel</strong> · <strong>${totalEntries} Einträge</strong><br>
          ${directionInfo}
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

  for (const info of getAllChapterInfos()) {
    if (!selectedIds.has(info.id)) continue;
    const data = chapterData[info.id];
    if (!data) continue;
    if (!modeSupportsType(mode, data.type)) continue;
    const entries = getChapterEntries(data).filter(e => modeSupportsEntry(mode, data.type, e));

    for (const entry of entries) {
      const id  = getEntryId(entry, data.type);
      const key = srsKey(info.id, data.type, id);
      const srs = getSRS(key) || { level: 0, nextReview: 0 };
      const card = { entry, chapterId: info.id, type: data.type, key, srs };

      allPool.push(card);

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

function buildKurztestCards(mode) {
  allPool = [];
  for (const info of getAllChapterInfos()) {
    if (!selectedIds.has(info.id)) continue;
    const data = chapterData[info.id];
    if (!data) continue;
    if (!modeSupportsType(mode, data.type)) continue;
    const entries = getChapterEntries(data).filter(e => modeSupportsEntry(mode, data.type, e));
    for (const entry of entries) {
      const id   = getEntryId(entry, data.type);
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

  addBatch(allPool.filter(c => c.weak >= 2));
  addBatch(allPool.filter(c => c.srs.level === 0 && !c.srs.lastPracticed));
  addBatch(allPool.filter(c => c.srs.level === 1));
  const oldest = allPool
    .filter(c => !seen.has(c.key))
    .sort((a, b) => (a.srs.lastPracticed || 0) - (b.srs.lastPracticed || 0));
  for (const c of oldest) {
    if (!seen.has(c.key) && result.length < 20) { seen.add(c.key); result.push(c); }
  }
  addBatch(allPool.filter(c => !seen.has(c.key)));

  return result;
}

function buildWeakCards(mode) {
  allPool = [];
  const weak = [];
  for (const info of getAllChapterInfos()) {
    if (!selectedIds.has(info.id)) continue;
    const data = chapterData[info.id];
    if (!data) continue;
    if (!modeSupportsType(mode, data.type)) continue;
    const entries = getChapterEntries(data).filter(e => modeSupportsEntry(mode, data.type, e));
    for (const entry of entries) {
      const id  = getEntryId(entry, data.type);
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

  for (const info of getAllChapterInfos()) {
    if (selectedIds.has(info.id) && !chapterData[info.id]) {
      await loadChapterFile(info);
    }
  }

  if (sessionType === 'kurztest') {
    sessionCards = buildKurztestCards(mode);
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

  let mode = currentMode;
  if (mode === 'typing' && card.type === 'verbs') mode = 'chain';
  if (mode === 'chain'  && card.type === 'vocab') mode = 'typing';
  if (mode === 'typing' && card.type === 'conjugation') mode = 'ending';
  if (mode === 'typing' && card.type === 'exercise') mode = 'exercise';

  if (mode.startsWith('exercise')) { renderExercise(card); return; }

  switch (mode) {
    case 'flashcard':     renderFlashcard(card);     break;
    case 'mc':            renderMC(card);            break;
    case 'typing':        renderTyping(card);        break;
    case 'pronunciation': renderPronunciation(card); break;
    case 'gap':           renderGap(card);           break;
    case 'chain':         renderChain(card);         break;
    case 'mc-conjug':     renderConjugMC(card);      break;
    case 'ending':        renderConjugEnding(card);  break;
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
    const wf      = getWordField(); // 'en' or 'es'
    const word    = e[wf];
    const flag    = getLangFlag();
    const lc      = getLangCode();
    const forward = isForwardDirection();
    const ph      = (selectedLanguage === 'en' && e.ph) ? `<div class="flashcard-phonetic">${e.ph}</div>` : '';

    if (forward) {
      front = `<div class="flashcard-label">${flag} ${lc}</div>
               <div class="flashcard-word">${word}</div>
               ${ph}`;
      back  = `<div class="flashcard-label">🇩🇪 Deutsch</div>
               <div class="flashcard-translation">${e.de}</div>
               ${e.ex ? `<div class="flashcard-phonetic" style="font-size:13px;margin-top:12px">&ldquo;${e.ex}&rdquo;</div>` : ''}`;
    } else {
      front = `<div class="flashcard-label">🇩🇪 Deutsch</div>
               <div class="flashcard-word">${e.de}</div>`;
      back  = `<div class="flashcard-label">${flag} ${lc}</div>
               <div class="flashcard-translation">${word}</div>
               ${ph}`;
    }
  } else {
    front = `<div class="flashcard-label">Infinitiv</div>
             <div class="flashcard-word">${e.base}</div>
             <div class="flashcard-phonetic">${e.ph_base}</div>
             <div class="flashcard-de" style="margin-top:8px">${e.de}</div>`;
    back  = `<div class="flashcard-label">Alle 3 Formen</div>
             <div class="flashcard-forms">${e.base.toUpperCase()}<br>↓<br>${e.past.toUpperCase()}<br>↓<br>${e.participle.toUpperCase()}</div>`;
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
    const wf      = getWordField();
    const flag    = getLangFlag();
    const lc      = getLangCode();
    const forward = isForwardDirection();
    const qField  = forward ? wf : 'de';
    const aField  = forward ? 'de' : wf;
    correctAns = e[aField];

    const distractors = shuffle(
      allPool
        .filter(p => p.type === 'vocab' && p.entry !== e)
        .map(p => p.entry[aField])
        .filter((v, i, a) => v && a.indexOf(v) === i && v !== correctAns)
    ).slice(0, 3);

    options = shuffle([correctAns, ...distractors]);
    const ph = (forward && selectedLanguage === 'en' && e.ph) ? `<div class="mc-question-phonetic">${e.ph}</div>` : '';
    questionHTML = forward
      ? `<div class="mc-question-sub">${flag} ${lc} → 🇩🇪 DE</div>
         <div class="mc-question-word">${e[wf]}</div>
         ${ph}`
      : `<div class="mc-question-sub">🇩🇪 DE → ${flag} ${lc}</div>
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
  const e       = card.entry;
  const wf      = getWordField();
  const flag    = getLangFlag();
  const lc      = getLangCode();
  const forward = isForwardDirection();
  const label   = forward ? `${flag} ${lc} → 🇩🇪 DE` : `🇩🇪 DE → ${flag} ${lc}`;
  const word    = forward ? e[wf] : e.de;
  const ph      = (forward && selectedLanguage === 'en' && e.ph) ? `<div class="typing-phonetic">${e.ph}</div>` : '';
  const placeholder = forward ? 'Deutsche Übersetzung…' : `${getLangName()} Übersetzung…`;

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
  const wf      = getWordField();
  const forward = isForwardDirection();
  const correct = forward ? card.entry.de : card.entry[wf];
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

  const speechLang = selectedLanguage === 'en' ? 'en-GB' : 'es-ES';

  if (card.type === 'vocab') {
    spokenText = e[getWordField()]; // e.en or e.es
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
  cardState.pronLang     = speechLang;

  const label = card.type === 'vocab' ? 'Deutsche Bedeutung wählen:' : 'Welches Verb wurde gesprochen?';
  const safeText = spokenText.replace(/'/g, "\\'");

  document.getElementById('session-content').innerHTML = `
    <div class="pron-display">
      <button class="pron-play-btn" onclick="speak('${safeText}','${speechLang}',0.85)">🔊</button>
      <div class="pron-question">${label}</div>
      <div class="pron-hint">Zum Wiederholen auf 🔊 tippen</div>
    </div>
    <div class="mc-options">
      ${options.map((opt, i) =>
        `<button class="mc-option" id="pron-opt-${i}" onclick="selectPronOption(${i})">${opt}</button>`
      ).join('')}
    </div>
    <div id="pron-feedback" class="hidden"></div>`;

  setTimeout(() => speak(spokenText, speechLang, 0.85), 400);
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

function makeGapSentence(ex, targetWord) {
  const word    = targetWord.replace(/^to\s+/i, '').split(/[;,\/]/)[0].trim();
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex   = new RegExp(`\\b${escaped}(?:s|es|ed|ing|'s|ndo|ando|ando)?\\b`, 'gi');
  const result  = ex.replace(regex, '<span class="gap-blank">___</span>');
  if (result !== ex) return result;
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
    const wf     = getWordField(); // 'en' or 'es'
    const word   = e[wf];
    const gapped = makeGapSentence(e.ex, word);
    correctAns   = word.replace(/^to\s+/i, '').split(/[;,\/]/)[0].trim();
    placeholder  = selectedLanguage === 'en' ? 'Englisches Wort…' : 'Spanisches Wort…';
    displayHTML  = `
      <div class="gap-display">
        <div class="gap-sentence">${gapped}</div>
        <div class="gap-hint mt-8">🇩🇪 ${e.de}</div>
      </div>`;
  } else {
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

  if (cardState.chainInit !== card.key) {
    cardState.chainInit  = card.key;
    cardState.chainStep  = 0;
    cardState.chainError = false;
    cardState.chainPast  = null;
  }

  const step   = cardState.chainStep;
  const isPast = step === 0;
  const label  = isPast ? 'Simple Past' : 'Past Participle';
  const placeholder = isPast ? 'Simple Past…' : 'Past Participle…';

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
    setTimeout(() => {
      cardState.chainStep = 1;
      renderChain(card);
    }, delay);
  } else {
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

// ===== SPANISH CONJUGATION MODES (Präsens) =====
// Direction is fixed (infinitive/German → Spanish form); the global EN-DE/ES-DE
// direction toggle does not apply here, since conjugation isn't a translation.

function renderConjugMC(card) {
  const e = card.entry;
  const correctAns = e.form;

  // Distractors come from the same verb's other persons — that's the actual
  // confusion point in Präsens (which ending goes with which pronoun), not
  // "which verb is this". Every verb in the pool has all 6 forms loaded
  // together (whole chapters, never single persons), so 5 alternatives are
  // always available for 3 distractors.
  const distractors = shuffle(
    allPool
      .filter(p => p.type === 'conjugation' && p.entry.inf === e.inf && p.entry.key !== e.key)
      .map(p => p.entry.form)
  ).slice(0, 3);

  const options = shuffle([correctAns, ...distractors]);
  cardState.mcOptions  = options;
  cardState.mcCorrect  = correctAns;
  cardState.mcSelected = null;

  document.getElementById('session-content').innerHTML = `
    <div class="mc-question">
      <div class="mc-question-sub">Presente · ${e.pronoun}</div>
      <div class="mc-question-word">${e.inf}</div>
      <div class="mc-question-phonetic">${e.de}</div>
    </div>
    <div class="mc-options">
      ${options.map((opt, i) =>
        `<button class="mc-option" id="mc-opt-${i}" onclick="selectMCOption(${i})">${opt}</button>`
      ).join('')}
    </div>
    <div id="mc-feedback" class="hidden"></div>`;
}

function renderConjugEnding(card) {
  const e = card.entry;
  document.getElementById('session-content').innerHTML = `
    <div class="typing-question">
      <div class="typing-question-sub">Presente · ${e.pronoun}</div>
      <div class="typing-word">${e.inf}</div>
      <div class="typing-phonetic">${e.de}</div>
      <div class="chain-forms-row" style="margin-top:14px">
        <span class="chain-known" style="font-size:22px">${e.stem}</span><span class="gap-blank" style="font-size:22px">___</span>
      </div>
    </div>
    <div class="typing-input-row">
      <input type="text" class="typing-input" id="ending-input"
             placeholder="Endung…" autocorrect="off" autocapitalize="none" spellcheck="false"
             onkeydown="if(event.key==='Enter')submitEnding()">
      <button class="btn-submit" id="ending-submit" onclick="submitEnding()">→</button>
    </div>
    <div id="ending-feedback" class="hidden"></div>
    <div id="ending-continue" class="hidden"></div>`;

  document.getElementById('ending-input').focus();
}

function submitEnding() {
  const input = document.getElementById('ending-input');
  const fb    = document.getElementById('ending-feedback');
  const cont  = document.getElementById('ending-continue');
  if (!input || input.disabled) return;

  const card   = sessionCards[sessionIdx];
  const e      = card.entry;
  const result = checkAnswer(input.value, e.ending);

  input.disabled = true;
  const submitBtn = document.getElementById('ending-submit');
  if (submitBtn) submitBtn.disabled = true;

  let rating;
  if (result.ok) {
    input.classList.add('correct');
    fb.className = 'feedback-box ok mt-8';
    fb.textContent = result.type === 'exact' ? '✓ Richtig!' : `✓ Fast! Richtig: ${e.ending}`;
    rating = result.type === 'exact' ? 3 : 2;
    sessionCorrect++;
  } else {
    input.classList.add('wrong');
    fb.className = 'feedback-box fail mt-8';
    fb.textContent = `✗ Richtig: ${e.stem}${e.ending}  (Endung: ${e.ending})`;
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

// ===== GRAMMAR EXERCISES (chapter type 'exercise') =====
// Item kinds: choice | gap | order | match | rewrite | mark.
// Flow for every kind: answer -> feedback + rule hint -> "Weiter".
// Grammar is not a translation, so the global direction toggle does not apply.

const RULE_LABELS = {
  time: 'Zeit- & Ortsangaben', pronoun: 'Pronomen', tense: 'Zeitenverschiebung',
  verb: 'Reporting verbs', 'say-tell': 'say / tell', command: 'Befehle',
  question: 'Fragen', mixed: 'Gemischt',
};

const RULE_HINTS = {
  time: 'Zeit- und Ortsangaben ändern sich: today → that day · tomorrow → the next / following day · yesterday → the day before · next week → the following week · last week → the week before · … ago → … before · now → then · here → there · this / these → that / those.',
  pronoun: 'Pronomen passen sich an, wer berichtet: I → he / she · we → they · you → I / he / she / they (je nach Person) · my → his / her · our → their · mine → his / hers.',
  tense: 'Zeitenverschiebung: present → past · will → would · can → could · must → had to · am / is / are going to → was / were going to · present perfect → past perfect · simple past → past perfect · past perfect bleibt unverändert.',
  verb: 'Reporting verbs sagen genauer, wie etwas gesagt wurde (promise, admit, deny, complain …). Sie stehen ebenfalls im Past. inform und remind brauchen eine Person: informed me, reminded him.',
  'say-tell': 'say + that-Satz (ohne Person): She said that … · tell + Person + that-Satz: She told me that …',
  command: 'Aufforderungen: told / asked / ordered … + Person + to + Infinitiv. Verneint: not to + Infinitiv (told him not to touch it).',
  question: 'Indirekte Fragen: Wortstellung wie im Aussagesatz, kein do / did (where he was going). Ja/Nein-Fragen werden mit if oder whether eingeleitet.',
  mixed: 'Achte auf drei Dinge gleichzeitig: Zeitenverschiebung, Pronomen und Zeit- / Ortsangaben.',
};

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Lower-case, unify apostrophes, expand n't / 'll / 've / 're / 'm, drop punctuation.
// ('d and 's stay as typed: they are ambiguous, so answer keys use full forms.)
function exNorm(s) {
  return String(s || '').toLowerCase()
    .replace(/[’‘´`]/g, "'")
    .replace(/\bwon't\b/g, 'will not')
    .replace(/\bcan't\b/g, 'can not')
    .replace(/\bcannot\b/g, 'can not')
    .replace(/n't\b/g, ' not')
    .replace(/'ll\b/g, ' will')
    .replace(/'ve\b/g, ' have')
    .replace(/'re\b/g, ' are')
    .replace(/'m\b/g, ' am')
    .replace(/[.,!?;:"“”„]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "She said (that) she left" -> ["She said that she left", "She said she left"]
function exExpand(str) {
  const re = /\(([^)]*)\)/;
  let out = [str];
  while (out.some(s => re.test(s))) {
    out = out.flatMap(s => {
      const m = s.match(re);
      return m ? [s.replace(re, m[1]), s.replace(re, '')] : [s];
    });
  }
  return out.map(s => s.replace(/\s+/g, ' ').trim());
}

function exMatchesAny(typed, variants) {
  const nt = exNorm(typed);
  return !!nt && variants.flatMap(exExpand).map(exNorm).includes(nt);
}

// Typed gap: exact match after normalising; a one-letter typo is only tolerated in
// long single words (in "had finished" vs "has finished" one letter IS the error).
function exCheckGap(typed, accepted) {
  const nt = exNorm(typed);
  if (!nt) return { ok: false };
  const norms = accepted.flatMap(exExpand).map(exNorm);
  if (norms.includes(nt)) return { ok: true, type: 'exact' };
  if (norms.some(n => !/\s/.test(n) && n.length >= 8 && levenshtein(nt, n) === 1)) return { ok: true, type: 'typo' };
  return { ok: false };
}

function exFill(text, answers) {
  let i = 0;
  return text.replace(/___/g, () => answers[i++] ?? '___');
}

function recordExerciseResult(card, isCorrect, rating) {
  applyWeakUpdate(card, isCorrect);
  recordAnswer(card, isCorrect);
  updateSRS(card.key, rating);
  if (rating === 0 && !card.requeued && sessionType !== 'kurztest') {
    const pos = Math.min(sessionIdx + 4, sessionCards.length);
    sessionCards.splice(pos, 0, { ...card, requeued: true });
    sessionTotal = sessionCards.length;
  }
  if (isCorrect) sessionCorrect++; else sessionWrong++;
}

function exHeaderHtml(e, defaultTask, extra) {
  return `<div class="ex-card">
    <div class="ex-task">${escHtml(e.task || defaultTask)}</div>
    ${e.passage ? `<div class="ex-passage">${escHtml(e.passage)}</div>` : ''}
    ${e.prompt ? `<div class="ex-prompt">${escHtml(e.prompt)}</div>` : ''}
    ${extra || ''}
  </div>`;
}

function exFeedbackHtml(ok, msg) {
  return `<div class="feedback-box ${ok ? 'ok' : 'fail'}">${msg}</div>`;
}

function exHintHtml(e) {
  const text = e.hint || RULE_HINTS[e.rule];
  return text ? `<div class="notice">💡 ${escHtml(text)}</div>` : '';
}

function exContinueHtml() {
  return `<button class="btn-continue" onclick="sessionIdx++;renderCurrentCard()">Weiter →</button>`;
}

function renderExercise(card) {
  switch (card.entry.kind) {
    case 'choice': renderExChoice(card); break;
    case 'gap':    renderExGap(card);    break;
    case 'order':  renderExOrder(card);  break;
    case 'match':  renderExMatch(card);  break;
    case 'mark':   renderExMark(card);   break;
    default:       renderExRewrite(card);
  }
}

// ----- choice: pick the right option for each gap -----

function renderExChoice(card) {
  cardState.exPicked = [];
  cardState.exOpts = card.entry.gaps.map(g => shuffle(g.options));
  drawExChoice(card);
}

function drawExChoice(card) {
  const e = card.entry;
  const picked = cardState.exPicked;
  const idx  = picked.length;
  const done = idx >= e.gaps.length;

  let sentence = '';
  e.text.split('___').forEach((part, i) => {
    sentence += escHtml(part);
    if (i >= e.gaps.length) return;
    if (i < picked.length) {
      const cls = done ? (picked[i] === e.gaps[i].answer ? ' ok' : ' wrong') : '';
      sentence += `<span class="ex-gap filled${cls}">${escHtml(picked[i])}</span>`;
    } else {
      sentence += `<span class="ex-gap${i === idx ? ' current' : ''}">&nbsp;</span>`;
    }
  });

  let below;
  if (!done) {
    below = `<div class="mc-options">${cardState.exOpts[idx].map((o, i) =>
      `<button class="mc-option" onclick="pickExChoice(${i})">${escHtml(o)}</button>`).join('')}</div>`;
  } else {
    const ok = e.gaps.every((g, i) => picked[i] === g.answer);
    below = exFeedbackHtml(ok, ok ? '✓ Richtig!' : `✗ Richtig: ${escHtml(exFill(e.text, e.gaps.map(g => g.answer)))}`)
      + exHintHtml(e) + exContinueHtml();
  }

  document.getElementById('session-content').innerHTML =
    exHeaderHtml(e, 'Wähle die richtige Form.', `<div class="ex-sentence">${sentence}</div>`) + below;
}

function pickExChoice(optIdx) {
  const card = sessionCards[sessionIdx];
  const gaps = card.entry.gaps;
  cardState.exPicked.push(cardState.exOpts[cardState.exPicked.length][optIdx]);
  if (cardState.exPicked.length === gaps.length) {
    const ok = gaps.every((g, i) => cardState.exPicked[i] === g.answer);
    recordExerciseResult(card, ok, ok ? 2 : 0);
  }
  drawExChoice(card);
}

// ----- gap: type the missing words -----

function renderExGap(card) {
  const e = card.entry;
  let sentence = '';
  e.text.split('___').forEach((part, i) => {
    sentence += escHtml(part);
    if (i >= e.answers.length) return;
    const len = Math.min(28, Math.max(6, ...e.answers[i].map(a => a.replace(/[()]/g, '').length)) + 2);
    sentence += `<input type="text" class="ex-gap-input" id="ex-gap-${i}" style="width:${len}ch"
      autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false"
      onkeydown="exGapKey(event, ${i})">`;
  });
  const bank = e.bank
    ? `<div class="ex-pool">${e.bank.map(b => `<span class="ex-chip static">${escHtml(b)}</span>`).join('')}</div>` : '';

  document.getElementById('session-content').innerHTML =
    exHeaderHtml(e, 'Ergänze die Lücken.', `<div class="ex-sentence">${sentence}</div>${bank}`)
    + `<button class="btn-continue" id="ex-check" onclick="checkExGap()">Prüfen</button>
       <div id="ex-after"></div>`;
  document.getElementById('ex-gap-0').focus();
}

function exGapKey(ev, i) {
  if (ev.key !== 'Enter') return;
  const next = document.getElementById(`ex-gap-${i + 1}`);
  if (next) next.focus(); else checkExGap();
}

function checkExGap() {
  if (cardState.exChecked) return;
  cardState.exChecked = true;
  const card = sessionCards[sessionIdx];
  const e = card.entry;

  let allOk = true, anyTypo = false;
  e.answers.forEach((accepted, i) => {
    const input = document.getElementById(`ex-gap-${i}`);
    const r = exCheckGap(input.value, accepted);
    input.disabled = true;
    input.classList.add(r.ok ? 'correct' : 'wrong');
    if (!r.ok) allOk = false;
    else if (r.type === 'typo') anyTypo = true;
  });
  recordExerciseResult(card, allOk, allOk ? (anyTypo ? 2 : 3) : 0);

  const solution = escHtml(exFill(e.text, e.answers.map(a => a[0].replace(/[()]/g, ''))));
  const msg = !allOk ? `✗ Richtig: ${solution}` : anyTypo ? `✓ Fast perfekt! Richtig: ${solution}` : '✓ Richtig!';
  document.getElementById('ex-check').classList.add('hidden');
  document.getElementById('ex-after').innerHTML = exFeedbackHtml(allOk, msg) + exHintHtml(e) + exContinueHtml();
}

// ----- order: tap the words into the right order -----

function renderExOrder(card) {
  const tokens = card.entry.answer.replace(/[.!?]+$/, '').split(/\s+/);
  let order = tokens.map((_, i) => i);
  for (let tries = 0; tokens.length > 2 && tries < 10; tries++) {
    order = shuffle(order);
    if (!order.every((v, i) => v === i)) break;
  }
  cardState.exTokens = tokens;
  cardState.exPool   = order;
  cardState.exPlaced = [];
  drawExOrder(card);
}

function drawExOrder(card) {
  const e = card.entry;
  const toks = cardState.exTokens;
  const checked = !!cardState.exChecked;
  const lineCls = checked ? (cardState.exOk ? ' ok' : ' wrong') : '';

  const placed = cardState.exPlaced.map(ti =>
    `<button class="ex-chip placed" ${checked ? 'disabled' : ''} onclick="unplaceExToken(${ti})">${escHtml(toks[ti])}</button>`).join('')
    || '<span class="ex-placeholder">Tippe die Wörter in der richtigen Reihenfolge an …</span>';
  const pool = cardState.exPool.map(ti =>
    `<button class="ex-chip" onclick="placeExToken(${ti})">${escHtml(toks[ti])}</button>`).join('');

  let below = '';
  if (checked) {
    below = exFeedbackHtml(cardState.exOk, cardState.exOk ? '✓ Richtig!' : `✗ Richtig: ${escHtml(e.answer)}`)
      + exHintHtml(e) + exContinueHtml();
  } else if (cardState.exPool.length === 0) {
    below = `<button class="btn-continue" onclick="checkExOrder()">Prüfen</button>`;
  }

  document.getElementById('session-content').innerHTML =
    exHeaderHtml(e, 'Bringe die Wörter in die richtige Reihenfolge.',
      `<div class="ex-answer-line${lineCls}">${placed}</div>`)
    + (checked ? '' : `<div class="ex-pool">${pool}</div>`) + below;
}

function placeExToken(ti) {
  cardState.exPool = cardState.exPool.filter(t => t !== ti);
  cardState.exPlaced.push(ti);
  drawExOrder(sessionCards[sessionIdx]);
}

function unplaceExToken(ti) {
  if (cardState.exChecked) return;
  cardState.exPlaced = cardState.exPlaced.filter(t => t !== ti);
  cardState.exPool.push(ti);
  drawExOrder(sessionCards[sessionIdx]);
}

function checkExOrder() {
  const card = sessionCards[sessionIdx];
  const e = card.entry;
  const typed = cardState.exPlaced.map(ti => cardState.exTokens[ti]).join(' ');
  cardState.exOk = exMatchesAny(typed, [e.answer, ...(e.alt || [])]);
  cardState.exChecked = true;
  recordExerciseResult(card, cardState.exOk, cardState.exOk ? 2 : 0);
  drawExOrder(card);
}

// ----- match: pair the items of two columns -----

function renderExMatch(card) {
  const e = card.entry;
  cardState.exRight    = shuffle(e.right.map((_, i) => i));
  cardState.exSel      = null;
  cardState.exDone     = [];
  cardState.exMistakes = 0;
  drawExMatch(card);
}

function drawExMatch(card) {
  const e = card.entry;
  const n = e.left.length;
  const finished = cardState.exDone.length === n;

  const left = e.left.map((t, i) => {
    const cls = cardState.exDone.includes(i) ? ' done' : cardState.exSel === i ? ' selected' : '';
    return `<button class="ex-match-btn${cls}" id="ex-l-${i}" ${cls === ' done' ? 'disabled' : ''} onclick="tapExLeft(${i})">${escHtml(t)}</button>`;
  }).join('');
  const right = cardState.exRight.map(j => {
    const done = cardState.exDone.includes(j);
    return `<button class="ex-match-btn${done ? ' done' : ''}" id="ex-r-${j}" ${done ? 'disabled' : ''} onclick="tapExRight(${j})">${escHtml(e.right[j])}</button>`;
  }).join('');

  let below = '';
  if (finished) {
    const m = cardState.exMistakes;
    const tol = Math.max(1, Math.floor(n / 3));
    below = exFeedbackHtml(m <= tol, m === 0 ? '✓ Alles richtig zugeordnet!'
        : `${m <= tol ? '✓' : '✗'} Fertig – ${m} ${m === 1 ? 'Fehlversuch' : 'Fehlversuche'}`)
      + exHintHtml(e) + exContinueHtml();
  } else {
    below = `<div class="rating-label">Erst links, dann rechts antippen · ${cardState.exDone.length}/${n} zugeordnet</div>`;
  }

  document.getElementById('session-content').innerHTML =
    exHeaderHtml(e, 'Ordne zu.', `<div class="ex-match"><div class="ex-match-col">${left}</div><div class="ex-match-col">${right}</div></div>`)
    + below;
}

function tapExLeft(i) {
  cardState.exSel = cardState.exSel === i ? null : i;
  drawExMatch(sessionCards[sessionIdx]);
}

function tapExRight(j) {
  if (cardState.exSel === null) return;
  const card = sessionCards[sessionIdx];
  if (j === cardState.exSel) {
    cardState.exDone.push(j);
    cardState.exSel = null;
    if (cardState.exDone.length === card.entry.left.length) {
      const m = cardState.exMistakes;
      const ok = m <= Math.max(1, Math.floor(card.entry.left.length / 3));
      recordExerciseResult(card, ok, m === 0 ? 3 : ok ? 2 : 0);
    }
    drawExMatch(card);
  } else {
    cardState.exMistakes++;
    drawExMatch(card);
    const btn = document.getElementById(`ex-r-${j}`);
    if (btn) {
      btn.classList.add('wrong');
      setTimeout(() => { const b = document.getElementById(`ex-r-${j}`); if (b) b.classList.remove('wrong'); }, 600);
    }
  }
}

// ----- rewrite: type a whole sentence; auto-checked against the accepted variants -----
// A match is scored automatically. Otherwise the differences are shown and the learner
// decides whether a different wording was still right (valid paraphrases exist).

function renderExRewrite(card) {
  const e = card.entry;
  const starter = e.starter ? `<div class="ex-starter">${escHtml(e.starter)} …</div>` : '';
  document.getElementById('session-content').innerHTML =
    exHeaderHtml(e, 'Forme in Reported Speech um.')
    + `<div>${starter}<textarea id="ex-text" class="ex-textarea" rows="${e.starter ? 2 : 3}"
         autocomplete="off" autocorrect="off" spellcheck="false" onkeydown="exRewriteKey(event)"></textarea></div>
       <button class="btn-continue" id="ex-check" onclick="checkExRewrite()">Prüfen</button>
       <div id="ex-after"></div>`;
  document.getElementById('ex-text').focus();
}

function exRewriteKey(ev) {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); checkExRewrite(); }
}

function checkExRewrite() {
  if (cardState.exChecked) return;
  cardState.exChecked = true;
  const card = sessionCards[sessionIdx];
  const e = card.entry;
  const area = document.getElementById('ex-text');
  area.disabled = true;

  const typed = ((e.starter ? e.starter + ' ' : '') + area.value.trim()).trim();
  document.getElementById('ex-check').classList.add('hidden');
  const after = document.getElementById('ex-after');

  if (exMatchesAny(typed, e.answers)) {
    recordExerciseResult(card, true, 3);
    after.innerHTML = exFeedbackHtml(true, '✓ Richtig!') + exHintHtml(e) + exContinueHtml();
    return;
  }

  const diff = exDiff(typed, e.answers);
  const others = e.answers.filter((_, i) => i !== diff.answerIdx);
  after.innerHTML = `
    <div class="ex-card">
      <div class="ex-task">Deine Lösung</div>
      <div class="ex-compare-text">${diff.userHtml}</div>
      <div class="ex-task">Musterlösung</div>
      <div class="ex-compare-text model">${diff.modelHtml}</div>
      ${others.length ? `<div class="ex-task">Weitere Lösungen</div>${others.map(a => `<div class="ex-compare-text model">${escHtml(a)}</div>`).join('')}` : ''}
      ${e.answers.some(a => a.includes('(')) ? '<div class="rating-label">Wörter in Klammern sind optional.</div>' : ''}
    </div>
    ${exHintHtml(e)}
    <div class="rating-section visible">
      <div class="rating-label">Anders formuliert, aber trotzdem richtig? Dann bewerte selbst:</div>
      <div class="rating-buttons" style="grid-template-columns:repeat(3,1fr)">
        <button class="btn-rate btn-rate-0" onclick="doRateAndAdvance(0)"><span class="btn-rate-emoji">😣</span>Falsch</button>
        <button class="btn-rate btn-rate-1" onclick="doRateAndAdvance(1)"><span class="btn-rate-emoji">😐</span>Fast</button>
        <button class="btn-rate btn-rate-2" onclick="doRateAndAdvance(2)"><span class="btn-rate-emoji">😊</span>War auch richtig</button>
      </div>
    </div>`;
}

// Word-level diff (longest common subsequence) between the learner's sentence and the
// closest accepted variant. Contractions are compared in expanded form, so
// "wasn't" vs "was not" is no difference; the learner's own wording is shown.
function exTokenize(str) {
  const tokens = str.trim().split(/\s+/).filter(Boolean)
    .map(raw => ({ raw, norms: exNorm(raw).split(' ').filter(Boolean) }));
  const flat = [], owner = [];
  tokens.forEach((t, ti) => t.norms.forEach(w => { flat.push(w); owner.push(ti); }));
  return { tokens, flat, owner };
}

function exLcs(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const inA = new Array(a.length).fill(false), inB = new Array(b.length).fill(false);
  for (let i = a.length, j = b.length; i > 0 && j > 0;) {
    if (a[i - 1] === b[j - 1]) { inA[i - 1] = inB[j - 1] = true; i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return { inA, inB, len: dp[a.length][b.length] };
}

function exDiff(typed, answers) {
  const user = exTokenize(typed);
  let best = null;
  answers.forEach((answer, answerIdx) => exExpand(answer).forEach(variant => {
    const model = exTokenize(variant);
    const lcs = exLcs(user.flat, model.flat);
    const cost = user.flat.length + model.flat.length - 2 * lcs.len;
    if (!best || cost < best.cost) best = { cost, answerIdx, model, lcs };
  }));

  const badUser = new Set(), badModel = new Set();
  user.flat.forEach((_, k) => { if (!best.lcs.inA[k]) badUser.add(user.owner[k]); });
  best.model.flat.forEach((_, k) => { if (!best.lcs.inB[k]) badModel.add(best.model.owner[k]); });

  return {
    answerIdx: best.answerIdx,
    userHtml: user.tokens.map((t, i) => badUser.has(i) ? `<span class="ex-diff-bad">${escHtml(t.raw)}</span>` : escHtml(t.raw)).join(' ') || '–',
    modelHtml: best.model.tokens.map((t, i) => badModel.has(i) ? `<span class="ex-diff-miss">${escHtml(t.raw)}</span>` : escHtml(t.raw)).join(' '),
  };
}

// ----- mark: pick a pen, tap the words that change in reported speech -----
// Only words inside the quotation marks can change; the same word in the narration
// (e.g. "told me") must stay unmarked.

const MARK_CATS = { v: 'Verb', p: 'Pronomen', t: 'Zeit & Ort' };

function exParseMark(text) {
  const words = [];
  let inQuote = false;
  const layout = text.split('\n').map(line => {
    const chunks = line.split(/\s+/).filter(Boolean);
    return chunks.map((chunk, ci) => {
      if (ci === 0 && chunks.length > 1 && chunk.endsWith(':')) return { speaker: chunk };
      const [, pre, core, post] = chunk.match(/^([“"‘(]*)(.*?)([.,!?;:”"’)…]*)$/);
      if (/[“"]/.test(pre)) inQuote = true;
      const word = { text: chunk, core: core.toLowerCase().replace(/’/g, "'"), inQuote, idx: words.length };
      words.push(word);
      if (/[”"]/.test(post)) inQuote = false;
      return { word: word.idx };
    });
  });
  return { words, layout };
}

function exMarkSolution(e, parsed) {
  const byWord = {};
  Object.keys(MARK_CATS).forEach(c => (e.marks[c] || []).forEach(w => { byWord[w.toLowerCase()] = c; }));
  return parsed.words.map(w => (w.inQuote ? byWord[w.core] || null : null));
}

function renderExMark(card) {
  const e = card.entry;
  cardState.exParsed = exParseMark(e.text);
  cardState.exSolution = exMarkSolution(e, cardState.exParsed);
  cardState.exMarks = {};
  cardState.exCats = e.cats || ['v', 'p', 't'];
  cardState.exPen = cardState.exCats.length === 1 ? cardState.exCats[0] : null;
  drawExMark(card);
}

function drawExMark(card) {
  const e = card.entry;
  const { words, layout } = cardState.exParsed;
  const checked = !!cardState.exChecked;

  const body = layout.map(line => line.map(item => {
    if (item.speaker) return `<span class="ex-speaker">${escHtml(item.speaker)}</span>`;
    const w = words[item.word];
    const given = cardState.exMarks[w.idx] || null;
    const want = cardState.exSolution[w.idx];
    let cls = given ? ` cat-${given}` : '';
    if (checked) {
      if (want && given === want) cls = ` cat-${want} ok`;
      else if (want) cls = ` cat-${want} miss`;
      else if (given) cls = ' extra';
      else cls = '';
    }
    return `<span class="ex-word${cls}" onclick="tapExWord(${w.idx})">${escHtml(w.text)}</span>`;
  }).join(' ')).join('<br>');

  const pens = cardState.exCats.map(c =>
    `<button class="ex-pen cat-${c}${cardState.exPen === c ? ' active' : ''}" ${checked ? 'disabled' : ''} onclick="tapExPen('${c}')">${MARK_CATS[c]}</button>`).join('');

  let below;
  if (checked) {
    const errors = cardState.exErrors;
    below = exFeedbackHtml(errors === 0, errors === 0 ? '✓ Alles richtig markiert!'
        : `✗ ${errors} ${errors === 1 ? 'Wort' : 'Wörter'} falsch oder vergessen (gestrichelt umrandet bzw. durchgestrichen)`)
      + exHintHtml(e) + exContinueHtml();
  } else {
    below = (cardState.exPen ? '' : '<div class="rating-label">Wähle einen Stift und tippe dann die Wörter an.</div>')
      + `<button class="btn-continue" onclick="checkExMark()">Prüfen</button>`;
  }

  document.getElementById('session-content').innerHTML =
    exHeaderHtml(e, 'Markiere, was sich in der indirekten Rede ändert. Verbgruppen markierst du komplett (z. B. have been waiting).',
      `${checked ? '' : `<div class="ex-pens">${pens}</div>`}<div class="ex-text-block">${body}</div>`)
    + below;
}

function tapExPen(c) {
  cardState.exPen = cardState.exPen === c ? null : c;
  drawExMark(sessionCards[sessionIdx]);
}

function tapExWord(idx) {
  if (cardState.exChecked || !cardState.exPen) return;
  if (cardState.exMarks[idx] === cardState.exPen) delete cardState.exMarks[idx];
  else cardState.exMarks[idx] = cardState.exPen;
  drawExMark(sessionCards[sessionIdx]);
}

function checkExMark() {
  const card = sessionCards[sessionIdx];
  cardState.exErrors = cardState.exSolution.filter((want, i) => want !== (cardState.exMarks[i] || null)).length;
  cardState.exChecked = true;
  const errors = cardState.exErrors;
  recordExerciseResult(card, errors === 0, errors === 0 ? 2 : errors === 1 ? 1 : 0);
  drawExMark(card);
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
    const id = getEntryId(w.entry, w.type);
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
  const chaptersAvailable = getAllChapterInfos().length;

  const renderWordLine = (w, icon) => {
    let wordId = getEntryId(w.entry, w.type);
    let de     = w.entry.de;
    if (w.type === 'conjugation') wordId = `${w.entry.form} (${w.entry.pronoun})`;
    if (w.type === 'exercise') {
      wordId = escHtml(w.entry.prompt || w.entry.text || w.entry.answer || w.entry.id);
      de     = RULE_LABELS[w.entry.rule] || 'Grammatik';
    }
    const tot = w.correct + w.wrong;
    return `<div class="stats-word-row">${icon} <span class="stats-word-en">${wordId}</span><span class="stats-word-arrow"> → </span><span class="stats-word-de">${de}</span><span class="stats-word-score">(${w.correct}/${tot} richtig)</span></div>`;
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
        <p class="chapter-header-subtitle">Statistiken – ${getLangName()} ${getLangFlag()}</p>
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
  migrateLocalStorage();

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

  selectedLanguage = localStorage.getItem('selected_language') || 'en';
  direction = `${getLangCode()}-DE`;
  sectionOpen.archiv    = localStorage.getItem('archiv_open') === 'true';
  sectionOpen.grammatik = localStorage.getItem('grammatik_open') !== 'false'; // standardmäßig offen

  await loadIndexForLanguage(selectedLanguage);
  await renderChapterScreen();
}

init();
