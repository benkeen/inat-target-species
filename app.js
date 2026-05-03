'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────

const API_BASE = 'https://api.inaturalist.org/v1';
const PER_PAGE = 200; // max per request (iNat v1 cap)
const BATCH_SIZE = 48; // cards rendered per "Load more" click
const REQ_DELAY = 200; // ms between paginated requests to respect rate limits

// ── State ──────────────────────────────────────────────────────────────────────

let allTargets = []; // full unfiltered result list
let currentFiltered = []; // sorted + filtered view
let displayedCount = 0;
let selectedPlaceId = null;
let placeDebounce = null;

// bbox / map draw state
let bboxMode = false;
let drawnBbox = null; // { nelat, nelng, swlat, swlng }
let selectedPlaceBounds = null; // Leaflet LatLngBounds of the picked place
let map = null;
let drawRect = null;
let drawStart = null;
let isDrawing = false;

// ── DOM references ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const form = $('search-form');
const placeInput = $('place-input');
const placeIdHidden = $('place-id');
const placeSelected = $('place-selected');
const suggestionsEl = $('suggestions');
const usernameEl = $('username');
const taxonEl = $('taxon-filter');
const gradeEl = $('quality-grade');
const monthEl = $('month-filter');
const placeOnlyEl = $('place-only');
const findBtn = $('find-btn');

// ── Persist username ───────────────────────────────────────────────────────────

const LS_USERNAME = 'inat_username';
const savedUsername = localStorage.getItem(LS_USERNAME);
if (savedUsername) usernameEl.value = savedUsername;
usernameEl.addEventListener('change', () => {
  const v = usernameEl.value.trim();
  if (v) localStorage.setItem(LS_USERNAME, v);
  else localStorage.removeItem(LS_USERNAME);
});

const statusSection = $('status-section');
const statusMsg = $('status-msg');
const progressBar = $('progress-bar');

const resultsSection = $('results-section');
const resultsTitleEl = $('results-title');
const resultsSummary = $('results-summary');
const sortEl = $('sort-select');
const filterEl = $('filter-input');
const grid = $('species-grid');
const loadMoreWrap = $('load-more-wrap');
const loadMoreBtn = $('load-more-btn');
const downloadBtn = $('download-btn');

const tabNameBtn = $('tab-name');
const tabMapBtn = $('tab-map');
const panelNameEl = $('panel-name');
const panelMapEl = $('panel-map');
const bboxSelected = $('bbox-selected');
const clearBboxBtn = $('clear-bbox-btn');
const toggleMapBtn = $('toggle-map-btn');
// ── Map toggle ────────────────────────────────────────────────────────────

toggleMapBtn.addEventListener('click', () => {
  const showing = !panelMapEl.hidden;
  panelMapEl.hidden = showing;
  bboxMode = !showing;
  toggleMapBtn.setAttribute('aria-pressed', String(!showing));
  toggleMapBtn.title = showing ? 'Show map' : 'Hide map';
  if (!showing) {
    initMap();
    requestAnimationFrame(() => {
      if (map) {
        map.invalidateSize();
        flyToSelectedPlace();
      }
    });
  } else {
    clearBbox();
  }
});
clearBboxBtn.addEventListener('click', clearBbox);

function switchTab() {} // no-op, kept so nothing breaks

// ── Leaflet map + rectangle drawing ───────────────────────────────────────────

function flyToSelectedPlace() {
  if (!map || !selectedPlaceBounds) return;
  map.fitBounds(selectedPlaceBounds, { padding: [30, 30] });
}

function initMap() {
  if (map) return;
  map = L.map('map-container', { zoomControl: true }).setView([20, 0], 2);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution:
      '\u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18,
  }).addTo(map);

  map.on('mousedown', (e) => {
    if (e.originalEvent.button !== 0) return;
    isDrawing = true;
    drawStart = e.latlng;
    if (drawRect) {
      map.removeLayer(drawRect);
      drawRect = null;
    }
    clearBbox();
    map.dragging.disable();
    map.getContainer().style.cursor = 'crosshair';
    map.on('mousemove', onMapMove);
    map.once('mouseup', onMapUp);
  });
}

