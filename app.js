// ============================================================
//  SOUNDBOARD — app.js
//  Requires: config.js (CONFIG object) loaded first
// ============================================================

'use strict';

// ── USER TAGS (persisted to localStorage) ──────────────────
const UserTags = {
  _key: 'soundboard_user_tags',
  _data: null,

  _load() {
    if (!this._data) {
      try { this._data = JSON.parse(localStorage.getItem(this._key)) || {}; }
      catch { this._data = {}; }
    }
    return this._data;
  },

  get(trackId) { return this._load()[trackId] || []; },

  add(trackId, tag) {
    tag = tag.trim().toLowerCase();
    if (!tag) return;
    const d = this._load();
    if (!d[trackId]) d[trackId] = [];
    if (!d[trackId].includes(tag)) d[trackId].push(tag);
    localStorage.setItem(this._key, JSON.stringify(d));
  },

  remove(trackId, tag) {
    const d = this._load();
    if (d[trackId]) d[trackId] = d[trackId].filter(t => t !== tag);
    localStorage.setItem(this._key, JSON.stringify(d));
  },
};

// ── SLOT PLAYER ────────────────────────────────────────────
class SlotPlayer {
  constructor(audioCtx, masterGain) {
    this.ctx = audioCtx;
    this.gainNode = audioCtx.createGain();
    this.gainNode.gain.value = 0;
    this.gainNode.connect(masterGain);

    this.buffer       = null;
    this.isPlaying    = false;
    this._activeSrcs  = [];   // { source, gain }
    this._loopTimer   = null;
  }

  setBuffer(buffer) { this.buffer = buffer; }

  // Kick off looping (internal gain starts silent; call fadeIn after)
  startLoop() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this._scheduleLoop(this.ctx.currentTime);
  }

  // Schedule one iteration of the buffer, overlapping the next by crossfadeDuration
  _scheduleLoop(startAt) {
    if (!this.isPlaying || !this.buffer) return;

    const duration = this.buffer.duration;
    const cf = Math.min(CONFIG.loopCrossfadeDuration, duration / 3);

    // Create source + per-iteration gain (for the loop crossfade)
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    const sourceGain = this.ctx.createGain();
    source.connect(sourceGain);
    sourceGain.connect(this.gainNode);

    // Fade in at loop start
    sourceGain.gain.setValueAtTime(0, startAt);
    sourceGain.gain.linearRampToValueAtTime(1, startAt + cf);

    // Sustain
    sourceGain.gain.setValueAtTime(1, startAt + duration - cf);

    // Fade out at loop end
    sourceGain.gain.linearRampToValueAtTime(0, startAt + duration);

    source.start(startAt, 0, duration);

    const entry = { source, gain: sourceGain };
    this._activeSrcs.push(entry);
    source.onended = () => {
      this._activeSrcs = this._activeSrcs.filter(e => e !== entry);
    };

    // Schedule next iteration to overlap by cf seconds
    const nextStart   = startAt + duration - cf;
    const delayMs     = Math.max(0, (nextStart - this.ctx.currentTime) * 1000 - 150);

    this._loopTimer = setTimeout(() => this._scheduleLoop(nextStart), delayMs);
  }

  stopLoop(immediate = false) {
    this.isPlaying = false;
    clearTimeout(this._loopTimer);
    if (immediate) {
      this._activeSrcs.forEach(({ source }) => { try { source.stop(0); } catch (_) {} });
      this._activeSrcs = [];
    }
    // If not immediate, the already-scheduled nodes play out quietly as gain fades
  }

  // Fade in the slot gain and begin looping
  fadeIn(durationSec) {
    this.startLoop();
    const now = this.ctx.currentTime;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
    this.gainNode.gain.linearRampToValueAtTime(1, now + durationSec);
  }

  // Fade out the slot gain, then stop the loop
  fadeOut(durationSec) {
    const now = this.ctx.currentTime;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
    this.gainNode.gain.linearRampToValueAtTime(0, now + durationSec);
    setTimeout(() => this.stopLoop(true), (durationSec + 0.1) * 1000);
  }
}

