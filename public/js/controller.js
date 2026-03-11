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

/** Reconnect timer ID */
let reconnectInterval = null;

/** Heartbeat timer to keep WebSocket alive */
let heartbeatInterval = null;
const HEARTBEAT_INTERVAL_MS = 15000;

// Scroll speed: pixels per requestAnimationFrame tick
// Dezimalskala wie professionelle Teleprompter-Software (Autocue, Parrot etc.)
// 0.1 = sehr langsam, 1.5 = normales Sprechtempo, 3.0+ = schnell
// Schrittweite: 0.1, Bereich: 0.1–8.0
const SPEED_MIN = 0.1;
const SPEED_MAX = 8.0;
const SPEED_STEP = 0.1;
let scrollSpeed = 1.5; // default: 1.5 (normales Sprechtempo)
let previewScrollPosition = 0; // float accumulator — preserves sub-pixel scroll precision

// Scroll sync throttle
const SCROLL_THROTTLE_MS = 60;
let lastScrollSendTime = 0;
let isProgrammaticScroll = false;

// Font size: Prozent-Skala
const FONTSIZE_MIN  = 60;
const FONTSIZE_MAX  = 200;
const FONTSIZE_STEP = 10;
let fontSize = 100; // default: 100%

// Teleprompter viewport dimensions (updated via status:viewport_info)
let teleprompterWidth = 768;   // default: iPad portrait width
let teleprompterHeight = 1024; // default: iPad portrait height

// Current scale factor applied to preview-inner
let previewScale = 1;

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
const btnSpeedDown    = document.getElementById('btnSpeedDown');
const btnSpeedUp      = document.getElementById('btnSpeedUp');
const speedDisplay    = document.getElementById('speedDisplay');
const btnFontDown    = document.getElementById('btnFontDown');
const btnFontUp      = document.getElementById('btnFontUp');
const fontsizeDisplay = document.getElementById('fontsizeDisplay');
const previewOuter     = document.getElementById('previewOuter');
const previewInner     = document.getElementById('previewInner');

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

    // Start heartbeat
    startHeartbeat();

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
    stopHeartbeat();
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

/**
 * Send a lightweight ping every 15 seconds to keep the WebSocket alive.
 */
function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Stop the heartbeat interval.
 */
function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
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

    case 'status:viewport_info': {
      const vw = msg.data && msg.data.viewportWidth;
      const vh = msg.data && msg.data.viewportHeight;
      if (vw && vh && vw > 0 && vh > 0) {
        teleprompterWidth  = vw;
        teleprompterHeight = vh;
        updatePreviewScale();
      }
      // Sync scroll position from viewport info — only when paused to avoid
      // fighting the rAF auto-scroll loop while playing
      if (!isPlaying && msg.data && typeof msg.data.scrollPercent === 'number') {
        const maxScroll = livePreview.scrollHeight - livePreview.clientHeight;
        if (maxScroll > 0) {
          isProgrammaticScroll = true;
          previewScrollPosition = (msg.data.scrollPercent / 100) * maxScroll;
          livePreview.scrollTop = Math.round(previewScrollPosition);
          isProgrammaticScroll = false;
        }
      }
      break;
    }

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
  previewScrollPosition = 0;
  livePreview.scrollTop = 0;
  isProgrammaticScroll = false;

  // Apply scaled preview layout
  updatePreviewScale();

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
  previewScrollPosition = 0;
  livePreview.scrollTop = 0;
  isProgrammaticScroll = false;

  sendMessage({ type: 'control:scroll', data: { scrollPercent: 0 } });
});

/**
 * Scroll to bottom.
 */
