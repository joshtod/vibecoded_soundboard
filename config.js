// ============================================================
// CONFIGURATION — update STORAGE_BASE_URL after Azure setup
// See DEPLOY.md for instructions
// ============================================================
const CONFIG = {
  // Base URL of your Azure Blob Storage container (no trailing slash)
  // Example: 'https://mystorage.blob.core.windows.net/soundboard'
  storageBaseUrl: 'https://YOUR_ACCOUNT.blob.core.windows.net/YOUR_CONTAINER',

  // Crossfade duration (seconds) when switching between slots
  slotCrossfadeDuration: 2.0,

  // Crossfade duration (seconds) at loop points (prevents silence between loops)
  loopCrossfadeDuration: 0.5,

  // Max number of music slots
  maxSlots: 10,
};
