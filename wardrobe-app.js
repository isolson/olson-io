// Capsule Wardrobe App
(function() {
  'use strict';

  const ELY_LAT = 47.9032;
  const ELY_LON = -91.8671;

  // --- DAY/CONTEXT DEFAULTS ---
  function getDefaultContext() {
    const day = new Date().getDay();
    return (day === 0 || day === 6) ? 'casual' : 'smart-casual';
  }

  // State
  let currentView = 'inventory';
  let categoryFilter = 'all';
  let statusFilter = 'all';
  let contextFilter = getDefaultContext();
  let outfitSlots = { footwear: null, pants: null, shirts: null, outerwear: null };
  let activeDrawerSlot = null;
  let weatherData = null;
  let activeOccasion = null;

  // --- AUTH ---
  async function hashPassword(pw) {
    const buf = new TextEncoder().encode(pw);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function initAuth() {
    if (sessionStorage.getItem('wardrobe-auth')) {
      showApp();
      return;
    }
    document.getElementById('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = document.getElementById('pw-input').value;
      const hash = await hashPassword(pw);
      if (hash === PASSWORD_HASH) {
        sessionStorage.setItem('wardrobe-auth', 'true');
        showApp();
      } else {
        document.getElementById('auth-error').hidden = false;
        document.getElementById('pw-input').value = '';
        document.getElementById('pw-input').focus();
      }
    });
  }

  function showApp() {
    document.getElementById('password-gate').hidden = true;
    document.getElementById('app').hidden = false;
    init();
  }

  // --- STATUS OVERRIDES (localStorage) ---
  function getStatusOverrides() {
    const raw = localStorage.getItem('wardrobe-status-overrides');
    return raw ? JSON.parse(raw) : {};
  }

  function setStatusOverride(itemId, status) {
    const overrides = getStatusOverrides();
    overrides[itemId] = status;
    localStorage.setItem('wardrobe-status-overrides', JSON.stringify(overrides));
  }

  function getEffectiveStatus(item) {
    const overrides = getStatusOverrides();
    return overrides[item.id] || item.status;
  }

  // --- CUSTOM ITEMS (localStorage) ---
  function loadCustomItems() {
    const raw = localStorage.getItem('wardrobe-custom-items');
    return raw ? JSON.parse(raw) : [];
  }

  function saveCustomItem(item) {
    const items = loadCustomItems();
    items.push(item);
    localStorage.setItem('wardrobe-custom-items', JSON.stringify(items));
  }

  function mergeCustomItems() {
    const custom = loadCustomItems();
    custom.forEach(item => {
      if (!WARDROBE.items.find(i => i.id === item.id)) {
        WARDROBE.items.push(item);
      }
    });
  }

  // --- PERSISTENCE ---
  function loadState() {
    const raw = localStorage.getItem('wardrobe-state');
    if (raw) return JSON.parse(raw);
    const state = { items: {}, outfitHistory: [], lastLaundry: null };
    WARDROBE.items.forEach(item => {
      state.items[item.id] = { wearsSinceWash: 0, lastWorn: null, totalWears: 0 };
    });
    saveState(state);
    return state;
  }

  function saveState(state) {
    localStorage.setItem('wardrobe-state', JSON.stringify(state));
  }

  function getItemState(id) {
    const state = loadState();
    if (!state.items[id]) {
      state.items[id] = { wearsSinceWash: 0, lastWorn: null, totalWears: 0 };
      saveState(state);
    }
    return state.items[id];
  }

  function isDirty(item) {
    if (!item.washAfterWears) return false;
    const s = getItemState(item.id);
    return s.wearsSinceWash >= item.washAfterWears;
  }

  // --- WEATHER ---
  async function fetchWeather() {
    const cached = sessionStorage.getItem('weather-cache');
    if (cached) {
      const { data, ts } = JSON.parse(cached);
      if (Date.now() - ts < 30 * 60 * 1000) return data;
    }
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${ELY_LAT}&longitude=${ELY_LON}&current=temperature_2m,apparent_temperature,weather_code&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=America/Chicago`;
      const res = await fetch(url);
      const data = await res.json();
      sessionStorage.setItem('weather-cache', JSON.stringify({ data, ts: Date.now() }));
      return data;
    } catch (e) {
      return null;
    }
  }

  function weatherIcon(code) {
    if (code <= 1) return '\u2600\uFE0F';
    if (code <= 3) return '\u26C5';
    if (code >= 61 && code <= 67) return '\uD83C\uDF27\uFE0F';
    if (code >= 71 && code <= 77) return '\u2744\uFE0F';
    if (code >= 80 && code <= 82) return '\uD83C\uDF27\uFE0F';
    if (code >= 85) return '\u2744\uFE0F';
    return '\u26C5';
  }

  function currentSeason(tempF) {
    if (tempF < 20) return 'winter';
    if (tempF < 45) return 'winter';
    if (tempF < 65) return 'spring';
    return 'summer';
  }

  // --- CONTEXT & OCCASION ---
  const CONTEXT_MAP = {
    rugged:        { formalities: ['rugged'], tags: ['work', 'outdoor', 'rugged', 'hiking'] },
    casual:        { formalities: ['casual'], tags: ['casual', 'everyday', 'town', 'travel', 'relaxed', 'summer'] },
    'smart-casual': { formalities: ['smart-casual'], tags: ['dress', 'travel', 'town', 'versatile'] }
  };

  const OCCASION_MAP = {
    'date-night':    { context: 'smart-casual', colorPreference: null },
    'wedding':       { context: 'smart-casual', colorPreference: null },
    'funeral':       { context: 'smart-casual', colorPreference: ['black', 'charcoal', 'navy', 'dark brown'] },
    'interview':     { context: 'smart-casual', colorPreference: null },
    'outdoor-event': { context: null, colorPreference: null }
  };

  function itemMatchesContext(item, context) {
    const map = CONTEXT_MAP[context];
    if (!map) return true;
    if (map.formalities.includes(item.formality)) return true;
    return item.tags.some(t => map.tags.includes(t));
  }

  function updateContextChip(context) {
    document.querySelectorAll('#context-filters .chip').forEach(c => c.classList.remove('active'));
    const chip = document.querySelector(`#context-filters .chip[data-context="${context}"]`);
    if (chip) chip.classList.add('active');
  }

  function renderWeather(data) {
    const bar = document.getElementById('weather-bar');
    if (!data || !data.current) {
      bar.style.display = 'none';
      return;
    }
    const c = data.current;
    const d = data.daily;
    document.getElementById('weather-icon').textContent = weatherIcon(c.weather_code);
    document.getElementById('weather-temp').textContent = Math.round(c.temperature_2m) + '\u00B0F';
    document.getElementById('weather-range').textContent = Math.round(d.temperature_2m_min[0]) + '\u00B0/' + Math.round(d.temperature_2m_max[0]) + '\u00B0';
    document.getElementById('weather-feels').textContent = 'feels ' + Math.round(c.apparent_temperature) + '\u00B0';
  }

  // --- RENDERING ---
  function getAbbr(name) {
    const words = name.split(/[\s-]+/);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return name.substring(0, 2).toUpperCase();
  }

  function createSquircle(item, size) {
    const el = document.createElement('div');
    el.className = 'item-squircle';
    const color = WARDROBE.colorHex[item.colors[0]] || '#555';
    el.style.backgroundColor = color;
    if (size) { el.style.width = size + 'px'; el.style.height = size + 'px'; }
    if (item.image) {
      el.innerHTML = `<img src="${item.image}" alt="${item.name}">`;
    } else {
      el.innerHTML = `<span class="abbr">${getAbbr(item.name)}</span>`;
    }
    return el;
  }

  function createItemCard(item, onClick) {
    const card = document.createElement('div');
    card.className = 'item-card';
    if (isDirty(item)) card.classList.add('dirty');

    card.appendChild(createSquircle(item));

    const name = document.createElement('div');
    name.className = 'item-name';
    name.textContent = item.name;
    card.appendChild(name);

    const status = getEffectiveStatus(item);
    if (status !== 'owned') {
      const badge = document.createElement('span');
      badge.className = `badge badge-${status}`;
      badge.textContent = status === 'to-buy' ? 'to buy' : status;
      card.appendChild(badge);
    }
    if (item.priority) {
      const pb = document.createElement('span');
      pb.className = `badge badge-${item.priority}`;
      pb.textContent = item.priority;
      card.appendChild(pb);
    }

    card.addEventListener('click', () => onClick(item));
    return card;
  }

  // --- INVENTORY ---
  function renderInventory() {
    const grid = document.getElementById('item-grid');
    grid.innerHTML = '';
    const items = WARDROBE.items.filter(item => {
      if (categoryFilter !== 'all' && item.category !== categoryFilter) return false;
      if (statusFilter !== 'all' && getEffectiveStatus(item) !== statusFilter) return false;
      return true;
    });
    items.forEach(item => {
      grid.appendChild(createItemCard(item, showDetail));
    });
    if (items.length === 0) {
      grid.innerHTML = '<div class="empty-state">No items</div>';
    }
  }

  // --- DETAIL SHEET ---
  function showDetail(item) {
    const sheet = document.getElementById('detail-sheet');
    document.getElementById('detail-name').textContent = item.name;

    const body = document.getElementById('detail-body');
    body.innerHTML = '';

    const status = getEffectiveStatus(item);
    const rows = [
      ['Role', item.role],
      ['Category', item.category + (item.subcategory ? ' / ' + item.subcategory : '')],
      ['Seasons', item.seasons.join(', ')],
      ['Formality', item.formality],
      ['Situations', item.situations.join(', ')]
    ];

    // Color swatch
    const colorHtml = item.colors.map(c => {
      const hex = WARDROBE.colorHex[c] || '#555';
      return `<span class="detail-color-swatch" style="background:${hex}"></span>${c}`;
    }).join(', ');
    rows.splice(1, 0, ['Color', colorHtml]);

    rows.forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'detail-row';
      row.innerHTML = `<span class="detail-label">${label}</span><span class="detail-value">${value}</span>`;
      body.appendChild(row);
    });

    // Status toggle buttons
    const statusRow = document.createElement('div');
    statusRow.className = 'detail-status-toggle';
    ['owned', 'to-buy', 'wishlist'].forEach(s => {
      const btn = document.createElement('button');
      btn.className = 'status-btn' + (s === status ? ' active' : '');
      btn.textContent = s === 'to-buy' ? 'To Buy' : s.charAt(0).toUpperCase() + s.slice(1);
      btn.addEventListener('click', () => {
        setStatusOverride(item.id, s);
        showDetail(item);
        if (currentView === 'inventory') renderInventory();
        if (currentView === 'laundry') renderLaundry();
      });
      statusRow.appendChild(btn);
    });
    body.appendChild(statusRow);

    // Wear tracking
    if (item.washAfterWears) {
      const s = getItemState(item.id);
      const pct = Math.min(100, (s.wearsSinceWash / item.washAfterWears) * 100);
      const color = pct >= 100 ? 'var(--danger)' : pct >= 70 ? 'var(--warn)' : 'var(--success)';
      const row = document.createElement('div');
      row.className = 'detail-row';
      row.innerHTML = `
        <span class="detail-label">Wear</span>
        <span class="detail-value">
          <div class="detail-wear-bar">
            <span>${s.wearsSinceWash}/${item.washAfterWears}</span>
            <div class="wear-track"><div class="wear-fill" style="width:${pct}%;background:${color}"></div></div>
          </div>
        </span>`;
      body.appendChild(row);

      if (s.lastWorn) {
        const lr = document.createElement('div');
        lr.className = 'detail-row';
        lr.innerHTML = `<span class="detail-label">Last worn</span><span class="detail-value">${s.lastWorn}</span>`;
        body.appendChild(lr);
      }
    }

    // Pairs with
    if (item.pairsWithIds.length > 0) {
      const row = document.createElement('div');
      row.className = 'detail-row';
      const pairs = item.pairsWithIds.map(id => {
        const p = WARDROBE.items.find(i => i.id === id);
        return p ? p.name : id;
      });
      row.innerHTML = `<span class="detail-label">Pairs with</span><span class="detail-value"><div class="detail-tags">${pairs.map(p => `<span class="detail-tag">${p}</span>`).join('')}</div></span>`;
      body.appendChild(row);
    }

    sheet.hidden = false;
  }

  // --- OUTFIT BUILDER ---
  function renderOutfitSlots() {
    Object.keys(outfitSlots).forEach(slot => {
      const el = document.querySelector(`.slot-item[data-slot="${slot}"]`);
      const item = outfitSlots[slot];
      if (item) {
        const filled = document.createElement('div');
        filled.className = 'slot-filled';
        filled.appendChild(createSquircle(item, 44));
        const info = document.createElement('div');
        info.innerHTML = `<div class="slot-item-name">${item.name}</div><div class="slot-item-color">${item.colors.join(', ')}</div>`;
        filled.appendChild(info);
        const clear = document.createElement('button');
        clear.className = 'slot-clear';
        clear.textContent = '\u00D7';
        clear.addEventListener('click', (e) => {
          e.stopPropagation();
          outfitSlots[slot] = null;
          renderOutfitSlots();
          validateOutfit();
        });
        filled.appendChild(clear);
        el.innerHTML = '';
        el.appendChild(filled);
      } else {
        el.innerHTML = '<span class="slot-placeholder">+ tap to select</span>';
      }
    });

    // Show outerwear slot based on weather
    const outerwearSlot = document.getElementById('outerwear-slot');
    if (weatherData && weatherData.current) {
      const temp = weatherData.current.temperature_2m;
      outerwearSlot.style.display = temp < 55 ? '' : 'none';
    }

    updateWearButton();
  }

  function openDrawer(slot) {
    activeDrawerSlot = slot;
    const drawer = document.getElementById('item-drawer');
    const title = document.getElementById('drawer-title');
    const grid = document.getElementById('drawer-items');

    const labels = { footwear: 'Footwear', pants: 'Bottoms', shirts: 'Top', outerwear: 'Outerwear' };
    title.textContent = 'Select ' + (labels[slot] || slot);

    // Filter items for this slot
    let items = WARDROBE.items.filter(i => i.category === slot);

    // Filter by weather season
    if (weatherData && weatherData.current) {
      const season = currentSeason(weatherData.current.temperature_2m);
      items = items.filter(i => i.seasons.includes(season) || (i.seasons.includes('spring') && season === 'fall'));
    }

    // Filter by context
    if (contextFilter !== 'any') {
      items = items.filter(i => itemMatchesContext(i, contextFilter));
    }

    // Apply occasion color preference (sort preferred first)
    if (activeOccasion && OCCASION_MAP[activeOccasion]?.colorPreference) {
      const preferred = OCCASION_MAP[activeOccasion].colorPreference;
      items.sort((a, b) => {
        const aMatch = a.colors.some(c => preferred.includes(c)) ? 0 : 1;
        const bMatch = b.colors.some(c => preferred.includes(c)) ? 0 : 1;
        return aMatch - bMatch;
      });
    }

    // Sort: compatible with already-selected items first, then by freshness
    const state = loadState();
    const selectedIds = Object.values(outfitSlots).filter(Boolean).map(i => i.id);
    items.sort((a, b) => {
      // Dirty items last
      const aDirty = isDirty(a) ? 1 : 0;
      const bDirty = isDirty(b) ? 1 : 0;
      if (aDirty !== bDirty) return aDirty - bDirty;

      // Explicit pairs with selected items first
      const aScore = selectedIds.reduce((s, id) => s + (a.pairsWithIds.includes(id) ? 1 : 0), 0);
      const bScore = selectedIds.reduce((s, id) => s + (b.pairsWithIds.includes(id) ? 1 : 0), 0);
      if (aScore !== bScore) return bScore - aScore;

      // Freshness: least recently worn first
      const aWorn = state.items[a.id]?.lastWorn || '0';
      const bWorn = state.items[b.id]?.lastWorn || '0';
      return aWorn.localeCompare(bWorn);
    });

    // Only show owned items in outfit builder
    items = items.filter(i => getEffectiveStatus(i) === 'owned');

    grid.innerHTML = '';
    items.forEach(item => {
      const card = createItemCard(item, (selected) => {
        if (isDirty(selected)) return;
        outfitSlots[slot] = selected;
        drawer.hidden = true;
        renderOutfitSlots();
        validateOutfit();
      });
      grid.appendChild(card);
    });

    if (items.length === 0) {
      grid.innerHTML = '<div class="empty-state">No items available</div>';
    }

    drawer.hidden = false;
  }

  function validateOutfit() {
    const bar = document.getElementById('validation-bar');
    const selected = Object.values(outfitSlots).filter(Boolean);

    if (selected.length < 2) {
      bar.hidden = true;
      return;
    }

    bar.hidden = false;

    // Color count
    const colors = new Set();
    selected.forEach(item => item.colors.forEach(c => colors.add(c)));
    const colorEl = document.getElementById('color-count');
    colorEl.textContent = colors.size + '/' + WARDROBE.palette.maxColorsPerOutfit + ' colors';

    // Compatibility
    const msgEl = document.getElementById('compatibility-msg');
    let issues = [];

    // Check color overflow
    if (colors.size > WARDROBE.palette.maxColorsPerOutfit) {
      issues.push('too many colors');
    }

    // Check conflicts
    for (let i = 0; i < selected.length; i++) {
      for (let j = i + 1; j < selected.length; j++) {
        if (selected[i].conflicts.includes(selected[j].id) || selected[j].conflicts.includes(selected[i].id)) {
          issues.push(selected[i].name.split(' ')[0] + ' + ' + selected[j].name.split(' ')[0] + ' clash');
        }
      }
    }

    // Check formality mismatch
    const formalities = new Set(selected.map(i => i.formality));
    if (formalities.has('rugged') && (formalities.has('smart-casual') || formalities.has('dressy'))) {
      issues.push('style mismatch');
    }

    if (issues.length > 0) {
      msgEl.textContent = issues.join(' \u2022 ');
      msgEl.className = issues.some(i => i.includes('clash')) ? 'error' : 'warn';
    } else {
      msgEl.textContent = '\u2713 good pairing';
      msgEl.className = 'ok';
    }

    updateWearButton();
  }

  function updateWearButton() {
    const btn = document.getElementById('btn-wear');
    const filled = Object.entries(outfitSlots)
      .filter(([slot]) => slot !== 'outerwear')
      .every(([, item]) => item !== null);
    btn.disabled = !filled;
  }

  function wearOutfit() {
    const selected = Object.values(outfitSlots).filter(Boolean);
    if (selected.length === 0) return;

    const state = loadState();
    const today = new Date().toISOString().split('T')[0];

    selected.forEach(item => {
      if (!state.items[item.id]) {
        state.items[item.id] = { wearsSinceWash: 0, lastWorn: null, totalWears: 0 };
      }
      state.items[item.id].wearsSinceWash++;
      state.items[item.id].lastWorn = today;
      state.items[item.id].totalWears++;
    });

    state.outfitHistory.unshift({
      date: today,
      itemIds: selected.map(i => i.id)
    });

    if (state.outfitHistory.length > 30) state.outfitHistory.length = 30;

    saveState(state);

    outfitSlots = { footwear: null, pants: null, shirts: null, outerwear: null };
    renderOutfitSlots();
    validateOutfit();

    const btn = document.getElementById('btn-wear');
    btn.textContent = '\u2713 Logged';
    setTimeout(() => { btn.textContent = 'Wear This'; }, 1500);
  }

  function suggestOutfit() {
    const temp = weatherData?.current?.temperature_2m;
    const season = temp != null ? currentSeason(temp) : 'spring';
    const state = loadState();

    function scoreItem(item) {
      let score = 0;
      if (getEffectiveStatus(item) !== 'owned') return -1000;
      if (isDirty(item)) return -100;

      // Context match
      if (contextFilter !== 'any' && itemMatchesContext(item, contextFilter)) score += 3;

      // Season match
      if (item.seasons.includes(season)) score += 2;

      // Occasion color preference
      if (activeOccasion && OCCASION_MAP[activeOccasion]?.colorPreference) {
        if (item.colors.some(c => OCCASION_MAP[activeOccasion].colorPreference.includes(c))) {
          score += 5;
        }
      }

      // Freshness
      const s = state.items[item.id];
      if (s && s.lastWorn) {
        const days = (Date.now() - new Date(s.lastWorn).getTime()) / 86400000;
        score += Math.min(days, 7);
      } else {
        score += 5;
      }

      // Wear distribution
      if (s) score += Math.max(0, 10 - s.totalWears) * 0.5;

      // Clean runway
      if (item.washAfterWears) {
        const remaining = item.washAfterWears - (s?.wearsSinceWash || 0);
        score += remaining * 0.3;
      }

      return score;
    }

    // Try preset-based suggestion first
    const matchingPresets = WARDROBE.outfits.filter(o => {
      if (!o.seasons.includes(season)) return false;
      if (temp != null && (temp < o.weatherRange.minTemp || temp > o.weatherRange.maxTemp)) return false;
      if (contextFilter !== 'any') {
        const presetItems = o.itemIds.map(id => WARDROBE.items.find(i => i.id === id)).filter(Boolean);
        if (!presetItems.some(i => itemMatchesContext(i, contextFilter))) return false;
      }
      return true;
    });

    let usedPreset = false;
    if (matchingPresets.length > 0) {
      let bestPreset = null;
      let bestScore = -Infinity;
      matchingPresets.forEach(preset => {
        const items = preset.itemIds.map(id => WARDROBE.items.find(i => i.id === id)).filter(Boolean);
        const total = items.reduce((sum, i) => sum + scoreItem(i), 0);
        if (total > bestScore) { bestScore = total; bestPreset = preset; }
      });

      if (bestPreset && bestScore > 0) {
        bestPreset.itemIds.forEach(id => {
          const item = WARDROBE.items.find(i => i.id === id);
          if (item) outfitSlots[item.category] = item;
        });
        usedPreset = true;
      }
    }

    // Build from scratch if no preset worked
    if (!usedPreset) {
      const candidates = (cat) => WARDROBE.items
        .filter(i => i.category === cat && getEffectiveStatus(i) === 'owned' && !isDirty(i) && i.seasons.includes(season))
        .filter(i => contextFilter === 'any' || itemMatchesContext(i, contextFilter))
        .map(i => ({ item: i, score: scoreItem(i) }))
        .sort((a, b) => b.score - a.score);

      const pickBest = (cat, alreadySelected) => {
        const list = candidates(cat);
        const selectedIds = alreadySelected.map(i => i.id);
        list.sort((a, b) => {
          const aMatch = selectedIds.filter(id => a.item.pairsWithIds.includes(id)).length;
          const bMatch = selectedIds.filter(id => b.item.pairsWithIds.includes(id)).length;
          if (aMatch !== bMatch) return bMatch - aMatch;
          return b.score - a.score;
        });
        const pick = list.find(({ item }) => {
          return !alreadySelected.some(sel => sel.conflicts.includes(item.id) || item.conflicts.includes(sel.id));
        });
        return pick?.item || null;
      };

      const shoes = candidates('footwear')[0]?.item;
      if (shoes) {
        outfitSlots.footwear = shoes;
        const pants = pickBest('pants', [shoes]);
        if (pants) {
          outfitSlots.pants = pants;
          const shirt = pickBest('shirts', [shoes, pants]);
          if (shirt) outfitSlots.shirts = shirt;
        }
        if (temp != null && temp < 55) {
          const outer = pickBest('outerwear', [shoes, outfitSlots.pants, outfitSlots.shirts].filter(Boolean));
          if (outer) outfitSlots.outerwear = outer;
        }
      }
    }

    renderOutfitSlots();
    validateOutfit();
  }

  // --- AI IMPORT ---
  async function importViaAI(input) {
    const apiKey = localStorage.getItem('wardrobe-api-key');
    if (!apiKey) {
      showImportError('Set your Anthropic API key in Settings first.');
      return null;
    }

    const existingItems = WARDROBE.items.map(i => ({
      id: i.id, name: i.name, category: i.category, colors: i.colors, formality: i.formality
    }));

    const prompt = `You are a wardrobe catalog assistant. Given a product URL or description, extract structured data for a capsule wardrobe app.

Existing wardrobe palette: ${JSON.stringify(WARDROBE.palette)}
Existing color hex map keys: ${Object.keys(WARDROBE.colorHex).join(', ')}
Existing items (for pairing suggestions): ${JSON.stringify(existingItems)}

Categories: footwear, pants, shirts, outerwear, accessories
Subcategories: footwear(boots,shoes) pants(outdoor,everyday,dress) shirts(work,oxford,tee,polo,flannel) outerwear(jacket) accessories(belt,socks,gloves,sunglasses,hat,wallet,bag)
Formalities: rugged, casual, smart-casual

Return ONLY a JSON object (no markdown, no explanation) with these exact fields:
{
  "id": "kebab-case-unique-id",
  "name": "Brand Model",
  "category": "...",
  "subcategory": "...",
  "role": "brief description of the item's role",
  "colors": ["color-name"],
  "quantity": 1,
  "status": "to-buy",
  "priority": null,
  "seasons": ["spring","summer","fall","winter"],
  "formality": "casual",
  "tags": ["tag1","tag2"],
  "pairsWithIds": ["existing-item-id"],
  "conflicts": [],
  "situations": ["situation1"],
  "image": null,
  "washAfterWears": null
}

If the color is not in the existing colorHex keys, add: "newColorHex": {"colorname": "#hexval"}

Product: ${input}`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`API ${res.status}: ${err}`);
      }

      const data = await res.json();
      const text = data.content[0].text;
      return JSON.parse(text);
    } catch (e) {
      showImportError('Import failed: ' + e.message);
      return null;
    }
  }

  function showImportError(msg) {
    const el = document.getElementById('import-error');
    el.textContent = msg;
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 5000);
  }

  function showImportReview(item) {
    const body = document.getElementById('import-review-body');
    body.innerHTML = '';
    const fields = ['name', 'category', 'subcategory', 'role', 'colors', 'formality', 'seasons', 'tags', 'situations', 'washAfterWears'];
    fields.forEach(f => {
      const row = document.createElement('div');
      row.className = 'detail-row';
      const val = Array.isArray(item[f]) ? item[f].join(', ') : (item[f] ?? 'none');
      row.innerHTML = `<span class="detail-label">${f}</span><span class="detail-value">${val}</span>`;
      body.appendChild(row);
    });

    document.getElementById('import-confirm').onclick = () => {
      // Ensure unique ID
      if (WARDROBE.items.find(i => i.id === item.id)) {
        item.id = item.id + '-' + Date.now();
      }
      // Ensure all required fields
      item.conflicts = item.conflicts || [];
      item.pairsWithIds = item.pairsWithIds || [];
      item.image = item.image || null;
      item.quantity = item.quantity || 1;
      item.priority = item.priority || null;

      // Add new colors if needed
      if (item.newColorHex) {
        Object.assign(WARDROBE.colorHex, item.newColorHex);
        delete item.newColorHex;
      }

      WARDROBE.items.push(item);
      saveCustomItem(item);

      // Initialize wear state
      const state = loadState();
      state.items[item.id] = { wearsSinceWash: 0, lastWorn: null, totalWears: 0 };
      saveState(state);

      document.getElementById('import-modal').hidden = true;
      document.getElementById('import-input').value = '';
      document.getElementById('import-review').hidden = true;
      renderInventory();
    };

    document.getElementById('import-review').hidden = false;
  }

  // --- OUTFITS VIEW ---
  function renderOutfits() {
    const list = document.getElementById('preset-list');
    list.innerHTML = '';

    WARDROBE.outfits.forEach(outfit => {
      const card = document.createElement('div');
      card.className = 'preset-card';

      const name = document.createElement('div');
      name.className = 'preset-name';
      name.textContent = outfit.name;
      card.appendChild(name);

      const items = document.createElement('div');
      items.className = 'preset-items';
      outfit.itemIds.forEach(id => {
        const item = WARDROBE.items.find(i => i.id === id);
        if (item) items.appendChild(createSquircle(item, 40));
      });
      card.appendChild(items);

      const weather = document.createElement('div');
      weather.className = 'preset-weather';
      weather.textContent = outfit.seasons.join(', ') + ' \u2022 ' + outfit.weatherRange.minTemp + '\u00B0\u2013' + outfit.weatherRange.maxTemp + '\u00B0F';
      card.appendChild(weather);

      const action = document.createElement('div');
      action.className = 'preset-action';
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      btn.style.width = 'auto';
      btn.style.flex = 'none';
      btn.style.fontSize = '0.75rem';
      btn.style.padding = '0.375rem 0.75rem';
      btn.textContent = 'Wear Today';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        outfit.itemIds.forEach(id => {
          const item = WARDROBE.items.find(i => i.id === id);
          if (item) outfitSlots[item.category] = item;
        });
        switchView('today');
        renderOutfitSlots();
        validateOutfit();
      });
      action.appendChild(btn);
      card.appendChild(action);

      list.appendChild(card);
    });

    // History
    const historyEl = document.getElementById('outfit-history');
    historyEl.innerHTML = '';
    const state = loadState();

    if (state.outfitHistory.length === 0) {
      historyEl.innerHTML = '<div class="empty-state">No outfits worn yet</div>';
      return;
    }

    state.outfitHistory.slice(0, 14).forEach(entry => {
      const row = document.createElement('div');
      row.className = 'history-item';

      const date = document.createElement('span');
      date.className = 'history-date';
      date.textContent = entry.date;
      row.appendChild(date);

      const items = document.createElement('div');
      items.className = 'history-items';
      entry.itemIds.forEach(id => {
        const item = WARDROBE.items.find(i => i.id === id);
        if (item) items.appendChild(createSquircle(item, 32));
      });
      row.appendChild(items);

      historyEl.appendChild(row);
    });
  }

  // --- LAUNDRY VIEW ---
  function renderLaundry() {
    const dirtyEl = document.getElementById('laundry-dirty');
    const cleanEl = document.getElementById('laundry-clean');
    dirtyEl.innerHTML = '';
    cleanEl.innerHTML = '';

    const washable = WARDROBE.items.filter(i => i.washAfterWears != null && getEffectiveStatus(i) === 'owned');
    const state = loadState();

    const dirty = [];
    const clean = [];

    washable.forEach(item => {
      const s = state.items[item.id] || { wearsSinceWash: 0 };
      if (s.wearsSinceWash >= item.washAfterWears) {
        dirty.push({ item, state: s });
      } else {
        clean.push({ item, state: s });
      }
    });

    dirty.sort((a, b) => (b.state.wearsSinceWash / b.item.washAfterWears) - (a.state.wearsSinceWash / a.item.washAfterWears));

    const renderList = (arr, container) => {
      if (arr.length === 0) {
        container.innerHTML = '<div class="empty-state">None</div>';
        return;
      }
      arr.forEach(({ item, state: s }) => {
        const row = document.createElement('div');
        row.className = 'laundry-item';

        row.appendChild(createSquircle(item, 36));

        const info = document.createElement('div');
        info.className = 'laundry-info';
        info.innerHTML = `<div class="laundry-name">${item.name} <span style="color:${WARDROBE.colorHex[item.colors[0]] || 'var(--muted)'}">\u25CF</span></div>`;

        const wears = document.createElement('div');
        wears.className = 'laundry-wears' + (s.wearsSinceWash >= item.washAfterWears ? ' over' : '');
        wears.textContent = s.wearsSinceWash + '/' + item.washAfterWears + ' wears';
        info.appendChild(wears);

        row.appendChild(info);

        row.addEventListener('click', () => {
          const st = loadState();
          if (!st.items[item.id]) st.items[item.id] = { wearsSinceWash: 0, lastWorn: null, totalWears: 0 };
          if (st.items[item.id].wearsSinceWash >= item.washAfterWears) {
            st.items[item.id].wearsSinceWash = 0;
          } else {
            st.items[item.id].wearsSinceWash = item.washAfterWears;
          }
          saveState(st);
          renderLaundry();
        });

        container.appendChild(row);
      });
    };

    renderList(dirty, dirtyEl);
    renderList(clean, cleanEl);
  }

  function doLaundry() {
    const state = loadState();
    WARDROBE.items.forEach(item => {
      if (item.washAfterWears && state.items[item.id]) {
        state.items[item.id].wearsSinceWash = 0;
      }
    });
    state.lastLaundry = new Date().toISOString().split('T')[0];
    saveState(state);
    renderLaundry();

    const btn = document.getElementById('btn-laundry');
    btn.textContent = '\u2713 All clean';
    setTimeout(() => { btn.textContent = 'Did Laundry'; }, 1500);
  }

  // --- NAVIGATION ---
  function switchView(view) {
    currentView = view;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + view).classList.add('active');
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.view === view);
    });

    // Show FAB only on inventory
    const fab = document.getElementById('btn-add-item');
    if (fab) fab.style.display = view === 'inventory' ? '' : 'none';

    if (view === 'inventory') renderInventory();
    if (view === 'outfits') renderOutfits();
    if (view === 'laundry') renderLaundry();
    if (view === 'today') {
      renderOutfitSlots();
      validateOutfit();
    }
  }

  // --- INIT ---
  async function init() {
    // Merge custom items before anything else
    mergeCustomItems();

    // Weather
    weatherData = await fetchWeather();
    renderWeather(weatherData);

    // Set day label
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    document.getElementById('day-label').textContent = dayNames[new Date().getDay()];

    // Set context chip based on day of week
    updateContextChip(contextFilter);

    // Tab navigation
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => switchView(tab.dataset.view));
    });

    // Category filters
    document.getElementById('category-filters').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      document.querySelectorAll('#category-filters .chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      categoryFilter = chip.dataset.filter;
      renderInventory();
    });

    // Status filters
    document.getElementById('status-filters').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      document.querySelectorAll('#status-filters .chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      statusFilter = chip.dataset.filter;
      renderInventory();
    });

    // Context filters (outfit builder)
    document.getElementById('context-filters').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      document.querySelectorAll('#context-filters .chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      contextFilter = chip.dataset.context;
      // Reset occasion when manually picking context
      document.getElementById('occasion-select').value = '';
      activeOccasion = null;
    });

    // Occasion select
    document.getElementById('occasion-select').addEventListener('change', (e) => {
      const val = e.target.value;
      activeOccasion = val || null;
      if (val && OCCASION_MAP[val]) {
        const occ = OCCASION_MAP[val];
        let newContext;
        if (val === 'outdoor-event') {
          const temp = weatherData?.current?.temperature_2m;
          newContext = (temp != null && temp < 50) ? 'rugged' : 'casual';
        } else {
          newContext = occ.context;
        }
        contextFilter = newContext;
        updateContextChip(newContext);
      } else {
        contextFilter = getDefaultContext();
        updateContextChip(contextFilter);
      }
    });

    // Outfit slot clicks
    document.querySelectorAll('.slot-item').forEach(slot => {
      slot.addEventListener('click', (e) => {
        if (e.target.closest('.slot-clear')) return;
        openDrawer(slot.dataset.slot);
      });
    });

    // Drawer close
    document.getElementById('drawer-close').addEventListener('click', () => {
      document.getElementById('item-drawer').hidden = true;
    });

    // Detail sheet close
    document.getElementById('detail-close').addEventListener('click', () => {
      document.getElementById('detail-sheet').hidden = true;
    });
    document.querySelectorAll('.sheet-backdrop').forEach(backdrop => {
      backdrop.addEventListener('click', (e) => {
        e.target.closest('.sheet').hidden = true;
      });
    });

    // Outfit actions
    document.getElementById('btn-wear').addEventListener('click', wearOutfit);
    document.getElementById('btn-suggest').addEventListener('click', suggestOutfit);

    // Laundry
    document.getElementById('btn-laundry').addEventListener('click', doLaundry);

    // Settings
    document.getElementById('btn-settings').addEventListener('click', () => {
      document.getElementById('settings-modal').hidden = false;
      document.getElementById('api-key-input').value = localStorage.getItem('wardrobe-api-key') || '';
    });
    document.getElementById('settings-save').addEventListener('click', () => {
      localStorage.setItem('wardrobe-api-key', document.getElementById('api-key-input').value.trim());
      document.getElementById('settings-modal').hidden = true;
    });

    // AI Import
    document.getElementById('btn-add-item').addEventListener('click', () => {
      document.getElementById('import-modal').hidden = false;
      document.getElementById('import-review').hidden = true;
      document.getElementById('import-error').hidden = true;
      document.getElementById('import-input').value = '';
    });
    document.getElementById('import-submit').addEventListener('click', async () => {
      const input = document.getElementById('import-input').value.trim();
      if (!input) return;
      const btn = document.getElementById('import-submit');
      btn.textContent = 'Analyzing...';
      btn.disabled = true;

      const result = await importViaAI(input);
      btn.textContent = 'Import';
      btn.disabled = false;

      if (result) {
        showImportReview(result);
      }
    });

    // Render initial view
    renderInventory();
    renderOutfitSlots();
  }

  // Start
  initAuth();
})();