// ── AUDIO ENGINE ───────────────────────────────────────────
const AudioEngine = (() => {
  let ctx          = null;
  let masterGain   = null;
  let slotPlayers  = [];
  let sfxBuffers   = new Map();   // id → AudioBuffer
  let musicBuffers = new Map();   // url → AudioBuffer
  let activeSlot   = null;        // index | null

  function ensureContext() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.8;
      masterGain.connect(ctx.destination);
      slotPlayers = Array.from({ length: CONFIG.maxSlots },
        () => new SlotPlayer(ctx, masterGain));
    }
    if (ctx.state === 'suspended') ctx.resume();
    // iOS blocks audio started outside a user gesture, even from async callbacks.
    // Playing a silent 1-sample buffer synchronously within the gesture unlocks it.
    if (!ctx._unlocked) {
      const silent = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = silent;
      src.connect(ctx.destination);
      src.start(0);
      src.onended = () => src.disconnect();
      ctx._unlocked = true;
    }
  }

  async function loadBuffer(url) {
    if (musicBuffers.has(url)) return musicBuffers.get(url);
    const res  = await fetch(url);
    const arr  = await res.arrayBuffer();
    const buf  = await ctx.decodeAudioData(arr);
    musicBuffers.set(url, buf);
    return buf;
  }

  async function loadSFX(id, url) {
    if (sfxBuffers.has(id)) return sfxBuffers.get(id);
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    const buf = await ctx.decodeAudioData(arr);
    sfxBuffers.set(id, buf);
    return buf;
  }

  async function activateSlot(index) {
    ensureContext();
    const player = slotPlayers[index];
    if (!player.buffer) return; // nothing loaded

    const cf = CONFIG.slotCrossfadeDuration;

    // Fade out the previously active slot (if different)
    if (activeSlot !== null && activeSlot !== index) {
      slotPlayers[activeSlot].fadeOut(cf);
    }

    // If clicking the already-active slot: stop it (toggle off)
    if (activeSlot === index) {
      player.fadeOut(cf);
      activeSlot = null;
      return null;
    }

    activeSlot = index;
    player.fadeIn(cf);
    return index;
  }

  async function playSFX(id, url) {
    ensureContext();
    let buf;
    try {
      buf = await loadSFX(id, url);
    } catch (err) {
      console.error('SFX load error', err);
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.connect(masterGain);
    source.start(0);
    source.onended = () => source.disconnect();
  }

  function setVolume(value) {
    ensureContext();
    masterGain.gain.setTargetAtTime(value, ctx.currentTime, 0.05);
  }

  function getActiveSlot() { return activeSlot; }

  return { ensureContext, loadBuffer, activateSlot, playSFX, setVolume, getActiveSlot,
           get slotPlayers() { return slotPlayers; } };
})();

// ── STATE ──────────────────────────────────────────────────
const State = {
  library: { music: [], sfx: [] },
  // Each slot: null | { track, buffer|null, loading }
  slots: Array(CONFIG.maxSlots).fill(null),
  selectedTrack: null,      // track metadata object or null
  tagFilters: new Set(),    // active tag filter strings
  searchQuery: '',
};

// ── HELPERS ────────────────────────────────────────────────
function url(path) {
  return `${CONFIG.storageBaseUrl}/${path}`;
}

function allTagsForTrack(track) {
  const devTags  = track.tags || [];
  const userTags = UserTags.get(track.id);
  return [...new Set([...devTags, ...userTags])];
}

function showToast(msg, durationMs = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => el.classList.add('hidden'), durationMs);
}

