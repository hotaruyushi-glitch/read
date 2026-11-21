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

  const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'svg']);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

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

    // Read Editor & Image Replacement
    modalReadEditor: document.getElementById('modal-read-editor'),
    editorReadTitle: document.getElementById('editor-read-title'),
    editorReadSub: document.getElementById('editor-read-sub'),
    inputEditorZip: document.getElementById('input-editor-zip'),
    btnEditorUploadZip: document.getElementById('btn-editor-upload-zip'),
    editorReplacementTray: document.getElementById('editor-replacement-tray'),
    trayCount: document.getElementById('tray-count'),
    trayImagesList: document.getElementById('tray-images-list'),
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
      await connectGitHub();
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
          const errMsg = errData.message || '';
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

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message || `GitHub API error: HTTP ${res.status}`);
        }
        return await res.json();
      } catch (err) {
        lastError = err;
        if (attempt >= retries || !/rate limit|secondary|fetch|network/i.test(err.message)) {
          throw err;
        }
        await sleep(1500 * (attempt + 1));
      }
    }
    throw lastError;
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

      await syncReadsFromGitHub();
      showLoading(false);
    } catch (err) {
      showLoading(false);
      state.ghConnected = false;
      updateGitHubStatusUI(false);
      alert('Could not connect to GitHub repository: ' + err.message);
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

  // Sync existing reads from GitHub repository
  async function syncReadsFromGitHub() {
    if (!state.ghConnected) return;

    try {
      const cleanPath = (state.ghConfig.path || 'reads').replace(/^\/|\/$/g, '');
      const contents = await ghRequest(`/repos/${state.ghConfig.repo}/contents/${cleanPath}?ref=${state.ghConfig.branch}`).catch(() => []);

      // Check if global library_order.json exists on GitHub
      let savedOrder = [];
      const orderFile = contents.find(f => f.name === 'library_order.json');
      if (orderFile) {
        try {
          const orderRes = await fetch(orderFile.download_url);
          const orderData = await orderRes.json();
          if (Array.isArray(orderData.order)) savedOrder = orderData.order;
        } catch (e) {
          console.warn('Could not read library_order.json:', e);
        }
      }

      // If not on GitHub, check local storage
      if (savedOrder.length === 0) {
        const localOrder = localStorage.getItem('sr_library_order');
        if (localOrder) {
          try { savedOrder = JSON.parse(localOrder); } catch (e) {}
        }
      }

      const folders = contents.filter(item => item.type === 'dir');
      const loadedReads = [];

      for (const dir of folders) {
        try {
          const files = await ghRequest(`/repos/${state.ghConfig.repo}/contents/${dir.path}?ref=${state.ghConfig.branch}`);

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

          // Sequence images according to manifest or natural sort
          if (manifest && manifest.pages && manifest.pages.length > 0) {
            const orderMap = new Map();
            manifest.pages.forEach((p, idx) => orderMap.set(p.filename, idx));
            imageFiles.sort((a, b) => {
              const oA = orderMap.has(a.name) ? orderMap.get(a.name) : 9999;
              const oB = orderMap.has(b.name) ? orderMap.get(b.name) : 9999;
              return oA - oB;
            });
          } else {
            imageFiles.sort((a, b) => collator.compare(a.name, b.name));
          }

          const pages = imageFiles.map((f, idx) => ({
            index: idx + 1,
            filename: f.name,
            url: f.download_url,
            size: f.size,
            sha: f.sha
          }));

          if (pages.length > 0) {
            loadedReads.push({
              id: dir.name,
              title: manifest?.title || dir.name.replace(/_/g, ' '),
              path: dir.path,
              pages: pages,
              pageCount: pages.length,
              isGitHub: true
            });
          }
        } catch (e) {
          console.warn(`Could not load folder ${dir.name}:`, e);
        }
      }

      // Sort reads according to saved library order if available
      if (savedOrder.length > 0) {
        const orderMap = new Map();
        savedOrder.forEach((id, idx) => orderMap.set(id, idx));
        loadedReads.sort((a, b) => {
          const oA = orderMap.has(a.id) ? orderMap.get(a.id) : 9999;
          const oB = orderMap.has(b.id) ? orderMap.get(b.id) : 9999;
          return oA - oB;
        });
      }

      state.reads = loadedReads;
      updateLibraryUI();

      if (state.reads.length > 0) {
        loadRead(0);
      } else {
        showEmptyState();
      }
    } catch (err) {
      console.warn('Error reading from GitHub:', err);
    }
  }

  // Save new read to GitHub repository
  async function saveReadToGitHub(read) {
    if (!state.ghConnected) return;

    const cleanPath = (state.ghConfig.path || 'reads').replace(/^\/|\/$/g, '');
    const folderPath = `${cleanPath}/${read.id}`;

    showLoading(true, 'Saving read to your GitHub repository...', 0, 'Committing pages...');

    for (let i = 0; i < read.pages.length; i++) {
      const page = read.pages[i];
      const pct = Math.round(((i + 1) / read.pages.length) * 85);
      updateLoading(`Saving page ${i + 1} of ${read.pages.length} to GitHub...`, pct, page.filename);

      if (!page.sha && page.blob) {
        const base64 = await blobToBase64(page.blob);

        let existingSha = null;
        try {
          const exFile = await ghRequest(`/repos/${state.ghConfig.repo}/contents/${folderPath}/${page.filename}?ref=${state.ghConfig.branch}`);
          existingSha = exFile.sha;
        } catch (e) {}

        const putBody = {
          message: `Add ${read.title} - ${page.filename}`,
          content: base64,
          branch: state.ghConfig.branch
        };
        if (existingSha) putBody.sha = existingSha;

        const res = await ghRequest(`/repos/${state.ghConfig.repo}/contents/${folderPath}/${page.filename}`, {
          method: 'PUT',
          body: JSON.stringify(putBody)
        });
        page.sha = res.content?.sha || null;
      }

      // Pacing delay to avoid secondary rate limits
      await sleep(250);
    }

    const manifest = {
      title: read.title,
      createdAt: read.createdAt || Date.now(),
      updatedAt: Date.now(),
      pages: read.pages.map(p => ({ filename: p.filename, order: p.index }))
    };

    updateLoading('Saving manifest to GitHub...', 95, 'manifest.json');
    const manifestBase64 = btoa(unescape(encodeURIComponent(JSON.stringify(manifest, null, 2))));
    let manifestSha = null;
    try {
      const ex = await ghRequest(`/repos/${state.ghConfig.repo}/contents/${folderPath}/manifest.json?ref=${state.ghConfig.branch}`);
      manifestSha = ex.sha;
    } catch (e) {}

    const manifestBody = {
      message: `Add manifest for ${read.title}`,
      content: manifestBase64,
      branch: state.ghConfig.branch
    };
    if (manifestSha) manifestBody.sha = manifestSha;

    await ghRequest(`/repos/${state.ghConfig.repo}/contents/${folderPath}/manifest.json`, {
      method: 'PUT',
      body: JSON.stringify(manifestBody)
    });

    read.isGitHub = true;
    showLoading(false);

    // Update library order on GitHub
    await saveLibraryOrder();
  }

  // Save library order (both to localStorage and optionally to GitHub repo)
  async function saveLibraryOrder() {
    const order = state.reads.map(r => r.id);
    localStorage.setItem('sr_library_order', JSON.stringify(order));

    if (state.ghConnected) {
      try {
        const cleanPath = (state.ghConfig.path || 'reads').replace(/^\/|\/$/g, '');
        const orderPath = `${cleanPath}/library_order.json`;

        let currentSha = null;
        try {
          const existing = await ghRequest(`/repos/${state.ghConfig.repo}/contents/${orderPath}?ref=${state.ghConfig.branch}`);
          currentSha = existing.sha;
        } catch (e) {}

        const body = {
          message: 'Update library order',
          content: btoa(unescape(encodeURIComponent(JSON.stringify({ order, updatedAt: Date.now() }, null, 2)))),
          branch: state.ghConfig.branch
        };
        if (currentSha) body.sha = currentSha;

        await ghRequest(`/repos/${state.ghConfig.repo}/contents/${orderPath}`, {
          method: 'PUT',
          body: JSON.stringify(body)
        });
      } catch (err) {
        console.warn('Could not sync library order to GitHub:', err);
      }
    }
  }

  // Move library item manually, one position at a time
  async function moveLibraryItem(index, delta) {
    const targetIdx = index + delta;
    if (targetIdx < 0 || targetIdx >= state.reads.length) return;

    // Track active read if affected
    const activeRead = state.reads[state.activeReadIndex];

    const [moved] = state.reads.splice(index, 1);
    state.reads.splice(targetIdx, 0, moved);

    if (activeRead) {
      state.activeReadIndex = state.reads.findIndex(r => r === activeRead);
    }

    updateLibraryUI();
    updateNavUI();
    await saveLibraryOrder();
  }

  // Update page order within a read on GitHub
  async function updateManifestOnGitHub(readId, orderedFilenames) {
    if (!state.ghConnected) return;

    showLoading(true, 'Updating page order in GitHub repository...', 50, 'Saving manifest.json');
    const cleanPath = (state.ghConfig.path || 'reads').replace(/^\/|\/$/g, '');
    const manifestPath = `${cleanPath}/${readId}/manifest.json`;

    let currentSha = null;
    try {
      const existing = await ghRequest(`/repos/${state.ghConfig.repo}/contents/${manifestPath}?ref=${state.ghConfig.branch}`);
      currentSha = existing.sha;
    } catch (e) {}

    const manifest = {
      title: state.currentRead.title,
      updatedAt: Date.now(),
      pages: orderedFilenames.map((fn, idx) => ({ filename: fn, order: idx + 1 }))
    };

    const manifestBase64 = btoa(unescape(encodeURIComponent(JSON.stringify(manifest, null, 2))));
    const body = {
      message: `Update page order for ${state.currentRead.title}`,
      content: manifestBase64,
      branch: state.ghConfig.branch
    };
    if (currentSha) body.sha = currentSha;

    await ghRequest(`/repos/${state.ghConfig.repo}/contents/${manifestPath}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });

    showLoading(false);
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
        if (entry.dir || relPath.includes('__MACOSX/') || relPath.startsWith('.')) return;
        const ext = relPath.split('.').pop().toLowerCase();
        if (IMAGE_EXTS.has(ext)) entries.push(entry);
      });

      if (entries.length === 0) {
        throw new Error('No valid images (JPG, PNG, WEBP) found in archive.');
      }

      entries.sort((a, b) => collator.compare(a.name, b.name));

      const pages = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const pct = Math.round(((i + 1) / entries.length) * 70) + 20;
        const fn = entry.name.split('/').pop();
        updateLoading(`Extracting page ${i + 1} of ${entries.length}...`, pct, fn);

        try {
          const blob = await entry.async('blob');
          if (blob && blob.size > 0) {
            pages.push({
              index: pages.length + 1,
              filename: fn,
              url: URL.createObjectURL(blob),
              blob: blob,
              size: blob.size
            });
          }
        } catch (e) {
          console.warn(`Skipping unreadable entry ${entry.name}:`, e);
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
      const newRead = {
        id: readId,
        title: file.name.replace(/\.[^/.]+$/, ''),
        pages: pages,
        pageCount: pages.length,
        isGitHub: false
      };

      state.reads.push(newRead);
      updateLibraryUI();
      saveLibraryOrder();
      loadRead(state.reads.length - 1);
      showLoading(false);

      if (state.ghConnected) {
        try {
          await saveReadToGitHub(newRead);
        } catch (ghErr) {
          console.error('GitHub save error:', ghErr);
          alert(`"${newRead.title}" loaded into reader successfully! Cloud sync to GitHub encountered an issue: ${ghErr.message}. You can retry or edit from the library.`);
        }
      }
    } catch (err) {
      showLoading(false);
      alert(`Could not extract ${file.name}: ` + err.message);
    }
  }

  async function processLooseImages(files) {
    showLoading(true, 'Processing image batch...', 30, `${files.length} images`);

    files.sort((a, b) => collator.compare(a.name, b.name));

    const pages = files.map((file, idx) => ({
      index: idx + 1,
      filename: file.name,
      url: URL.createObjectURL(file),
      blob: file,
      size: file.size
    }));

    const dateStr = new Date().toISOString().slice(0, 10);
    const title = `Image Set ${dateStr}`;
    const readId = `images_${Date.now()}`;

    const newRead = {
      id: readId,
      title: title,
      pages: pages,
      pageCount: pages.length,
      isGitHub: false
    };

    state.reads.push(newRead);
    updateLibraryUI();
    saveLibraryOrder();
    loadRead(state.reads.length - 1);
    showLoading(false);

    if (state.ghConnected) {
      await saveReadToGitHub(newRead);
    }
  }

  function sanitizeId(str) {
    return str.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').toLowerCase();
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
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
      img.src = page.url;
      img.alt = page.filename;
      img.loading = 'lazy';

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
    el.btnPrevRead.disabled = state.activeReadIndex <= 0;
    el.btnNextRead.disabled = state.activeReadIndex >= state.reads.length - 1;
    el.btnFooterPrev.disabled = state.activeReadIndex <= 0;
    el.btnFooterNext.disabled = state.activeReadIndex >= state.reads.length - 1;
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
    state.stagedPages = JSON.parse(JSON.stringify(state.currentRead.pages));
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

    exitEditMode();
  }

  // --- LIBRARY MODAL (WITH MANUAL REORDERING & DELETE) ---
  function updateLibraryUI() {
    el.libraryCount.textContent = state.reads.length;
    el.libraryGrid.innerHTML = '';

    state.reads.forEach((read, idx) => {
      const card = document.createElement('div');
      card.className = `library-card ${idx === state.activeReadIndex ? 'active-read' : ''}`;
      card.dataset.index = idx;
      card.draggable = true;

      card.innerHTML = `
        <div class="library-drag-handle" title="Drag to reorder">⠿</div>
        <div class="library-order-num">#${idx + 1}</div>
        <div class="library-reorder-btns">
          <button class="btn-reorder-arrow btn-lib-up" title="Move Up" ${idx === 0 ? 'disabled' : ''}>▲</button>
          <button class="btn-reorder-arrow btn-lib-down" title="Move Down" ${idx === state.reads.length - 1 ? 'disabled' : ''}>▼</button>
        </div>
        <img class="library-thumb" src="${read.pages[0]?.url || ''}" alt="">
        <div class="library-info">
          <div class="library-title">${read.title}</div>
          <div class="library-sub">${read.pages.length} Pages ${read.isGitHub ? '• Saved on GitHub' : '• Local'}</div>
        </div>
        <div class="library-actions">
          <button class="library-btn btn-edit-read" title="Edit read & replace images">Edit</button>
          <button class="library-btn btn-rename" title="Rename read">Rename</button>
          <button class="library-btn library-btn-danger btn-delete" title="Delete read">Delete</button>
        </div>
      `;

      // Up / Down manual button moves
      card.querySelector('.btn-lib-up').addEventListener('click', (e) => {
        e.stopPropagation();
        moveLibraryItem(idx, -1);
      });
      card.querySelector('.btn-lib-down').addEventListener('click', (e) => {
        e.stopPropagation();
        moveLibraryItem(idx, 1);
      });

      // Card click to load read
      card.addEventListener('click', (e) => {
        if (e.target.closest('.library-actions') || e.target.closest('.library-reorder-btns') || e.target.closest('.library-drag-handle')) return;
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

      el.libraryGrid.appendChild(card);
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
  async function handleLibDrop(e) {
    e.stopPropagation();
    const dest = parseInt(this.dataset.index, 10);
    if (state.dragLibIndex !== null && state.dragLibIndex !== dest) {
      const activeRead = state.reads[state.activeReadIndex];
      const [moved] = state.reads.splice(state.dragLibIndex, 1);
      state.reads.splice(dest, 0, moved);

      if (activeRead) {
        state.activeReadIndex = state.reads.findIndex(r => r === activeRead);
      }
      updateLibraryUI();
      updateNavUI();
      await saveLibraryOrder();
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
          await ghRequest(`/repos/${state.ghConfig.repo}/contents/${f.path}`, {
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
        alert(`Error deleting from GitHub: ${err.message}`);
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

    updateLibraryUI();
    updateNavUI();
    saveLibraryOrder();
  }

  async function renameRead(idx) {
    if (idx < 0 || idx >= state.reads.length) return;
    const read = state.reads[idx];
    if (!read) return;

    const newTitle = prompt('Enter new title for this read:', read.title);
    if (!newTitle || newTitle.trim() === '' || newTitle.trim() === read.title) return;

    read.title = newTitle.trim();

    if (read.isGitHub && state.ghConnected) {
      await updateManifestOnGitHub(read.id, read.pages.map(p => p.filename));
    }

    if (state.activeReadIndex === idx) {
      el.activeReadTitle.textContent = read.title;
    }

    updateLibraryUI();
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
        <button class="tray-btn-use" title="Assign this image to replace a page">Assign to Page...</button>
      `;

      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', String(trayIdx));
        e.dataTransfer.effectAllowed = 'copy';
      });

      card.querySelector('.tray-btn-use').addEventListener('click', (e) => {
        e.stopPropagation();
        promptAssignTrayItem(trayIdx);
      });

      el.trayImagesList.appendChild(card);
    });
  }

  function promptAssignTrayItem(trayIdx) {
    const item = editorState.replacementTray[trayIdx];
    if (!item) return;

    const pageCount = editorState.pages.length;
    const input = prompt(`Assign "${item.filename}" to replace which page?\nEnter a page number (1 to ${pageCount}), or type "append" to add at end:`, '1');
    if (!input) return;

    if (input.trim().toLowerCase() === 'append') {
      editorState.pages.push({
        id: 'p_app_' + Date.now(),
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
      return;
    }

    const pageNum = parseInt(input.trim(), 10);
    if (isNaN(pageNum) || pageNum < 1 || pageNum > pageCount) {
      alert(`Please enter a valid page number between 1 and ${pageCount}.`);
      return;
    }

    replacePageWithTrayItem(pageNum - 1, trayIdx);
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
    const files = Array.from(fileList);
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
    if (modified > 0) msg.push(`${modified} page(s) replaced`);
    if (isCountChanged) msg.push(`total pages: ${editorState.pages.length} (was ${initialCount})`);

    if (msg.length > 0) {
      el.editorChangesStatus.textContent = msg.join(' • ') + ' (unsaved)';
      el.btnSaveReadEditor.disabled = false;
    } else {
      el.editorChangesStatus.textContent = 'No modifications yet';
      el.btnSaveReadEditor.disabled = false;
    }
  }

  async function handleEditorZipUpload(fileList) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);

    showLoading(true, 'Processing replacement archive/images...', 20, 'Reading files');

    try {
      for (const file of files) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (['zip', 'cbz'].includes(ext)) {
          const zip = new JSZip();
          const loadedZip = await zip.loadAsync(file);
          const entries = [];

          loadedZip.forEach((relPath, entry) => {
            if (entry.dir || relPath.includes('__MACOSX/') || relPath.startsWith('.')) return;
            const entryExt = relPath.split('.').pop().toLowerCase();
            if (IMAGE_EXTS.has(entryExt)) entries.push(entry);
          });

          entries.sort((a, b) => collator.compare(a.name, b.name));

          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const pct = Math.round(((i + 1) / entries.length) * 70) + 20;
            const fn = entry.name.split('/').pop();
            updateLoading(`Unpacking replacement ${i + 1} of ${entries.length}...`, pct, fn);

            try {
              const blob = await entry.async('blob');
              if (blob && blob.size > 0) {
                editorState.replacementTray.push({
                  id: 'tray_' + Math.random().toString(36).substr(2, 6),
                  filename: fn,
                  url: URL.createObjectURL(blob),
                  blob: blob,
                  size: blob.size
                });
              }
            } catch (entryErr) {
              console.warn('Skipping entry:', entry.name, entryErr);
            }

            if (i % 3 === 0) await sleep(5);
          }
        } else if (IMAGE_EXTS.has(ext)) {
          editorState.replacementTray.push({
            id: 'tray_' + Math.random().toString(36).substr(2, 6),
            filename: file.name,
            url: URL.createObjectURL(file),
            blob: file,
            size: file.size
          });
        }
      }

      showLoading(false);
      renderReplacementTray();
    } catch (err) {
      showLoading(false);
      alert('Could not unpack replacement files: ' + err.message);
    }
  }

  async function saveReadEditorChanges() {
    const targetRead = editorState.read;
    if (!targetRead) return;

    const modifiedPages = editorState.pages.filter(p => p.isModified);
    const hasGitHub = state.ghConnected && targetRead.isGitHub;

    if (hasGitHub) {
      showLoading(true, `Saving changes to GitHub for "${targetRead.title}"...`, 10, 'Committing modified pages');
      const cleanPath = (state.ghConfig.path || 'reads').replace(/^\/|\/$/g, '');
      const folderPath = `${cleanPath}/${targetRead.id}`;

      try {
        for (let i = 0; i < modifiedPages.length; i++) {
          const page = modifiedPages[i];
          const pct = Math.round(((i + 1) / (modifiedPages.length + 1)) * 80) + 10;
          updateLoading(`Committing page ${i + 1} of ${modifiedPages.length}: ${page.filename}`, pct, 'Pacing commits to protect GitHub rate limits');

          let existingSha = page.sha;
          if (!existingSha) {
            try {
              const info = await ghRequest(`/repos/${state.ghConfig.repo}/contents/${folderPath}/${page.filename}?ref=${state.ghConfig.branch}`);
              existingSha = info.sha;
            } catch (e) {}
          }

          const base64 = await blobToBase64(page.blob);
          const body = {
            message: `Update ${targetRead.title} - ${page.filename}`,
            content: base64,
            branch: state.ghConfig.branch
          };
          if (existingSha) body.sha = existingSha;

          const res = await ghRequest(`/repos/${state.ghConfig.repo}/contents/${folderPath}/${page.filename}`, {
            method: 'PUT',
            body: JSON.stringify(body)
          });
          page.sha = res.content?.sha || null;
          page.isModified = false;

          await sleep(250);
        }

        updateLoading('Updating manifest.json on GitHub...', 95, 'Saving sequence');
        const manifestPath = `${cleanPath}/${targetRead.id}/manifest.json`;
        let manifestSha = null;
        try {
          const ex = await ghRequest(`/repos/${state.ghConfig.repo}/contents/${manifestPath}?ref=${state.ghConfig.branch}`);
          manifestSha = ex.sha;
        } catch (e) {}

        const manifest = {
          title: targetRead.title,
          updatedAt: Date.now(),
          pages: editorState.pages.map((p, idx) => ({ filename: p.filename, order: idx + 1 }))
        };
        const manifestBody = {
          message: `Update manifest and pages for ${targetRead.title}`,
          content: btoa(unescape(encodeURIComponent(JSON.stringify(manifest, null, 2)))),
          branch: state.ghConfig.branch
        };
        if (manifestSha) manifestBody.sha = manifestSha;

        await ghRequest(`/repos/${state.ghConfig.repo}/contents/${manifestPath}`, {
          method: 'PUT',
          body: JSON.stringify(manifestBody)
        });

      } catch (ghErr) {
        showLoading(false);
        alert('Encountered issue while saving to GitHub: ' + ghErr.message);
        return;
      }
    }

    targetRead.pages = editorState.pages.map((p, idx) => ({
      index: idx + 1,
      filename: p.filename,
      url: p.url,
      blob: p.blob || null,
      size: p.size || 0,
      sha: p.sha || null
    }));
    targetRead.pageCount = targetRead.pages.length;

    showLoading(false);
    closeModal(el.modalReadEditor);

    if (state.activeReadIndex === editorState.readIndex) {
      state.currentRead = targetRead;
      renderStrip();
      updateNavUI();
    }

    updateLibraryUI();
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

    // Read navigation
    el.btnPrevRead.addEventListener('click', () => loadRead(state.activeReadIndex - 1));
    el.btnNextRead.addEventListener('click', () => loadRead(state.activeReadIndex + 1));
    el.btnFooterPrev.addEventListener('click', () => loadRead(state.activeReadIndex - 1));
    el.btnFooterNext.addEventListener('click', () => loadRead(state.activeReadIndex + 1));
    el.btnFooterTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    if (el.btnFooterEdit) {
      el.btnFooterEdit.addEventListener('click', () => {
        if (state.activeReadIndex >= 0) openReadEditor(state.activeReadIndex);
      });
    }
    if (el.btnFooterDelete) {
      el.btnFooterDelete.addEventListener('click', () => deleteRead(state.activeReadIndex));
    }

    // Library
    el.btnOpenShelf.addEventListener('click', () => openModal(el.modalLibrary));
    el.btnLibrarySync.addEventListener('click', syncReadsFromGitHub);

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
      state.stagedPages = JSON.parse(JSON.stringify(state.currentRead.pages));
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
      if (e.key === '[') loadRead(state.activeReadIndex - 1);
      if (e.key === ']') loadRead(state.activeReadIndex + 1);
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