function onMapMove(e) {
  if (!isDrawing || !drawStart) return;
  const bounds = L.latLngBounds(drawStart, e.latlng);
  if (drawRect) {
    drawRect.setBounds(bounds);
  } else {
    drawRect = L.rectangle(bounds, {
      color: '#2d5a27',
      weight: 2,
      fillColor: '#4a7c59',
      fillOpacity: 0.15,
    }).addTo(map);
  }
}

function onMapUp(e) {
  isDrawing = false;
  map.dragging.enable();
  map.getContainer().style.cursor = '';
  map.off('mousemove', onMapMove);
  if (!drawStart) return;
  const bounds = L.latLngBounds(drawStart, e.latlng);
  drawStart = null;

  if (Math.abs(bounds.getNorth() - bounds.getSouth()) < 0.01) {
    if (drawRect) {
      map.removeLayer(drawRect);
      drawRect = null;
    }
    return;
  }

  drawnBbox = {
    nelat: bounds.getNorth().toFixed(6),
    nelng: bounds.getEast().toFixed(6),
    swlat: bounds.getSouth().toFixed(6),
    swlng: bounds.getWest().toFixed(6),
  };
  bboxSelected.textContent = `Box: ${parseFloat(drawnBbox.swlat).toFixed(3)}\u00b0, ${parseFloat(drawnBbox.swlng).toFixed(3)}\u00b0 \u2192 ${parseFloat(drawnBbox.nelat).toFixed(3)}\u00b0, ${parseFloat(drawnBbox.nelng).toFixed(3)}\u00b0`;
}

function clearBbox() {
  drawnBbox = null;
  if (map && drawRect) {
    map.removeLayer(drawRect);
    drawRect = null;
  }
  if (bboxSelected)
    bboxSelected.textContent = 'Click and drag on the map to select a region';
}

// ── Place autocomplete ─────────────────────────────────────────────────────────

placeInput.addEventListener('input', () => {
  clearTimeout(placeDebounce);
  clearPlaceSelection();

  const q = placeInput.value.trim();

  // Accept a raw numeric place ID typed directly
  if (/^\d+$/.test(q)) {
    selectedPlaceId = q;
    placeIdHidden.value = q;
    placeSelected.textContent = `Using place ID: ${q}`;
    hideSuggestions();
    return;
  }

  if (q.length < 2) {
    hideSuggestions();
    return;
  }
  placeDebounce = setTimeout(() => doPlaceSearch(q), 300);
});

placeInput.addEventListener('keydown', (e) => {
  const items = [...suggestionsEl.querySelectorAll('.sg-item')];
  const idx = items.findIndex((el) => el.classList.contains('active'));

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = (idx + 1) % items.length;
    items.forEach((el) => el.classList.remove('active'));
    items[next]?.classList.add('active');
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = idx <= 0 ? items.length - 1 : idx - 1;
    items.forEach((el) => el.classList.remove('active'));
    items[prev]?.classList.add('active');
  } else if (e.key === 'Enter') {
    const active = suggestionsEl.querySelector('.sg-item.active');
    if (active) {
      e.preventDefault();
      active.click();
    }
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

// Close suggestions when clicking outside the place field
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#place-wrap')) hideSuggestions();
});

async function doPlaceSearch(q) {
  try {
    const res = await fetch(
      `${API_BASE}/places/autocomplete?q=${encodeURIComponent(q)}&per_page=8`,
    );
    if (!res.ok) return;
    const { results } = await res.json();
    renderSuggestions(results || []);
  } catch {
    hideSuggestions();
  }
}

