/**
 * Teleprompter Controller Client
 *
 * This script runs on the controller interface (laptop/PC). It connects via
 * WebSocket to the Node.js server, handles .docx file uploads, displays a
 * live preview of the script, and sends playback/scroll/mirror commands to
 * the teleprompter display.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let isPlaying = false;
let isMirrored = false;
let ws = null;
let isConnected = false;
let teleprompterConnected = false;

/** Animation frame ID for the live-preview auto-scroll loop */
let autoScrollFrameId = null;

/** Flag to suppress manual scroll-sync while we programmatically scroll */
let isProgrammaticScroll = false;

/** Throttle timestamp for manual scroll events */
let lastScrollSendTime = 0;
const SCROLL_THROTTLE_MS = 60;

/** Reconnect timer ID */
let reconnectInterval = null;

// Scroll speed: pixels per requestAnimationFrame tick (fixed for prototype)
const SCROLL_SPEED = 2;

// ---------------------------------------------------------------------------
// DOM References
// ---------------------------------------------------------------------------

const statusDot       = document.getElementById('statusDot');
const statusText      = document.getElementById('statusText');
const uploadSection   = document.getElementById('uploadSection');
const uploadZone      = document.getElementById('uploadZone');
const fileInput       = document.getElementById('fileInput');
const scriptSection   = document.getElementById('scriptSection');
const livePreview     = document.getElementById('livePreview');
const scriptText      = document.getElementById('scriptText');
const controlsPanel   = document.getElementById('controlsPanel');
const btnPlayPause    = document.getElementById('btnPlayPause');
const btnScrollTop    = document.getElementById('btnScrollTop');
const btnScrollBottom = document.getElementById('btnScrollBottom');
const btnNewScript    = document.getElementById('btnNewScript');
const btnMirror       = document.getElementById('btnMirror');

// ---------------------------------------------------------------------------
// WebSocket Connection
// ---------------------------------------------------------------------------

/**
 * Establish a WebSocket connection to the server.
 * On success, register this client as a controller.
 */
function connect() {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws`);

  ws.addEventListener('open', () => {
    console.log('[Controller] Connected to server');
    isConnected = true;

    // Clear any pending reconnect timer
    if (reconnectInterval) {
      clearInterval(reconnectInterval);
      reconnectInterval = null;
    }

    // Register as controller
    ws.send(JSON.stringify({
      type: 'register',
      data: { role: 'controller' }
    }));
  });

  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (err) {
      console.error('[Controller] Failed to parse message:', err);
    }
  });

  ws.addEventListener('close', () => {
    console.warn('[Controller] Connection closed');
    isConnected = false;
    teleprompterConnected = false;
    statusDot.classList.remove('connected');
    statusDot.classList.add('disconnected');
    statusText.textContent = 'Nicht verbunden';
    scheduleReconnect();
  });

  ws.addEventListener('error', (err) => {
    console.error('[Controller] WebSocket error:', err);
  });
}

/**
 * Schedule reconnect attempts every 3 seconds.
 * Guards against duplicate intervals.
 */
function scheduleReconnect() {
  if (!reconnectInterval) {
    reconnectInterval = setInterval(() => {
      console.log('[Controller] Attempting to reconnect...');
      connect();
    }, 3000);
  }
}

/**
 * Send a JSON message over the WebSocket (if connected).
 */
function sendMessage(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ---------------------------------------------------------------------------
// Message Handlers
// ---------------------------------------------------------------------------

/**
 * Route an incoming WebSocket message to the appropriate handler.
 */
function handleMessage(msg) {
  switch (msg.type) {
    case 'script:loaded':
      handleScriptLoaded(msg.data);
      break;

    case 'status:teleprompter_connected':
      teleprompterConnected = true;
      statusDot.classList.remove('disconnected');
      statusDot.classList.add('connected');
      statusText.textContent = 'Teleprompter verbunden';
      console.log('[Controller] Teleprompter connected');
      break;

    case 'status:teleprompter_disconnected':
      teleprompterConnected = false;
      statusDot.classList.remove('connected');
      statusDot.classList.add('disconnected');
      statusText.textContent = 'Teleprompter nicht verbunden';
      console.log('[Controller] Teleprompter disconnected');
      break;

    default:
      console.log('[Controller] Unknown message type:', msg.type);
  }
}

/**
 * script:loaded – Display the script text in the live preview.
 *
 * @param {string|object} data - Raw text or { text: string }.
 */
function handleScriptLoaded(data) {
  // data may be a string directly or an object with .text
  const rawText = (typeof data === 'string') ? data : (data.text || '');

  // Convert newlines to HTML for display
  const html = rawText
    .split('\n')
    .map(line => line.trim() === '' ? '<br><br>' : line)
    .join('<br>');

  scriptText.innerHTML = html;

  // Switch views
  uploadSection.classList.add('hidden');
  scriptSection.classList.remove('hidden');
  controlsPanel.classList.remove('hidden');

  // Reset scroll to top
  isProgrammaticScroll = true;
  livePreview.scrollTop = 0;
  requestAnimationFrame(() => { isProgrammaticScroll = false; });

  console.log('[Controller] Script loaded and displayed');
}

// ---------------------------------------------------------------------------
// File Upload
// ---------------------------------------------------------------------------

/**
 * Clicking on the upload zone triggers the hidden file input.
 */
uploadZone.addEventListener('click', () => {
  fileInput.click();
});

/**
 * Handle file selection from the file input dialog.
 */
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    uploadFile(fileInput.files[0]);
  }
});

// -- Drag and Drop --

uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('dragover');
});

uploadZone.addEventListener('dragleave', () => {
  uploadZone.classList.remove('dragover');
});

uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('dragover');

  const file = e.dataTransfer.files[0];
  if (file) {
    uploadFile(file);
  }
});

/**
 * Validate and upload a .docx file to the server.
 * The server will parse it and broadcast the script via WebSocket.
 */
async function uploadFile(file) {
  // Validate file type
  if (!file.name.toLowerCase().endsWith('.docx')) {
    showUploadProgress('Bitte eine .docx Datei auswählen.', true);
    return;
  }

  // Show upload progress
  showUploadProgress('Wird hochgeladen...');

  try {
    const formData = new FormData();
    formData.append('script', file);

    const response = await fetch('/upload', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Upload fehlgeschlagen (${response.status})`);
    }

    // Success – the script will arrive via the WebSocket broadcast
    showUploadProgress('Skript wird geladen...');
  } catch (err) {
    console.error('[Controller] Upload error:', err);
    showUploadProgress(err.message || 'Upload fehlgeschlagen.', true);
  }

  // Reset the file input so the same file can be re-uploaded
  fileInput.value = '';
}

