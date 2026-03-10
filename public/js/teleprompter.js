/**
 * Teleprompter Display Client
 *
 * Connects via WebSocket to the Node.js server and receives commands
 * from the controller (laptop) to display and scroll script text.
 * Designed to run on an iPad in fullscreen.
 *
 * Features:
 * - Auto-scroll with configurable speed
 * - Dynamic font size control from controller
 * - Viewport info reporting back to controller
 * - Smooth scroll for manual position jumps
 * - Play/pause status indicator with auto-fade
 * - Mirror mode for reflective glass setups
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let isPlaying = false;
let isMirrored = false;
let scrollSpeed = 2;          // pixels per frame, will be updated by controller
let fontSize = 56;            // in px, will be updated by controller
let animationFrameId = null;
let scriptLoaded = false;
let ws = null;
let reconnectInterval = null;
let reconnectAttempts = 0;

// For viewport info reporting
let viewportReportInterval = null;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const connectionOverlay  = document.getElementById('connectionOverlay');
const waitingOverlay     = document.getElementById('waitingOverlay');
const teleprompterDisplay = document.getElementById('teleprompterDisplay');
const scriptText         = document.getElementById('scriptText');
const scrollIndicator    = document.getElementById('scrollIndicator');
const statusIndicator    = document.getElementById('statusIndicator');
const statusIcon         = document.getElementById('statusIcon');
const statusLabel        = document.getElementById('statusLabel');
const readingLine        = document.getElementById('readingLine');
const connectionStatus  = document.getElementById('connectionStatus');
const connectionDetail  = document.getElementById('connectionDetail');

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

/**
 * Establish a WebSocket connection to the server.
 * First performs an HTTP pre-flight check (/api/ping) to verify basic
 * connectivity, then attempts the WebSocket upgrade.
 */
async function connect() {
    // Clean up any existing WebSocket before creating a new one.
    if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
        }
        ws = null;
    }

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

    // Update overlay with connection info
    reconnectAttempts++;
    if (reconnectAttempts > 1) {
        connectionStatus.textContent = `Verbinde mit Server... (Versuch ${reconnectAttempts})`;
    } else {
        connectionStatus.textContent = 'Verbinde mit Server...';
    }
    connectionDetail.textContent = wsUrl;

    // Pre-flight HTTP check
    try {
        const pingUrl = `${window.location.protocol}//${window.location.host}/api/ping`;
        const response = await fetch(pingUrl, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) {
            connectionDetail.textContent = `HTTP-Fehler: ${response.status} — ${wsUrl}`;
            scheduleReconnect();
            return;
        }
        console.log('[Teleprompter] Pre-flight ping OK');
    } catch (err) {
        console.warn('[Teleprompter] Pre-flight ping failed:', err.message);
        connectionStatus.textContent = 'Server nicht erreichbar';
        connectionDetail.textContent = `HTTP-Verbindung zu ${window.location.host} fehlgeschlagen. Gleiches WLAN?`;
        scheduleReconnect();
        return;
    }

    // HTTP works — now try WebSocket
    connectionStatus.textContent = reconnectAttempts > 1
        ? `Öffne WebSocket... (Versuch ${reconnectAttempts})`
        : 'Öffne WebSocket...';

    try {
        ws = new WebSocket(wsUrl);
    } catch (err) {
        console.error('[Teleprompter] Failed to create WebSocket:', err);
        connectionDetail.textContent = `WebSocket-Fehler: ${err.message}`;
        scheduleReconnect();
        return;
    }

    ws.addEventListener('open', () => {
        console.log('[Teleprompter] Connected to server');
        reconnectAttempts = 0;

        // Hide connection overlay
        connectionOverlay.classList.add('hidden');

        // Clear any pending reconnect timer
        if (reconnectInterval) {
            clearInterval(reconnectInterval);
            reconnectInterval = null;
        }

        // Register this client as a teleprompter display
        ws.send(JSON.stringify({
            type: 'register',
            data: { role: 'teleprompter' }
        }));
    });

    ws.addEventListener('message', (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleMessage(msg);
        } catch (err) {
            console.error('[Teleprompter] Failed to parse message:', err);
        }
    });

    ws.addEventListener('close', (event) => {
        console.warn('[Teleprompter] Connection closed. Code:', event.code, 'Reason:', event.reason);
        connectionDetail.textContent = `Verbindung geschlossen (Code: ${event.code})`;
        onDisconnect();
    });

    ws.addEventListener('error', () => {
        console.error('[Teleprompter] WebSocket error');
        connectionStatus.textContent = 'WebSocket-Fehler';
        connectionDetail.textContent = `Verbindung zu ${wsUrl} fehlgeschlagen. Firewall prüfen!`;
    });
}

