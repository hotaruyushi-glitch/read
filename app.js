/**
 * Strip Reader — Minimalist Long Strip Viewer with GitHub Repository Cloud Storage
 * - Works 100% on GitHub Pages (static, zero-server)
 * - Saves reads directly to your GitHub repository via GitHub REST API
 * - Persistent forever across all devices (phone, laptop, tablet)
 * - Manual Library Reordering (each item at a time with ▲/▼ or drag-and-drop)
 * - Hide/Show Menu Bar (for distraction-free vertical reading)
 * - Phone Responsive Layout + Auto/Manual Fit Width (fit phone screen seamlessly)
 * - Unpacks ZIP, CBZ, and batches of images with natural alphanumeric ordering
 * - Live Edit Order mode for pages within each read
 */

(() => {
  'use strict';

  // --- STATE ---
  const state = {
    ghConfig: {
      repo: localStorage.getItem('sr_gh_repo') || '',
      token: localStorage.getItem('sr_gh_token') || '',
      branch: localStorage.getItem('sr_gh_branch') || 'main',
      path: localStorage.getItem('sr_gh_path') || 'reads'
    },
    ghConnected: false,
    reads: [], // List of loaded reads
    playlists: [], // [{ id, name }]
    activePlaylistId: localStorage.getItem('sr_active_playlist') || 'all',
    sortMode: localStorage.getItem('sr_sort_mode') || 'custom',
    customOrder: [], // Saved custom read ID order
    openPlaylistPopoverReadId: null,
    syncDebounceTimer: null,

    activeReadIndex: -1,
    currentRead: null,
    stripWidth: localStorage.getItem('sr_strip_width') || (window.innerWidth <= 768 ? 'fit-screen' : 'fit-screen'),
    menuHidden: false,

    // Edit Pages Mode
    isEditing: false,
    stagedPages: [],
    hasUnsavedChanges: false,
    dragSrcIndex: null,

    // Library Reorder Drag
    dragLibIndex: null,

    pageObserver: null
  };

  const IMAGE_EXTS = new Set([
    'jpg', 'jpeg', 'jfif', 'jpe', 'jif',
    'png', 'webp', 'gif', 'avif', 'bmp',
    'svg', 'tiff', 'tif', 'jxl'
  ]);

  /**
   * Multi-segment numeric natural sort.
   * Ensures "2.jpg" always comes before "19.jpg" and "20.jpg",
   * and handles multi-segment names like "ch2_p10.png" vs "ch10_p2.png".
   */
  function naturalCompare(a, b) {
    const strA = String(a || '');
    const strB = String(b || '');
    const chunksA = strA.match(/(\d+|\D+)/g) || [];
    const chunksB = strB.match(/(\d+|\D+)/g) || [];
    const len = Math.min(chunksA.length, chunksB.length);

    let leadingZeroTieBreaker = 0;

    for (let i = 0; i < len; i++) {
      const partA = chunksA[i];
      const partB = chunksB[i];
      const isNumA = /^\d+$/.test(partA);
      const isNumB = /^\d+$/.test(partB);

      if (isNumA && isNumB) {
        // Strip leading zeros for numeric comparison without overflow
        const trimA = partA.replace(/^0+/, '') || '0';
        const trimB = partB.replace(/^0+/, '') || '0';
        if (trimA.length !== trimB.length) {
          return trimA.length - trimB.length;
        }
        if (trimA !== trimB) {
          return trimA < trimB ? -1 : 1;
        }
        if (leadingZeroTieBreaker === 0 && partA.length !== partB.length) {
          leadingZeroTieBreaker = partA.length - partB.length;
        }
      } else {
        const lowerA = partA.toLowerCase();
        const lowerB = partB.toLowerCase();
        if (lowerA !== lowerB) {
          return lowerA < lowerB ? -1 : 1;
        }
        if (partA !== partB) {
          return partA < partB ? -1 : 1;
        }
      }
    }

    if (chunksA.length !== chunksB.length) {
      return chunksA.length - chunksB.length;
    }
    return leadingZeroTieBreaker;
  }

  function getMimeType(filename) {
    const ext = (filename || '').split('.').pop().toLowerCase();
    switch (ext) {
      case 'jpg':
      case 'jpeg':
      case 'jfif':
      case 'jpe':
      case 'jif':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'webp':
        return 'image/webp';
      case 'gif':
        return 'image/gif';
      case 'avif':
        return 'image/avif';
      case 'bmp':
        return 'image/bmp';
      case 'svg':
        return 'image/svg+xml';
      case 'tiff':
      case 'tif':
        return 'image/tiff';
      case 'jxl':
        return 'image/jxl';
      default:
        return 'image/jpeg';
    }
  }

  function getErrorMessage(err) {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    if (err.message && typeof err.message === 'string' && err.message !== 'undefined') return err.message;
    if (err.error && typeof err.error === 'string') return err.error;
    if (err.statusText) return `HTTP ${err.status}: ${err.statusText}`;
    if (err.target && err.target.error) return getErrorMessage(err.target.error);
    try {
      const str = JSON.stringify(err);
      if (str && str !== '{}') return str;
    } catch (e) {}
    return String(err) || 'An unexpected error occurred';
  }

  function ghPath(...segments) {
    return segments
      .map(s => String(s || '').replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .map(s => encodeURIComponent(s))
      .join('/');
  }

  // DOM Elements
  const el = {
    topBar: document.getElementById('top-bar'),
    btnGithubStatus: document.getElementById('btn-github-status'),
    githubDot: document.getElementById('github-dot'),
    githubStatusText: document.getElementById('github-status-text'),

    readNav: document.getElementById('read-nav'),
    btnPrevRead: document.getElementById('btn-prev-read'),
    btnNextRead: document.getElementById('btn-next-read'),
    btnOpenShelf: document.getElementById('btn-open-shelf'),
    activeReadTitle: document.getElementById('active-read-title'),
    activeReadCount: document.getElementById('active-read-count'),

    telemetryBox: document.getElementById('telemetry-box'),
    telemPage: document.getElementById('telem-page'),
    telemTotal: document.getElementById('telem-total'),

    btnEditOrder: document.getElementById('btn-edit-order'),
    selectWidth: document.getElementById('select-width'),
    btnOpenSettings: document.getElementById('btn-open-settings'),
    btnUploadMore: document.getElementById('btn-upload-more'),
    btnToggleMenu: document.getElementById('btn-toggle-menu'),
    btnRevealMenu: document.getElementById('btn-reveal-menu'),
    btnMoreMenu: document.getElementById('btn-more-menu'),
    mobileMenuDropdown: document.getElementById('mobile-menu-dropdown'),

    // Mobile Menu Items
    btnMobileEdit: document.getElementById('btn-mobile-edit'),
    btnMobileSlider: document.getElementById('btn-mobile-slider'),
    btnMobileSettings: document.getElementById('btn-mobile-settings'),
    btnMobileUpload: document.getElementById('btn-mobile-upload'),
    btnMobileHideBar: document.getElementById('btn-mobile-hide-bar'),

    // Width Slider Bar
    widthSliderBar: document.getElementById('width-slider-bar'),
    inputCustomWidth: document.getElementById('input-custom-width'),
    customWidthVal: document.getElementById('custom-width-val'),
    btnFitScreenQuick: document.getElementById('btn-fit-screen-quick'),
    btnCloseSlider: document.getElementById('btn-close-slider'),

    masterFileInput: document.getElementById('master-file-input'),

    dropZone: document.getElementById('drop-zone'),
    btnPickFiles: document.getElementById('btn-pick-files'),
    btnSampleRead: document.getElementById('btn-sample-read'),
    btnSetupGithubQuick: document.getElementById('btn-setup-github-quick'),

    loadingOverlay: document.getElementById('loading-overlay'),
    loadingText: document.getElementById('loading-text'),
    progressBar: document.getElementById('progress-bar'),
    loadingSub: document.getElementById('loading-sub'),

    readerView: document.getElementById('reader-view'),
    editBar: document.getElementById('edit-bar'),
    btnSaveOrder: document.getElementById('btn-save-order'),
    btnResetOrder: document.getElementById('btn-reset-order'),
    btnExitEdit: document.getElementById('btn-exit-edit'),
    editCardsContainer: document.getElementById('edit-cards-container'),
    editCardsList: document.getElementById('edit-cards-list'),

    stripOuter: document.getElementById('strip-outer'),
    stripContainer: document.getElementById('strip-container'),
    btnFooterPrev: document.getElementById('btn-footer-prev'),
    btnFooterTop: document.getElementById('btn-footer-top'),
    btnFooterEdit: document.getElementById('btn-footer-edit'),
    btnFooterNext: document.getElementById('btn-footer-next'),
    btnFooterDelete: document.getElementById('btn-footer-delete'),

    modalSettings: document.getElementById('modal-settings'),
    inputGhRepo: document.getElementById('input-gh-repo'),
    inputGhToken: document.getElementById('input-gh-token'),
    inputGhBranch: document.getElementById('input-gh-branch'),
    inputGhPath: document.getElementById('input-gh-path'),
    btnSaveGithub: document.getElementById('btn-save-github'),
    btnDisconnectGithub: document.getElementById('btn-disconnect-github'),

    modalLibrary: document.getElementById('modal-library'),
    libraryGrid: document.getElementById('library-grid'),
    libraryCount: document.getElementById('library-count'),
    btnLibrarySync: document.getElementById('btn-library-sync'),
    libraryPlaylistTabs: document.getElementById('library-playlist-tabs'),
    btnNewPlaylist: document.getElementById('btn-new-playlist'),
    librarySyncStatus: document.getElementById('library-sync-status'),

    // Read Editor & Image Replacement
    modalReadEditor: document.getElementById('modal-read-editor'),
    editorReadTitle: document.getElementById('editor-read-title'),
    editorReadSub: document.getElementById('editor-read-sub'),
    inputEditorZip: document.getElementById('input-editor-zip'),
    inputEditorResumeZip: document.getElementById('input-editor-resume-zip'),
    btnEditorResumeMissing: document.getElementById('btn-editor-resume-missing'),
    btnEditorUploadZip: document.getElementById('btn-editor-upload-zip'),
    editorReplacementTray: document.getElementById('editor-replacement-tray'),
    trayCount: document.getElementById('tray-count'),
    trayImagesList: document.getElementById('tray-images-list'),
    btnTrayAppendAll: document.getElementById('btn-tray-append-all'),
    editorPagesCount: document.getElementById('editor-pages-count'),
    editorPagesGrid: document.getElementById('editor-pages-grid'),
    btnEditorAppendPage: document.getElementById('btn-editor-append-page'),
    editorChangesStatus: document.getElementById('editor-changes-status'),
    btnSaveReadEditor: document.getElementById('btn-save-read-editor'),
    inputSinglePageReplace: document.getElementById('input-single-page-replace'),
    inputSinglePageAppend: document.getElementById('input-single-page-append')
  };

  // --- INITIALIZATION ---
  async function init() {
    setupEventListeners();
    setupDropZone();
    setupScrollMonitoring();

    // Populate settings inputs
    el.inputGhRepo.value = state.ghConfig.repo;
    el.inputGhToken.value = state.ghConfig.token;
    el.inputGhBranch.value = state.ghConfig.branch;
    el.inputGhPath.value = state.ghConfig.path;

    // Apply saved or responsive width
    applyWidth(state.stripWidth);

    // Check if GitHub is already configured
    if (state.ghConfig.repo && state.ghConfig.token) {
      // Stale-while-revalidate: render from localStorage cache instantly
      const hasCache = loadLibraryFromCache();
      if (hasCache) {
        state.ghConnected = true;
        updateGitHubStatusUI(true);
        renderPlaylistTabs();
        updateSortPresetUI();
        updateLibraryUI();
        const visible = getVisibleReads();
        if (visible.length > 0) {
          const firstIdx = state.reads.indexOf(visible[0]);
          loadRead(firstIdx >= 0 ? firstIdx : 0);
        } else if (state.reads.length > 0) {
          loadRead(0);
        }
        // Silently revalidate in the background
        syncReadsFromGitHub({ silent: true });
      } else {
        await connectGitHub();
      }
    } else {
      updateGitHubStatusUI(false);
    }
  }

  // --- WIDTH ENGINE (AUTO FIT PHONE OR MANUAL ADJUSTMENT) ---
  function applyWidth(val) {
    state.stripWidth = val;
    localStorage.setItem('sr_strip_width', val);

    if (val === 'fit-screen') {
      el.stripOuter.className = 'strip-outer width-fit-screen';
      el.stripOuter.style.maxWidth = '100%';
      el.selectWidth.value = 'fit-screen';
      el.widthSliderBar.classList.add('hidden');
    } else if (val === '100%') {
      el.stripOuter.className = 'strip-outer width-100%';
      el.stripOuter.style.maxWidth = '100%';
      el.selectWidth.value = '100%';
      el.widthSliderBar.classList.add('hidden');
    } else if (val === 'custom' || (!isNaN(Number(val)) && !['420', '600', '760', '960', '1200'].includes(val))) {
      const num = parseInt(val, 10) || 1000;
      el.stripOuter.className = 'strip-outer width-custom';
      el.stripOuter.style.maxWidth = `${num}px`;
      el.selectWidth.value = 'custom';
      el.widthSliderBar.classList.remove('hidden');
      el.inputCustomWidth.value = num;
      el.customWidthVal.textContent = `${num}px`;
    } else {
      el.stripOuter.className = `strip-outer width-${val}`;
      el.stripOuter.style.maxWidth = '';
      el.selectWidth.value = val;
      el.widthSliderBar.classList.add('hidden');
    }
  }

  // --- HIDE / SHOW MENU BAR ---
  function toggleMenuBar(forceState) {
    if (typeof forceState === 'boolean') {
      state.menuHidden = forceState;
    } else {
      state.menuHidden = !state.menuHidden;
    }

    if (state.menuHidden) {
      el.topBar.classList.add('bar-hidden');
      el.btnRevealMenu.classList.remove('hidden');
      el.widthSliderBar.classList.add('hidden');
      closeMobileDropdown();
    } else {
      el.topBar.classList.remove('bar-hidden');
      el.btnRevealMenu.classList.add('hidden');
    }
  }

  function toggleMobileDropdown() {
    el.mobileMenuDropdown.classList.toggle('hidden');
  }

  function closeMobileDropdown() {
    el.mobileMenuDropdown.classList.add('hidden');
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // --- GITHUB REPOSITORY CLOUD STORAGE API ---
  async function ghRequest(endpoint, options = {}, retries = 3) {
    if (!state.ghConfig.token) throw new Error('GitHub Personal Access Token not provided.');
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${state.ghConfig.token.trim()}`,
      ...(options.headers || {})
    };

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(`https://api.github.com${endpoint}`, { ...options, headers });
        if (res.status === 403 || res.status === 429) {
          const errData = await res.json().catch(() => ({}));
          const errMsg = errData.message || (errData.errors && errData.errors[0]?.message) || '';
          const isRateLimit = /rate limit|secondary/i.test(errMsg) || res.status === 429;

          if (isRateLimit && attempt < retries) {
            const waitSec = Math.pow(2, attempt + 1); // 2s, 4s, 8s
            console.warn(`GitHub rate limit hit. Pacing and waiting ${waitSec}s (attempt ${attempt + 1}/${retries})...`);
            if (el.loadingOverlay && !el.loadingOverlay.classList.contains('hidden')) {
              updateLoading(`GitHub rate limit pacing... waiting ${waitSec}s`, null, 'Pacing upload to avoid secondary limits');
            }
            await sleep(waitSec * 1000);
            continue;
          }
          throw new Error(errMsg || `GitHub API rate limit (HTTP ${res.status})`);
        }

        if (res.status >= 500 && res.status < 600 && attempt < retries) {
          const waitMs = Math.pow(2, attempt) * 1000;
          await sleep(waitMs);
          continue;
        }

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          const subMsg = errData.errors && errData.errors[0]?.message;
          const detail = subMsg ? `${errData.message}: ${subMsg}` : errData.message;
          const err = new Error(detail || `GitHub API error: HTTP ${res.status}`);
          err.status = res.status;
          throw err;
        }
        return await res.json();
      } catch (err) {
        lastError = err;
        const msg = getErrorMessage(err);
        if (attempt >= retries || !/rate limit|secondary|fetch|network|50\d/i.test(msg)) {
          throw (err instanceof Error ? err : new Error(msg));
        }
        await sleep(1500 * Math.pow(2, attempt));
      }
    }
    throw (lastError instanceof Error ? lastError : new Error(getErrorMessage(lastError)));
  }

  function buildRawGitHubUrl(repo, branch, cleanPath, readId, filename) {
    return `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${ghPath(cleanPath, readId, filename)}`;
  }

  // --- LOCALSTORAGE CACHE (STALE-WHILE-REVALIDATE) ---
  function getLibraryCacheKey() {
    const repo = (state.ghConfig.repo || '').trim();
    const branch = (state.ghConfig.branch || 'main').trim();
    const cleanPath = (state.ghConfig.path || 'reads').replace(/^\/|\/$/g, '');
    return `sr_lib_cache_v1_${repo}_${branch}_${cleanPath}`;
  }

  function buildLibraryIndexPayload() {
    const repo = (state.ghConfig.repo || '').trim();
    const branch = (state.ghConfig.branch || 'main').trim();
    const cleanPath = (state.ghConfig.path || 'reads').replace(/^\/|\/$/g, '');

    return {
      version: 1,
      updatedAt: Date.now(),
      sortMode: state.sortMode,
      order: state.reads.map(r => r.id),
      playlists: state.playlists.map(pl => ({ id: pl.id, name: pl.name })),
      reads: state.reads.map(r => ({
        id: r.id,
        title: r.title,
        path: r.path || `${cleanPath}/${r.id}`,
        createdAt: r.createdAt || Date.now(),
        updatedAt: r.updatedAt || Date.now(),
        playlists: Array.isArray(r.playlists) ? r.playlists : [],
        isGitHub: !!r.isGitHub,
        hasMissingPages: !!r.hasMissingPages,
        pageCount: r.pages.length,
        pages: r.pages.map((p, idx) => ({
          index: idx + 1,
          filename: p.filename,
          url: (p.url && !p.url.startsWith('blob:'))
            ? p.url
            : (r.isGitHub ? buildRawGitHubUrl(repo, branch, cleanPath, r.id, p.filename) : ''),
          size: p.size || 0,
          sha: p.sha || null
        }))
      }))
    };
  }

  function saveLibraryToCache() {
    if (!state.ghConfig.repo) return;
    try {
      const payload = buildLibraryIndexPayload();
      localStorage.setItem(getLibraryCacheKey(), JSON.stringify(payload));
      localStorage.setItem('sr_library_order', JSON.stringify(payload.order));
    } catch (e) {
      console.warn('Could not save library cache to localStorage:', e);
    }
  }

  function loadLibraryFromCache() {
    if (!state.ghConfig.repo) return false;
    try {
      const raw = localStorage.getItem(getLibraryCacheKey());
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.reads) || data.reads.length === 0) return false;

      const repo = state.ghConfig.repo.trim();
      const branch = state.ghConfig.branch.trim() || 'main';
      const cleanPath = (state.ghConfig.path || 'reads').replace(/^\/|\/$/g, '');

      state.playlists = Array.isArray(data.playlists) ? data.playlists : [];
      if (data.sortMode) state.sortMode = data.sortMode;

      // Ensure activePlaylistId is still valid
      if (state.activePlaylistId !== 'all' && !state.playlists.some(p => p.id === state.activePlaylistId)) {
        state.activePlaylistId = 'all';
      }

      state.reads = data.reads.map(r => ({
        id: r.id,
        title: r.title || r.id.replace(/_/g, ' '),
        path: r.path || `${cleanPath}/${r.id}`,
        createdAt: r.createdAt || 0,
        updatedAt: r.updatedAt || 0,
        playlists: Array.isArray(r.playlists) ? r.playlists : [],
        isGitHub: r.isGitHub !== false,
        hasMissingPages: !!r.hasMissingPages,
        pageCount: (r.pages || []).length,
        pages: (r.pages || []).map((p, idx) => ({
          index: idx + 1,
          filename: p.filename,
          url: p.url || buildRawGitHubUrl(repo, branch, cleanPath, r.id, p.filename),
          size: p.size || 0,
          sha: p.sha || null
        }))
      }));

      applyOrderOrSort(data.order || []);
      return true;
    } catch (e) {
      console.warn('Could not load library cache:', e);
      return false;
    }
  }

  function applyOrderOrSort(savedOrder = []) {
    if (state.sortMode === 'az') {
      state.reads.sort((a, b) => naturalCompare(a.title, b.title));
    } else if (state.sortMode === 'newest') {
      state.reads.sort((a, b) => (b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0));
    } else if (Array.isArray(savedOrder) && savedOrder.length > 0) {
      const orderMap = new Map();
      savedOrder.forEach((id, idx) => orderMap.set(id, idx));
      state.reads.sort((a, b) => {
        const oA = orderMap.has(a.id) ? orderMap.get(a.id) : 999999;
        const oB = orderMap.has(b.id) ? orderMap.get(b.id) : 999999;
        return oA - oB;
      });
    }
  }

  // --- PLAYLISTS & VISIBLE READS ---
  function getVisibleReads() {
    if (!state.activePlaylistId || state.activePlaylistId === 'all') {
      return state.reads;
    }
    return state.reads.filter(r => Array.isArray(r.playlists) && r.playlists.includes(state.activePlaylistId));
  }

  function setActivePlaylist(playlistId) {
    state.activePlaylistId = playlistId || 'all';
    localStorage.setItem('sr_active_playlist', state.activePlaylistId);
    renderPlaylistTabs();
    updateLibraryUI();
    updateNavUI();
  }

  function createPlaylist() {
    const name = prompt('Enter new playlist / category name:');
    if (!name || !name.trim()) return;
    const cleanName = name.trim();
    const id = 'pl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    state.playlists.push({ id, name: cleanName });
    saveLibraryToCache();
    renderPlaylistTabs();
    updateLibraryUI();
    debouncedSyncLibrary();
  }

  function deletePlaylist(playlistId) {
    const pl = state.playlists.find(p => p.id === playlistId);
    if (!pl) return;
    if (!confirm(`Delete playlist "${pl.name}"? Reads inside will remain in your library.`)) return;

    state.playlists = state.playlists.filter(p => p.id !== playlistId);
    state.reads.forEach(r => {
      if (Array.isArray(r.playlists)) {
        r.playlists = r.playlists.filter(id => id !== playlistId);
      }
    });
    if (state.activePlaylistId === playlistId) {
      state.activePlaylistId = 'all';
      localStorage.setItem('sr_active_playlist', 'all');
    }

    saveLibraryToCache();
    renderPlaylistTabs();
    updateLibraryUI();
    updateNavUI();
    debouncedSyncLibrary();
  }

  function toggleReadPlaylist(readId, playlistId) {
    const read = state.reads.find(r => r.id === readId);
    if (!read) return;
    if (!Array.isArray(read.playlists)) read.playlists = [];

    const idx = read.playlists.indexOf(playlistId);
    if (idx >= 0) {
      read.playlists.splice(idx, 1);
    } else {
      read.playlists.push(playlistId);
    }

    saveLibraryToCache();
    renderPlaylistTabs();
    updateLibraryUI();
    updateNavUI();
    debouncedSyncLibrary();
  }

  function renderPlaylistTabs() {
    if (!el.libraryPlaylistTabs) return;
    el.libraryPlaylistTabs.innerHTML = '';

    // "All" tab
    const allBtn = document.createElement('button');
    allBtn.className = `playlist-tab ${state.activePlaylistId === 'all' ? 'active' : ''}`;
    allBtn.innerHTML = `<span>All</span><span class="playlist-tab-count">${state.reads.length}</span>`;
    allBtn.addEventListener('click', () => setActivePlaylist('all'));
    el.libraryPlaylistTabs.appendChild(allBtn);

    // Custom playlist tabs
    state.playlists.forEach(pl => {
      const count = state.reads.filter(r => Array.isArray(r.playlists) && r.playlists.includes(pl.id)).length;
      const tab = document.createElement('button');
      tab.className = `playlist-tab ${state.activePlaylistId === pl.id ? 'active' : ''}`;
      tab.innerHTML = `
        <span>${pl.name}</span>
        <span class="playlist-tab-count">${count}</span>
        <span class="playlist-tab-del" title="Delete playlist">✕</span>
      `;
      tab.addEventListener('click', (e) => {
        if (e.target.closest('.playlist-tab-del')) {
          e.stopPropagation();
          deletePlaylist(pl.id);
          return;
        }
        setActivePlaylist(pl.id);
      });
      el.libraryPlaylistTabs.appendChild(tab);
    });
  }

  function updateSortPresetUI() {
    document.querySelectorAll('.sort-preset-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sort === state.sortMode);
    });
  }

  function applySortPreset(mode) {
    state.sortMode = mode;
    localStorage.setItem('sr_sort_mode', mode);
    updateSortPresetUI();

    const activeRead = state.reads[state.activeReadIndex];
    if (mode === 'az') {
      state.reads.sort((a, b) => naturalCompare(a.title, b.title));
    } else if (mode === 'newest') {
      state.reads.sort((a, b) => (b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0));
    } else if (mode === 'custom' && state.customOrder.length > 0) {
      applyOrderOrSort(state.customOrder);
    }

    if (activeRead) {
      state.activeReadIndex = state.reads.indexOf(activeRead);
    }

    saveLibraryToCache();
    updateLibraryUI();
    updateNavUI();
    debouncedSyncLibrary();
  }

  function setSyncStatusText(text) {
    if (el.librarySyncStatus) {
      el.librarySyncStatus.textContent = text;
    }
  }

  function debouncedSyncLibrary() {
    setSyncStatusText('Saving...');
    if (state.syncDebounceTimer) clearTimeout(state.syncDebounceTimer);
    state.syncDebounceTimer = setTimeout(async () => {
      await saveLibraryOrder();
    }, 1000);
  }

  async function connectGitHub() {
    showLoading(true, 'Connecting to GitHub repository...', 30, state.ghConfig.repo);
    try {
      await ghRequest(`/repos/${state.ghConfig.repo.trim()}`);
      state.ghConnected = true;
      updateGitHubStatusUI(true);

      localStorage.setItem('sr_gh_repo', state.ghConfig.repo.trim());
      localStorage.setItem('sr_gh_token', state.ghConfig.token.trim());
      localStorage.setItem('sr_gh_branch', state.ghConfig.branch.trim() || 'main');
      localStorage.setItem('sr_gh_path', state.ghConfig.path.trim() || 'reads');

      await syncReadsFromGitHub({ silent: false });
      showLoading(false);
    } catch (err) {
      showLoading(false);
      state.ghConnected = false;
      updateGitHubStatusUI(false);
      alert('Could not connect to GitHub repository: ' + getErrorMessage(err));
    }
  }

  function updateGitHubStatusUI(connected) {
    if (connected) {
      el.githubDot.classList.add('connected');
      el.githubStatusText.textContent = state.ghConfig.repo;
    } else {
      el.githubDot.classList.remove('connected');
      el.githubStatusText.textContent = 'Connect GitHub';
    }
  }

  // Sync existing reads from GitHub repository (1-request library_index.json with legacy folder fallback)
  async function syncReadsFromGitHub(options = {}) {
    const silent = !!options.silent;
    if (!state.ghConnected) return;

    const repo = state.ghConfig.repo.trim();
    const branch = state.ghConfig.branch.trim() || 'main';
    const cleanPath = (state.ghConfig.path || 'reads').replace(/^\/|\/$/g, '');
    const previousActiveId = state.currentRead ? state.currentRead.id : null;

    if (silent) setSyncStatusText('Syncing...');

    try {
      // 1. Try single-request master library_index.json first
      let indexData = null;
      try {
        const indexRes = await fetch(
          `https://api.github.com/repos/${repo}/contents/${ghPath(cleanPath, 'library_index.json')}?ref=${encodeURIComponent(branch)}`,
          {
            headers: {
              'Accept': 'application/vnd.github.v3.raw',
              'Authorization': `Bearer ${state.ghConfig.token.trim()}`
            }
          }
        );
        if (indexRes.ok) {
          indexData = await indexRes.json();
        }
      } catch (e) {
        console.warn('Could not fetch library_index.json directly:', e);
      }

      if (indexData && Array.isArray(indexData.reads)) {
        state.playlists = Array.isArray(indexData.playlists) ? indexData.playlists : [];
        if (Array.isArray(indexData.order)) {
          state.customOrder = indexData.order;
        }
        if (state.activePlaylistId !== 'all' && !state.playlists.some(p => p.id === state.activePlaylistId)) {
          state.activePlaylistId = 'all';
        }

        const loadedReads = indexData.reads.map(r => {
          const pages = (r.pages || []).map((p, idx) => ({
            index: idx + 1,
            filename: p.filename,
            url: p.url || buildRawGitHubUrl(repo, branch, cleanPath, r.id, p.filename),
            size: p.size || 0,
            sha: p.sha || null
          }));
          return {
            id: r.id,
            title: r.title || r.id.replace(/_/g, ' '),
            path: r.path || `${cleanPath}/${r.id}`,
            createdAt: r.createdAt || 0,
            updatedAt: r.updatedAt || 0,
            playlists: Array.isArray(r.playlists) ? r.playlists : [],
            pages,
            pageCount: pages.length,
            isGitHub: true,
            hasMissingPages: !!r.hasMissingPages
          };
        });

        state.reads = loadedReads;
        applyOrderOrSort(indexData.order || []);
        saveLibraryToCache();
      } else {
        // Fallback: legacy folder-by-folder scan, then auto-generate library_index.json
        const contents = await ghRequest(`/repos/${repo}/contents/${cleanPath}?ref=${encodeURIComponent(branch)}`).catch(() => []);

        let savedOrder = [];
        let savedPlaylists = [];
        let savedReadPlaylists = {};
        const orderFile = contents.find(f => f.name === 'library_order.json');
        if (orderFile) {
          try {
            const orderRes = await fetch(orderFile.download_url);
            const orderData = await orderRes.json();
            if (Array.isArray(orderData.order)) savedOrder = orderData.order;
            if (Array.isArray(orderData.playlists)) savedPlaylists = orderData.playlists;
            if (orderData.readPlaylists && typeof orderData.readPlaylists === 'object') {
              savedReadPlaylists = orderData.readPlaylists;
            }
          } catch (e) {
            console.warn('Could not read library_order.json:', e);
          }
        }

        if (savedOrder.length === 0) {
          const localOrder = localStorage.getItem('sr_library_order');
          if (localOrder) {
            try { savedOrder = JSON.parse(localOrder); } catch (e) {}
          }
        }

        state.playlists = savedPlaylists;
        state.customOrder = savedOrder;

        const folders = contents.filter(item => item.type === 'dir');
        const loadedReads = [];

        for (const dir of folders) {
          try {
            const files = await ghRequest(`/repos/${repo}/contents/${dir.path}?ref=${encodeURIComponent(branch)}`);

            const manifestFile = files.find(f => f.name === 'manifest.json');
            let manifest = null;
            if (manifestFile) {
              const manifestRes = await fetch(manifestFile.download_url);
              manifest = await manifestRes.json();
            }

            const imageFiles = files.filter(f => {
              const ext = f.name.split('.').pop().toLowerCase();
              return IMAGE_EXTS.has(ext);
            });

            // Sequence images according to manifest or multi-segment natural sort
            if (manifest && manifest.pages && manifest.pages.length > 0) {
              const orderMap = new Map();
              manifest.pages.forEach((p, idx) => orderMap.set(p.filename, idx));
              imageFiles.sort((a, b) => {
                const oA = orderMap.has(a.name) ? orderMap.get(a.name) : 999999;
                const oB = orderMap.has(b.name) ? orderMap.get(b.name) : 999999;
                if (oA !== oB) return oA - oB;
                return naturalCompare(a.name, b.name);
              });
            } else {
              imageFiles.sort((a, b) => naturalCompare(a.name, b.name));
            }

            const pages = imageFiles.map((f, idx) => ({
              index: idx + 1,
              filename: f.name,
              url: buildRawGitHubUrl(repo, branch, cleanPath, dir.name, f.name),
              size: f.size,
              sha: f.sha
            }));

            if (pages.length > 0) {
              loadedReads.push({
                id: dir.name,
                title: manifest?.title || dir.name.replace(/_/g, ' '),
                path: dir.path,
                createdAt: manifest?.createdAt || 0,
                updatedAt: manifest?.updatedAt || 0,
                playlists: Array.isArray(manifest?.playlists)
                  ? manifest.playlists
                  : (Array.isArray(savedReadPlaylists[dir.name]) ? savedReadPlaylists[dir.name] : []),
                pages,
                pageCount: pages.length,
                isGitHub: true
              });
            }
          } catch (e) {
            console.warn(`Could not load folder ${dir.name}:`, e);
          }
        }

        state.reads = loadedReads;
        applyOrderOrSort(savedOrder);
        saveLibraryToCache();

        // Create master library_index.json so future reloads take 1 request
        if (state.reads.length > 0) {
          saveLibraryOrder().catch(e => console.warn('Could not write initial library_index.json:', e));
        }
      }

      renderPlaylistTabs();
      updateSortPresetUI();
      updateLibraryUI();
      if (silent) setSyncStatusText('Synced');

      // Preserve active read if silently revalidating
      if (silent && previousActiveId) {
        const newIdx = state.reads.findIndex(r => r.id === previousActiveId);
        if (newIdx >= 0) {
          state.activeReadIndex = newIdx;
          state.currentRead = state.reads[newIdx];
          updateNavUI();
          return;
        }
      }

      const visible = getVisibleReads();
      if (visible.length > 0) {
        const firstIdx = state.reads.indexOf(visible[0]);
        loadRead(firstIdx >= 0 ? firstIdx : 0);
      } else if (state.reads.length > 0) {
        loadRead(0);
      } else {
        showEmptyState();
      }
    } catch (err) {
      if (silent) setSyncStatusText('Sync error');
      console.warn('Error reading from GitHub:', err);
    }
  }

  // Concurrently upload binary blobs via GitHub Git Data API with exponential backoff retry
  async function uploadBlobsConcurrently(pages, repo, concurrency = 4, onProgress) {
    let completed = 0;
    let failed = 0;
    let idx = 0;
    const failedPages = [];

    const workers = Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
      while (idx < pages.length) {
        const currentIdx = idx++;
        const page = pages[currentIdx];

        if (page.sha) {
          completed++;
          if (onProgress) onProgress(completed, pages.length, page.filename);
          continue;
        }

        if (!page.blob) {
          failed++;
          failedPages.push(page);
          continue;
        }

        let success = false;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            const base64 = await blobToBase64(page.blob);
            const res = await ghRequest(`/repos/${repo}/git/blobs`, {
              method: 'POST',
              body: JSON.stringify({ content: base64, encoding: 'base64' })
            });
            if (res && res.sha) {
              page.sha = res.sha;
              success = true;
              break;
            }
          } catch (err) {
            console.warn(`Retry ${attempt + 1}/4 uploading blob for ${page.filename}:`, err);
            if (attempt < 3) {
              const backoffMs = 800 * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
              await sleep(backoffMs);
            }
          }
        }

        if (success) {
          completed++;
        } else {
          failed++;
          failedPages.push(page);
          console.error(`Failed to upload blob for ${page.filename}`);
        }

        if (onProgress) onProgress(completed, pages.length, page.filename);
      }
    });

    await Promise.all(workers);
    return { completed, failed, failedPages };
  }

  // Get current branch commit sha and tree sha, auto-initializing if empty repo
  async function getBranchHeadAndTree(repo, branch) {
    let commitSha = null;
    let treeSha = null;

    try {
      const branchData = await ghRequest(`/repos/${repo}/branches/${branch}`);
      commitSha = branchData.commit?.sha;
      treeSha = branchData.commit?.commit?.tree?.sha;
    } catch (e) {
      try {
        const refData = await ghRequest(`/repos/${repo}/git/ref/heads/${branch}`);
        commitSha = refData.object?.sha;
        if (commitSha) {
          const commitData = await ghRequest(`/repos/${repo}/git/commits/${commitSha}`);
          treeSha = commitData.tree?.sha;
        }
      } catch (refErr) {}
    }

    if (!commitSha) {
      // Empty repo or new branch: initialize it
      await ghRequest(`/repos/${repo}/contents/README.md`, {
        method: 'PUT',
        body: JSON.stringify({
          message: 'Initialize Strip Reader storage',
          content: btoa('# Strip Reader Library\nStorage for your manga and comic strip reads.\n'),
          branch: branch
        })
      });
      const branchData = await ghRequest(`/repos/${repo}/branches/${branch}`);
      commitSha = branchData.commit?.sha;
      treeSha = branchData.commit?.commit?.tree?.sha;
    }

    return { commitSha, treeSha };
  }

  // Save new or resumed read to GitHub repository using Git Database Trees API (1 commit for all pages)
  async function saveReadToGitHub(read) {
    if (!state.ghConnected) return;

    const cleanPath = (state.ghConfig.path || 'reads').replace(/^\/|\/$/g, '');
    const repo = state.ghConfig.repo.trim();
    const branch = state.ghConfig.branch.trim() || 'main';

    showLoading(true, 'Saving read to your GitHub repository...', 0, 'Preparing fast upload...');

    try {
      // 1. Pass 1: Upload all page blobs without sha in parallel (4 concurrent streams, exponential backoff)
      const pass1 = await uploadBlobsConcurrently(
        read.pages,
        repo,
        4,
        (curr, total, fn) => {
          const pct = Math.round((curr / total) * 75);
          updateLoading(`Uploading pages to GitHub: ${curr} of ${total}...`, pct, fn);
        }
      );

      // 2. Pass 2: Retry any failed pages with lower concurrency and longer backoff
      let remainingFailed = pass1.failedPages || [];
      if (remainingFailed.length > 0) {
        updateLoading(`2nd-pass retry for ${remainingFailed.length} failed page(s)...`, 77, 'Recovering dropped pages...');
        await sleep(2000);
        const pass2 = await uploadBlobsConcurrently(
          remainingFailed,
          repo,
          2,
          (curr, total, fn) => {
            updateLoading(`2nd-pass retry: ${curr} of ${total} recovered...`, 78, fn);
          }
        );
        remainingFailed = pass2.failedPages || [];
      }

      const uploadedPagesCount = read.pages.filter(p => p.sha).length;
      if (uploadedPagesCount === 0) {
        throw new Error('All page uploads failed. Check your connection or token and use Resume Missing Pages.');
      }

      // 3. Fetch latest commit & tree from branch
      updateLoading('Fetching repository branch state...', 82, branch);
      const { commitSha, treeSha } = await getBranchHeadAndTree(repo, branch);

      // 4. Prepare manifest blob
      updateLoading('Creating manifest blob...', 85, 'manifest.json');
      read.createdAt = read.createdAt || Date.now();
      read.updatedAt = Date.now();
      const manifest = {
        title: read.title,
        createdAt: read.createdAt,
        updatedAt: read.updatedAt,
        playlists: Array.isArray(read.playlists) ? read.playlists : [],
        pages: read.pages.map(p => ({ filename: p.filename, order: p.index }))
      };
      const manifestStr = JSON.stringify(manifest, null, 2);
      const manifestBase64 = btoa(unescape(encodeURIComponent(manifestStr)));
      const manifestBlob = await ghRequest(`/repos/${repo}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: manifestBase64, encoding: 'base64' })
      });

      read.isGitHub = true;
      read.hasMissingPages = remainingFailed.length > 0;

      // 5. Prepare library_order.json & library_index.json blobs
      updateLoading('Updating library index...', 88, 'library_index.json');
      const order = state.reads.map(r => r.id);
      if (!order.includes(read.id)) order.push(read.id);

      const readPlaylists = {};
      state.reads.forEach(r => {
        if (Array.isArray(r.playlists) && r.playlists.length > 0) {
          readPlaylists[r.id] = r.playlists;
        }
      });

      const orderStr = JSON.stringify({
        order,
        playlists: state.playlists,
        readPlaylists,
        updatedAt: Date.now()
      }, null, 2);
      const orderBase64 = btoa(unescape(encodeURIComponent(orderStr)));
      const orderBlob = await ghRequest(`/repos/${repo}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: orderBase64, encoding: 'base64' })
      });

      const indexPayload = buildLibraryIndexPayload();
      const indexStr = JSON.stringify(indexPayload, null, 2);
      const indexBase64 = btoa(unescape(encodeURIComponent(indexStr)));
      const indexBlob = await ghRequest(`/repos/${repo}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: indexBase64, encoding: 'base64' })
      });

      // 6. Construct Git tree entries
      const treeItems = [];
      for (const page of read.pages) {
        if (page.sha) {
          treeItems.push({
            path: `${cleanPath}/${read.id}/${page.filename}`,
            mode: '100644',
            type: 'blob',
            sha: page.sha
          });
        }
      }
      treeItems.push({
        path: `${cleanPath}/${read.id}/manifest.json`,
        mode: '100644',
        type: 'blob',
        sha: manifestBlob.sha
      });
      treeItems.push({
        path: `${cleanPath}/library_order.json`,
        mode: '100644',
        type: 'blob',
        sha: orderBlob.sha
      });
      treeItems.push({
        path: `${cleanPath}/library_index.json`,
        mode: '100644',
        type: 'blob',
        sha: indexBlob.sha
      });

      // 7. Create Git Tree (all pages combined into 1 tree)
      updateLoading('Creating Git tree on GitHub...', 92, `${treeItems.length} files`);
      const newTree = await ghRequest(`/repos/${repo}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({
          base_tree: treeSha,
          tree: treeItems
        })
      });

      // 8. Create single Commit
      updateLoading('Creating single Git commit...', 95, '1 commit for all pages');
      const newCommit = await ghRequest(`/repos/${repo}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({
          message: `Add/Update ${read.title} (${uploadedPagesCount}/${read.pages.length} pages)`,
          tree: newTree.sha,
          parents: [commitSha]
        })
      });

      // 9. Update branch ref
      updateLoading('Updating branch reference...', 98, branch);
      await ghRequest(`/repos/${repo}/git/refs/heads/${branch}`, {
        method: 'PATCH',
        body: JSON.stringify({
          sha: newCommit.sha,
          force: false
        })
      });

      saveLibraryToCache();
      updateLibraryUI();
      showLoading(false);

      if (remainingFailed.length > 0) {
        alert(`Read partially saved to GitHub: ${uploadedPagesCount} of ${read.pages.length} pages uploaded (${remainingFailed.length} failed after 2 passes). Click "Resume Missing Pages" in the Library to upload only the remaining pages.`);
      }
    } catch (saveErr) {
      read.hasMissingPages = read.pages.some(p => !p.sha);
      saveLibraryToCache();
      updateLibraryUI();
      showLoading(false);
      throw saveErr;
    }
  }

  // Resume uploading only pages without a GitHub SHA
  async function resumeMissingPages(readIdx) {
    const read = state.reads[readIdx];
    if (!read) return;
    if (!state.ghConnected) {
      alert('Please connect GitHub in Settings first.');
      return;
    }

    const hasInMemoryMissing = read.pages.some(p => !p.sha && p.blob);
    if (hasInMemoryMissing) {
      try {
        await saveReadToGitHub(read);
        alert(`Resume complete for "${read.title}"!`);
      } catch (err) {
        alert('Resume encountered an issue: ' + getErrorMessage(err));
      }
    } else {
      // Open Read Editor and trigger Resume Missing Pages file picker
      closeModal(el.modalLibrary);
      openReadEditor(readIdx);
      if (el.inputEditorResumeZip) {
        el.inputEditorResumeZip.value = '';
        el.inputEditorResumeZip.click();
      }
    }
  }

  // Save library order, playlists, and master library_index.json (to localStorage and GitHub repo via 1 commit)
  async function saveLibraryOrder() {
    saveLibraryToCache();

    if (!state.ghConnected) {
      setSyncStatusText('Saved locally');
      return;
    }

    try {
      setSyncStatusText('Syncing...');
      const cleanPath = (state.ghConfig.path || 'reads').replace(/^\/|\/$/g, '');
      const repo = state.ghConfig.repo.trim();
      const branch = state.ghConfig.branch.trim() || 'main';

      const order = state.reads.map(r => r.id);
      if (state.sortMode === 'custom') {
        state.customOrder = order;
      }

      const readPlaylists = {};
      state.reads.forEach(r => {
        if (Array.isArray(r.playlists) && r.playlists.length > 0) {
          readPlaylists[r.id] = r.playlists;
        }
      });

      const orderStr = JSON.stringify({
        order,
        playlists: state.playlists,
        readPlaylists,
        updatedAt: Date.now()
      }, null, 2);

      const indexStr = JSON.stringify(buildLibraryIndexPayload(), null, 2);

      const { commitSha, treeSha } = await getBranchHeadAndTree(repo, branch);

      const [orderBlob, indexBlob] = await Promise.all([
        ghRequest(`/repos/${repo}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content: btoa(unescape(encodeURIComponent(orderStr))), encoding: 'base64' })
        }),
        ghRequest(`/repos/${repo}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content: btoa(unescape(encodeURIComponent(indexStr))), encoding: 'base64' })
        })
      ]);

      const newTree = await ghRequest(`/repos/${repo}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({
          base_tree: treeSha,
          tree: [
            { path: `${cleanPath}/library_order.json`, mode: '100644', type: 'blob', sha: orderBlob.sha },
            { path: `${cleanPath}/library_index.json`, mode: '100644', type: 'blob', sha: indexBlob.sha }
          ]
        })
      });

      const newCommit = await ghRequest(`/repos/${repo}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({
          message: 'Update library index, order & playlists',
          tree: newTree.sha,
          parents: [commitSha]
        })
      });

      await ghRequest(`/repos/${repo}/git/refs/heads/${branch}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: newCommit.sha, force: false })
      });

      setSyncStatusText('Synced');
    } catch (err) {
      setSyncStatusText('Sync failed');
      console.warn('Could not sync library index/order to GitHub:', err);
    }
  }

  // Move library item from index to targetIdx (supports ▲/▼, Top, Bottom, and direct # jump)
  function moveLibraryItemTo(fromIdx, toIdx) {
    if (fromIdx < 0 || fromIdx >= state.reads.length) return;
    const clampedTarget = Math.max(0, Math.min(state.reads.length - 1, toIdx));
    if (fromIdx === clampedTarget) return;

    const activeRead = state.reads[state.activeReadIndex];
    const [moved] = state.reads.splice(fromIdx, 1);
    state.reads.splice(clampedTarget, 0, moved);

    if (activeRead) {
      state.activeReadIndex = state.reads.findIndex(r => r === activeRead);
    }

    state.sortMode = 'custom';
    state.customOrder = state.reads.map(r => r.id);
    localStorage.setItem('sr_sort_mode', 'custom');
    updateSortPresetUI();

    saveLibraryToCache();
    updateLibraryUI();
    updateNavUI();
    debouncedSyncLibrary();
  }

  // Move library item manually, one position at a time
  function moveLibraryItem(index, delta) {
    moveLibraryItemTo(index, index + delta);
  }

  // Update page order within a read on GitHub
  async function updateManifestOnGitHub(readId, orderedFilenames) {
    if (!state.ghConnected) return;

    showLoading(true, 'Updating page order in GitHub repository...', 50, 'Saving manifest.json');
    try {
      const cleanPath = (state.ghConfig.path || 'reads').replace(/^\/|\/$/g, '');
      const manifestEndpoint = `/repos/${state.ghConfig.repo}/contents/${ghPath(cleanPath, readId, 'manifest.json')}`;

      let currentSha = null;
      try {
        const existing = await ghRequest(`${manifestEndpoint}?ref=${state.ghConfig.branch}`);
        currentSha = existing.sha;
      } catch (e) {}

      const manifest = {
        title: state.currentRead ? state.currentRead.title : readId,
        updatedAt: Date.now(),
        pages: orderedFilenames.map((fn, idx) => ({ filename: fn, order: idx + 1 }))
      };

      const manifestBase64 = btoa(unescape(encodeURIComponent(JSON.stringify(manifest, null, 2))));
      const body = {
        message: `Update page order for ${manifest.title}`,
        content: manifestBase64,
        branch: state.ghConfig.branch
      };
      if (currentSha) body.sha = currentSha;

      await ghRequest(manifestEndpoint, {
        method: 'PUT',
        body: JSON.stringify(body)
      });
    } catch (err) {
      console.warn('Could not update manifest on GitHub:', err);
    } finally {
      showLoading(false);
    }
  }

  // --- FILE HANDLING PIPELINE (ZIP, CBZ, IMAGES) ---
  async function handleFilesSelected(fileList) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);

    const archives = [];
    const images = [];

    for (const file of files) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (['zip', 'cbz'].includes(ext)) {
        archives.push(file);
      } else if (['rar', 'cbr', '7z'].includes(ext)) {
        archives.push(file);
      } else if (IMAGE_EXTS.has(ext)) {
        images.push(file);
      }
    }

    for (const arch of archives) {
      const ext = arch.name.split('.').pop().toLowerCase();
      if (['zip', 'cbz'].includes(ext)) {
        await unpackZipArchive(arch);
      } else {
        alert(`RAR archive "${arch.name}" detected. ZIP and raw images are recommended for static GitHub hosting. Please convert to ZIP or extract images before uploading.`);
      }
    }

    if (images.length > 0) {
      await processLooseImages(images);
    }
  }

  async function unpackZipArchive(file) {
    showLoading(true, `Unpacking ${file.name}...`, 20, 'Reading archive entries');

    try {
      const zip = new JSZip();
      const loadedZip = await zip.loadAsync(file);
      const entries = [];

      loadedZip.forEach((relPath, entry) => {
        const cleanPath = relPath.replace(/\\/g, '/');
        const basename = cleanPath.split('/').pop().trim();
        if (entry.dir || 
            cleanPath.includes('__MACOSX') || 
            basename.startsWith('.') || 
            basename.startsWith('._') ||
            basename.toLowerCase() === 'thumbs.db' ||
            basename.toLowerCase() === 'desktop.ini') {
          return;
        }
        const ext = basename.split('.').pop().toLowerCase();
        if (IMAGE_EXTS.has(ext)) {
          entries.push({ entry, basename });
        }
      });

      if (entries.length === 0) {
        throw new Error('No valid images (JPG, PNG, WEBP, etc.) found in archive.');
      }

      entries.sort((a, b) => naturalCompare(a.basename, b.basename));

      const pages = [];
      for (let i = 0; i < entries.length; i++) {
        const { entry, basename } = entries[i];
        const pct = Math.round(((i + 1) / entries.length) * 70) + 20;
        updateLoading(`Extracting page ${i + 1} of ${entries.length}...`, pct, basename);

        try {
          const mime = getMimeType(basename);
          const buffer = await entry.async('arraybuffer');
          if (buffer && buffer.byteLength > 10) {
            const blob = new Blob([buffer], { type: mime });
            const url = URL.createObjectURL(blob);
            pages.push({
              index: pages.length + 1,
              filename: basename,
              url: url,
              blob: blob,
              size: blob.size,
              mime: mime
            });
          } else {
            console.warn(`Skipping empty or invalid entry: ${basename}`);
          }
        } catch (e) {
          console.warn(`Skipping unreadable entry ${basename}:`, e);
        }

        // Non-blocking yield so browser UI remains responsive on 50-100+ pages
        if (i % 3 === 0) {
          await sleep(5);
        }
      }

      if (pages.length === 0) {
        throw new Error('No valid images could be decoded from this archive.');
      }

      const readId = sanitizeId(file.name.replace(/\.[^/.]+$/, '')) || `read_${Date.now()}`;
      const now = Date.now();
      const newRead = {
        id: readId,
        title: file.name.replace(/\.[^/.]+$/, ''),
        createdAt: now,
        updatedAt: now,
        playlists: state.activePlaylistId && state.activePlaylistId !== 'all' ? [state.activePlaylistId] : [],
        pages: pages,
        pageCount: pages.length,
        isGitHub: false
      };

      state.reads.push(newRead);
      saveLibraryToCache();
      renderPlaylistTabs();
      updateLibraryUI();
      loadRead(state.reads.length - 1);
      showLoading(false);

      if (state.ghConnected) {
        try {
          await saveReadToGitHub(newRead);
        } catch (ghErr) {
          console.error('GitHub save error:', ghErr);
          const msg = getErrorMessage(ghErr);
          alert(`"${newRead.title}" loaded into reader successfully! Cloud sync to GitHub encountered an issue: ${msg}. You can retry or click "Resume Missing Pages" from the library.`);
        }
      }
    } catch (err) {
      showLoading(false);
      const msg = getErrorMessage(err);
      alert(`Could not extract ${file.name}: ` + msg);
    }
  }

  async function processLooseImages(files) {
    showLoading(true, 'Processing image batch...', 30, `${files.length} images`);

    files.sort((a, b) => naturalCompare(a.name, b.name));

    const pages = files.map((file, idx) => {
      const mime = file.type || getMimeType(file.name);
      return {
        index: idx + 1,
        filename: file.name,
        url: URL.createObjectURL(file),
        blob: file,
        size: file.size,
        mime: mime
      };
    });

    const dateStr = new Date().toISOString().slice(0, 10);
    const title = `Image Set ${dateStr}`;
    const readId = `images_${Date.now()}`;
    const now = Date.now();

    const newRead = {
      id: readId,
      title: title,
      createdAt: now,
      updatedAt: now,
      playlists: state.activePlaylistId && state.activePlaylistId !== 'all' ? [state.activePlaylistId] : [],
      pages: pages,
      pageCount: pages.length,
      isGitHub: false
    };

    state.reads.push(newRead);
    saveLibraryToCache();
    renderPlaylistTabs();
    updateLibraryUI();
    loadRead(state.reads.length - 1);
    showLoading(false);

    if (state.ghConnected) {
      try {
        await saveReadToGitHub(newRead);
      } catch (ghErr) {
        console.error('GitHub save error:', ghErr);
        const msg = getErrorMessage(ghErr);
        alert(`"${newRead.title}" loaded into reader successfully! Cloud sync to GitHub encountered an issue: ${msg}. You can retry or click "Resume Missing Pages" from the library.`);
      }
    }
  }

  function sanitizeId(str) {
    return str.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').toLowerCase();
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      if (!blob || !(blob instanceof Blob)) {
        return reject(new Error('Invalid image blob: file is empty or corrupted'));
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (!reader.result || typeof reader.result !== 'string') {
          return reject(new Error('FileReader returned empty result'));
        }
        const parts = reader.result.split(',');
        if (parts.length < 2 || !parts[1]) {
          return reject(new Error('Could not extract base64 data from file'));
        }
        resolve(parts[1]);
      };
      reader.onerror = () => {
        const err = reader.error;
        reject(new Error(err?.message || 'FileReader failed to read image blob'));
      };
      reader.readAsDataURL(blob);
    });
  }

  // --- READING & STRIP RENDERING ---
  function loadRead(index) {
    if (index < 0 || index >= state.reads.length) return;
    state.activeReadIndex = index;
    state.currentRead = state.reads[index];

    if (state.isEditing) exitEditMode();

    renderActiveRead();
    updateNavUI();
  }

  function renderActiveRead() {
    const read = state.currentRead;
    if (!read) return;

    if (state.pageObserver) state.pageObserver.disconnect();

    el.dropZone.classList.add('hidden');
    el.readerView.classList.remove('hidden');
    el.readNav.classList.remove('hidden');
    el.telemetryBox.classList.remove('hidden');
    el.btnEditOrder.classList.remove('hidden');
    el.btnMobileEdit.classList.remove('hidden');

    el.activeReadTitle.textContent = read.title;
    el.activeReadCount.textContent = `${read.pages.length} P`;

    el.stripContainer.innerHTML = '';
    const fragment = document.createDocumentFragment();

    state.pageObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const idx = parseInt(entry.target.dataset.pageIndex, 10);
          updateTelemetry(idx);
        }
      });
    }, { rootMargin: '-20% 0px -60% 0px' });

    read.pages.forEach(page => {
      const pageEl = document.createElement('div');
      pageEl.className = 'strip-page';
      pageEl.dataset.pageIndex = page.index;

      const badge = document.createElement('div');
      badge.className = 'page-badge';
      badge.textContent = `#${page.index}`;

      const img = document.createElement('img');
      img.alt = page.filename || `Page #${page.index}`;
      img.loading = 'lazy';
      if (page.url) {
        img.src = page.url;
      }

      img.onerror = async () => {
        // Authenticated fallback for private GitHub repositories
        if (state.ghConnected && state.ghConfig.token && read.isGitHub) {
          try {
            const cleanPath = (state.ghConfig.path || 'reads').replace(/^\/|\/$/g, '');
            const rawEndpoint = `/repos/${state.ghConfig.repo}/contents/${ghPath(cleanPath, read.id, page.filename)}`;
            const res = await fetch(`https://api.github.com${rawEndpoint}`, {
              headers: {
                'Accept': 'application/vnd.github.v3.raw',
                'Authorization': `Bearer ${state.ghConfig.token.trim()}`
              }
            });
            if (res.ok) {
              const mime = getMimeType(page.filename);
              const ab = await res.arrayBuffer();
              const blob = new Blob([ab], { type: mime });
              const authUrl = URL.createObjectURL(blob);
              page.url = authUrl;
              page.blob = blob;
              img.src = authUrl;
              return;
            }
          } catch (e) {
            console.warn(`Auth fallback load failed for ${page.filename}:`, e);
          }
        }

        // Show fallback notice in the strip
        pageEl.classList.add('image-render-failed');
        if (!pageEl.querySelector('.render-error-notice')) {
          const notice = document.createElement('div');
          notice.className = 'render-error-notice';
          notice.innerHTML = `
            <div class="render-error-content">
              <span class="render-error-icon">⚠️</span>
              <div class="render-error-details">
                <strong>Page #${page.index} could not be rendered</strong>
                <span class="render-error-fn">${page.filename || 'Unknown image'}</span>
              </div>
            </div>
            <div class="render-error-actions">
              <button class="btn btn-small btn-retry-render">Retry</button>
              <button class="btn btn-small btn-replace-render">Replace</button>
            </div>
          `;
          notice.querySelector('.btn-retry-render').addEventListener('click', (e) => {
            e.stopPropagation();
            if (page.blob) {
              img.src = URL.createObjectURL(page.blob);
            } else if (page.url) {
              img.src = page.url + (page.url.includes('?') ? '&' : '?') + 't=' + Date.now();
            }
          });
          notice.querySelector('.btn-replace-render').addEventListener('click', (e) => {
            e.stopPropagation();
            openReadEditor(state.activeReadIndex);
          });
          pageEl.appendChild(notice);
        }
      };

      img.onload = () => {
        pageEl.classList.remove('image-render-failed');
        const notice = pageEl.querySelector('.render-error-notice');
        if (notice) notice.remove();
      };

      pageEl.appendChild(badge);
      pageEl.appendChild(img);
      fragment.appendChild(pageEl);

      state.pageObserver.observe(pageEl);
    });

    el.stripContainer.appendChild(fragment);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function updateTelemetry(pageNum) {
    if (!state.currentRead) return;
    el.telemPage.textContent = String(pageNum).padStart(2, '0');
    el.telemTotal.textContent = String(state.currentRead.pages.length).padStart(2, '0');
  }

  function setupScrollMonitoring() {
    // Keep telemetry sync
  }

  function showEmptyState() {
    el.readerView.classList.add('hidden');
    el.readNav.classList.add('hidden');
    el.telemetryBox.classList.add('hidden');
    el.btnEditOrder.classList.add('hidden');
    el.btnMobileEdit.classList.add('hidden');
    el.dropZone.classList.remove('hidden');
  }

  function updateNavUI() {
    const visible = getVisibleReads();
    const pos = state.currentRead ? visible.indexOf(state.currentRead) : -1;

    const hasPrev = pos > 0;
    const hasNext = pos >= 0 ? pos < visible.length - 1 : visible.length > 0;

    el.btnPrevRead.disabled = !hasPrev;
    el.btnNextRead.disabled = !hasNext;
    el.btnFooterPrev.disabled = !hasPrev;
    el.btnFooterNext.disabled = !hasNext;
  }

  function loadPrevRead() {
    const visible = getVisibleReads();
    if (visible.length === 0) return;
    const pos = state.currentRead ? visible.indexOf(state.currentRead) : -1;
    if (pos > 0) {
      const realIdx = state.reads.indexOf(visible[pos - 1]);
      if (realIdx >= 0) loadRead(realIdx);
    }
  }

  function loadNextRead() {
    const visible = getVisibleReads();
    if (visible.length === 0) return;
    const pos = state.currentRead ? visible.indexOf(state.currentRead) : -1;
    if (pos >= 0 && pos < visible.length - 1) {
      const realIdx = state.reads.indexOf(visible[pos + 1]);
      if (realIdx >= 0) loadRead(realIdx);
    } else if (pos === -1) {
      const realIdx = state.reads.indexOf(visible[0]);
      if (realIdx >= 0) loadRead(realIdx);
    }
  }

  // --- EDIT ORDER MODE (FOR PAGES WITHIN ACTIVE READ) ---
  function toggleEditMode() {
    closeMobileDropdown();
    if (state.isEditing) exitEditMode();
    else enterEditMode();
  }

  function enterEditMode() {
    if (!state.currentRead) return;
    state.isEditing = true;
    state.stagedPages = state.currentRead.pages.map(p => ({ ...p }));
    state.hasUnsavedChanges = false;

    el.btnEditOrder.textContent = '✕ Exit Edit';
    el.btnMobileEdit.textContent = '✕ Exit Edit Mode';
    el.editBar.classList.remove('hidden');
    el.editCardsContainer.classList.remove('hidden');
    el.stripOuter.classList.add('hidden');

    renderEditCards();
  }

  function exitEditMode() {
    state.isEditing = false;
    state.hasUnsavedChanges = false;
    el.btnEditOrder.textContent = 'Edit Order';
    el.btnMobileEdit.textContent = '✏️ Edit Page Order';
    el.editBar.classList.add('hidden');
    el.editCardsContainer.classList.add('hidden');
    el.stripOuter.classList.remove('hidden');

    renderActiveRead();
  }

  function renderEditCards() {
    el.editCardsList.innerHTML = '';

    state.stagedPages.forEach((page, idx) => {
      const card = document.createElement('div');
      card.className = 'edit-card';
      card.dataset.index = idx;
      card.draggable = true;

      card.innerHTML = `
        <div class="edit-card-handle">⠿</div>
        <div class="edit-card-num">#${idx + 1}</div>
        <img class="edit-card-thumb" src="${page.url}" alt="${page.filename}">
        <div class="edit-card-title">${page.filename}</div>
        <div class="edit-card-actions">
          <button class="btn btn-small btn-up" ${idx === 0 ? 'disabled' : ''}>▲</button>
          <button class="btn btn-small btn-down" ${idx === state.stagedPages.length - 1 ? 'disabled' : ''}>▼</button>
          <button class="btn-del-page" title="Delete page">🗑️</button>
        </div>
      `;

      card.querySelector('.btn-up').addEventListener('click', () => movePage(idx, -1));
      card.querySelector('.btn-down').addEventListener('click', () => movePage(idx, 1));
      card.querySelector('.btn-del-page').addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete page "${page.filename}"?`)) {
          state.stagedPages.splice(idx, 1);
          state.hasUnsavedChanges = true;
          renderEditCards();
        }
      });

      card.addEventListener('dragstart', handleDragStart);
      card.addEventListener('dragover', handleDragOver);
      card.addEventListener('drop', handleDrop);
      card.addEventListener('dragend', handleDragEnd);

      el.editCardsList.appendChild(card);
    });

    el.btnSaveOrder.disabled = !state.hasUnsavedChanges;
  }

  function movePage(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= state.stagedPages.length) return;
    const [moved] = state.stagedPages.splice(index, 1);
    state.stagedPages.splice(target, 0, moved);
    state.hasUnsavedChanges = true;
    renderEditCards();
  }

  function handleDragStart(e) {
    state.dragSrcIndex = parseInt(this.dataset.index, 10);
    this.classList.add('dragging');
  }
  function handleDragOver(e) {
    e.preventDefault();
    this.classList.add('drag-over');
  }
  function handleDrop(e) {
    e.stopPropagation();
    const dest = parseInt(this.dataset.index, 10);
    if (state.dragSrcIndex !== null && state.dragSrcIndex !== dest) {
      const [moved] = state.stagedPages.splice(state.dragSrcIndex, 1);
      state.stagedPages.splice(dest, 0, moved);
      state.hasUnsavedChanges = true;
      renderEditCards();
    }
  }
  function handleDragEnd() {
    state.dragSrcIndex = null;
    document.querySelectorAll('.edit-card').forEach(c => {
      c.classList.remove('dragging');
      c.classList.remove('drag-over');
    });
  }

  async function saveOrder() {
    if (!state.currentRead || !state.hasUnsavedChanges) return;

    state.currentRead.pages = state.stagedPages.map((p, idx) => ({ ...p, index: idx + 1 }));
    state.hasUnsavedChanges = false;

    if (state.ghConnected && state.currentRead.isGitHub) {
      await updateManifestOnGitHub(state.currentRead.id, state.currentRead.pages.map(p => p.filename));
    }
    saveLibraryToCache();
    debouncedSyncLibrary();

    exitEditMode();
  }

  // --- LIBRARY MODAL (WITH EFFORTLESS REORDERING, PLAYLISTS & DELETE) ---
  function updateLibraryUI() {
    const visibleReads = getVisibleReads();
    el.libraryCount.textContent = visibleReads.length;
    el.libraryGrid.innerHTML = '';

    if (visibleReads.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'library-empty-msg';
      emptyMsg.textContent = state.activePlaylistId === 'all'
        ? 'No reads in library yet. Drop a ZIP or images to get started.'
        : 'No reads in this playlist yet. Click "Playlists" on any read in "All" to assign it here.';
      el.libraryGrid.appendChild(emptyMsg);
      return;
    }

    visibleReads.forEach((read) => {
      const idx = state.reads.indexOf(read);
      const wrap = document.createElement('div');
      wrap.className = 'library-card-wrap';

      const card = document.createElement('div');
      card.className = `library-card ${idx === state.activeReadIndex ? 'active-read' : ''}`;
      card.dataset.index = idx;
      card.draggable = true;

      const missingInMem = read.pages.filter(p => !p.sha && p.blob).length;
      const showResumeBtn = read.hasMissingPages || missingInMem > 0;

      // Playlist badges on the card
      const assignedPlaylists = (read.playlists || [])
        .map(plId => state.playlists.find(p => p.id === plId))
        .filter(Boolean);

      const playlistTagsHtml = assignedPlaylists.length > 0
        ? `<div class="library-playlist-tags">${assignedPlaylists.map(pl =>
            `<span class="playlist-chip assigned" data-pl-id="${pl.id}" title="Click to remove from ${pl.name}">${pl.name} ✕</span>`
          ).join('')}</div>`
        : '';

      card.innerHTML = `
        <div class="library-drag-handle" title="Drag to reorder">⠿</div>
        <div class="library-order-num" title="Click to jump to position">#${idx + 1}</div>
        <div class="library-reorder-grid">
          <button class="btn-reorder-arrow btn-lib-top" title="Move to Top (#1)" ${idx === 0 ? 'disabled' : ''}>⤒</button>
          <button class="btn-reorder-arrow btn-lib-up" title="Move Up" ${idx === 0 ? 'disabled' : ''}>▲</button>
          <button class="btn-reorder-arrow btn-lib-bottom" title="Move to Bottom" ${idx === state.reads.length - 1 ? 'disabled' : ''}>⤓</button>
          <button class="btn-reorder-arrow btn-lib-down" title="Move Down" ${idx === state.reads.length - 1 ? 'disabled' : ''}>▼</button>
        </div>
        <img class="library-thumb" src="${read.pages[0]?.url || ''}" alt="">
        <div class="library-info">
          <div class="library-title">${read.title}</div>
          <div class="library-sub">${read.pages.length} Pages ${read.isGitHub ? '• Saved on GitHub' : '• Local'}${showResumeBtn ? ' • Incomplete' : ''}</div>
          ${playlistTagsHtml}
        </div>
        <div class="library-actions">
          ${showResumeBtn ? `<button class="library-btn library-btn-resume btn-resume-read" title="Resume uploading only missing pages">↻ Resume</button>` : ''}
          <button class="library-btn btn-playlist-toggle" title="Assign to playlists">+ List</button>
          <button class="library-btn btn-edit-read" title="Edit read & replace images">Edit</button>
          <button class="library-btn btn-rename" title="Rename read">Rename</button>
          <button class="library-btn library-btn-danger btn-delete" title="Delete read">Delete</button>
        </div>
      `;

      // Click position number (#) to type target position directly
      const orderNumEl = card.querySelector('.library-order-num');
      orderNumEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '1';
        input.max = String(state.reads.length);
        input.value = String(idx + 1);
        input.className = 'library-order-input';

        orderNumEl.replaceWith(input);
        input.focus();
        input.select();

        let committed = false;
        const commitJump = () => {
          if (committed) return;
          committed = true;
          const val = parseInt(input.value, 10);
          if (!isNaN(val) && val >= 1 && val <= state.reads.length && val - 1 !== idx) {
            moveLibraryItemTo(idx, val - 1);
          } else {
            updateLibraryUI();
          }
        };

        input.addEventListener('click', (ev) => ev.stopPropagation());
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            commitJump();
          } else if (ev.key === 'Escape') {
            committed = true;
            updateLibraryUI();
          }
        });
        input.addEventListener('blur', commitJump);
      });

      // Top / Bottom / Up / Down manual button moves
      card.querySelector('.btn-lib-top').addEventListener('click', (e) => {
        e.stopPropagation();
        moveLibraryItemTo(idx, 0);
      });
      card.querySelector('.btn-lib-bottom').addEventListener('click', (e) => {
        e.stopPropagation();
        moveLibraryItemTo(idx, state.reads.length - 1);
      });
      card.querySelector('.btn-lib-up').addEventListener('click', (e) => {
        e.stopPropagation();
        moveLibraryItem(idx, -1);
      });
      card.querySelector('.btn-lib-down').addEventListener('click', (e) => {
        e.stopPropagation();
        moveLibraryItem(idx, 1);
      });

      // 1-click remove on playlist chips
      card.querySelectorAll('.playlist-chip[data-pl-id]').forEach(chip => {
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleReadPlaylist(read.id, chip.dataset.plId);
        });
      });

      // Toggle 1-click playlist assignment popover
      card.querySelector('.btn-playlist-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        state.openPlaylistPopoverReadId = state.openPlaylistPopoverReadId === read.id ? null : read.id;
        updateLibraryUI();
      });

      const resumeBtn = card.querySelector('.btn-resume-read');
      if (resumeBtn) {
        resumeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          resumeMissingPages(idx);
        });
      }

      // Card click to load read
      card.addEventListener('click', (e) => {
        if (
          e.target.closest('.library-actions') ||
          e.target.closest('.library-reorder-grid') ||
          e.target.closest('.library-drag-handle') ||
          e.target.closest('.library-order-num') ||
          e.target.closest('.library-order-input') ||
          e.target.closest('.playlist-chip')
        ) return;
        loadRead(idx);
        closeModal(el.modalLibrary);
      });

      card.querySelector('.btn-edit-read').addEventListener('click', (e) => {
        e.stopPropagation();
        closeModal(el.modalLibrary);
        openReadEditor(idx);
      });

      card.querySelector('.btn-rename').addEventListener('click', (e) => {
        e.stopPropagation();
        renameRead(idx);
      });

      card.querySelector('.btn-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteRead(idx);
      });

      // Drag and drop for library cards
      card.addEventListener('dragstart', handleLibDragStart);
      card.addEventListener('dragover', handleLibDragOver);
      card.addEventListener('drop', handleLibDrop);
      card.addEventListener('dragend', handleLibDragEnd);

      wrap.appendChild(card);

      // 1-click playlist popover if open for this read
      if (state.openPlaylistPopoverReadId === read.id) {
        const popover = document.createElement('div');
        popover.className = 'library-playlist-popover';
        popover.innerHTML = `<span class="popover-label">Playlists:</span>`;

        if (state.playlists.length === 0) {
          const noneMsg = document.createElement('span');
          noneMsg.className = 'popover-label';
          noneMsg.textContent = 'None yet.';
          popover.appendChild(noneMsg);
        } else {
          state.playlists.forEach(pl => {
            const isAssigned = Array.isArray(read.playlists) && read.playlists.includes(pl.id);
            const chip = document.createElement('button');
            chip.className = `playlist-chip ${isAssigned ? 'assigned' : ''}`;
            chip.textContent = `${isAssigned ? '✓' : '+'} ${pl.name}`;
            chip.addEventListener('click', (e) => {
              e.stopPropagation();
              toggleReadPlaylist(read.id, pl.id);
            });
            popover.appendChild(chip);
          });
        }

        const newBtn = document.createElement('button');
        newBtn.className = 'playlist-chip';
        newBtn.textContent = '+ New Playlist';
        newBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          createPlaylist();
        });
        popover.appendChild(newBtn);

        wrap.appendChild(popover);
      }

      el.libraryGrid.appendChild(wrap);
    });
  }

  function handleLibDragStart(e) {
    state.dragLibIndex = parseInt(this.dataset.index, 10);
    this.classList.add('dragging');
  }
  function handleLibDragOver(e) {
    e.preventDefault();
    this.classList.add('drag-over');
  }
  function handleLibDrop(e) {
    e.stopPropagation();
    const dest = parseInt(this.dataset.index, 10);
    if (state.dragLibIndex !== null && state.dragLibIndex !== dest) {
      moveLibraryItemTo(state.dragLibIndex, dest);
    }
  }
  function handleLibDragEnd() {
    state.dragLibIndex = null;
    document.querySelectorAll('.library-card').forEach(c => {
      c.classList.remove('dragging');
      c.classList.remove('drag-over');
    });
  }

  async function deleteRead(idx) {
    if (idx < 0 || idx >= state.reads.length) return;
    const read = state.reads[idx];
    if (!read) return;

    const confirmMsg = read.isGitHub
      ? `Permanently delete "${read.title}" and all its pages from your GitHub repository?`
      : `Delete "${read.title}" from your library?`;

    if (!confirm(confirmMsg)) return;

    if (read.isGitHub && state.ghConnected) {
      showLoading(true, `Deleting "${read.title}" from GitHub...`, 20, 'Removing repository files');
      try {
        const cleanPath = (state.ghConfig.path || 'reads').replace(/^\/|\/$/g, '');
        const folderPath = `${cleanPath}/${read.id}`;

        const files = await ghRequest(`/repos/${state.ghConfig.repo}/contents/${folderPath}?ref=${state.ghConfig.branch}`).catch(() => []);

        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const pct = Math.round(((i + 1) / files.length) * 90);
          updateLoading(`Deleting ${f.name}...`, pct, `${i + 1} / ${files.length}`);
          const fileEndpoint = `/repos/${state.ghConfig.repo}/contents/${ghPath(...f.path.split('/'))}`;
          await ghRequest(fileEndpoint, {
            method: 'DELETE',
            body: JSON.stringify({
              message: `Delete ${read.title} - ${f.name}`,
              sha: f.sha,
              branch: state.ghConfig.branch
            })
          });
        }
      } catch (err) {
        showLoading(false);
        alert(`Error deleting from GitHub: ${getErrorMessage(err)}`);
        return;
      }
      showLoading(false);
    } else {
      if (read.pages) {
        read.pages.forEach(p => {
          if (p.url && p.url.startsWith('blob:')) URL.revokeObjectURL(p.url);
        });
      }
    }

    state.reads.splice(idx, 1);

    if (state.activeReadIndex === idx) {
      if (state.reads.length > 0) {
        loadRead(Math.max(0, idx - 1));
      } else {
        state.activeReadIndex = -1;
        state.currentRead = null;
        showEmptyState();
      }
    } else if (state.activeReadIndex > idx) {
      state.activeReadIndex--;
    }

    saveLibraryToCache();
    renderPlaylistTabs();
    updateLibraryUI();
    updateNavUI();
    debouncedSyncLibrary();
  }

  async function renameRead(idx) {
    if (idx < 0 || idx >= state.reads.length) return;
    const read = state.reads[idx];
    if (!read) return;

    const newTitle = prompt('Enter new title for this read:', read.title);
    if (!newTitle || newTitle.trim() === '' || newTitle.trim() === read.title) return;

    read.title = newTitle.trim();
    read.updatedAt = Date.now();

    if (read.isGitHub && state.ghConnected) {
      await updateManifestOnGitHub(read.id, read.pages.map(p => p.filename));
    }

    if (state.activeReadIndex === idx) {
      el.activeReadTitle.textContent = read.title;
    }

    saveLibraryToCache();
    updateLibraryUI();
    debouncedSyncLibrary();
  }

  // --- SAMPLE READ GENERATOR ---
  async function loadSampleRead() {
    showLoading(true, 'Generating sample comic strip...', 30, 'Drawing panels');

    const zip = new JSZip();
    for (let i = 1; i <= 5; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = 1200;
      canvas.height = 1600;
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, 1200, 1600);

      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 4;
      ctx.strokeRect(80, 80, 1040, 680);
      ctx.strokeRect(80, 840, 1040, 680);

      ctx.fillStyle = '#fff';
      ctx.font = 'bold 36px sans-serif';
      ctx.fillText(`SAMPLE STRIP — PAGE ${i}`, 140, 160);

      ctx.fillStyle = '#888';
      ctx.font = '22px sans-serif';
      ctx.fillText(`Seamless zero-gap long strip reading demonstration.`, 140, 220);
      ctx.fillText(`Continuous page flow without borders or visual breaks.`, 140, 260);

      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.88));
      zip.file(`page_0${i}.jpg`, blob);
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    const file = new File([blob], 'Sample_Strip.zip', { type: 'application/zip' });
    await unpackZipArchive(file);
  }

  // --- UTILITY: FORMAT BYTES ---
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // --- READ EDITOR & IMAGE REPLACEMENT ---
  let editorState = {
    readIndex: -1,
    read: null,
    pages: [],
    replacementTray: [],
    targetPageIndex: null
  };

  function openReadEditor(readIndex) {
    if (readIndex < 0 || readIndex >= state.reads.length) return;
    const targetRead = state.reads[readIndex];

    editorState.readIndex = readIndex;
    editorState.read = targetRead;
    editorState.replacementTray = [];
    editorState.targetPageIndex = null;

    // Clone pages
    editorState.pages = targetRead.pages.map((p, idx) => ({
      id: 'p_' + idx + '_' + Math.random().toString(36).substr(2, 6),
      index: idx + 1,
      filename: p.filename,
      url: p.url,
      blob: p.blob || null,
      size: p.size || 0,
      sha: p.sha || null,
      isModified: false,
      originalFilename: p.filename
    }));

    el.editorReadTitle.textContent = `Edit Read: ${targetRead.title}`;
    el.editorReadSub.textContent = `${editorState.pages.length} Pages • Upload local ZIP/images to replace or reorder`;

    renderReplacementTray();
    renderEditorPages();
    updateEditorChangesStatus();

    openModal(el.modalReadEditor);
  }

  function appendTrayItem(trayIdx) {
    const item = editorState.replacementTray[trayIdx];
    if (!item) return;

    editorState.pages.push({
      id: 'p_app_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      index: editorState.pages.length + 1,
      filename: item.filename,
      url: item.url,
      blob: item.blob,
      size: item.size,
      sha: null,
      isModified: true
    });
    renderEditorPages();
    updateEditorChangesStatus();
  }

  function appendAllTrayItems() {
    if (!editorState.replacementTray || editorState.replacementTray.length === 0) return;

    editorState.replacementTray.forEach((item, idx) => {
      editorState.pages.push({
        id: 'p_app_' + Date.now() + '_' + idx + '_' + Math.random().toString(36).substr(2, 4),
        index: editorState.pages.length + 1,
        filename: item.filename,
        url: item.url,
        blob: item.blob,
        size: item.size,
        sha: null,
        isModified: true
      });
    });

    renderEditorPages();
    updateEditorChangesStatus();
  }

  function executeTrayAction(trayIdx, action, selectEl) {
    const item = editorState.replacementTray[trayIdx];
    if (!item) return;

    if (action === 'append') {
      appendTrayItem(trayIdx);
      return;
    }

    if (action === 'replace') {
      const pageCount = editorState.pages.length;
      if (pageCount === 0) {
        alert('There are no pages to replace yet. Use append instead.');
        if (selectEl) selectEl.value = 'append';
        return;
      }

      const input = prompt(`Replace which page with "${item.filename}"?\nEnter page number (1 to ${pageCount}):`, '1');
      if (!input) {
        if (selectEl) selectEl.value = 'append';
        return;
      }

      const pageNum = parseInt(input.trim(), 10);
      if (isNaN(pageNum) || pageNum < 1 || pageNum > pageCount) {
        alert(`Please enter a valid page number between 1 and ${pageCount}.`);
        if (selectEl) selectEl.value = 'append';
        return;
      }

      replacePageWithTrayItem(pageNum - 1, trayIdx);
      if (selectEl) selectEl.value = 'append';
    }
  }

  function renderReplacementTray() {
    el.trayImagesList.innerHTML = '';
    el.trayCount.textContent = editorState.replacementTray.length;

    if (editorState.replacementTray.length === 0) {
      el.editorReplacementTray.classList.add('hidden');
      return;
    }

    el.editorReplacementTray.classList.remove('hidden');

    editorState.replacementTray.forEach((item, trayIdx) => {
      const card = document.createElement('div');
      card.className = 'tray-item';
      card.draggable = true;
      card.dataset.trayIndex = trayIdx;

      card.innerHTML = `
        <img class="tray-thumb" src="${item.url}" alt="${item.filename}">
        <div class="tray-filename" title="${item.filename}">${item.filename}</div>
        <div class="tray-actions">
          <select class="tray-action-select" aria-label="Action for ${item.filename}">
            <option value="append" selected>+ Append (Default)</option>
            <option value="replace">Replace Page #</option>
          </select>
          <button class="tray-btn-apply" title="Execute selected action">Apply</button>
        </div>
      `;

      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', String(trayIdx));
        e.dataTransfer.effectAllowed = 'copy';
      });

      const selectEl = card.querySelector('.tray-action-select');
      const applyBtn = card.querySelector('.tray-btn-apply');

      selectEl.addEventListener('change', () => {
        if (selectEl.value === 'replace') {
          executeTrayAction(trayIdx, 'replace', selectEl);
        }
      });

      applyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        executeTrayAction(trayIdx, selectEl.value, selectEl);
      });

      el.trayImagesList.appendChild(card);
    });
  }

  function replacePageWithTrayItem(pageIdx, trayIdx) {
    const targetPage = editorState.pages[pageIdx];
    const trayItem = editorState.replacementTray[trayIdx];
    if (!targetPage || !trayItem) return;

    targetPage.url = trayItem.url;
    targetPage.blob = trayItem.blob;
    targetPage.size = trayItem.size;
    targetPage.filename = trayItem.filename;
    targetPage.isModified = true;
    targetPage.sha = null;

    renderEditorPages();
    updateEditorChangesStatus();
  }

  function renderEditorPages() {
    el.editorPagesCount.textContent = editorState.pages.length;
    el.editorPagesGrid.innerHTML = '';

    editorState.pages.forEach((page, idx) => {
      page.index = idx + 1;

      const card = document.createElement('div');
      card.className = `editor-page-card ${page.isModified ? 'is-modified' : ''}`;
      card.dataset.pageIndex = idx;

      const sizeStr = page.size ? formatBytes(page.size) : '';

      card.innerHTML = `
        <img class="editor-page-thumb" src="${page.url}" alt="Page ${idx + 1}">
        <div class="editor-page-details">
          <div class="editor-page-top">
            <span class="editor-page-num">Page #${idx + 1}</span>
            ${page.isModified ? '<span class="badge-replaced">Replaced</span>' : ''}
          </div>
          <div class="editor-page-fn" title="${page.filename}">${page.filename}</div>
          ${sizeStr ? `<div class="editor-page-size">${sizeStr}</div>` : ''}
          <div class="editor-page-actions">
            <button class="btn-pg-action btn-pg-replace" title="Replace image for page ${idx + 1}">Replace</button>
            <button class="btn-pg-action btn-pg-up" title="Move page up" ${idx === 0 ? 'disabled' : ''}>▲</button>
            <button class="btn-pg-action btn-pg-down" title="Move page down" ${idx === editorState.pages.length - 1 ? 'disabled' : ''}>▼</button>
            <button class="btn-pg-action btn-pg-del" title="Delete page">✕</button>
          </div>
        </div>
      `;

      card.querySelector('.btn-pg-replace').addEventListener('click', (e) => {
        e.stopPropagation();
        triggerPageReplacement(idx);
      });

      card.querySelector('.btn-pg-up').addEventListener('click', (e) => {
        e.stopPropagation();
        if (idx > 0) {
          const [moved] = editorState.pages.splice(idx, 1);
          editorState.pages.splice(idx - 1, 0, moved);
          renderEditorPages();
          updateEditorChangesStatus();
        }
      });

      card.querySelector('.btn-pg-down').addEventListener('click', (e) => {
        e.stopPropagation();
        if (idx < editorState.pages.length - 1) {
          const [moved] = editorState.pages.splice(idx, 1);
          editorState.pages.splice(idx + 1, 0, moved);
          renderEditorPages();
          updateEditorChangesStatus();
        }
      });

      card.querySelector('.btn-pg-del').addEventListener('click', (e) => {
        e.stopPropagation();
        if (editorState.pages.length <= 1) {
          alert('A read must have at least one page.');
          return;
        }
        if (confirm(`Remove Page #${idx + 1} (${page.filename}) from this read?`)) {
          editorState.pages.splice(idx, 1);
          renderEditorPages();
          updateEditorChangesStatus();
        }
      });

      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        card.classList.add('drag-target');
      });
      card.addEventListener('dragleave', () => {
        card.classList.remove('drag-target');
      });
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('drag-target');
        const trayIdxStr = e.dataTransfer.getData('text/plain');
        if (trayIdxStr !== '') {
          const trayIdx = parseInt(trayIdxStr, 10);
          if (!isNaN(trayIdx)) {
            replacePageWithTrayItem(idx, trayIdx);
          }
        }
      });

      el.editorPagesGrid.appendChild(card);
    });
  }

  function triggerPageReplacement(pageIndex) {
    editorState.targetPageIndex = pageIndex;

    if (editorState.replacementTray.length > 0) {
      const trayNames = editorState.replacementTray.map((item, i) => `${i + 1}: ${item.filename}`).join('\n');
      const choice = prompt(
        `Replace Page #${pageIndex + 1} with an image from your Replacement Tray:\n\n${trayNames}\n\nEnter number (1-${editorState.replacementTray.length}), or click Cancel to browse a local file directly:`,
        '1'
      );
      if (choice) {
        const pickIdx = parseInt(choice.trim(), 10) - 1;
        if (pickIdx >= 0 && pickIdx < editorState.replacementTray.length) {
          replacePageWithTrayItem(pageIndex, pickIdx);
          return;
        }
      }
    }

    el.inputSinglePageReplace.value = '';
    el.inputSinglePageReplace.click();
  }

  function handleEditorReplaceFile(fileList) {
    if (!fileList || fileList.length === 0 || editorState.targetPageIndex === null) return;
    const file = fileList[0];
    const targetPage = editorState.pages[editorState.targetPageIndex];
    if (!targetPage) return;

    targetPage.url = URL.createObjectURL(file);
    targetPage.blob = file;
    targetPage.size = file.size;
    targetPage.filename = file.name;
    targetPage.isModified = true;
    targetPage.sha = null;

    renderEditorPages();
    updateEditorChangesStatus();
  }

  function handleEditorAppendFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).sort((a, b) => naturalCompare(a.name, b.name));
    files.forEach(file => {
      editorState.pages.push({
        id: 'p_app_' + Math.random().toString(36).substr(2, 6),
        index: editorState.pages.length + 1,
        filename: file.name,
        url: URL.createObjectURL(file),
        blob: file,
        size: file.size,
        sha: null,
        isModified: true
      });
    });

    renderEditorPages();
    updateEditorChangesStatus();
  }

  function updateEditorChangesStatus() {
    const modified = editorState.pages.filter(p => p.isModified).length;
    const initialCount = editorState.read?.pages?.length || 0;
    const isCountChanged = editorState.pages.length !== initialCount;

    let msg = [];
    if (modified > 0) msg.push(`${modified} page(s) modified/added`);
    if (isCountChanged) msg.push(`total pages: ${editorState.pages.length} (was ${initialCount})`);

    if (msg.length > 0) {
      el.editorChangesStatus.textContent = msg.join(' • ') + ' (unsaved)';
      el.btnSaveReadEditor.disabled = false;
    } else {
      el.editorChangesStatus.textContent = 'No modifications yet';
      el.btnSaveReadEditor.disabled = false;
    }
  }

  async function handleEditorResumeMissing(fileList) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).sort((a, b) => naturalCompare(a.name, b.name));

    showLoading(true, 'Scanning for missing pages...', 15, 'Comparing against existing pages');
    const candidatePages = [];

    try {
      for (const file of files) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (['zip', 'cbz'].includes(ext)) {
          const zip = new JSZip();
          const loadedZip = await zip.loadAsync(file);
          const entries = [];

          loadedZip.forEach((relPath, entry) => {
            const cleanPath = relPath.replace(/\\/g, '/');
            const basename = cleanPath.split('/').pop().trim();
            if (entry.dir ||
                cleanPath.includes('__MACOSX') ||
                basename.startsWith('.') ||
                basename.startsWith('._') ||
                basename.toLowerCase() === 'thumbs.db' ||
                basename.toLowerCase() === 'desktop.ini') {
              return;
            }
            const entryExt = basename.split('.').pop().toLowerCase();
            if (IMAGE_EXTS.has(entryExt)) {
              entries.push({ entry, basename });
            }
          });

          entries.sort((a, b) => naturalCompare(a.basename, b.basename));

          for (let i = 0; i < entries.length; i++) {
            const { entry, basename } = entries[i];
            const pct = Math.round(((i + 1) / entries.length) * 65) + 15;
            updateLoading(`Checking ${i + 1} of ${entries.length}...`, pct, basename);
            const mime = getMimeType(basename);
            const buffer = await entry.async('arraybuffer');
            if (buffer && buffer.byteLength > 10) {
              const blob = new Blob([buffer], { type: mime });
              candidatePages.push({ filename: basename, blob, size: blob.size });
            }
            if (i % 5 === 0) await sleep(5);
          }
        } else if (IMAGE_EXTS.has(ext)) {
          candidatePages.push({ filename: file.name, blob: file, size: file.size });
        }
      }

      const existingMap = new Map();
      editorState.pages.forEach((p, idx) => existingMap.set(p.filename, { p, idx }));

      let addedCount = 0;
      let filledCount = 0;
      candidatePages.forEach(cand => {
        const existing = existingMap.get(cand.filename);
        if (existing) {
          if (!existing.p.sha) {
            existing.p.blob = cand.blob;
            existing.p.url = URL.createObjectURL(cand.blob);
            existing.p.size = cand.size;
            existing.p.isModified = true;
            filledCount++;
          }
        } else {
          editorState.pages.push({
            id: 'p_res_' + Math.random().toString(36).substr(2, 6),
            index: editorState.pages.length + 1,
            filename: cand.filename,
            url: URL.createObjectURL(cand.blob),
            blob: cand.blob,
            size: cand.size,
            sha: null,
            isModified: true
          });
          addedCount++;
        }
      });

      // Re-sort combined pages naturally so missing pages land in their proper order
      editorState.pages.sort((a, b) => naturalCompare(a.filename, b.filename));

      showLoading(false);
      renderEditorPages();
      updateEditorChangesStatus();

      const totalMissing = addedCount + filledCount;
      if (totalMissing === 0) {
        alert('All pages from the selected files are already present on GitHub!');
      } else {
        alert(`Found ${totalMissing} missing page(s). Click "Save Changes" to upload only the missing pages.`);
      }
    } catch (err) {
      showLoading(false);
      alert('Could not scan files for missing pages: ' + getErrorMessage(err));
    }
  }

  async function handleEditorZipUpload(fileList) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).sort((a, b) => naturalCompare(a.name, b.name));

    showLoading(true, 'Processing replacement archive/images...', 20, 'Reading files');

    try {
      for (const file of files) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (['zip', 'cbz'].includes(ext)) {
          const zip = new JSZip();
          const loadedZip = await zip.loadAsync(file);
          const entries = [];

          loadedZip.forEach((relPath, entry) => {
            const cleanPath = relPath.replace(/\\/g, '/');
            const basename = cleanPath.split('/').pop().trim();
            if (entry.dir || 
                cleanPath.includes('__MACOSX') || 
                basename.startsWith('.') || 
                basename.startsWith('._') ||
                basename.toLowerCase() === 'thumbs.db' ||
                basename.toLowerCase() === 'desktop.ini') {
              return;
            }
            const entryExt = basename.split('.').pop().toLowerCase();
            if (IMAGE_EXTS.has(entryExt)) {
              entries.push({ entry, basename });
            }
          });

          entries.sort((a, b) => naturalCompare(a.basename, b.basename));

          for (let i = 0; i < entries.length; i++) {
            const { entry, basename } = entries[i];
            const pct = Math.round(((i + 1) / entries.length) * 70) + 20;
            updateLoading(`Unpacking replacement ${i + 1} of ${entries.length}...`, pct, basename);

            try {
              const mime = getMimeType(basename);
              const buffer = await entry.async('arraybuffer');
              if (buffer && buffer.byteLength > 10) {
                const blob = new Blob([buffer], { type: mime });
                editorState.replacementTray.push({
                  id: 'tray_' + Math.random().toString(36).substr(2, 6),
                  filename: basename,
                  url: URL.createObjectURL(blob),
                  blob: blob,
                  size: blob.size,
                  mime: mime
                });
              }
            } catch (entryErr) {
              console.warn('Skipping entry:', basename, entryErr);
            }

            if (i % 3 === 0) await sleep(5);
          }
        } else if (IMAGE_EXTS.has(ext)) {
          const mime = file.type || getMimeType(file.name);
          editorState.replacementTray.push({
            id: 'tray_' + Math.random().toString(36).substr(2, 6),
            filename: file.name,
            url: URL.createObjectURL(file),
            blob: file,
            size: file.size,
            mime: mime
          });
        }
      }

      showLoading(false);
      renderReplacementTray();
    } catch (err) {
      showLoading(false);
      alert('Could not unpack replacement files: ' + getErrorMessage(err));
    }
  }

  async function saveReadEditorChanges() {
    const targetRead = editorState.read;
    if (!targetRead) return;

    const hasGitHub = state.ghConnected && targetRead.isGitHub;
    let remainingFailed = [];

    if (hasGitHub) {
      showLoading(true, `Saving changes to GitHub for "${targetRead.title}"...`, 10, 'Uploading modified pages...');
      const cleanPath = (state.ghConfig.path || 'reads').replace(/^\/|\/$/g, '');
      const repo = state.ghConfig.repo.trim();
      const branch = state.ghConfig.branch.trim() || 'main';

      try {
        // 1. Concurrently upload any newly added or modified page blobs (Pass 1)
        const pagesToUpload = editorState.pages.filter(p => p.blob && (!p.sha || p.isModified));
        if (pagesToUpload.length > 0) {
          const pass1 = await uploadBlobsConcurrently(
            pagesToUpload,
            repo,
            4,
            (curr, total, fn) => {
              const pct = Math.round((curr / total) * 55) + 10;
              updateLoading(`Uploading pages: ${curr} of ${total}...`, pct, fn);
            }
          );

          // Pass 2 retry for any failed pages
          remainingFailed = pass1.failedPages || [];
          if (remainingFailed.length > 0) {
            updateLoading(`2nd-pass retry for ${remainingFailed.length} failed page(s)...`, 68, 'Recovering...');
            await sleep(2000);
            const pass2 = await uploadBlobsConcurrently(
              remainingFailed,
              repo,
              2,
              (curr, total, fn) => {
                updateLoading(`2nd-pass retry: ${curr} of ${total}...`, 70, fn);
              }
            );
            remainingFailed = pass2.failedPages || [];
          }
        }

        // 2. Fetch current branch head and base tree
        updateLoading('Fetching repository branch state...', 75, branch);
        const { commitSha, treeSha } = await getBranchHeadAndTree(repo, branch);

        // 3. Prepare updated manifest blob
        updateLoading('Creating manifest blob...', 82, 'manifest.json');
        targetRead.updatedAt = Date.now();
        const manifest = {
          title: targetRead.title,
          createdAt: targetRead.createdAt || targetRead.updatedAt,
          updatedAt: targetRead.updatedAt,
          playlists: Array.isArray(targetRead.playlists) ? targetRead.playlists : [],
          pages: editorState.pages.map((p, idx) => ({ filename: p.filename, order: idx + 1 }))
        };
        const manifestStr = JSON.stringify(manifest, null, 2);
        const manifestBase64 = btoa(unescape(encodeURIComponent(manifestStr)));
        const manifestBlob = await ghRequest(`/repos/${repo}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content: manifestBase64, encoding: 'base64' })
        });

        // Apply updated pages before building library_index.json
        const previousPages = targetRead.pages || [];
        targetRead.pages = editorState.pages.map((p, idx) => ({
          index: idx + 1,
          filename: p.filename,
          url: p.url,
          blob: p.blob || null,
          size: p.size || 0,
          sha: p.sha || null
        }));
        targetRead.pageCount = targetRead.pages.length;
        targetRead.hasMissingPages = remainingFailed.length > 0;

        const indexStr = JSON.stringify(buildLibraryIndexPayload(), null, 2);
        const indexBlob = await ghRequest(`/repos/${repo}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content: btoa(unescape(encodeURIComponent(indexStr))), encoding: 'base64' })
        });

        // 4. Build Git Tree items
        const treeItems = [];
        editorState.pages.forEach(p => {
          if (p.sha) {
            treeItems.push({
              path: `${cleanPath}/${targetRead.id}/${p.filename}`,
              mode: '100644',
              type: 'blob',
              sha: p.sha
            });
          }
        });
        const activeFilenames = new Set(editorState.pages.map(p => p.filename));
        previousPages.forEach(origP => {
          if (!activeFilenames.has(origP.filename)) {
            treeItems.push({
              path: `${cleanPath}/${targetRead.id}/${origP.filename}`,
              mode: '100644',
              type: 'blob',
              sha: null
            });
          }
        });
        treeItems.push({
          path: `${cleanPath}/${targetRead.id}/manifest.json`,
          mode: '100644',
          type: 'blob',
          sha: manifestBlob.sha
        });
        treeItems.push({
          path: `${cleanPath}/library_index.json`,
          mode: '100644',
          type: 'blob',
          sha: indexBlob.sha
        });

        // 5. Create Git Tree
        updateLoading('Creating Git tree on GitHub...', 90, `${treeItems.length} entries`);
        const newTree = await ghRequest(`/repos/${repo}/git/trees`, {
          method: 'POST',
          body: JSON.stringify({
            base_tree: treeSha,
            tree: treeItems
          })
        });

        // 6. Create Commit
        updateLoading('Creating single Git commit...', 95, '1 commit for all updates');
        const newCommit = await ghRequest(`/repos/${repo}/git/commits`, {
          method: 'POST',
          body: JSON.stringify({
            message: `Update ${targetRead.title} (${editorState.pages.length} pages)`,
            tree: newTree.sha,
            parents: [commitSha]
          })
        });

        // 7. Update branch ref
        updateLoading('Updating branch reference...', 98, branch);
        await ghRequest(`/repos/${repo}/git/refs/heads/${branch}`, {
          method: 'PATCH',
          body: JSON.stringify({
            sha: newCommit.sha,
            force: false
          })
        });

      } catch (ghErr) {
        showLoading(false);
        alert('Encountered issue while saving to GitHub: ' + getErrorMessage(ghErr));
        return;
      }
    } else {
      targetRead.pages = editorState.pages.map((p, idx) => ({
        index: idx + 1,
        filename: p.filename,
        url: p.url,
        blob: p.blob || null,
        size: p.size || 0,
        sha: p.sha || null
      }));
      targetRead.pageCount = targetRead.pages.length;
    }

    saveLibraryToCache();
    showLoading(false);
    closeModal(el.modalReadEditor);

    if (state.activeReadIndex === editorState.readIndex) {
      state.currentRead = targetRead;
      renderActiveRead();
      updateNavUI();
    }

    updateLibraryUI();
    if (remainingFailed.length > 0) {
      alert(`Saved with ${remainingFailed.length} failed page(s). Use "Resume Missing Pages" to retry only the remaining pages.`);
    } else {
      alert(`Changes saved successfully for "${targetRead.title}" (${targetRead.pages.length} pages).`);
    }
  }

  // --- EVENT LISTENERS ---
  function setupEventListeners() {
    // File inputs
    el.btnPickFiles.addEventListener('click', () => el.masterFileInput.click());
    el.btnUploadMore.addEventListener('click', () => el.masterFileInput.click());
    el.masterFileInput.addEventListener('change', (e) => {
      handleFilesSelected(e.target.files);
      el.masterFileInput.value = '';
    });

    el.btnSampleRead.addEventListener('click', loadSampleRead);

    // Read navigation (respects active playlist)
    el.btnPrevRead.addEventListener('click', loadPrevRead);
    el.btnNextRead.addEventListener('click', loadNextRead);
    el.btnFooterPrev.addEventListener('click', loadPrevRead);
    el.btnFooterNext.addEventListener('click', loadNextRead);
    el.btnFooterTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    if (el.btnFooterEdit) {
      el.btnFooterEdit.addEventListener('click', () => {
        if (state.activeReadIndex >= 0) openReadEditor(state.activeReadIndex);
      });
    }
    if (el.btnFooterDelete) {
      el.btnFooterDelete.addEventListener('click', () => deleteRead(state.activeReadIndex));
    }

    // Library, Playlists & Sort Presets
    el.btnOpenShelf.addEventListener('click', () => {
      renderPlaylistTabs();
      updateSortPresetUI();
      updateLibraryUI();
      openModal(el.modalLibrary);
    });
    el.btnLibrarySync.addEventListener('click', () => syncReadsFromGitHub({ silent: false }));
    if (el.btnNewPlaylist) {
      el.btnNewPlaylist.addEventListener('click', createPlaylist);
    }
    document.querySelectorAll('.sort-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => applySortPreset(btn.dataset.sort));
    });

    // Settings
    el.btnGithubStatus.addEventListener('click', () => openModal(el.modalSettings));
    el.btnOpenSettings.addEventListener('click', () => openModal(el.modalSettings));
    el.btnSetupGithubQuick.addEventListener('click', () => openModal(el.modalSettings));

    el.btnSaveGithub.addEventListener('click', () => {
      state.ghConfig.repo = el.inputGhRepo.value.trim();
      state.ghConfig.token = el.inputGhToken.value.trim();
      state.ghConfig.branch = el.inputGhBranch.value.trim() || 'main';
      state.ghConfig.path = el.inputGhPath.value.trim() || 'reads';
      closeModal(el.modalSettings);
      connectGitHub();
    });

    el.btnDisconnectGithub.addEventListener('click', () => {
      localStorage.removeItem('sr_gh_repo');
      localStorage.removeItem('sr_gh_token');
      state.ghConfig.repo = '';
      state.ghConfig.token = '';
      state.ghConnected = false;
      updateGitHubStatusUI(false);
      closeModal(el.modalSettings);
    });

    // Strip width dropdown
    el.selectWidth.addEventListener('change', (e) => {
      applyWidth(e.target.value);
    });

    // Manual Width Slider
    el.inputCustomWidth.addEventListener('input', (e) => {
      const px = e.target.value;
      el.customWidthVal.textContent = `${px}px`;
      el.stripOuter.style.maxWidth = `${px}px`;
      localStorage.setItem('sr_strip_width', px);
    });
    el.btnFitScreenQuick.addEventListener('click', () => {
      applyWidth('fit-screen');
    });
    el.btnCloseSlider.addEventListener('click', () => {
      el.widthSliderBar.classList.add('hidden');
    });

    // Hide / Reveal Menu Bar
    el.btnToggleMenu.addEventListener('click', () => toggleMenuBar());
    el.btnRevealMenu.addEventListener('click', () => toggleMenuBar(false));

    // Mobile More Menu
    el.btnMoreMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMobileDropdown();
    });
    el.btnMobileEdit.addEventListener('click', () => {
      closeMobileDropdown();
      toggleEditMode();
    });
    el.btnMobileSlider.addEventListener('click', () => {
      closeMobileDropdown();
      applyWidth('custom');
    });
    el.btnMobileSettings.addEventListener('click', () => {
      closeMobileDropdown();
      openModal(el.modalSettings);
    });
    el.btnMobileUpload.addEventListener('click', () => {
      closeMobileDropdown();
      el.masterFileInput.click();
    });
    el.btnMobileHideBar.addEventListener('click', () => {
      closeMobileDropdown();
      toggleMenuBar(true);
    });

    // Close mobile dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#mobile-menu-dropdown') && !e.target.closest('#btn-more-menu')) {
        closeMobileDropdown();
      }
    });

    // Edit Order
    el.btnEditOrder.addEventListener('click', toggleEditMode);
    el.btnSaveOrder.addEventListener('click', saveOrder);
    el.btnResetOrder.addEventListener('click', () => {
      state.stagedPages = state.currentRead.pages.map(p => ({ ...p }));
      state.hasUnsavedChanges = false;
      renderEditCards();
    });
    el.btnExitEdit.addEventListener('click', exitEditMode);

    // Read Editor Controls
    if (el.btnEditorUploadZip) {
      el.btnEditorUploadZip.addEventListener('click', () => el.inputEditorZip.click());
    }
    if (el.inputEditorZip) {
      el.inputEditorZip.addEventListener('change', (e) => {
        handleEditorZipUpload(e.target.files);
        el.inputEditorZip.value = '';
      });
    }
    if (el.btnEditorResumeMissing && el.inputEditorResumeZip) {
      el.btnEditorResumeMissing.addEventListener('click', () => el.inputEditorResumeZip.click());
      el.inputEditorResumeZip.addEventListener('change', (e) => {
        handleEditorResumeMissing(e.target.files);
        el.inputEditorResumeZip.value = '';
      });
    }
    if (el.btnEditorAppendPage) {
      el.btnEditorAppendPage.addEventListener('click', () => el.inputSinglePageAppend.click());
    }
    if (el.inputSinglePageAppend) {
      el.inputSinglePageAppend.addEventListener('change', (e) => {
        handleEditorAppendFiles(e.target.files);
        el.inputSinglePageAppend.value = '';
      });
    }
    if (el.inputSinglePageReplace) {
      el.inputSinglePageReplace.addEventListener('change', (e) => {
        handleEditorReplaceFile(e.target.files);
        el.inputSinglePageReplace.value = '';
      });
    }
    if (el.btnSaveReadEditor) {
      el.btnSaveReadEditor.addEventListener('click', saveReadEditorChanges);
    }
    if (el.btnTrayAppendAll) {
      el.btnTrayAppendAll.addEventListener('click', appendAllTrayItems);
    }

    // Modal close buttons
    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modal = document.getElementById(btn.dataset.close);
        if (modal) closeModal(modal);
      });
    });

    // Global keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (e.key === '[') loadPrevRead();
      if (e.key === ']') loadNextRead();
      if (e.key === 'h' || e.key === 'H') toggleMenuBar();
      if (e.key === 'Escape') {
        closeModal(el.modalSettings);
        closeModal(el.modalLibrary);
        closeModal(el.modalReadEditor);
        closeMobileDropdown();
        el.widthSliderBar.classList.add('hidden');
        if (state.isEditing) exitEditMode();
      }
    });
  }

  // --- DROP ZONE ---
  function setupDropZone() {
    const zone = el.dropZone;
    const card = zone.querySelector('.drop-card');

    ['dragenter', 'dragover'].forEach(name => {
      window.addEventListener(name, (e) => {
        e.preventDefault();
        card.classList.add('drag-over');
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      window.addEventListener(name, (e) => {
        e.preventDefault();
        card.classList.remove('drag-over');
      });
    });

    window.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files && files.length > 0) handleFilesSelected(files);
    });
  }

  function openModal(modal) { modal.classList.remove('hidden'); }
  function closeModal(modal) { modal.classList.add('hidden'); }

  function showLoading(show, title = '', percent = 0, sub = '') {
    if (show) {
      el.loadingText.textContent = title;
      el.progressBar.style.width = `${percent}%`;
      el.loadingSub.textContent = sub;
      el.loadingOverlay.classList.remove('hidden');
    } else {
      el.loadingOverlay.classList.add('hidden');
    }
  }

  function updateLoading(title, percent, sub) {
    el.loadingText.textContent = title;
    el.progressBar.style.width = `${percent}%`;
    el.loadingSub.textContent = sub;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
