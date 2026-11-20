# Strip Reader

A clean, minimalist long-strip reader for image archives (ZIP, CBZ) and image sets (JPG, PNG, WEBP, AVIF, GIF).

Designed to be hosted directly on **GitHub Pages** with permanent cross-device cloud storage powered by the GitHub API.

## Features

- **Long Strip Flow**: Seamless, zero-gap continuous vertical scrolling.
- **Permanent GitHub Cloud Storage**: Connect your repository to save reads forever. Never gets deleted when clearing browser cache or cookies, and syncs across all your devices (phone, laptop, tablet).
- **Edit Order Mode**: Reorder pages with drag-and-drop or arrows. The updated order is saved directly to your repository's `manifest.json`.
- **Works 100% on GitHub Pages**: Pure static HTML, CSS, and JavaScript. No Node server or database required.
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