/**
 * Handle a disconnection: show overlay and schedule reconnect attempts.
 */
function onDisconnect() {
    // Show connection overlay
    connectionOverlay.classList.remove('hidden');

    // Stop any running scroll
    stopAutoScroll();
    isPlaying = false;

    // Stop viewport reporting
    if (viewportReportInterval) {
        clearInterval(viewportReportInterval);
        viewportReportInterval = null;
    }

    // Schedule reconnect (only if not already scheduled)
    scheduleReconnect();
}

/**
 * Schedule reconnect attempts every 3 seconds.
 * Guards against duplicate intervals.
 */
function scheduleReconnect() {
    if (!reconnectInterval) {
        reconnectInterval = setInterval(() => {
            console.log('[Teleprompter] Attempting to reconnect...');
            connect();
        }, 3000);
    }
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

/**
 * Route an incoming WebSocket message to the appropriate handler.
 */
function handleMessage(msg) {
    switch (msg.type) {
        case 'script:loaded':
            handleScriptLoaded(msg.data);
            break;
        case 'control:play':
            handlePlay();
            break;
        case 'control:pause':
            handlePause();
            break;
        case 'control:scroll':
            handleScroll(msg.data);
            break;
        case 'control:mirror':
            handleMirror(msg.data);
            break;
        case 'control:speed':
            handleSpeed(msg.data);
            break;
        case 'control:fontsize':
            handleFontSize(msg.data);
            break;
        default:
            console.log('[Teleprompter] Unknown message type:', msg.type);
    }
}

/**
 * script:loaded - Display the received script text.
 * Text arrives as plain text; newlines are converted to <br> tags and
 * consecutive blank lines produce paragraph spacing.
 */
function handleScriptLoaded(data) {
    const rawText = (typeof data === 'string') ? data : (data.text || '');

    // Convert plain text to HTML:
    // - Split on newlines
    // - Empty lines become a visual paragraph spacer
    // - Non-empty lines are kept as-is, joined with <br>
    const html = rawText
        .split('\n')
        .map(line => {
            if (line.trim() === '') {
                // Empty line -> paragraph spacer
                return '<div class="paragraph-spacer" style="height:1.2em;"></div>';
            }
            return line;
        })
        .join('<br>');

    scriptText.innerHTML = html;

    // Apply current font size
    scriptText.style.fontSize = fontSize + 'px';

    // Update state
    scriptLoaded = true;

    // Hide waiting overlay, ensure display is visible
    waitingOverlay.classList.add('hidden');
    teleprompterDisplay.style.display = '';

    // Reset scroll position to top
    teleprompterDisplay.scrollTop = 0;

    // Show scroll indicator
    if (scrollIndicator) scrollIndicator.style.display = '';
    if (scrollIndicator) scrollIndicator.textContent = '0%';

    // Start reporting viewport info to the controller
    startViewportReporting();

    console.log('[Teleprompter] Script loaded');
}

/**
 * control:play - Start auto-scrolling the script.
 * Updates the status indicator and fades it out after 2 seconds.
 */
function handlePlay() {
    if (!scriptLoaded) return;
    isPlaying = true;
    startAutoScroll();

    // Update status indicator
    if (statusIcon) statusIcon.textContent = '\u25B6'; // ▶
    if (statusLabel) statusLabel.textContent = 'Play';
    if (statusIndicator) statusIndicator.style.opacity = '1';

    // Fade out indicator after 2 seconds
    setTimeout(() => {
        if (isPlaying && statusIndicator) statusIndicator.style.opacity = '0.3';
    }, 2000);

    console.log('[Teleprompter] Playing');
}

/**
 * control:pause - Pause auto-scrolling.
 * Shows the status indicator at full opacity.
 */
function handlePause() {
    isPlaying = false;
    stopAutoScroll();

    // Update status indicator
    if (statusIcon) statusIcon.textContent = '\u23F8'; // ⏸
    if (statusLabel) statusLabel.textContent = 'Pause';
    if (statusIndicator) statusIndicator.style.opacity = '1';

    console.log('[Teleprompter] Paused');
}

/**
 * control:scroll - Jump to a specific scroll percentage (0-100).
 * Uses smooth scrolling when paused, instant when playing.
 */
function handleScroll(data) {
    if (!scriptLoaded) return;
    const percent = Math.max(0, Math.min(100, data.scrollPercent));
    const maxScroll = teleprompterDisplay.scrollHeight - teleprompterDisplay.clientHeight;
    const targetScrollTop = (percent / 100) * maxScroll;

    // Use smooth scrolling for manual jumps (not during auto-scroll)
    if (!isPlaying) {
        teleprompterDisplay.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
    } else {
        teleprompterDisplay.scrollTop = targetScrollTop;
    }

    // Update indicator
    if (scrollIndicator) scrollIndicator.textContent = Math.round(percent) + '%';
    console.log('[Teleprompter] Scrolled to', Math.round(percent) + '%');
}

/**
 * control:mirror - Toggle horizontal mirroring of the script text.
 */
function handleMirror(data) {
    isMirrored = data.mirrored;
    if (isMirrored) {
        scriptText.classList.add('mirrored');
    } else {
        scriptText.classList.remove('mirrored');
    }
    console.log('[Teleprompter] Mirror:', isMirrored);
}

/**
 * control:speed - Update the auto-scroll speed.
 */
function handleSpeed(data) {
    scrollSpeed = data.speed;
    console.log('[Teleprompter] Speed set to', scrollSpeed);
}

/**
 * control:fontsize - Update the displayed font size.
 */
function handleFontSize(data) {
    fontSize = data.fontSize;
    scriptText.style.fontSize = fontSize + 'px';
    console.log('[Teleprompter] Font size set to', fontSize);
}

// ---------------------------------------------------------------------------
// Viewport info reporting
// ---------------------------------------------------------------------------

/**
 * Start periodically sending viewport info to the server (which forwards
 * it to controllers). This tells the controller what portion of the text
 * is currently visible and how far the user has scrolled.
 *
 * Reports 5 times per second (every 200ms).
 */
function startViewportReporting() {
    // Stop any existing interval
    if (viewportReportInterval) clearInterval(viewportReportInterval);

    viewportReportInterval = setInterval(() => {
        if (!scriptLoaded || !ws || ws.readyState !== WebSocket.OPEN) return;

        const container = teleprompterDisplay;
        const maxScroll = container.scrollHeight - container.clientHeight;
        const scrollPercent = maxScroll > 0 ? (container.scrollTop / maxScroll) * 100 : 0;
        const viewportRatio = container.scrollHeight > 0 ? container.clientHeight / container.scrollHeight : 1;

        ws.send(JSON.stringify({
            type: 'status:viewport_info',
            data: { scrollPercent, viewportRatio }
        }));
    }, 200); // Report 5 times per second
}

// ---------------------------------------------------------------------------
// Auto-scroll
// ---------------------------------------------------------------------------

/**
 * Start the auto-scroll animation loop.
 * Scrolls the container by `scrollSpeed` pixels each frame.
 * Stops automatically when the bottom is reached.
 */
function startAutoScroll() {
    // Cancel any existing animation to avoid duplicate loops
    if (animationFrameId) cancelAnimationFrame(animationFrameId);

    function scroll() {
        if (!isPlaying) return;

        const container = teleprompterDisplay;
        container.scrollTop += scrollSpeed;

        // Calculate current scroll percentage
        const maxScroll = container.scrollHeight - container.clientHeight;
        const percent = maxScroll > 0
            ? Math.round((container.scrollTop / maxScroll) * 100)
            : 0;
        if (scrollIndicator) scrollIndicator.textContent = percent + '%';

        // Stop when we reach the bottom
        if (container.scrollTop >= maxScroll) {
            isPlaying = false;

            // Update status indicator to paused
            if (statusIcon) statusIcon.textContent = '\u23F8'; // ⏸
            if (statusLabel) statusLabel.textContent = 'Ende';
            if (statusIndicator) statusIndicator.style.opacity = '1';

            return;
        }

        animationFrameId = requestAnimationFrame(scroll);
    }

    animationFrameId = requestAnimationFrame(scroll);
}

/**
 * Stop the auto-scroll animation loop.
 */
function stopAutoScroll() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
}

// ---------------------------------------------------------------------------
// Touch prevention
// ---------------------------------------------------------------------------

/**
 * Prevent manual touch-scrolling on the teleprompter display.
 * Only the controller should be able to scroll the content.
 */
teleprompterDisplay.addEventListener('touchstart', (e) => {
    e.preventDefault();
}, { passive: false });

teleprompterDisplay.addEventListener('touchmove', (e) => {
    e.preventDefault();
}, { passive: false });

teleprompterDisplay.addEventListener('touchend', (e) => {
    e.preventDefault();
}, { passive: false });

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------
connect();