/**
 * Show a progress or error message below the upload zone.
 */
function showUploadProgress(message, isError = false) {
  // Remove existing progress element if any
  const existing = uploadZone.querySelector('.upload-progress');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.className = 'upload-progress';
  if (isError) el.style.color = '#ff4d6d';
  el.textContent = message;
  uploadZone.appendChild(el);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/**
 * Play / Pause toggle.
 */
btnPlayPause.addEventListener('click', () => {
  isPlaying = !isPlaying;

  if (isPlaying) {
    sendMessage({ type: 'control:play' });
    btnPlayPause.textContent = 'Pause';
    startAutoScroll();
  } else {
    sendMessage({ type: 'control:pause' });
    btnPlayPause.textContent = 'Play';
    stopAutoScroll();
  }
});

/**
 * Scroll to top.
 */
btnScrollTop.addEventListener('click', () => {
  // Pause if playing
  if (isPlaying) {
    isPlaying = false;
    sendMessage({ type: 'control:pause' });
    btnPlayPause.textContent = 'Play';
    stopAutoScroll();
  }

  isProgrammaticScroll = true;
  livePreview.scrollTop = 0;
  requestAnimationFrame(() => { isProgrammaticScroll = false; });

  sendMessage({ type: 'control:scroll', data: { scrollPercent: 0 } });
});

/**
 * Scroll to bottom.
 */
btnScrollBottom.addEventListener('click', () => {
  isProgrammaticScroll = true;
  livePreview.scrollTop = livePreview.scrollHeight - livePreview.clientHeight;
  requestAnimationFrame(() => { isProgrammaticScroll = false; });

  sendMessage({ type: 'control:scroll', data: { scrollPercent: 100 } });
});

/**
 * New Script – go back to the upload view.
 */
btnNewScript.addEventListener('click', () => {
  // Pause if playing
  if (isPlaying) {
    isPlaying = false;
    sendMessage({ type: 'control:pause' });
    btnPlayPause.textContent = 'Play';
    stopAutoScroll();
  }

  scriptSection.classList.add('hidden');
  controlsPanel.classList.add('hidden');
  uploadSection.classList.remove('hidden');
  scriptText.innerHTML = '';
});

/**
 * Mirror toggle.
 */
btnMirror.addEventListener('click', () => {
  isMirrored = !isMirrored;
  sendMessage({ type: 'control:mirror', data: { mirrored: isMirrored } });

  if (isMirrored) {
    btnMirror.classList.add('btn-mirror-active');
  } else {
    btnMirror.classList.remove('btn-mirror-active');
  }
});

// ---------------------------------------------------------------------------
// Manual Scroll Sync
// ---------------------------------------------------------------------------

/**
 * When the user manually scrolls the live preview, sync the scroll position
 * to the teleprompter. Throttled to avoid flooding the WebSocket.
 */
livePreview.addEventListener('scroll', () => {
  // Ignore programmatic scrolls (auto-scroll or button-triggered)
  if (isProgrammaticScroll) return;

  const now = Date.now();
  if (now - lastScrollSendTime < SCROLL_THROTTLE_MS) return;
  lastScrollSendTime = now;

  const maxScroll = livePreview.scrollHeight - livePreview.clientHeight;
  if (maxScroll <= 0) return;

  const percent = (livePreview.scrollTop / maxScroll) * 100;
  sendMessage({ type: 'control:scroll', data: { scrollPercent: percent } });
});

// ---------------------------------------------------------------------------
// Auto-Scroll (Live Preview)
// ---------------------------------------------------------------------------

/**
 * Start auto-scrolling the live preview at SCROLL_SPEED pixels per frame.
 * Mirrors what the teleprompter does, giving the controller a true live view.
 */
function startAutoScroll() {
  stopAutoScroll(); // Cancel any existing animation

  function tick() {
    if (!isPlaying) return;

    const maxScroll = livePreview.scrollHeight - livePreview.clientHeight;

    isProgrammaticScroll = true;
    livePreview.scrollTop += SCROLL_SPEED;
    requestAnimationFrame(() => { isProgrammaticScroll = false; });

    // Stop when we reach the bottom
    if (livePreview.scrollTop >= maxScroll) {
      isPlaying = false;
      btnPlayPause.textContent = 'Play';
      sendMessage({ type: 'control:pause' });
      return;
    }

    autoScrollFrameId = requestAnimationFrame(tick);
  }

  autoScrollFrameId = requestAnimationFrame(tick);
}

/**
 * Stop the auto-scroll animation loop.
 */
function stopAutoScroll() {
  if (autoScrollFrameId) {
    cancelAnimationFrame(autoScrollFrameId);
    autoScrollFrameId = null;
  }
}

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------

connect();
