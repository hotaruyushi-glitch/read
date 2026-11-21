# Strip Reader

A clean, minimalist long-strip reader for image archives (ZIP, CBZ) and image sets (JPG, PNG, WEBP, AVIF, GIF).

Designed to be hosted directly on **GitHub Pages** with permanent cross-device cloud storage powered by the GitHub API.

## Features

- **Long Strip Flow**: Seamless, zero-gap continuous vertical scrolling.
- **Permanent GitHub Cloud Storage**: Connect your repository to save reads forever. Never gets deleted when clearing browser cache or cookies, and syncs across all your devices (phone, laptop, tablet).
- **Edit & Replace Images**: Click **Edit** in the Library or reader footer to upload a local ZIP/images into a replacement tray, swap specific pages, append new pages, or delete unwanted pages.
- **Manual Library Reordering**: Move reads up and down manually with ▲ / ▼ arrows or drag-and-drop. Order syncs to `library_order.json` in your repository and local storage.
- **Large File & Long Archive Resilience**: Non-blocking asynchronous extraction with UI yielding and rate-limit paced GitHub commits with exponential backoff retry.
- **Phone & Mobile Responsive**: Optimized for phones with edge-to-edge screen fitting, hideable menu bar (`H`), and custom width slider.
- **Works 100% on GitHub Pages**: Pure static client-side web application. No server or database needed.
- **Minimalist Aesthetic**: Clean monochrome interface with zero unnecessary colors or distractions.

## How to Deploy on GitHub Pages

1. Push these files to your GitHub repository:
   - `index.html`
   - `style.css`
   - `app.js`
   - `js/jszip.min.js`
2. Go to your repository **Settings** > **Pages**.
3. Under **Build and deployment**, set **Source** to `Deploy from a branch` and select `main` (root `/`).
4. Click **Save**. Your site will be live at `https://<username>.github.io/<repo>/`!

## How to Connect Permanent Storage

1. Open your hosted site.
2. Click **Connect GitHub** in the top navigation.
3. Enter:
   - **Repository**: `your-username/your-storage-repo`
   - **Personal Access Token (PAT)**: A GitHub token with `repo` or `Contents: Read & Write` permissions.
4. Click **Save & Connect**.
5. Any ZIP or images you drop in will be permanently saved to your GitHub repo in the `reads/` folder!

