const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.resolve(__dirname);
const DATA_DIR = path.join(ROOT, 'data', 'reads');
const UPLOAD_TMP_DIR = path.join(ROOT, 'uploads_tmp');

// Ensure directories exist
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });

// Natural alphanumeric collator for filenames (e.g. 1, 2, ... 10)
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp', '.svg']);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.rar', '.cbz', '.cbr', '.7z', '.tar', '.gz']);

// Multer storage in temporary uploads directory
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_TMP_DIR),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safeName}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB per file
});

app.use(express.json());
app.use(express.static(ROOT));
app.use('/data/reads', express.static(DATA_DIR));

// Helper: Sanitize folder names
function sanitizeFolderName(name) {
  const base = name.replace(/\.[^/.]+$/, '').trim();
  const clean = base.replace(/[^a-zA-Z0-9_\-\s]/g, '_').replace(/\s+/g, '_');
  return clean || `read_${Date.now()}`;
}

// Helper: Recursively find all images in a directory
function findImagesRecursively(dir) {
  let results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Ignore macOS and system junk
      if (entry.name === '__MACOSX' || entry.name.startsWith('.')) continue;
      results = results.concat(findImagesRecursively(fullPath));
    } else if (entry.isFile()) {
      if (entry.name.startsWith('.') || entry.name.toLowerCase() === 'thumbs.db') continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

// Helper: Get read folder info
function getReadInfo(folderName) {
  const readPath = path.join(DATA_DIR, folderName);
  if (!fs.existsSync(readPath) || !fs.statSync(readPath).isDirectory()) return null;

  const manifestPath = path.join(readPath, 'manifest.json');
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      manifest = null;
    }
  }

  // Scan physical files in folder
  const files = fs.readdirSync(readPath).filter(file => {
    if (file === 'manifest.json' || file.startsWith('.')) return false;
    const ext = path.extname(file).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });

  // Sort physically by natural sequence
  files.sort((a, b) => collator.compare(a, b));

  let totalSize = 0;
  const pages = files.map((filename, index) => {
    const filePath = path.join(readPath, filename);
    const stats = fs.statSync(filePath);
    totalSize += stats.size;
    const ext = path.extname(filename).toLowerCase().replace('.', '');
    return {
      index: index + 1,
      filename: filename,
      url: `/data/reads/${encodeURIComponent(folderName)}/${encodeURIComponent(filename)}`,
      size: stats.size,
      ext: ext,
      mtime: stats.mtimeMs
    };
  });

  const folderStat = fs.statSync(readPath);
  const title = manifest?.title || folderName.replace(/_/g, ' ');

  return {
    id: folderName,
    title: title,
    folderName: folderName,
    pageCount: pages.length,
    pages: pages,
    totalSize: totalSize,
    firstPageUrl: pages[0]?.url || '',
    updatedAt: manifest?.updatedAt || folderStat.mtimeMs,
    createdAt: manifest?.createdAt || folderStat.birthtimeMs,
    sourceArchive: manifest?.sourceArchive || null
  };
}

// -----------------------------------------------------------------------------
// API ENDPOINTS
// -----------------------------------------------------------------------------

