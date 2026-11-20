/**
 * STRIP//ZIP — Technical Multi-Archive Image Strip Reader Engine
 * Robust Dual-Mode Architecture:
 * 1. Server Disk Mode (when node server.js is running on localhost:3000)
 *    - Direct upload of ZIP, RAR, CBZ, and loose images to server disk
 *    - Native 7-Zip extraction into dedicated folders in /data/reads/
 *    - Physical disk file reordering when rearranged in Edit Mode
 * 2. In-Browser Mode Fallback (when opened via static server or double-clicked)
 *    - Safe JSON detection (prevents "Unexpected token < <!doctype" errors)
 *    - Instant client-side JSZip decompressor and memory reordering
 */

(() => {
  'use strict';

  // --- APPLICATION STATE ---
  const state = {
    serverMode: false, // True if server backend /api/reads is accessible
    reads: [], // List of loaded reads
    activeReadIndex: -1,
    currentRead: null, // Full data for currently displayed read
    readingMode: 'long-strip', // 'long-strip' | 'single-page' | 'double-spread'
    pagedIndex: 0,
    stripWidth: 'fit-1200',
    gap: 0,
    brightness: 100,
    contrast: 100,
    invert: false,
    grayscale: false,
    showBadges: true,
    smoothScroll: true,
    hudVisible: true,
    pageObserver: null,

    // Edit Mode State
    isEditing: false,
    stagedPages: [], // Working copy for drag-and-drop reordering
    hasUnsavedChanges: false,
    dragSrcIndex: null,

    // Background sync
    syncTimer: null,
    lastKnownUpdate: 0,
  };

  const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'svg']);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  // DOM Elements
  const el = {
    topHud: document.getElementById('top-hud'),
    readSwitcher: document.getElementById('read-switcher'),
    btnPrevRead: document.getElementById('btn-prev-read'),
    btnNextRead: document.getElementById('btn-next-read'),
    btnReadSelector: document.getElementById('btn-read-selector'),
    currentReadBadge: document.getElementById('current-read-badge'),
    currentReadTitle: document.getElementById('current-read-title'),
    currentReadPages: document.getElementById('current-read-pages'),
    readsCount: document.getElementById('reads-count'),
    btnLibraryToggle: document.getElementById('btn-library-toggle'),
    serverSyncStatus: document.getElementById('server-sync-status'),

    hudTelemetry: document.getElementById('hud-telemetry'),
    telemPage: document.getElementById('telem-page'),
    telemTotal: document.getElementById('telem-total'),
    telemPercent: document.getElementById('telem-percent'),

    selectStripWidth: document.getElementById('select-strip-width'),
    selectReadMode: document.getElementById('select-read-mode'),
    btnEnterEdit: document.getElementById('btn-enter-edit'),
    btnToggleFilters: document.getElementById('btn-toggle-filters'),
    btnOpenSpecs: document.getElementById('btn-open-specs'),
    btnAddFilesHud: document.getElementById('btn-add-files-hud'),
    btnFullscreen: document.getElementById('btn-fullscreen'),

    dropZone: document.getElementById('drop-zone'),
    fileInput: document.getElementById('file-input'),
    btnLoadDemo: document.getElementById('btn-load-demo'),

    loadingOverlay: document.getElementById('loading-overlay'),
    loadingTitle: document.getElementById('loading-title'),
    loadingProgressFill: document.getElementById('loading-progress-fill'),
    loadingMeta: document.getElementById('loading-meta'),

    readerView: document.getElementById('reader-view'),
    readerArchiveName: document.getElementById('reader-archive-name'),
    readerArchiveSub: document.getElementById('reader-archive-sub'),
    btnBannerEdit: document.getElementById('btn-banner-edit'),
    btnBannerSpecs: document.getElementById('btn-banner-specs'),
    btnBannerDeleteRead: document.getElementById('btn-banner-delete-read'),

    // Edit Mode Bar & Grid
    editModeBar: document.getElementById('edit-mode-bar'),
    editChangesCount: document.getElementById('edit-changes-count'),
    btnSaveOrder: document.getElementById('btn-save-order'),
    btnResetOrder: document.getElementById('btn-reset-order'),
    btnExitEdit: document.getElementById('btn-exit-edit'),
    editGridContainer: document.getElementById('edit-grid-container'),
    editCardsList: document.getElementById('edit-cards-list'),

    stripOuter: document.getElementById('strip-outer'),
    stripContainer: document.getElementById('strip-container'),

    pagedControls: document.getElementById('paged-controls'),
    btnPagedPrev: document.getElementById('btn-paged-prev'),
    btnPagedNext: document.getElementById('btn-paged-next'),
    pagedIndicator: document.getElementById('paged-indicator'),

    btnFooterPrevRead: document.getElementById('btn-footer-prev-read'),
    btnFooterNextRead: document.getElementById('btn-footer-next-read'),
    btnFooterTop: document.getElementById('btn-footer-top'),
    footerNextText: document.getElementById('footer-next-text'),

    quickRadar: document.getElementById('quick-radar'),
    btnRadarTop: document.getElementById('btn-radar-top'),
    btnRadarBottom: document.getElementById('btn-radar-bottom'),
    radarCurrentPage: document.getElementById('radar-current-page'),
    radarTotalPages: document.getElementById('radar-total-pages'),
    radarScrubTrack: document.getElementById('radar-scrub-track'),
    radarScrubThumb: document.getElementById('radar-scrub-thumb'),

    readsDrawer: document.getElementById('reads-drawer'),
    drawerBackdrop: document.getElementById('drawer-backdrop'),
    btnCloseDrawer: document.getElementById('btn-close-drawer'),
    drawerFileInput: document.getElementById('drawer-file-input'),
    shelfGrid: document.getElementById('shelf-grid'),
    shelfCount: document.getElementById('shelf-count'),
    shelfSummary: document.getElementById('shelf-summary'),
    btnRefreshServer: document.getElementById('btn-refresh-server'),

    modalFilters: document.getElementById('modal-filters'),
    rangeGap: document.getElementById('range-gap'),
    valGap: document.getElementById('val-gap'),
    rangeBrightness: document.getElementById('range-brightness'),
    valBrightness: document.getElementById('val-brightness'),
    rangeContrast: document.getElementById('range-contrast'),
    valContrast: document.getElementById('val-contrast'),
    checkInvert: document.getElementById('check-invert'),
    checkGrayscale: document.getElementById('check-grayscale'),
    checkPageBadges: document.getElementById('check-page-badges'),
    checkSmoothScroll: document.getElementById('check-smooth-scroll'),
    btnResetFilters: document.getElementById('btn-reset-filters'),

    modalSpecs: document.getElementById('modal-specs'),
    specsModalTitle: document.getElementById('specs-modal-title'),
    specFolderName: document.getElementById('spec-folder-name'),
    specPayloadSize: document.getElementById('spec-payload-size'),
    specImageCount: document.getElementById('spec-image-count'),
    specLastUpdate: document.getElementById('spec-last-update'),
    specsManifestTbody: document.getElementById('specs-manifest-tbody'),
  };

  // --- SAFE JSON FETCHER (Prevents "Unexpected token < <!doctype" crashes) ---
  async function safeFetchJson(url, options = {}) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        return { ok: false, status: res.status, error: `HTTP ${res.status}` };
      }
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        // Returned HTML (e.g., 404 page or index.html from static dev server)
        return { ok: false, error: 'Server returned HTML instead of JSON', isHtml: true };
      }
      const data = await res.json();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // --- INITIALIZATION ---
  async function init() {
    setupEventListeners();
    setupDropZone();
    setupScrollMonitoring();

    // Check if the Node server backend is active
    await detectServerEnvironment();
  }

  // --- DETECT SERVER ENVIRONMENT ---
  async function detectServerEnvironment() {
    const check = await safeFetchJson('/api/reads');

    if (check.ok && check.data && check.data.success) {
      // Backend is online
      state.serverMode = true;
      el.serverSyncStatus.textContent = '● SERVER DISK ACTIVE';
      el.serverSyncStatus.className = 'sync-badge sync-online';
      el.serverSyncStatus.title = 'Connected to Node.js backend. Uploads save to /data/reads/ and support physical disk reordering.';

      state.reads = check.data.reads;
      updateHudUI();
      updateShelfUI();

      if (state.reads.length > 0) {
        await loadRead(0);
      } else {
        showEmptyState();
      }

      startSyncPolling();
    } else {
      // Backend is NOT running on this port (e.g. user opened with Live Server, Python, or static host)
      state.serverMode = false;
      el.serverSyncStatus.textContent = '⚡ IN-BROWSER MODE (OFFLINE)';
      el.serverSyncStatus.className = 'sync-badge sync-offline';
      el.serverSyncStatus.title = 'No Node server detected on this port. Running in 100% private in-browser mode.';

      console.info('[STRIP//ZIP] Running in local in-browser mode. To enable server disk storage, run: npm start (or node server.js) and open http://localhost:3000');
      showEmptyState();
    }
  }

  // --- SERVER READS LOADER ---
  async function loadRead(index) {
    if (index < 0 || index >= state.reads.length) return;
    const summary = state.reads[index];

    if (state.serverMode) {
      const result = await safeFetchJson(`/api/reads/${encodeURIComponent(summary.id)}`);
      if (result.ok && result.data.success) {
        state.activeReadIndex = index;
        state.currentRead = result.data.read;
        state.lastKnownUpdate = result.data.read.updatedAt;
        state.pagedIndex = 0;

        if (state.isEditing) exitEditMode();
        renderActiveRead();
        updateHudUI();
        updateShelfUI();
      } else {
        console.warn('Could not load read from server:', result.error);
      }
    } else {
      // In-browser read
      state.activeReadIndex = index;
      state.currentRead = state.reads[index];
      state.pagedIndex = 0;
      if (state.isEditing) exitEditMode();
      renderActiveRead();
      updateHudUI();
      updateShelfUI();
    }
  }

  // --- UNIFIED FILE DISPATCHER ---
  async function handleFilesSelected(fileList) {
    if (!fileList || fileList.length === 0) return;

    if (state.serverMode) {
      // Route through server backend
      uploadFilesToServer(fileList);
    } else {
      // Route through in-browser client JSZip engine
      await processArchivesInBrowser(fileList);
    }
  }

  // --- 1. SERVER UPLOAD PIPELINE ---
  function uploadFilesToServer(fileList) {
    const formData = new FormData();
    for (let i = 0; i < fileList.length; i++) {
      formData.append('files', fileList[i]);
    }

    showLoading(true, 'UPLOADING TO SERVER DISK...', 0, `Uploading ${fileList.length} file(s)...`);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        updateLoading(
          pct < 100 ? 'UPLOADING TO SERVER...' : 'SERVER 7z EXTRACTING & ORGANIZING FOLDERS...',
          pct,
          `${(e.loaded / (1024 * 1024)).toFixed(1)} MB / ${(e.total / (1024 * 1024)).toFixed(1)} MB`
        );
      }
    };

    xhr.onload = async () => {
      showLoading(false);
      try {
        const contentType = xhr.getResponseHeader('content-type') || '';
        if (!contentType.includes('application/json')) {
          alert('Upload failed: Server returned non-JSON response. Please ensure "node server.js" is running on port 3000.');
          return;
        }

        const res = JSON.parse(xhr.responseText);
        if (res.success) {
          await refreshServerReads(res.reads[0]?.id);
        } else {
          alert('Upload failed: ' + res.error);
        }
      } catch (err) {
        alert('Server response parsing error: ' + err.message);
      }
    };

    xhr.onerror = () => {
      showLoading(false);
      alert('Network error while uploading to server.');
    };

    xhr.send(formData);
  }

  async function refreshServerReads(autoSelectId = null) {
    const check = await safeFetchJson('/api/reads');
    if (check.ok && check.data.success) {
      state.reads = check.data.reads;
      updateHudUI();
      updateShelfUI();

      let targetIndex = 0;
      if (autoSelectId) {
        const found = state.reads.findIndex(r => r.id === autoSelectId);
        if (found !== -1) targetIndex = found;
      }
      await loadRead(targetIndex);
    }
  }

  // --- 2. IN-BROWSER CLIENT-SIDE PARSER (OFFLINE FALLBACK) ---
  async function processArchivesInBrowser(fileList) {
    if (typeof JSZip === 'undefined') {
      alert('JSZip library is not loaded. Please ensure js/jszip.min.js is present.');
      return;
    }

    const files = Array.from(fileList);
    const zipFiles = files.filter(f => f.name.toLowerCase().endsWith('.zip') || f.name.toLowerCase().endsWith('.cbz') || f.type.includes('zip'));

    if (zipFiles.length === 0) {
      alert('In-browser mode currently supports .zip and .cbz archives. To unpack .rar archives or store directly on disk, run "npm start" to enable Server Disk Mode.');
      return;
    }

    showLoading(true, 'EXTRACTING IN BROWSER RAM...', 0, `Processing ${zipFiles.length} archive(s)...`);

    for (let i = 0; i < zipFiles.length; i++) {
      const file = zipFiles[i];
      updateLoading(
        `UNPACKING [${i + 1}/${zipFiles.length}]: ${file.name}`,
        Math.round((i / zipFiles.length) * 100),
        'Decompressing image streams in browser memory...'
      );

      try {
        const zip = new JSZip();
        const loadedZip = await zip.loadAsync(file);
        const entries = [];

        loadedZip.forEach((relPath, entry) => {
          if (entry.dir || relPath.includes('__MACOSX/') || relPath.startsWith('.')) return;
          const ext = relPath.split('.').pop().toLowerCase();
          if (IMAGE_EXTENSIONS.has(ext)) entries.push(entry);
        });

        if (entries.length === 0) {
          throw new Error(`Archive ${file.name} contains no valid image files.`);
        }

        // Natural sequence sorting
        entries.sort((a, b) => collator.compare(a.name, b.name));

        const pages = [];
        let totalPayload = 0;
        for (let j = 0; j < entries.length; j++) {
          const entry = entries[j];
          const blob = await entry.async('blob');
          const url = URL.createObjectURL(blob);
          totalPayload += blob.size;
          const ext = entry.name.split('.').pop().toLowerCase();

          pages.push({
            index: j + 1,
            filename: entry.name,
            url: url,
            size: blob.size,
            ext: ext,
            isBlob: true
          });
        }

        const readData = {
          id: 'local_' + Date.now() + '_' + i,
          title: file.name.replace(/\.[^/.]+$/, ''),
          folderName: '(Local Browser Memory)',
          pageCount: pages.length,
          pages: pages,
          totalSize: totalPayload,
          firstPageUrl: pages[0]?.url || '',
          updatedAt: Date.now()
        };

        state.reads.push(readData);
      } catch (err) {
        console.error('Error unpacking in browser:', err);
        alert(`Error unpacking ${file.name}: ${err.message}`);
      }
    }

    showLoading(false);
    updateHudUI();
    updateShelfUI();

    if (state.activeReadIndex === -1 && state.reads.length > 0) {
      await loadRead(0);
    }
  }

  // --- EVENT LISTENERS ---
  function setupEventListeners() {
    el.fileInput.addEventListener('change', (e) => {
      handleFilesSelected(e.target.files);
      el.fileInput.value = '';
    });
    el.drawerFileInput.addEventListener('change', (e) => {
      handleFilesSelected(e.target.files);
      el.drawerFileInput.value = '';
    });
    el.btnAddFilesHud.addEventListener('click', () => el.fileInput.click());

    // Demo archive generation
    el.btnLoadDemo.addEventListener('click', createDemoReads);

    // Read navigation
    el.btnPrevRead.addEventListener('click', () => switchRead(state.activeReadIndex - 1));
    el.btnNextRead.addEventListener('click', () => switchRead(state.activeReadIndex + 1));
    el.btnFooterPrevRead.addEventListener('click', () => switchRead(state.activeReadIndex - 1));
    el.btnFooterNextRead.addEventListener('click', () => switchRead(state.activeReadIndex + 1));
    el.btnReadSelector.addEventListener('click', toggleReadsDrawer);
    el.btnLibraryToggle.addEventListener('click', toggleReadsDrawer);

    // Drawer
    el.btnCloseDrawer.addEventListener('click', closeReadsDrawer);
    el.drawerBackdrop.addEventListener('click', closeReadsDrawer);
    el.btnRefreshServer.addEventListener('click', () => {
      if (state.serverMode) refreshServerReads();
      else updateShelfUI();
    });

    // Footer actions
    el.btnFooterTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

    // Strip width selector
    el.selectStripWidth.addEventListener('change', (e) => {
      state.stripWidth = e.target.value;
      el.stripOuter.className = `strip-outer width-${state.stripWidth}`;
    });

    // Reading mode selector
    el.selectReadMode.addEventListener('change', (e) => {
      state.readingMode = e.target.value;
      renderActiveRead();
    });

    // Edit Mode buttons
    el.btnEnterEdit.addEventListener('click', toggleEditMode);
    el.btnBannerEdit.addEventListener('click', toggleEditMode);
    el.btnSaveOrder.addEventListener('click', saveReorderedPages);
    el.btnResetOrder.addEventListener('click', resetEditOrder);
    el.btnExitEdit.addEventListener('click', exitEditMode);

    // Delete read button
    el.btnBannerDeleteRead.addEventListener('click', deleteCurrentRead);

    // Filters modal
    el.btnToggleFilters.addEventListener('click', () => openModal(el.modalFilters));
    el.rangeGap.addEventListener('input', (e) => {
      state.gap = parseInt(e.target.value, 10);
      el.valGap.textContent = state.gap === 0 ? '0px (Seamless Strip)' : `${state.gap}px`;
      updateFiltersStyle();
    });
    el.rangeBrightness.addEventListener('input', (e) => {
      state.brightness = parseInt(e.target.value, 10);
      el.valBrightness.textContent = `${state.brightness}%`;
      updateFiltersStyle();
    });
    el.rangeContrast.addEventListener('input', (e) => {
      state.contrast = parseInt(e.target.value, 10);
      el.valContrast.textContent = `${state.contrast}%`;
      updateFiltersStyle();
    });
    el.checkInvert.addEventListener('change', (e) => {
      state.invert = e.target.checked;
      updateFiltersStyle();
    });
    el.checkGrayscale.addEventListener('change', (e) => {
      state.grayscale = e.target.checked;
      updateFiltersStyle();
    });
    el.checkPageBadges.addEventListener('change', (e) => {
      state.showBadges = e.target.checked;
      document.querySelectorAll('.page-badge-overlay').forEach(b => {
        b.style.display = state.showBadges ? 'inline-flex' : 'none';
      });
    });
    el.checkSmoothScroll.addEventListener('change', (e) => {
      state.smoothScroll = e.target.checked;
      document.documentElement.style.scrollBehavior = state.smoothScroll ? 'smooth' : 'auto';
    });
    el.btnResetFilters.addEventListener('click', resetFilters);

    // Canvas background swatches
    document.querySelectorAll('.bg-swatch').forEach(swatch => {
      swatch.addEventListener('click', () => {
        document.querySelectorAll('.bg-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
        const bg = swatch.dataset.bg;
        document.body.style.backgroundColor = bg;
        el.stripContainer.style.backgroundColor = bg;
      });
    });

    // Technical Specs Modal
    el.btnOpenSpecs.addEventListener('click', openSpecsModal);
    el.btnBannerSpecs.addEventListener('click', openSpecsModal);

    // Modal close buttons
    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modalId = btn.dataset.close;
        const target = document.getElementById(modalId);
        if (target) closeModal(target);
      });
    });

    // Fullscreen toggle
    el.btnFullscreen.addEventListener('click', toggleFullscreen);

    // Radar buttons
    el.btnRadarTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    el.btnRadarBottom.addEventListener('click', () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    el.radarScrubTrack.addEventListener('click', handleScrubTrackClick);

    // Paged controls
    el.btnPagedPrev.addEventListener('click', () => stepPage(-1));
    el.btnPagedNext.addEventListener('click', () => stepPage(1));

    // Global Keyboard Shortcuts
    window.addEventListener('keydown', handleGlobalKeydown);
  }

  // --- DRAG AND DROP ZONE ---
  function setupDropZone() {
    const zone = el.dropZone;
    const box = zone.querySelector('.drop-box');

    ['dragenter', 'dragover'].forEach(name => {
      window.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        box.classList.add('drag-over');
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      window.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        box.classList.remove('drag-over');
      });
    });

    window.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        handleFilesSelected(files);
      }
    });
  }

  // --- READ SWITCHING ---
  function switchRead(newIndex) {
    if (state.reads.length === 0) return;
    if (newIndex < 0) newIndex = 0;
    if (newIndex >= state.reads.length) newIndex = state.reads.length - 1;
    loadRead(newIndex);
  }

  function showEmptyState() {
    el.readerView.classList.add('hidden');
    el.readSwitcher.classList.add('hidden');
    el.hudTelemetry.classList.add('hidden');
    el.btnEnterEdit.classList.add('hidden');
    el.quickRadar.classList.add('hidden');
    el.dropZone.classList.remove('hidden');
  }

  // --- RENDER ACTIVE READ ---
  function renderActiveRead() {
    const currentRead = state.currentRead;
    if (!currentRead) return;

    if (state.pageObserver) {
      state.pageObserver.disconnect();
    }

    el.dropZone.classList.add('hidden');
    el.readerView.classList.remove('hidden');
    el.readSwitcher.classList.remove('hidden');
    el.hudTelemetry.classList.remove('hidden');
    el.btnEnterEdit.classList.remove('hidden');
    el.quickRadar.classList.remove('hidden');

    el.readerArchiveName.textContent = currentRead.title || currentRead.folderName;
    el.readerArchiveSub.textContent = state.serverMode
      ? `Server Folder: /data/reads/${currentRead.folderName} • ${currentRead.pages.length} Pages • ${(currentRead.totalSize / (1024 * 1024)).toFixed(2)} MB`
      : `In-Browser RAM • ${currentRead.pages.length} Pages • ${(currentRead.totalSize / (1024 * 1024)).toFixed(2)} MB`;

    const hasNext = state.activeReadIndex < state.reads.length - 1;
    if (hasNext) {
      const nextRead = state.reads[state.activeReadIndex + 1];
      el.footerNextText.textContent = `Next read: ${nextRead.title || nextRead.folderName} (${nextRead.pageCount || nextRead.pages?.length} pages)`;
      el.btnFooterNextRead.classList.remove('hidden');
    } else {
      el.footerNextText.textContent = `You have reached the end of all ${state.reads.length} loaded reads.`;
      el.btnFooterNextRead.classList.add('hidden');
    }

    el.stripContainer.innerHTML = '';
    if (state.readingMode === 'long-strip') {
      el.pagedControls.classList.add('hidden');
      renderLongStrip(currentRead);
    } else {
      el.pagedControls.classList.remove('hidden');
      renderPagedMode(currentRead);
    }
  }

  // --- CONTINUOUS LONG STRIP RENDERER ---
  function renderLongStrip(currentRead) {
    const fragment = document.createDocumentFragment();

    state.pageObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const pageIndex = parseInt(entry.target.dataset.pageIndex, 10);
          updateTelemetryCurrentPage(pageIndex);
        }
      });
    }, {
      rootMargin: '-30% 0px -50% 0px',
      threshold: 0
    });

    currentRead.pages.forEach((page) => {
      const pageEl = document.createElement('div');
      pageEl.className = 'strip-page';
      pageEl.id = `page-frame-${page.index}`;
      pageEl.dataset.pageIndex = page.index;

      const badge = document.createElement('div');
      badge.className = 'page-badge-overlay';
      badge.innerHTML = `<span class="page-badge-num">#${String(page.index).padStart(2, '0')}</span><span>•</span><span>${page.filename}</span>`;
      if (!state.showBadges) badge.style.display = 'none';

      const img = document.createElement('img');
      img.src = page.url;
      img.alt = page.filename;
      img.loading = 'lazy';
      img.decoding = 'async';

      pageEl.appendChild(badge);
      pageEl.appendChild(img);
      fragment.appendChild(pageEl);

      state.pageObserver.observe(pageEl);
    });

    el.stripContainer.appendChild(fragment);
    updateFiltersStyle();
  }

  // --- PAGED / DOUBLE SPREAD MODE ---
  function renderPagedMode(currentRead) {
    el.stripContainer.innerHTML = '';
    const pages = currentRead.pages;
    const isDouble = state.readingMode === 'double-spread';

    const p1 = pages[state.pagedIndex];
    const p2 = isDouble && state.pagedIndex + 1 < pages.length ? pages[state.pagedIndex + 1] : null;

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '12px';
    row.style.justifyContent = 'center';
    row.style.alignItems = 'center';
    row.style.minHeight = '70vh';

    if (p1) {
      const img1 = document.createElement('img');
      img1.src = p1.url;
      img1.style.maxWidth = isDouble ? '48%' : '90%';
      img1.style.maxHeight = '85vh';
      img1.style.objectFit = 'contain';
      row.appendChild(img1);
    }

    if (p2) {
      const img2 = document.createElement('img');
      img2.src = p2.url;
      img2.style.maxWidth = '48%';
      img2.style.maxHeight = '85vh';
      img2.style.objectFit = 'contain';
      row.appendChild(img2);
    }

    el.stripContainer.appendChild(row);

    const currentNum = state.pagedIndex + 1;
    const displayNum = p2 ? `${currentNum}-${currentNum + 1}` : `${currentNum}`;
    el.pagedIndicator.textContent = `PAGE ${displayNum} / ${pages.length}`;
    updateTelemetryCurrentPage(currentNum);
  }

  function stepPage(delta) {
    const currentRead = state.currentRead;
    if (!currentRead) return;
    const step = state.readingMode === 'double-spread' ? 2 : 1;
    const nextIdx = state.pagedIndex + (delta * step);

    if (nextIdx >= 0 && nextIdx < currentRead.pages.length) {
      state.pagedIndex = nextIdx;
      renderPagedMode(currentRead);
    }
  }

  // ===========================================================================
  // EDIT MODE & REORDERING ENGINE
  // ===========================================================================
  function toggleEditMode() {
    if (state.isEditing) exitEditMode();
    else enterEditMode();
  }

  function enterEditMode() {
    if (!state.currentRead) return;
    state.isEditing = true;
    state.stagedPages = JSON.parse(JSON.stringify(state.currentRead.pages));
    state.hasUnsavedChanges = false;

    el.btnEnterEdit.classList.add('active');
    el.btnBannerEdit.textContent = '✕ EXIT EDIT MODE';
    el.editModeBar.classList.remove('hidden');
    el.editGridContainer.classList.remove('hidden');
    el.stripOuter.classList.add('hidden');

    renderEditCards();
    updateEditBarStatus();
  }

  function exitEditMode() {
    if (state.hasUnsavedChanges) {
      const confirmExit = confirm('You have unsaved page order changes. Discard and exit edit mode?');
      if (!confirmExit) return;
    }

    state.isEditing = false;
    state.hasUnsavedChanges = false;
    el.btnEnterEdit.classList.remove('active');
    el.btnBannerEdit.textContent = '✏️ EDIT PAGE ORDER';
    el.editModeBar.classList.add('hidden');
    el.editGridContainer.classList.add('hidden');
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
        <div class="edit-card-handle" title="Drag to reorder">⠿</div>
        <div class="edit-card-num">#${String(idx + 1).padStart(2, '0')}</div>
        <img class="edit-card-thumb" src="${page.url}" alt="${page.filename}">
        <div class="edit-card-info">
          <div class="edit-card-title">${page.filename}</div>
          <div class="edit-card-meta">${(page.size / 1024).toFixed(1)} KB • ${(page.ext || 'IMG').toUpperCase()}</div>
        </div>
        <div class="edit-card-actions">
          <button class="card-btn-arrow btn-up" title="Move Up" ${idx === 0 ? 'disabled' : ''}>▲</button>
          <button class="card-btn-arrow btn-down" title="Move Down" ${idx === state.stagedPages.length - 1 ? 'disabled' : ''}>▼</button>
          <button class="card-btn-delete" title="Delete page">🗑️</button>
        </div>
      `;

      card.querySelector('.btn-up').addEventListener('click', () => movePage(idx, -1));
      card.querySelector('.btn-down').addEventListener('click', () => movePage(idx, 1));
      card.querySelector('.card-btn-delete').addEventListener('click', () => deletePage(idx));

      card.addEventListener('dragstart', handleDragStart);
      card.addEventListener('dragover', handleDragOver);
      card.addEventListener('drop', handleDrop);
      card.addEventListener('dragend', handleDragEnd);

      el.editCardsList.appendChild(card);
    });
  }

  function movePage(index, delta) {
    const targetIdx = index + delta;
    if (targetIdx < 0 || targetIdx >= state.stagedPages.length) return;

    const [moved] = state.stagedPages.splice(index, 1);
    state.stagedPages.splice(targetIdx, 0, moved);

    state.hasUnsavedChanges = true;
    renderEditCards();
    updateEditBarStatus();
  }

  function handleDragStart(e) {
    state.dragSrcIndex = parseInt(this.dataset.index, 10);
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const targetCard = e.currentTarget;
    if (targetCard && !targetCard.classList.contains('dragging')) {
      document.querySelectorAll('.edit-card').forEach(c => c.classList.remove('drag-over'));
      targetCard.classList.add('drag-over');
    }
  }

  function handleDrop(e) {
    e.stopPropagation();
    const destIndex = parseInt(this.dataset.index, 10);
    if (state.dragSrcIndex !== null && state.dragSrcIndex !== destIndex) {
      const [moved] = state.stagedPages.splice(state.dragSrcIndex, 1);
      state.stagedPages.splice(destIndex, 0, moved);
      state.hasUnsavedChanges = true;
      renderEditCards();
      updateEditBarStatus();
    }
  }

  function handleDragEnd() {
    state.dragSrcIndex = null;
    document.querySelectorAll('.edit-card').forEach(c => {
      c.classList.remove('dragging');
      c.classList.remove('drag-over');
    });
  }

  function resetEditOrder() {
    state.stagedPages = JSON.parse(JSON.stringify(state.currentRead.pages));
    state.hasUnsavedChanges = false;
    renderEditCards();
    updateEditBarStatus();
  }

  function updateEditBarStatus() {
    if (state.hasUnsavedChanges) {
      el.editChangesCount.textContent = '● Changes pending save';
      el.btnSaveOrder.disabled = false;
    } else {
      el.editChangesCount.textContent = 'No changes';
      el.btnSaveOrder.disabled = true;
    }
  }

  async function saveReorderedPages() {
    if (!state.currentRead || !state.hasUnsavedChanges) return;

    if (state.serverMode) {
      // Physically rename on server disk
      const orderedFilenames = state.stagedPages.map(p => p.filename);
      showLoading(true, 'SAVING TO SERVER DISK...', 50, 'Physically re-sequencing files in server folder...');

      const result = await safeFetchJson(`/api/reads/${encodeURIComponent(state.currentRead.id)}/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedFilenames })
      });

      showLoading(false);

      if (result.ok && result.data.success) {
        state.currentRead = result.data.read;
        state.lastKnownUpdate = result.data.read.updatedAt;
        state.hasUnsavedChanges = false;
        alert('✅ Saved to server! Files in the server folder have been physically renamed in your custom order.');
        exitEditMode();
      } else {
        alert('Server reorder failed: ' + (result.error || result.data?.error));
      }
    } else {
      // In-browser memory reordering
      state.currentRead.pages = state.stagedPages.map((p, idx) => ({ ...p, index: idx + 1 }));
      state.hasUnsavedChanges = false;
      alert('✅ Page sequence updated in memory!');
      exitEditMode();
    }
  }

  async function deletePage(index) {
    const page = state.stagedPages[index];
    if (!page) return;

    const confirmDel = confirm(`Delete page "${page.filename}"?`);
    if (!confirmDel) return;

    if (state.serverMode) {
      showLoading(true, 'DELETING PAGE FROM SERVER...', 50, 'Removing file from server disk...');
      const result = await safeFetchJson(`/api/reads/${encodeURIComponent(state.currentRead.id)}/delete-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: page.filename })
      });
      showLoading(false);

      if (result.ok && result.data.success) {
        state.currentRead = result.data.read;
        state.stagedPages = JSON.parse(JSON.stringify(result.data.read.pages));
        state.hasUnsavedChanges = false;
        renderEditCards();
        updateEditBarStatus();
      } else {
        alert('Error deleting page: ' + (result.error || result.data?.error));
      }
    } else {
      state.stagedPages.splice(index, 1);
      state.hasUnsavedChanges = true;
      renderEditCards();
      updateEditBarStatus();
    }
  }

  async function deleteCurrentRead() {
    if (!state.currentRead) return;
    const confirmDel = confirm(`Permanently delete read "${state.currentRead.title}"?`);
    if (!confirmDel) return;

    if (state.serverMode) {
      await safeFetchJson(`/api/reads/${encodeURIComponent(state.currentRead.id)}`, { method: 'DELETE' });
      await refreshServerReads();
    } else {
      state.reads.splice(state.activeReadIndex, 1);
      if (state.reads.length > 0) switchRead(0);
      else showEmptyState();
      updateShelfUI();
    }
  }

  // --- MULTI-USER SYNC POLLING ---
  function startSyncPolling() {
    if (!state.serverMode) return;
    state.syncTimer = setInterval(async () => {
      if (state.isEditing) return;

      const check = await safeFetchJson('/api/reads');
      if (check.ok && check.data.success) {
        state.reads = check.data.reads;
        updateHudUI();

        if (state.currentRead) {
          const activeServerSummary = check.data.reads.find(r => r.id === state.currentRead.id);
          if (activeServerSummary && activeServerSummary.updatedAt > state.lastKnownUpdate) {
            console.log('[SYNC] Server folder changed. Reloading pages...');
            el.serverSyncStatus.textContent = '⚡ SYNCING...';
            await loadRead(state.activeReadIndex);
            setTimeout(() => {
              el.serverSyncStatus.textContent = '● SERVER DISK ACTIVE';
            }, 1000);
          }
        }
      }
    }, 4000);
  }

  // --- DEMO READS GENERATOR ---
  async function createDemoReads() {
    showLoading(true, 'CREATING DEMO READS...', 20, 'Synthesizing schematics and manga strips...');

    try {
      if (typeof JSZip === 'undefined') {
        alert('JSZip library is not loaded.');
        showLoading(false);
        return;
      }

      const zip1 = new JSZip();
      const zip2 = new JSZip();

      for (let i = 1; i <= 6; i++) {
        const c1 = document.createElement('canvas'); c1.width = 1200; c1.height = 1600;
        renderSchematicPage(c1.getContext('2d'), i, 6);
        const b1 = await new Promise(r => c1.toBlob(r, 'image/webp', 0.9));
        zip1.file(`0${i}_cyber_blueprint.webp`, b1);

        const c2 = document.createElement('canvas'); c2.width = 1200; c2.height = 1700;
        renderMangaPage(c2.getContext('2d'), i, 6);
        const b2 = await new Promise(r => c2.toBlob(r, 'image/jpeg', 0.9));
        zip2.file(`0${i}_orbital_episode.jpg`, b2);
      }

      const blob1 = await zip1.generateAsync({ type: 'blob' });
      const blob2 = await zip2.generateAsync({ type: 'blob' });

      const file1 = new File([blob1], 'DEMO_01_CYBER_BLUEPRINT.zip', { type: 'application/zip' });
      const file2 = new File([blob2], 'DEMO_02_ORBITAL_MANGA.zip', { type: 'application/zip' });

      await handleFilesSelected([file1, file2]);
    } catch (err) {
      console.error('Demo creation error:', err);
      alert('Error creating demo: ' + err.message);
      showLoading(false);
    }
  }

  function renderSchematicPage(ctx, pageNum, total) {
    ctx.fillStyle = '#080d1a'; ctx.fillRect(0, 0, 1200, 1600);
    ctx.strokeStyle = '#14213d'; ctx.lineWidth = 1;
    for (let x = 0; x < 1200; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 1600); ctx.stroke(); }
    ctx.strokeStyle = '#06b6d4'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(600, 0); ctx.lineTo(600, 1600); ctx.stroke();
    ctx.fillStyle = '#0f172a'; ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2;
    ctx.fillRect(150, 200, 900, 320); ctx.strokeRect(150, 200, 900, 320);
    ctx.fillStyle = '#38bdf8'; ctx.font = 'bold 36px monospace';
    ctx.fillText(`SECTOR 0${pageNum} // SCHEMATIC RELAY`, 200, 270);
    ctx.fillStyle = '#94a3b8'; ctx.font = '22px monospace';
    ctx.fillText(`DUAL-MODE ENGINE: ZERO DEPENDENCIES REQUIRED`, 200, 330);
    ctx.fillText(`PAGE ${pageNum} OF ${total}`, 200, 390);
    ctx.fillStyle = '#10b981'; ctx.fillText(`STATUS: NOMINAL (CONNECTED ACROSS STRIP)`, 200, 450);
  }

  function renderMangaPage(ctx, pageNum, total) {
    ctx.fillStyle = '#0f0f14'; ctx.fillRect(0, 0, 1200, 1700);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 5;
    ctx.fillStyle = '#171722'; ctx.fillRect(80, 80, 1040, 480); ctx.strokeRect(80, 80, 1040, 480);
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 42px sans-serif';
    ctx.fillText(`ORBITAL PROTOCOL // EPISODE 02`, 140, 170);
    ctx.fillStyle = '#38bdf8'; ctx.font = 'bold 28px monospace';
    ctx.fillText(`PAGE ${pageNum} OF ${total} — STRIP VIEWER`, 140, 230);
  }

  // --- TELEMETRY & HUD UPDATES ---
  function updateTelemetryCurrentPage(pageNum) {
    if (!state.currentRead) return;
    el.telemPage.textContent = String(pageNum).padStart(2, '0');
    el.telemTotal.textContent = String(state.currentRead.pages.length).padStart(2, '0');
    el.radarCurrentPage.textContent = pageNum;
    el.radarTotalPages.textContent = state.currentRead.pages.length;
    const progress = (pageNum - 1) / Math.max(1, state.currentRead.pages.length - 1);
    el.radarScrubThumb.style.top = `${progress * 76}px`;
  }

  function setupScrollMonitoring() {
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          const scrollTop = window.scrollY;
          const maxScroll = document.body.scrollHeight - window.innerHeight;
          const pct = maxScroll > 0 ? Math.min(100, Math.round((scrollTop / maxScroll) * 100)) : 0;
          el.telemPercent.textContent = `${pct}%`;
          ticking = false;
        });
        ticking = true;
      }
    });
  }

  function handleScrubTrackClick(e) {
    if (!state.currentRead) return;
    const rect = el.radarScrubTrack.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const ratio = Math.max(0, Math.min(1, clickY / rect.height));
    const targetPage = Math.max(1, Math.round(ratio * state.currentRead.pages.length));
    jumpToPage(targetPage);
  }

  function jumpToPage(pageNum) {
    if (state.readingMode === 'long-strip') {
      const targetEl = document.getElementById(`page-frame-${pageNum}`);
      if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      state.pagedIndex = Math.max(0, pageNum - 1);
      renderPagedMode(state.currentRead);
    }
  }

  function updateHudUI() {
    const totalReads = state.reads.length;
    el.readsCount.textContent = totalReads;
    if (totalReads > 0 && state.activeReadIndex >= 0 && state.reads[state.activeReadIndex]) {
      const read = state.reads[state.activeReadIndex];
      el.currentReadBadge.textContent = `READ ${state.activeReadIndex + 1}/${totalReads}`;
      el.currentReadTitle.textContent = read.title || read.folderName;
      el.currentReadPages.textContent = `${read.pageCount || read.pages?.length || 0} P`;
      el.btnPrevRead.disabled = state.activeReadIndex === 0;
      el.btnNextRead.disabled = state.activeReadIndex === totalReads - 1;
      el.btnPrevRead.style.opacity = state.activeReadIndex === 0 ? '0.4' : '1';
      el.btnNextRead.style.opacity = state.activeReadIndex === totalReads - 1 ? '0.4' : '1';
    }
  }

  function toggleReadsDrawer() {
    if (el.readsDrawer.classList.contains('hidden')) {
      updateShelfUI();
      el.readsDrawer.classList.remove('hidden');
    } else {
      closeReadsDrawer();
    }
  }

  function closeReadsDrawer() { el.readsDrawer.classList.add('hidden'); }

  function updateShelfUI() {
    el.shelfCount.textContent = state.reads.length;
    el.shelfSummary.textContent = state.serverMode
      ? `${state.reads.length} server folders in /data/reads/`
      : `${state.reads.length} in-browser reads in memory`;
    el.shelfGrid.innerHTML = '';

    state.reads.forEach((read, idx) => {
      const card = document.createElement('div');
      card.className = `shelf-card ${idx === state.activeReadIndex ? 'active-read' : ''}`;

      const thumb = document.createElement('img');
      thumb.className = 'shelf-thumb';
      thumb.src = read.firstPageUrl || (read.pages && read.pages[0]?.url) || '';
      thumb.alt = read.title || read.folderName;

      const info = document.createElement('div');
      info.className = 'shelf-info';
      const pagesCount = read.pageCount || (read.pages ? read.pages.length : 0);
      info.innerHTML = `
        <div class="shelf-title">${read.title || read.folderName}</div>
        <div class="shelf-meta">${pagesCount} Pages • ${(read.totalSize / (1024 * 1024)).toFixed(2)} MB</div>
      `;

      card.appendChild(thumb);
      card.appendChild(info);

      card.addEventListener('click', () => {
        loadRead(idx);
        closeReadsDrawer();
      });

      el.shelfGrid.appendChild(card);
    });
  }

  function updateFiltersStyle() {
    el.stripContainer.style.setProperty('--filter-brightness', `${state.brightness}%`);
    el.stripContainer.style.setProperty('--filter-contrast', `${state.contrast}%`);
    el.stripContainer.style.setProperty('--filter-invert', state.invert ? '100%' : '0%');
    el.stripContainer.style.setProperty('--filter-grayscale', state.grayscale ? '100%' : '0%');
    el.stripContainer.className = `strip-container gap-${state.gap}`;
  }

  function resetFilters() {
    state.gap = 0; state.brightness = 100; state.contrast = 100; state.invert = false; state.grayscale = false;
    el.rangeGap.value = 0; el.valGap.textContent = '0px (Seamless Strip)';
    el.rangeBrightness.value = 100; el.valBrightness.textContent = '100%';
    el.rangeContrast.value = 100; el.valContrast.textContent = '100%';
    el.checkInvert.checked = false; el.checkGrayscale.checked = false;
    updateFiltersStyle();
  }

  function openSpecsModal() {
    const currentRead = state.currentRead;
    if (!currentRead) return;

    el.specsModalTitle.textContent = `READ: ${currentRead.title}`;
    el.specFolderName.textContent = state.serverMode ? `/data/reads/${currentRead.folderName}` : 'In-Browser RAM';
    el.specPayloadSize.textContent = `${(currentRead.totalSize / (1024 * 1024)).toFixed(2)} MB (${currentRead.totalSize.toLocaleString()} bytes)`;
    el.specImageCount.textContent = `${currentRead.pages.length} PAGES`;
    el.specLastUpdate.textContent = new Date(currentRead.updatedAt || Date.now()).toLocaleString();

    el.specsManifestTbody.innerHTML = '';
    currentRead.pages.forEach((p, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>#${String(idx + 1).padStart(2, '0')}</td>
        <td style="font-family: monospace;">${p.filename}</td>
        <td><span class="spec-tag">${(p.ext || 'IMG').toUpperCase()}</span></td>
        <td>${(p.size / 1024).toFixed(1)} KB</td>
        <td><a href="${p.url}" target="_blank" class="table-btn-dl">VIEW ORIGINAL</a></td>
      `;
      el.specsManifestTbody.appendChild(tr);
    });

    openModal(el.modalSpecs);
  }

  function openModal(modalEl) { modalEl.classList.remove('hidden'); }
  function closeModal(modalEl) { modalEl.classList.add('hidden'); }

  function showLoading(show, title = '', percent = 0, meta = '') {
    if (show) {
      el.loadingTitle.textContent = title;
      el.loadingProgressFill.style.width = `${percent}%`;
      el.loadingMeta.textContent = meta;
      el.loadingOverlay.classList.remove('hidden');
    } else {
      el.loadingOverlay.classList.add('hidden');
    }
  }

  function updateLoading(title, percent, meta) {
    el.loadingTitle.textContent = title;
    el.loadingProgressFill.style.width = `${percent}%`;
    el.loadingMeta.textContent = meta;
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
    }
  }

  function handleGlobalKeydown(e) {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    switch (e.key) {
      case '[': e.preventDefault(); switchRead(state.activeReadIndex - 1); break;
      case ']': e.preventDefault(); switchRead(state.activeReadIndex + 1); break;
      case 'e': case 'E': e.preventDefault(); toggleEditMode(); break;
      case 'f': case 'F': e.preventDefault(); toggleFullscreen(); break;
      case 'l': case 'L': e.preventDefault(); toggleReadsDrawer(); break;
      case 'h': case 'H': e.preventDefault(); state.hudVisible = !state.hudVisible; el.topHud.classList.toggle('hud-collapsed', !state.hudVisible); break;
      case 'Escape': closeModal(el.modalFilters); closeModal(el.modalSpecs); closeReadsDrawer(); if (state.isEditing) exitEditMode(); break;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
