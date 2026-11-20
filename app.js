/**
 * Strip Reader — Minimalist Long Strip Viewer with GitHub Repository Cloud Storage
 * - Works 100% on GitHub Pages (static, zero-server)
 * - Saves reads directly to your GitHub repository via GitHub REST API
 * - Persistent forever across all devices (phone, laptop, tablet)
 * - Unpacks ZIP, CBZ, and batches of images with natural alphanumeric ordering
 * - Live Edit Order mode
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
    stripWidth: '1200',

    // Edit Mode
    isEditing: false,
    stagedPages: [],
    hasUnsavedChanges: false,
    dragSrcIndex: null,

    pageObserver: null
  };

  const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'svg']);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  // DOM Elements
  const el = {
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
    btnFooterNext: document.getElementById('btn-footer-next'),

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
    btnLibrarySync: document.getElementById('btn-library-sync')
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

    // Check if GitHub is already configured
    if (state.ghConfig.repo && state.ghConfig.token) {
      await connectGitHub();
    } else {
      updateGitHubStatusUI(false);
    }
  }

  // --- GITHUB REPOSITORY CLOUD STORAGE API ---
  async function ghRequest(endpoint, options = {}) {
    if (!state.ghConfig.token) throw new Error('GitHub Personal Access Token not provided.');
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${state.ghConfig.token.trim()}`,
      ...(options.headers || {})
    };
    const res = await fetch(`https://api.github.com${endpoint}`, { ...options, headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `GitHub API error: HTTP ${res.status}`);
    }
    return res.json();
  }

  async function connectGitHub() {
    showLoading(true, 'Connecting to GitHub repository...', 30, state.ghConfig.repo);
    try {
      const repoData = await ghRequest(`/repos/${state.ghConfig.repo.trim()}`);
      state.ghConnected = true;
      updateGitHubStatusUI(true);

      // Save to localStorage
      localStorage.setItem('sr_gh_repo', state.ghConfig.repo.trim());
      localStorage.setItem('sr_gh_token', state.ghConfig.token.trim());
      localStorage.setItem('sr_gh_branch', state.ghConfig.branch.trim() || 'main');
      localStorage.setItem('sr_gh_path', state.ghConfig.path.trim() || 'reads');

      // Fetch existing reads from GitHub
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

  // Sync existing reads from the user's GitHub repo folder
  async function syncReadsFromGitHub() {
    if (!state.ghConnected) return;

    try {
      const cleanPath = (state.ghConfig.path || 'reads').replace(/^\/|\/$/g, '');
      const contents = await ghRequest(`/repos/${state.ghConfig.repo}/contents/${cleanPath}?ref=${state.ghConfig.branch}`).catch(() => []);

      const folders = contents.filter(item => item.type === 'dir');
      const loadedReads = [];

      for (const dir of folders) {
        try {
          const files = await ghRequest(`/repos/${state.ghConfig.repo}/contents/${dir.path}?ref=${state.ghConfig.branch}`);

          // Check if manifest exists
          const manifestFile = files.find(f => f.name === 'manifest.json');
          let manifest = null;
          if (manifestFile) {
            const manifestRes = await fetch(manifestFile.download_url);
            manifest = await manifestRes.json();
          }

          // Image files
          const imageFiles = files.filter(f => {
            const ext = f.name.split('.').pop().toLowerCase();
            return IMAGE_EXTS.has(ext);
          });

          // Order images: use manifest order if available, otherwise natural sort
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

  // Commit a newly uploaded read directly into the user's GitHub repository
  async function saveReadToGitHub(read) {
    if (!state.ghConnected) return;

    const cleanPath = (state.ghConfig.path || 'reads').replace(/^\/|\/$/g, '');
    const folderPath = `${cleanPath}/${read.id}`;

    showLoading(true, 'Saving read to your GitHub repository...', 0, 'Committing pages...');

    for (let i = 0; i < read.pages.length; i++) {
      const page = read.pages[i];
      const pct = Math.round(((i + 1) / read.pages.length) * 90);
      updateLoading(`Saving page ${i + 1} of ${read.pages.length} to GitHub...`, pct, page.filename);

      // Convert page blob / data to base64
      const base64 = await blobToBase64(page.blob);

      // Commit file to GitHub via PUT /repos/{owner}/{repo}/contents/{path}
      await ghRequest(`/repos/${state.ghConfig.repo}/contents/${folderPath}/${page.filename}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: `Add ${read.title} - ${page.filename}`,
          content: base64,
          branch: state.ghConfig.branch
        })
      });
    }

    // Write manifest.json
    const manifest = {
      title: read.title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pages: read.pages.map(p => ({ filename: p.filename, order: p.index }))
    };

    const manifestBase64 = btoa(unescape(encodeURIComponent(JSON.stringify(manifest, null, 2))));
    await ghRequest(`/repos/${state.ghConfig.repo}/contents/${folderPath}/manifest.json`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `Add manifest for ${read.title}`,
        content: manifestBase64,
        branch: state.ghConfig.branch
      })
    });

    read.isGitHub = true;
    showLoading(false);
  }

  // Update manifest.json on GitHub when user reorders pages in Edit Mode
  async function updateManifestOnGitHub(readId, orderedFilenames) {
    if (!state.ghConnected) return;

    showLoading(true, 'Updating page order in GitHub repository...', 50, 'Saving manifest.json');
    const cleanPath = (state.ghConfig.path || 'reads').replace(/^\/|\/$/g, '');
    const manifestPath = `${cleanPath}/${readId}/manifest.json`;

    // Get current manifest sha to overwrite
    let currentSha = null;
    try {
      const existing = await ghRequest(`/repos/${state.ghConfig.repo}/contents/${manifestPath}?ref=${state.ghConfig.branch}`);
      currentSha = existing.sha;
    } catch (e) {
      // Manifest does not exist yet
    }

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

  // --- FILE HANDLING PIPELINE (ZIP, RAR, IMAGES) ---
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

    // Process ZIP / CBZ archives
    for (const arch of archives) {
      const ext = arch.name.split('.').pop().toLowerCase();
      if (['zip', 'cbz'].includes(ext)) {
        await unpackZipArchive(arch);
      } else {
        // RAR / 7Z notice
        alert(`RAR archive "${arch.name}" detected. ZIP and raw images are recommended for static GitHub hosting. Please convert to ZIP or extract images before uploading.`);
      }
    }

    // Process loose images uploaded together
    if (images.length > 0) {
      await processLooseImages(images);
    }
  }

  // Unpack ZIP directly in browser
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

      // Natural sort
      entries.sort((a, b) => collator.compare(a.name, b.name));

      const pages = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const blob = await entry.async('blob');
        const url = URL.createObjectURL(blob);
        pages.push({
          index: i + 1,
          filename: entry.name.split('/').pop(),
          url: url,
          blob: blob,
          size: blob.size
        });
      }

      const readId = sanitizeId(file.name.replace(/\.[^/.]+$/, ''));
      const newRead = {
        id: readId,
        title: file.name.replace(/\.[^/.]+$/, ''),
        pages: pages,
        pageCount: pages.length,
        isGitHub: false
      };

      state.reads.push(newRead);
      updateLibraryUI();
      loadRead(state.reads.length - 1);
      showLoading(false);

      // If GitHub is connected, save to repository
      if (state.ghConnected) {
        await saveReadToGitHub(newRead);
      }
    } catch (err) {
      showLoading(false);
      alert(`Could not extract ${file.name}: ` + err.message);
    }
  }

  // Process a batch of loose images
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
    // Basic telemetry tracking
  }

  function showEmptyState() {
    el.readerView.classList.add('hidden');
    el.readNav.classList.add('hidden');
    el.telemetryBox.classList.add('hidden');
    el.btnEditOrder.classList.add('hidden');
    el.dropZone.classList.remove('hidden');
  }

  function updateNavUI() {
    el.btnPrevRead.disabled = state.activeReadIndex <= 0;
    el.btnNextRead.disabled = state.activeReadIndex >= state.reads.length - 1;
  }

  // --- EDIT ORDER MODE ---
  function toggleEditMode() {
    if (state.isEditing) exitEditMode();
    else enterEditMode();
  }

  function enterEditMode() {
    if (!state.currentRead) return;
    state.isEditing = true;
    state.stagedPages = JSON.parse(JSON.stringify(state.currentRead.pages));
    state.hasUnsavedChanges = false;

    el.btnEditOrder.textContent = '✕ Exit Edit';
    el.editBar.classList.remove('hidden');
    el.editCardsContainer.classList.remove('hidden');
    el.stripOuter.classList.add('hidden');

    renderEditCards();
  }

  function exitEditMode() {
    state.isEditing = false;
    state.hasUnsavedChanges = false;
    el.btnEditOrder.textContent = 'Edit Order';
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
        </div>
      `;

      card.querySelector('.btn-up').addEventListener('click', () => movePage(idx, -1));
      card.querySelector('.btn-down').addEventListener('click', () => movePage(idx, 1));

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

    // Update read in state
    state.currentRead.pages = state.stagedPages.map((p, idx) => ({ ...p, index: idx + 1 }));
    state.hasUnsavedChanges = false;

    // If connected to GitHub, update manifest on repo
    if (state.ghConnected && state.currentRead.isGitHub) {
      await updateManifestOnGitHub(state.currentRead.id, state.currentRead.pages.map(p => p.filename));
    }

    exitEditMode();
  }

  // --- LIBRARY MODAL ---
  function updateLibraryUI() {
    el.libraryCount.textContent = state.reads.length;
    el.libraryGrid.innerHTML = '';

    state.reads.forEach((read, idx) => {
      const card = document.createElement('div');
      card.className = `library-card ${idx === state.activeReadIndex ? 'active-read' : ''}`;

      card.innerHTML = `
        <img class="library-thumb" src="${read.pages[0]?.url || ''}" alt="">
        <div class="library-info">
          <div class="library-title">${read.title}</div>
          <div class="library-sub">${read.pages.length} Pages ${read.isGitHub ? '• Saved on GitHub' : '• Local'}</div>
        </div>
      `;

      card.addEventListener('click', () => {
        loadRead(idx);
        closeModal(el.modalLibrary);
      });

      el.libraryGrid.appendChild(card);
    });
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

      // Minimalist black-and-white comic style
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

  // --- EVENT LISTENERS ---
  function setupEventListeners() {
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

    // Strip width
    el.selectWidth.addEventListener('change', (e) => {
      state.stripWidth = e.target.value;
      el.stripOuter.className = `strip-outer width-${state.stripWidth}`;
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

    // Modal close buttons
    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modal = document.getElementById(btn.dataset.close);
        if (modal) closeModal(modal);
      });
    });

    // Global keys
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'SELECT'].includes(e.target.tagName)) return;
      if (e.key === '[') loadRead(state.activeReadIndex - 1);
      if (e.key === ']') loadRead(state.activeReadIndex + 1);
      if (e.key === 'Escape') {
        closeModal(el.modalSettings);
        closeModal(el.modalLibrary);
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