function renderSuggestions(places) {
  suggestionsEl.innerHTML = '';
  if (!places.length) {
    hideSuggestions();
    return;
  }

  places.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'sg-item';
    el.innerHTML = `
      <span class="sg-name">${esc(p.display_name || p.name)}</span>
      <span class="sg-meta">${
        p.place_type_name ? esc(p.place_type_name) + ' · ' : ''
      }ID ${p.id}</span>
    `;
    el.addEventListener('click', () => pickPlace(p));
    suggestionsEl.appendChild(el);
  });

  suggestionsEl.hidden = false;
}

function pickPlace(p) {
  selectedPlaceId = p.id;
  placeIdHidden.value = p.id;
  placeInput.value = p.display_name || p.name;
  placeSelected.textContent = `Place ID: ${p.id}`;
  hideSuggestions();

  // Derive map bounds from the place object
  selectedPlaceBounds = null;
  if (p.bounding_box_geojson) {
    try {
      selectedPlaceBounds = L.geoJSON(p.bounding_box_geojson).getBounds();
    } catch {
      /* ignore */
    }
  }
  if (!selectedPlaceBounds && p.location) {
    const [lat, lng] = p.location.split(',').map(Number);
    if (!isNaN(lat) && !isNaN(lng)) {
      selectedPlaceBounds = L.latLngBounds([
        [lat - 0.5, lng - 0.5],
        [lat + 0.5, lng + 0.5],
      ]);
    }
  }
  flyToSelectedPlace();
}

function clearPlaceSelection() {
  selectedPlaceId = null;
  placeIdHidden.value = '';
  placeSelected.textContent = '';
  selectedPlaceBounds = null;
}

function hideSuggestions() {
  suggestionsEl.hidden = true;
  suggestionsEl.innerHTML = '';
}

// ── API helpers ────────────────────────────────────────────────────────────────