// ── METADATA LOADING ───────────────────────────────────────
async function loadMetadata() {
  try {
    const res = await fetch('metadata.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    State.library.music = data.music || [];
    State.library.sfx   = data.sfx   || [];
  } catch (err) {
    console.error('Could not load metadata.json:', err);
    showToast('⚠ Could not load library. Check config.js storage URL.', 6000);
  }
}

// ── UI — LIBRARY ───────────────────────────────────────────
function buildTagFilters() {
  const allTags = new Set();
  [...State.library.music, ...State.library.sfx].forEach(t =>
    allTagsForTrack(t).forEach(tag => allTags.add(tag)));

  const container = document.getElementById('tag-filters');
  container.innerHTML = '';
  [...allTags].sort().forEach(tag => {
    const btn = document.createElement('button');
    btn.className = 'tag-filter-pill' + (State.tagFilters.has(tag) ? ' active' : '');
    btn.textContent = tag;
    btn.addEventListener('click', () => {
      if (State.tagFilters.has(tag)) State.tagFilters.delete(tag);
      else State.tagFilters.add(tag);
      renderLibrary();
      buildTagFilters();
    });
    container.appendChild(btn);
  });
}

function filteredMusic() {
  return State.library.music.filter(track => {
    const q    = State.searchQuery.toLowerCase();
    const tags = allTagsForTrack(track);
    const nameMatch = track.name.toLowerCase().includes(q);
    const tagMatch  = q === '' ? true :
      tags.some(t => t.includes(q)) || nameMatch;
    const filterMatch = State.tagFilters.size === 0 ||
      [...State.tagFilters].every(f => tags.includes(f));
    return tagMatch && filterMatch;
  });
}

function renderLibrary() {
  const list   = document.getElementById('track-list');
  const tracks = filteredMusic();
  list.innerHTML = '';

  if (!tracks.length) {
    list.innerHTML = '<div class="empty-state">No tracks match your filters.</div>';
    return;
  }

  tracks.forEach(track => {
    const tags = allTagsForTrack(track);
    const isSelected = State.selectedTrack?.id === track.id;

    const item = document.createElement('div');
    item.className = 'track-item' + (isSelected ? ' selected' : '');
    item.draggable = true;
    item.dataset.trackId = track.id;

    item.innerHTML = `
      <div class="track-item-icon">&#9835;</div>
      <div class="track-item-info">
        <div class="track-item-name">${escHtml(track.name)}</div>
        <div class="track-item-tags">
          ${tags.map(t => `<span class="tag-badge">${escHtml(t)}</span>`).join('')}
        </div>
      </div>
      <button class="track-item-tag-btn" data-track-id="${track.id}" title="Edit user tags">+ tag</button>
      <button class="track-item-add" data-track-id="${track.id}" title="Add to slot">+</button>
    `;

    // Select track (click anywhere except buttons)
    // On touch devices, go straight to the slot picker — the two-step
    // select-then-tap-slot flow is unreliable on iOS due to phantom taps.
    item.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      if (navigator.maxTouchPoints > 0) {
        showSlotPicker(track);
      } else {
        selectTrack(track);
      }
    });

    // Add button → open slot picker
    item.querySelector('.track-item-add').addEventListener('click', e => {
      e.stopPropagation();
      showSlotPicker(track);
    });

    // Tag button → open tag editor
    item.querySelector('.track-item-tag-btn').addEventListener('click', e => {
      e.stopPropagation();
      openTagEditor(track, item.querySelector('.track-item-tag-btn'));
    });

    // Drag
    item.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', track.id);
      e.dataTransfer.effectAllowed = 'copy';
      item.classList.add('dragging');
      State.selectedTrack = track;
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));

    list.appendChild(item);
  });
}

function selectTrack(track) {
  // Guard against iOS phantom taps: after a DOM rebuild iOS can fire a second
  // synthetic click at the same coordinates, which would immediately toggle off
  // the track we just selected. Ignore calls within 350ms of a selection.
  const now = Date.now();
  if (selectTrack._lastSelected === track.id && now - selectTrack._lastTime < 350) return;

  // Toggle selection
  if (State.selectedTrack?.id === track.id) {
    State.selectedTrack = null;
    updateSlotHint();
    renderLibrary();
    return;
  }
  State.selectedTrack = track;
  selectTrack._lastSelected = track.id;
  selectTrack._lastTime = now;
  updateSlotHint();
  renderLibrary();
  showToast(`"${track.name}" selected — click a slot to load it.`);
}

function updateSlotHint() {
  const hint = document.getElementById('slot-hint');
  if (State.selectedTrack) {
    hint.textContent = `"${State.selectedTrack.name}" selected — click a slot to load it. (ESC to cancel)`;
    hint.style.color = 'var(--accent)';
  } else {
    hint.textContent = 'Select a track from the library, then click a slot to load it.';
    hint.style.color = '';
  }
}