// 1. GET /api/reads: List all reads directly from server disk
app.get('/api/reads', (req, res) => {
  try {
    const folders = fs.readdirSync(DATA_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name);

    const reads = folders
      .map(f => getReadInfo(f))
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    res.json({ success: true, reads });
  } catch (err) {
    console.error('Error listing reads:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. GET /api/reads/:id: Get single read details and ordered pages
app.get('/api/reads/:id', (req, res) => {
  try {
    const read = getReadInfo(req.params.id);
    if (!read) {
      return res.status(404).json({ success: false, error: 'Read not found' });
    }
    res.json({ success: true, read });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. POST /api/upload: Upload ZIP, RAR, CBZ, or batch of images
app.post('/api/upload', upload.array('files'), (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    const createdReads = [];

    // Separate archives from raw images
    const archiveFiles = [];
    const imageFiles = [];

    for (const f of files) {
      const ext = path.extname(f.originalname).toLowerCase();
      if (ARCHIVE_EXTENSIONS.has(ext)) {
        archiveFiles.push(f);
      } else if (IMAGE_EXTENSIONS.has(ext)) {
        imageFiles.push(f);
      }
    }

    // Process each archive: unpack into its own server folder
    for (const arch of archiveFiles) {
      const folderBaseName = sanitizeFolderName(arch.originalname);
      let targetFolderName = folderBaseName;
      let counter = 1;
      while (fs.existsSync(path.join(DATA_DIR, targetFolderName))) {
        targetFolderName = `${folderBaseName}_${counter++}`;
      }
      const targetDir = path.join(DATA_DIR, targetFolderName);
      fs.mkdirSync(targetDir, { recursive: true });

      // Unpack using 7z
      const extractTempDir = path.join(UPLOAD_TMP_DIR, `extract_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`);
      fs.mkdirSync(extractTempDir, { recursive: true });

      try {
        console.log(`[7z] Extracting ${arch.path} to ${extractTempDir}...`);
        execSync(`7z x -y "${arch.path}" -o"${extractTempDir}"`, { stdio: 'pipe' });

        // Find all image files
        const extractedImages = findImagesRecursively(extractTempDir);
        // Naturally sort images
        extractedImages.sort((a, b) => collator.compare(path.basename(a), path.basename(b)));

        if (extractedImages.length === 0) {
          throw new Error(`Archive ${arch.originalname} contains no recognized image files.`);
        }

        // Copy into target folder with sequential physical prefix (0001_..., 0002_...)
        const manifestPages = [];
        extractedImages.forEach((imgSrcPath, idx) => {
          const originalName = path.basename(imgSrcPath);
          const ext = path.extname(originalName).toLowerCase();
          const cleanBase = path.basename(originalName, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
          const seqNum = String(idx + 1).padStart(4, '0');
          const destFileName = `${seqNum}_${cleanBase}${ext}`;
          const destPath = path.join(targetDir, destFileName);

          fs.copyFileSync(imgSrcPath, destPath);
          manifestPages.push({
            order: idx + 1,
            originalName: originalName,
            filename: destFileName
          });
        });

        // Write manifest
        const manifest = {
          title: arch.originalname.replace(/\.[^/.]+$/, ''),
          sourceArchive: arch.originalname,
          archiveSize: arch.size,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          pageCount: manifestPages.length,
          pages: manifestPages
        };
        fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

        const info = getReadInfo(targetFolderName);
        if (info) createdReads.push(info);
      } finally {
        // Clean up temp extract directory and upload file
        fs.rmSync(extractTempDir, { recursive: true, force: true });
        if (fs.existsSync(arch.path)) fs.unlinkSync(arch.path);
      }
    }

    // Process loose images uploaded together as a single batch read
    if (imageFiles.length > 0) {
      // Sort images naturally by original name
      imageFiles.sort((a, b) => collator.compare(a.originalname, b.originalname));

      const now = new Date();
      const timeStr = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
      const batchTitle = req.body.batchTitle ? sanitizeFolderName(req.body.batchTitle) : `Image_Batch_${timeStr}`;

      let targetFolderName = batchTitle;
      let counter = 1;
      while (fs.existsSync(path.join(DATA_DIR, targetFolderName))) {
        targetFolderName = `${batchTitle}_${counter++}`;
      }

      const targetDir = path.join(DATA_DIR, targetFolderName);
      fs.mkdirSync(targetDir, { recursive: true });

      const manifestPages = [];
      imageFiles.forEach((imgFile, idx) => {
        const ext = path.extname(imgFile.originalname).toLowerCase();
        const cleanBase = path.basename(imgFile.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
        const seqNum = String(idx + 1).padStart(4, '0');
        const destFileName = `${seqNum}_${cleanBase}${ext}`;
        const destPath = path.join(targetDir, destFileName);

        fs.copyFileSync(imgFile.path, destPath);
        fs.unlinkSync(imgFile.path);

        manifestPages.push({
          order: idx + 1,
          originalName: imgFile.originalname,
          filename: destFileName
        });
      });

      const manifest = {
        title: batchTitle.replace(/_/g, ' '),
        sourceArchive: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pageCount: manifestPages.length,
        pages: manifestPages
      };
      fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      const info = getReadInfo(targetFolderName);
      if (info) createdReads.push(info);
    }

    res.json({
      success: true,
      message: `Successfully mounted ${createdReads.length} reads on server.`,
      reads: createdReads
    });
  } catch (err) {
    console.error('Upload processing failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. POST /api/reads/:id/reorder: Physically re-sequence files in the folder on disk
app.post('/api/reads/:id/reorder', (req, res) => {
  try {
    const folderName = req.params.id;
    const readPath = path.join(DATA_DIR, folderName);

    if (!fs.existsSync(readPath) || !fs.statSync(readPath).isDirectory()) {
      return res.status(404).json({ success: false, error: 'Read folder not found' });
    }

    const { orderedFilenames } = req.body;
    if (!Array.isArray(orderedFilenames) || orderedFilenames.length === 0) {
      return res.status(400).json({ success: false, error: 'orderedFilenames array required' });
    }

    // Step 1: Verify all files exist in readPath
    for (const fn of orderedFilenames) {
      const fp = path.join(readPath, fn);
      if (!fs.existsSync(fp)) {
        return res.status(400).json({ success: false, error: `File not found on disk: ${fn}` });
      }
    }

    // Step 2: Temporary rename to avoid collision while renumbering
    const tempMap = [];
    const timestamp = Date.now();
    orderedFilenames.forEach((fn, idx) => {
      const src = path.join(readPath, fn);
      const tmpName = `_reorder_tmp_${timestamp}_${idx}_${fn}`;
      const tmpDst = path.join(readPath, tmpName);
      fs.renameSync(src, tmpDst);
      tempMap.push({
        tmpDst: tmpDst,
        originalBaseName: fn.replace(/^\d{4}_/, ''), // strip previous 4-digit prefix if any
      });
    });

    // Step 3: Physically rename to new sequence prefixes (0001_..., 0002_...)
    const newManifestPages = [];
    tempMap.forEach((item, idx) => {
      const seqNum = String(idx + 1).padStart(4, '0');
      const finalName = `${seqNum}_${item.originalBaseName}`;
      const finalDst = path.join(readPath, finalName);
      fs.renameSync(item.tmpDst, finalDst);

      newManifestPages.push({
        order: idx + 1,
        filename: finalName
      });
    });

    // Step 4: Update manifest.json with updated timestamp
    const manifestPath = path.join(readPath, 'manifest.json');
    let manifest = {};
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (e) {
        manifest = {};
      }
    }
    manifest.updatedAt = Date.now();
    manifest.pages = newManifestPages;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    console.log(`[DISK REORDER] Read "${folderName}" reordered ${orderedFilenames.length} files physically on disk.`);

    // Return the updated read info
    const updatedRead = getReadInfo(folderName);
    res.json({
      success: true,
      message: 'Files physically re-sequenced on server disk.',
      read: updatedRead
    });
  } catch (err) {
    console.error('Error reordering files:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. POST /api/reads/:id/delete-page: Delete a page and re-sequence remaining
app.post('/api/reads/:id/delete-page', (req, res) => {
  try {
    const folderName = req.params.id;
    const { filename } = req.body;
    const readPath = path.join(DATA_DIR, folderName);

    if (!fs.existsSync(readPath)) return res.status(404).json({ success: false, error: 'Read not found' });
    const targetFile = path.join(readPath, filename);

    if (fs.existsSync(targetFile)) {
      fs.unlinkSync(targetFile);
    }

    // Re-sequence remaining
    const remaining = fs.readdirSync(readPath).filter(f => {
      if (f === 'manifest.json' || f.startsWith('.')) return false;
      return IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase());
    });
    remaining.sort((a, b) => collator.compare(a, b));

    // Temporarily rename
    const tmpArr = [];
    const ts = Date.now();
    remaining.forEach((fn, idx) => {
      const src = path.join(readPath, fn);
      const tmpName = `_del_tmp_${ts}_${idx}_${fn}`;
      const tmpDst = path.join(readPath, tmpName);
      fs.renameSync(src, tmpDst);
      tmpArr.push({ tmpDst, base: fn.replace(/^\d{4}_/, '') });
    });

    // Final sequence
    tmpArr.forEach((item, idx) => {
      const seq = String(idx + 1).padStart(4, '0');
      const finalName = `${seq}_${item.base}`;
      fs.renameSync(item.tmpDst, path.join(readPath, finalName));
    });

    const info = getReadInfo(folderName);
    res.json({ success: true, message: 'Page deleted and remaining pages re-sequenced on disk.', read: info });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. DELETE /api/reads/:id: Delete entire read folder
app.delete('/api/reads/:id', (req, res) => {
  try {
    const folderName = req.params.id;
    const readPath = path.join(DATA_DIR, folderName);
    if (fs.existsSync(readPath)) {
      fs.rmSync(readPath, { recursive: true, force: true });
    }
    res.json({ success: true, message: `Read folder ${folderName} deleted from server.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start Express Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[STRIP//ZIP SERVER] Live at http://localhost:${PORT}`);
  console.log(`[STRIP//ZIP SERVER] Storage directory: ${DATA_DIR}`);
});