btnScrollBottom.addEventListener('click', () => {
  isProgrammaticScroll = true;
  previewScrollPosition = livePreview.scrollHeight - livePreview.clientHeight;
  livePreview.scrollTop = previewScrollPosition;
  isProgrammaticScroll = false;

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

/**
 * Rundet auf eine Nachkommastelle, um Floating-Point-Fehler zu vermeiden.
 */
function roundSpeed(val) {
  return Math.round(val * 10) / 10;
}

/**
 * Update scroll speed display and notify teleprompter.
 */
function applySpeed() {
  speedDisplay.textContent = scrollSpeed.toFixed(1);
  sendMessage({ type: 'control:speed', data: { speed: scrollSpeed } });
}

/**
 * Speed Down – verringert die Scrollgeschwindigkeit um 0.1.
 */
btnSpeedDown.addEventListener('click', () => {
  const next = roundSpeed(scrollSpeed - SPEED_STEP);
  if (next >= SPEED_MIN) {
    scrollSpeed = next;
    applySpeed();
  }
});

/**
 * Speed Up – erhöht die Scrollgeschwindigkeit um 0.1.
 */
btnSpeedUp.addEventListener('click', () => {
  const next = roundSpeed(scrollSpeed + SPEED_STEP);
  if (next <= SPEED_MAX) {
    scrollSpeed = next;
    applySpeed();
  }
});

/**
 * Update font size display, apply to live preview, and notify teleprompter.
 * The preview renders at the same absolute px as the teleprompter; the
 * container itself is CSS-scaled to fit the available space.
 */
function applyFontSize() {
  fontsizeDisplay.textContent = fontSize + '%';
  const TELEPROMPTER_BASE_PX = 56;
  const scaledPx = (fontSize / 100) * TELEPROMPTER_BASE_PX;
  scriptText.style.fontSize = Math.max(scaledPx, 8) + 'px';
  scriptText.style.lineHeight = '1.6';
  sendMessage({ type: 'control:fontsize', data: { fontSize: Math.max(scaledPx, 8) } });
}

/**
 * Recalculate and apply the CSS scale transform so that preview-inner
 * (which has real teleprompter dimensions) fits inside preview-outer.
 * Also sizes preview-outer height to maintain the teleprompter aspect ratio,
 * and updates the script-text padding to match the teleprompter exactly.
 */
function updatePreviewScale() {
  if (!previewOuter || !previewInner) return;

  // Constrain the preview to the teleprompter's portrait aspect ratio.
  // Compute the ideal width that fills the available vertical space.
  const HEADER_H   = 64;   // fixed header height
  const CONTROLS_H = 95;   // fixed bottom controls bar height
  const SECTION_PAD = 24;  // top padding of .script-section
  const availableH = window.innerHeight - HEADER_H - CONTROLS_H - SECTION_PAD;

  const aspectRatio = teleprompterWidth / teleprompterHeight; // e.g. 768/1024 = 0.75
  const idealWidth  = Math.round(availableH * aspectRatio);

  // Cap to idealWidth (preserves aspect ratio); never smaller than 100px
  const outerWidth = Math.max(idealWidth, 100);

  // Apply constrained width and centre horizontally
  previewOuter.style.width  = outerWidth + 'px';
  previewOuter.style.margin = '0 auto';

  // Scale factor: fit the teleprompter width into the constrained outer width
  previewScale = outerWidth / teleprompterWidth;

  // Set outer height to match the scaled teleprompter aspect ratio
  const scaledHeight = teleprompterHeight * previewScale;
  previewOuter.style.height = scaledHeight + 'px';

  // Apply scale transform to inner container
  previewInner.style.width  = teleprompterWidth  + 'px';
  previewInner.style.height = teleprompterHeight + 'px';
  previewInner.style.transform = `scale(${previewScale})`;
  previewInner.style.transformOrigin = 'top left';

  // Match teleprompter padding exactly (35vh and 60vh of the teleprompter viewport)
  const paddingTop    = teleprompterHeight * 0.35;
  const paddingBottom = teleprompterHeight * 0.60;
  scriptText.style.paddingTop    = paddingTop    + 'px';
  scriptText.style.paddingBottom = paddingBottom + 'px';
  scriptText.style.paddingLeft   = '48px';
  scriptText.style.paddingRight  = '48px';

  // Re-apply font size so it stays consistent after scale recalculation
  applyFontSize();
}

/**
 * Font Down – verringert die Schriftgröße um 10%.
 */
btnFontDown.addEventListener('click', () => {
  if (fontSize > FONTSIZE_MIN) {
    fontSize -= FONTSIZE_STEP;
    applyFontSize();
  }
});

/**
 * Font Up – erhöht die Schriftgröße um 10%.
 */
btnFontUp.addEventListener('click', () => {
  if (fontSize < FONTSIZE_MAX) {
    fontSize += FONTSIZE_STEP;
    applyFontSize();
  }
});

/**
 * Spacebar → Play / Pause (only when script is visible).
 */
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !scriptSection.classList.contains('hidden')) {
    e.preventDefault();
    btnPlayPause.click();
  }
});

// ---------------------------------------------------------------------------
// Manual Scroll Sync
// ---------------------------------------------------------------------------

/**
 * When the user manually scrolls the live preview, sync position to teleprompter.
 * Throttled to avoid flooding the WebSocket.
 */
livePreview.addEventListener('scroll', () => {
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
 * Start auto-scrolling the live preview at scrollSpeed pixels per frame.
 */
function startAutoScroll() {
  stopAutoScroll();

  function tick() {
    if (!isPlaying) return;

    const maxScroll = livePreview.scrollHeight - livePreview.clientHeight;

    isProgrammaticScroll = true;
    previewScrollPosition += scrollSpeed;
    livePreview.scrollTop = Math.round(previewScrollPosition);
    isProgrammaticScroll = false;

    if (maxScroll > 0 && previewScrollPosition >= maxScroll) {
      isPlaying = false;
      btnPlayPause.textContent = 'Play';
      stopAutoScroll();
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
window.addEventListener('resize', () => {
  applyFontSize();
  updatePreviewScale();
});