// ── UI — SLOT PICKER MODAL ─────────────────────────────────
function showSlotPicker(track) {
  removeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'slot-picker-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <h3>Load into slot</h3>
    <p>Choose a slot for <strong>${escHtml(track.name)}</strong>:</p>
    <div class="modal-slots" id="modal-slots"></div>
    <button class="modal-cancel">Cancel</button>
  `;

  const slotsEl = modal.querySelector('#modal-slots');
  State.slots.forEach((slot, i) => {
    const btn = document.createElement('button');
    btn.className = 'modal-slot-btn' + (slot ? ' occupied' : '');
    btn.title = slot ? `Replace: ${slot.track.name}` : `Empty slot`;
    btn.innerHTML = `<div style="font-weight:700;margin-bottom:2px">${i + 1}</div>
      <div style="font-size:10px;color:var(--text-muted)">${slot ? slot.track.name.slice(0, 10) + '…' : 'Empty'}</div>`;
    btn.addEventListener('click', () => {
      removeModal();
      assignTrackToSlot(track, i);
    });
    slotsEl.appendChild(btn);
  });

  modal.querySelector('.modal-cancel').addEventListener('click', removeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) removeModal(); });

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

function removeModal() {
  document.getElementById('slot-picker-overlay')?.remove();
  // Always clear selection when modal closes so stale state can't cause
  // a subsequent slot tap to unexpectedly load a track.
  State.selectedTrack = null;
  updateSlotHint();
  renderLibrary();
}

// ── UI — TAG EDITOR ────────────────────────────────────────
function openTagEditor(track, anchorEl) {
  document.getElementById('tag-editor-popup')?.remove();

  const popup = document.createElement('div');
  popup.className = 'modal-overlay';
  popup.id = 'tag-editor-popup';
  popup.style.cssText = 'z-index:110';

  const box = document.createElement('div');
  box.className = 'tag-editor';

  function refresh() {
    const tags = allTagsForTrack(track);
    box.innerHTML = `
      <h3>Tags for "${escHtml(track.name)}"</h3>
      <div class="tag-editor-current">
        ${tags.map(t => {
          const isUser = UserTags.get(track.id).includes(t);
          return `<span class="tag-editor-pill">
            ${escHtml(t)}
            ${isUser ? `<button data-tag="${escHtml(t)}" title="Remove">&times;</button>` : ''}
          </span>`;
        }).join('')}
        ${tags.length === 0 ? '<span style="color:var(--text-muted);font-size:11px">No tags yet</span>' : ''}
      </div>
      <div class="tag-editor-input">
        <input type="text" placeholder="Add tag&hellip;" id="tag-input" maxlength="32">
        <button id="tag-add-btn">Add</button>
      </div>
      <button class="tag-editor-close">Done</button>
    `;

    box.querySelectorAll('[data-tag]').forEach(btn => {
      btn.addEventListener('click', () => {
        UserTags.remove(track.id, btn.dataset.tag);
        refresh();
        buildTagFilters();
        renderLibrary();
      });
    });

    const input = box.querySelector('#tag-input');
    const addBtn = box.querySelector('#tag-add-btn');
    function addTag() {
      const val = input.value.trim();
      if (val) { UserTags.add(track.id, val); input.value = ''; refresh(); buildTagFilters(); renderLibrary(); }
    }
    addBtn.addEventListener('click', addTag);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') addTag(); });
    box.querySelector('.tag-editor-close').addEventListener('click', () => popup.remove());
  }

  refresh();
  popup.addEventListener('click', e => { if (e.target === popup) popup.remove(); });
  popup.appendChild(box);
  document.body.appendChild(popup);
}

// ── UI — SLOTS GRID ────────────────────────────────────────
function renderSlots() {
  const grid = document.getElementById('slots-grid');
  grid.innerHTML = '';

  State.slots.forEach((slot, i) => {
    const activeSlot = AudioEngine.getActiveSlot();
    const isActive   = activeSlot === i;
    const isLoading  = slot?.loading;

    const card = document.createElement('div');
    card.className = 'slot-card'
      + (isActive  ? ' active'  : '')
      + (isLoading ? ' loading' : '');
    card.dataset.slot = i;

    if (slot) {
      const tags = allTagsForTrack(slot.track).slice(0, 3);
      card.innerHTML = `
        <div class="slot-number">Slot ${i + 1}${isActive ? ' &#9654;' : ''}</div>
        <div class="slot-name">${escHtml(slot.track.name)}${isLoading ? '<span class="slot-spinner"></span>' : ''}</div>
        <div class="slot-tags">
          ${tags.map(t => `<span class="tag-badge">${escHtml(t)}</span>`).join('')}
        </div>
        <button class="slot-remove" data-slot="${i}" title="Remove from slot">&times;</button>
      `;
    } else {
      card.innerHTML = `
        <div class="slot-number">Slot ${i + 1}</div>
        <div class="slot-empty-label">Empty</div>
      `;
    }

    // Click: if track selected (desktop only) → assign it; else play/toggle
    card.addEventListener('click', e => {
      if (e.target.closest('.slot-remove')) return;

      // Ensure AudioContext is started on user gesture
      AudioEngine.ensureContext();

      // On touch devices, loading is handled exclusively via the slot picker
      // modal — never via State.selectedTrack — to avoid iOS phantom tap issues.
      const isTouch = navigator.maxTouchPoints > 0;
      if (!isTouch && State.selectedTrack) {
        assignTrackToSlot(State.selectedTrack, i);
        State.selectedTrack = null;
        updateSlotHint();
        renderLibrary();
        return;
      }

      if (State.slots[i]) {
        toggleSlot(i);
      }
    });

    // Remove button
    card.querySelector('.slot-remove')?.addEventListener('click', e => {
      e.stopPropagation();
      removeSlot(i);
    });

    // Drag-and-drop target
    card.addEventListener('dragover', e => {
      e.preventDefault();
      card.classList.add('drop-target');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
    card.addEventListener('drop', e => {
      e.preventDefault();
      card.classList.remove('drop-target');
      const trackId = e.dataTransfer.getData('text/plain');
      const track   = State.library.music.find(t => t.id === trackId);
      if (track) assignTrackToSlot(track, i);
      State.selectedTrack = null;
      updateSlotHint();
    });

    grid.appendChild(card);
  });
}

// ── SLOT LOGIC ─────────────────────────────────────────────
async function assignTrackToSlot(track, slotIndex) {
  // If this slot is currently playing, stop it
  if (AudioEngine.getActiveSlot() === slotIndex) {
    AudioEngine.slotPlayers[slotIndex].fadeOut(0.3);
    // activeSlot handled below
  }

  // Mark as loading
  State.slots[slotIndex] = { track, buffer: null, loading: true };
  renderSlots();

  try {
    AudioEngine.ensureContext();
    const buffer = await AudioEngine.loadBuffer(url(track.file));
    AudioEngine.slotPlayers[slotIndex].stopLoop(true);
    AudioEngine.slotPlayers[slotIndex].setBuffer(buffer);
    State.slots[slotIndex] = { track, buffer, loading: false };
    showToast(`"${track.name}" loaded into slot ${slotIndex + 1}.`);
  } catch (err) {
    console.error('Track load error:', err);
    State.slots[slotIndex] = null;
    showToast(`Failed to load "${track.name}". Check the file path.`, 4000);
  }

  renderSlots();
}

async function toggleSlot(index) {
  if (!State.slots[index] || State.slots[index].loading) return;

  const newActive = await AudioEngine.activateSlot(index);
  // newActive is null if we toggled off, or index if we turned on
  renderSlots();
}

function removeSlot(index) {
  if (AudioEngine.getActiveSlot() === index) {
    AudioEngine.slotPlayers[index].fadeOut(0.4);
  }
  AudioEngine.slotPlayers[index].stopLoop(true);
  State.slots[index] = null;
  renderSlots();
}

// ── UI — SFX GRID ──────────────────────────────────────────
function renderSFX() {
  const grid = document.getElementById('sfx-grid');
  grid.innerHTML = '';

  if (!State.library.sfx.length) {
    grid.innerHTML = '<div class="empty-state">No sound effects in library.</div>';
    return;
  }

  State.library.sfx.forEach(sfx => {
    const btn = document.createElement('button');
    btn.className = 'sfx-btn';
    btn.textContent = sfx.name;
    btn.title = (sfx.tags || []).join(', ');

    btn.addEventListener('click', async () => {
      AudioEngine.ensureContext();
      btn.classList.add('playing');
      await AudioEngine.playSFX(sfx.id, url(sfx.file));
      btn.classList.remove('playing');
    });

    grid.appendChild(btn);
  });
}

// ── VOLUME SLIDER ──────────────────────────────────────────
function initVolume() {
  const slider  = document.getElementById('master-volume');
  const display = document.getElementById('volume-display');

  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    display.textContent = Math.round(v * 100) + '%';
    AudioEngine.setVolume(v);
  });
}

// ── SEARCH ─────────────────────────────────────────────────
function initSearch() {
  const input = document.getElementById('search');
  input.addEventListener('input', () => {
    State.searchQuery = input.value;
    renderLibrary();
  });
}

// ── KEYBOARD SHORTCUTS ─────────────────────────────────────
function initKeyboard() {
  document.addEventListener('keydown', e => {
    // ESC: deselect track
    if (e.key === 'Escape') {
      if (State.selectedTrack) {
        State.selectedTrack = null;
        updateSlotHint();
        renderLibrary();
      }
      removeModal();
      return;
    }

    // Number keys 1-9, 0 → toggle slots 1-10
    if (['1','2','3','4','5','6','7','8','9','0'].includes(e.key)
        && !e.target.matches('input')) {
      const i = e.key === '0' ? 9 : parseInt(e.key) - 1;
      if (State.slots[i]) toggleSlot(i);
    }
  });
}

// ── UTILITY ────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── INIT ───────────────────────────────────────────────────
async function init() {
  initVolume();
  initSearch();
  initKeyboard();
  renderSlots(); // render empty slots immediately

  await loadMetadata();

  buildTagFilters();
  renderLibrary();
  renderSFX();
}

document.addEventListener('DOMContentLoaded', init);
