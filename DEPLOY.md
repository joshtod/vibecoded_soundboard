# Soundboard — Azure Deployment Guide

## Architecture

| Component | Azure Service | Cost |
|-----------|--------------|------|
| Web app (HTML/CSS/JS) | Azure Static Web Apps (Free tier) | **$0/month** |
| Audio files + metadata | Azure Blob Storage (LRS) | ~$0.02/GB/month |
| Total for ~5 GB of audio | | ~**$0.10–$2/month** depending on traffic |

---

## Step 1 — Create Azure Blob Storage

1. In the [Azure Portal](https://portal.azure.com), create a **Storage Account**:
   - Performance: Standard
   - Redundancy: LRS (cheapest)
   - Name: e.g. `mysoundbstorage`

2. Inside the storage account, go to **Containers** → **+ Container**:
   - Name: `soundboard`
   - Public access level: **Blob** (anonymous read for blobs)

3. **Enable CORS** on the storage account:
   - Storage Account → Resource sharing (CORS) → Blob service
   - Add a rule:
     - Allowed origins: `*` (or your Static Web App URL once you have it)
     - Allowed methods: `GET, HEAD`
     - Allowed headers: `*`
     - Exposed headers: `*`
     - Max age: `86400`

4. Note the container URL, e.g.:
   ```
   https://mysoundbstorage.blob.core.windows.net/soundboard
   ```

---

## Step 2 — Upload Files

Folder structure inside the `soundboard` container:
```
soundboard/
  metadata.json          ← track listing (see format below)
  music/
    forest_ambience.mp3
    tavern_bustle.mp3
    ...
  sfx/
    thunder.mp3
    sword_clash.mp3
    ...
```

Upload via:
- Azure Portal (drag & drop in Storage Browser)
- Azure Storage Explorer (free desktop app)
- Azure CLI: `az storage blob upload-batch -s ./audio -d soundboard --account-name mysoundbstorage`

---

## Step 3 — Edit metadata.json

```json
{
  "music": [
    {
      "id": "track_001",
      "name": "Forest Ambience",
      "file": "music/forest_ambience.mp3",
      "tags": ["nature", "calm"]
    }
  ],
  "sfx": [
    {
      "id": "sfx_001",
      "name": "Thunder Crack",
      "file": "sfx/thunder.mp3",
      "tags": ["weather", "dramatic"]
    }
  ]
}
```

- `id` must be unique across all tracks
- `file` is relative to the container root
- `tags` are the developer-defined tags (users can add their own via the UI, stored in browser localStorage)
- Upload the updated `metadata.json` to the container root whenever you add tracks

---

## Step 4 — Configure config.js

Edit `config.js` in this project:
```js
const CONFIG = {
  storageBaseUrl: 'https://mysoundbstorage.blob.core.windows.net/soundboard',
  slotCrossfadeDuration: 2.0,   // seconds to cross-fade between slots
  loopCrossfadeDuration: 0.5,   // seconds of overlap at loop points
  maxSlots: 10,
};
```

---

## Step 5 — Deploy to Azure Static Web Apps

### Option A: GitHub (recommended)

1. Push this project folder to a GitHub repository.
2. In Azure Portal → **Static Web Apps** → **+ Create**:
   - Source: GitHub → select your repo + branch
   - Build preset: **Custom** (no framework)
   - App location: `/`
   - Api location: (leave blank)
   - Output location: (leave blank)
3. Azure creates a GitHub Actions workflow automatically.
4. Every push to the branch auto-deploys.

### Option B: Azure CLI (manual)

```bash
# Install Azure Static Web Apps CLI
npm install -g @azure/static-web-apps-cli

# Deploy from this folder
swa deploy ./ --env production
```

### Option C: VS Code Extension

Install the **Azure Static Web Apps** VS Code extension, then right-click the project folder → **Create Static Web App** → follow the prompts.

---

## Step 6 — Update CORS (if needed)

Once you have your Static Web App URL (e.g., `https://purple-flower-123.azurestaticapps.net`), update the CORS rule on your Blob Storage to use that specific origin instead of `*` for better security.

---

## Adding / Updating Audio Files

1. Upload the new `.mp3` files to the appropriate folder in the `soundboard` container.
2. Add entries to `metadata.json` and re-upload it.
3. No redeployment of the web app needed — it always fetches the latest `metadata.json`.

---

## Audio Format Recommendations

- **Format**: MP3 (320 kbps) or OGG Vorbis (best browser compatibility)
- **Music tracks**: Any length. Longer tracks loop with less audible repetition.
- **SFX**: Keep under ~5 MB for fast playback response.
- Normalize loudness across tracks so volume is consistent.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1`–`9`, `0` | Toggle slots 1–10 |
| `ESC` | Cancel track selection / close modal |

---

## User Tags

Users can add personal tags to any track in the library via the **+ tag** button. These are saved in `localStorage` in their browser (per-device, not synced). Developer tags are set in `metadata.json`.