async function apiFetch(endpoint, params) {
  const url = new URL(`${API_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== '' && v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `API error ${res.status}${body ? ': ' + body.slice(0, 120) : ''}`,
    );
  }
  return res.json();
}

/**
 * Fetch all pages from /observations/species_counts for the given params.
 * Calls onProgress(fetched, total) after each page.
 */
async function fetchAllSpeciesCounts(params, onProgress) {
  const all = [];
  let page = 1;
  let total = Infinity;

  while (all.length < total) {
    const data = await apiFetch('observations/species_counts', {
      ...params,
      page,
      per_page: PER_PAGE,
    });

    if (page === 1) total = data.total_results;
    all.push(...data.results);
    onProgress(all.length, total);

    if (!data.results.length || all.length >= total) break;
    page++;
    await sleep(REQ_DELAY);
  }

  return all;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Form submission ────────────────────────────────────────────────────────────

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  await runSearch();
});

async function runSearch() {
  const username = usernameEl.value.trim();

  // Validate location input based on active mode
  if (bboxMode) {
    if (!drawnBbox) {
      removeErrorCard();
      showErrorCard('Please draw a rectangle on the map to define a region.');
      return;
    }
  } else {
    const placeId = placeIdHidden.value.trim();
    if (!placeId) {
      placeInput.focus();
      placeInput.setCustomValidity('Please select or enter a place.');
      placeInput.reportValidity();
      return;
    }
    placeInput.setCustomValidity('');
  }

  if (!username) {
    usernameEl.focus();
    usernameEl.setCustomValidity('Please enter your iNaturalist username.');
    usernameEl.reportValidity();
    return;
  }
  usernameEl.setCustomValidity('');

  // Reset UI
  removeErrorCard();
  resultsSection.hidden = true;
  findBtn.disabled = true;
  setStatus(true, 'Fetching species observed in region…', 0);

  const shared = {};
  if (taxonEl.value) shared.taxon_id = taxonEl.value;
  if (gradeEl.value) shared.quality_grade = gradeEl.value;
  if (monthEl.value) shared.month = monthEl.value;

  const locationParams = bboxMode
    ? {
        nelat: drawnBbox.nelat,
        nelng: drawnBbox.nelng,
        swlat: drawnBbox.swlat,
        swlng: drawnBbox.swlng,
      }
    : { place_id: placeIdHidden.value };

  try {
    // Step 1 — region species (0–46 %)
    const placeSpecies = await fetchAllSpeciesCounts(
      { ...shared, ...locationParams, verifiable: true },
      (done, total) =>
        setStatus(
          true,
          `Fetching species… ${fmt(done)} of ${fmt(total)}`,
          (done / Math.max(total, 1)) * 46,
        ),
    );

    // Step 2 — user species (46–92 %)
    const userParams = { ...shared, user_id: username, verifiable: true };
    if (placeOnlyEl.checked) Object.assign(userParams, locationParams);

    const userSpecies = await fetchAllSpeciesCounts(userParams, (done, total) =>
      setStatus(
        true,
        `Fetching your observations… ${fmt(done)} of ${fmt(total)}`,
        46 + (done / Math.max(total, 1)) * 46,
      ),
    );

    // Step 3 — compute difference
    setStatus(true, 'Computing target species…', 95);
    await sleep(50);

    const seen = new Set(userSpecies.map((s) => s.taxon.id));
    const targets = placeSpecies
      .filter((s) => !seen.has(s.taxon.id))
      .sort((a, b) => b.count - a.count);

    setStatus(false);
    displayResults(targets);
  } catch (err) {
    setStatus(false);
    showErrorCard(err.message);
  } finally {
    findBtn.disabled = false;
  }
}

// ── Results display ────────────────────────────────────────────────────────────

function displayResults(targets) {
  allTargets = targets;
  applyFilters();
  resultsSection.hidden = false;
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function applyFilters() {
  const sortVal = sortEl.value;
  const query = filterEl.value.toLowerCase().trim();

  let list = allTargets;

  if (query) {
    list = list.filter((s) => {
      const cn = (s.taxon.preferred_common_name || '').toLowerCase();
      const sn = s.taxon.name.toLowerCase();
      return cn.includes(query) || sn.includes(query);
    });
  }

  list = [...list];

  switch (sortVal) {
    case 'count-asc':
      list.sort((a, b) => a.count - b.count);
      break;
    case 'count-desc':
      list.sort((a, b) => b.count - a.count);
      break;
    case 'name-asc':
      list.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      break;
    case 'name-desc':
      list.sort((a, b) => nameOf(b).localeCompare(nameOf(a)));
      break;
  }

  currentFiltered = list;
  displayedCount = 0;
  grid.innerHTML = '';

  const total = allTargets.length;
  const showing = list.length;

  resultsTitleEl.textContent = 'Target Species';
  resultsSummary.textContent = query
    ? `Showing ${fmt(showing)} of ${fmt(total)} target species`
    : `${fmt(total)} species in this place you haven't observed yet`;

  if (!list.length) {
    grid.innerHTML = `<p class="empty-msg">${
      query
        ? 'No species match your filter.'
        : "No target species found — you've seen everything here! 🎉"
    }</p>`;
    loadMoreWrap.hidden = true;
    return;
  }

  renderBatch();
}

function renderBatch() {
  const slice = currentFiltered.slice(
    displayedCount,
    displayedCount + BATCH_SIZE,
  );
  slice.forEach((s) => grid.appendChild(makeCard(s)));
  displayedCount += slice.length;

  const remaining = currentFiltered.length - displayedCount;
  if (remaining > 0) {
    loadMoreWrap.hidden = false;
    loadMoreBtn.textContent = `Load more (${fmt(remaining)} remaining)`;
  } else {
    loadMoreWrap.hidden = true;
  }
}

function makeCard(s) {
  const { taxon, count } = s;
  const cn = taxon.preferred_common_name || taxon.name;
  const sn = taxon.name;
  const photo = taxon.default_photo?.square_url?.replace(
    '/square.',
    '/medium.',
  );
  const iconic = taxon.iconic_taxon_name || '';

  const obsUrl = new URL('https://www.inaturalist.org/observations');
  obsUrl.searchParams.set('taxon_id', taxon.id);
  obsUrl.searchParams.set('verifiable', 'true');
  if (bboxMode && drawnBbox) {
    obsUrl.searchParams.set('nelat', drawnBbox.nelat);
    obsUrl.searchParams.set('nelng', drawnBbox.nelng);
    obsUrl.searchParams.set('swlat', drawnBbox.swlat);
    obsUrl.searchParams.set('swlng', drawnBbox.swlng);
  } else {
    obsUrl.searchParams.set('place_id', placeIdHidden.value);
  }
  if (gradeEl.value) obsUrl.searchParams.set('quality_grade', gradeEl.value);
  if (monthEl.value) obsUrl.searchParams.set('month', monthEl.value);

  const a = document.createElement('a');
  a.className = 'species-card';
  a.href = obsUrl.toString();
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.setAttribute('role', 'listitem');

  // Photo or emoji placeholder
  const photoDiv = document.createElement('div');
  photoDiv.className = 'card-photo';

  if (photo) {
    const img = document.createElement('img');
    img.src = photo;
    img.alt = cn;
    img.loading = 'lazy';
    img.decoding = 'async';
    photoDiv.appendChild(img);
  } else {
    photoDiv.classList.add('card-photo--empty');
    photoDiv.textContent = taxonEmoji(iconic);
  }

  a.appendChild(photoDiv);

  // Info
  const info = document.createElement('div');
  info.className = 'card-info';
  info.innerHTML = `
    <div class="card-common">${esc(cn)}</div>
    <div class="card-sci">${esc(sn)}</div>
    <div class="card-count">${fmt(count)} obs. in place</div>
    ${iconic ? `<div class="card-group">${esc(iconic)}</div>` : ''}
  `;
  a.appendChild(info);

  return a;
}

const nameOf = (s) => s.taxon.preferred_common_name || s.taxon.name;

function taxonEmoji(iconic) {
  return (
    {
      Aves: '🐦',
      Mammalia: '🦊',
      Reptilia: '🦎',
      Amphibia: '🐸',
      Actinopterygii: '🐟',
      Insecta: '🦋',
      Arachnida: '🕷️',
      Mollusca: '🐌',
      Plantae: '🌿',
      Fungi: '🍄',
    }[iconic] || '🔬'
  );
}

// ── Sort / filter events ───────────────────────────────────────────────────────

sortEl.addEventListener('change', applyFilters);
filterEl.addEventListener('input', applyFilters);
loadMoreBtn.addEventListener('click', renderBatch);

// ── CSV download ───────────────────────────────────────────────────────────────

downloadBtn.addEventListener('click', () => {
  if (!allTargets.length) return;

  const rows = [
    [
      'Common Name',
      'Scientific Name',
      'Taxon ID',
      'Obs. in Place',
      'iNaturalist URL',
    ],
  ];

  allTargets.forEach((s) => {
    rows.push([
      s.taxon.preferred_common_name || '',
      s.taxon.name,
      s.taxon.id,
      s.count,
      `https://www.inaturalist.org/taxa/${s.taxon.id}`,
    ]);
  });

  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = 'inat-target-species.csv';
  a.click();
  URL.revokeObjectURL(url);
});

function csvCell(val) {
  const s = String(val);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

function setStatus(visible, msg = '', pct = 0) {
  statusSection.hidden = !visible;
  if (visible) {
    statusMsg.textContent = msg;
    progressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    progressBar.parentElement.setAttribute('aria-valuenow', Math.round(pct));
  }
}

function showErrorCard(msg) {
  const div = document.createElement('div');
  div.className = 'error-card';
  div.id = 'error-card';
  div.textContent = `Error: ${msg}`;
  // Insert after the form section
  document.querySelector('.form-section').after(div);
}

function removeErrorCard() {
  document.getElementById('error-card')?.remove();
}

/** Sanitise a string for insertion into innerHTML */
function esc(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Format a number with locale-appropriate thousands separators */
const fmt = (n) => n.toLocaleString();
