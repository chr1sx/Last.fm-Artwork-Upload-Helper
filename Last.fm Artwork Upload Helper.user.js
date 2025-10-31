// ==UserScript==
// @name         Last.fm Artwork Upload Helper
// @namespace    https://github.com/chr1sx/Last.fm-Artwork-Upload-Helper
// @version      1.0.1
// @description  A userscript that streamlines the process of uploading high-quality album artwork to Last.fm by integrating with COV - Cover Search Engine.
// @match        https://www.last.fm/*
// @match        https://covers.musichoarders.xyz/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      covers.musichoarders.xyz
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
'use strict';

// === CONFIG ===
const DEFAULT_CONFIG = {
    theme: 'dark',
    resolution: '0',
    sources: ['Bandcamp', 'Deezer', 'Discogs', 'Spotify', 'Qobuz', 'Tidal'],
    country: 'us',
    remoteAgent: 'lastfm-mh-integration/3.4',
    debug: false
};

let MH_CONFIG = {};

// Full list of available sources for checkboxes
const ALL_SOURCES = [
    'Amazon', 'Amazon Music', 'Apple Music', 'Bandcamp', 'Beatport', 'Bugs', 'BOOTH', 'Deezer', 'Discogs',
    'Fanart.tv', 'FLO', 'Gaana', 'iTunes', 'KKBOX', 'KuGou', 'Last.fm', 'LINE MUSIC', 'Melon',
    'Metal Archives', 'MusicBrainz', 'NetEase', 'OTOTOY', 'Qobuz', 'RecoChoku', 'Soulseek',
    'SoundCloud', 'Spotify', 'THWiki', 'TIDAL', 'VGMdb'
];


// =================

/* Helpers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from((r || document).querySelectorAll(s));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

function normalizeSources(list) {
    return list.map(s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')).join(',');
}

async function saveConfig() {
    await GM_setValue('mh_config', JSON.stringify(MH_CONFIG));
}

async function loadConfig() {
    const storedConfig = await GM_getValue('mh_config');
    if (storedConfig) {
        MH_CONFIG = Object.assign({}, DEFAULT_CONFIG, JSON.parse(storedConfig));
    } else {
        MH_CONFIG = Object.assign({}, DEFAULT_CONFIG);
        await saveConfig();
    }
}

function buildMhUrl({ artist, album }, opts = {}) {
    const params = new URLSearchParams();
    const cfg = Object.assign({}, MH_CONFIG, opts || {});
    if (cfg.theme) params.set('theme', cfg.theme);
    if (cfg.resolution) params.set('resolution', cfg.resolution);
    if (cfg.sources && cfg.sources.length) params.set('sources', normalizeSources(cfg.sources));
    if (cfg.country) params.set('country', cfg.country.toLowerCase());
    if (artist) params.set('artist', artist);
    if (album) params.set('album', album);
    params.set('identifier', 'lastfm-mh-puppet');
    if (cfg.remoteAgent) params.set('remote.agent', cfg.remoteAgent);
    if (opts.remoteText) params.set('remote.text', opts.remoteText);

    return `https://covers.musichoarders.xyz/?${params.toString()}`;
}

/* Page detection & artist/album extraction */
function isUploadPath(pathname = location.pathname) {
    return /\/music\/.+\/.+\/\+images\/upload(\/|$|\?)/i.test(pathname) ||
           /\/music\/.+\/\+images\/upload(\/|$|\?)/i.test(pathname) ||
           /\/settings\/profile\/images\/upload(\/|$|\?)/i.test(pathname);
}

function extractArtistAlbum() {
    try {
        const metaArtist = document.querySelector('meta[property="music:musician"], meta[name="music:musician"]')?.content;
        const metaOgTitle = document.querySelector('meta[property="og:title"], meta[name="og:title"]')?.content;

        if (metaArtist && metaOgTitle) {
            let artist = metaArtist.trim();
            let album = metaOgTitle.trim();

            const byArtistPattern = new RegExp(` by ${escapeRegExp(artist)}`, 'i');
            if (byArtistPattern.test(album)) {
                album = album.replace(byArtistPattern, '').trim();
            } else {
                const dashSeparatorIndex = album.indexOf(' — ');
                if (dashSeparatorIndex !== -1) {
                     const potentialArtistInTitle = album.substring(0, dashSeparatorIndex).trim();
                     if (potentialArtistInTitle.toLowerCase() === artist.toLowerCase()) {
                        album = album.substring(dashSeparatorIndex + 3).trim();
                     }
                }
            }
            return { artist, album };
        }

        const parts = location.pathname.split('/').filter(Boolean);
        const mi = parts.indexOf('music');
        if (mi >= 0 && parts.length > mi + 2) {
            const d = s => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return s.replace(/\+/g, ' '); } };
            return { artist: d(parts[mi + 1]), album: d(parts[mi + 2]) };
        }
    } catch (e) {
        console.warn('CoverFinder: Error extracting artist/album:', e);
    }
    return null;
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- CRITICAL: Check if this is the Cover Search Engine puppet window ---
const isMHPuppetWindow = window.location.origin === 'https://covers.musichoarders.xyz' &&
                         new URLSearchParams(window.location.search).get('identifier') === 'lastfm-mh-puppet';

if (isMHPuppetWindow) {
    if (DEFAULT_CONFIG.debug) console.log('CoverFinder: Detected as Cover Search Engine puppet window.');

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(injectArtworkSelectionScript, 500);
        });
    } else {
        setTimeout(injectArtworkSelectionScript, 500);
    }

    throw new Error('Puppet window - stopping Last.fm script execution');
}

// Continue with Last.fm logic below
let currentInfo = extractArtistAlbum();

/* UI: panel with controls and settings */
function createPanel() {
    const existingPanel = document.getElementById('mh-cover-panel');
    if (existingPanel) {
        existingPanel.remove();
    }

    currentInfo = extractArtistAlbum();
    if (!currentInfo) {
        if (MH_CONFIG.debug) console.warn('CoverFinder: Cannot determine artist/album for this page.');
        return null;
    }

    const panel = document.createElement('div');
    panel.id = 'mh-cover-panel';

    // Theme-based colors
    const isDark = MH_CONFIG.theme === 'dark';
    const bgColor = isDark ? '#0f1113' : '#ffffff';
    const textColor = isDark ? '#ddd' : '#333';
    const borderColor = isDark ? '#222' : '#ccc';
    const headerColor = isDark ? '#fff' : '#000';
    const inputBg = isDark ? '#111' : '#f5f5f5';
    const inputBorder = isDark ? '#222' : '#ddd';
    const labelColor = isDark ? '#bbb' : '#666';
    const topBorderColor = isDark ? '#1a1a1a' : '#e0e0e0';

    Object.assign(panel.style, {
        position: 'fixed', right: '12px', top: '100px', zIndex: 2147483647,
        background: bgColor, color: textColor, border: `1px solid ${borderColor}`, padding: '12px', borderRadius: '8px',
        boxShadow: isDark ? '0 8px 30px rgba(0,0,0,0.6)' : '0 8px 30px rgba(0,0,0,0.15)',
        width: '310px', maxHeight: '85vh', overflowY: 'auto',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial', fontSize: '13px'
    });

    // Generate source checkboxes
    const sourceCheckboxesHtml = ALL_SOURCES.map(source => `
        <div style="display:flex;align-items:center;margin-bottom:4px;">
            <input type="checkbox" id="mh-source-${source.replace(/\s/g, '_')}" name="mh-sources" value="${esc(source)}" style="margin-right:8px;">
            <label for="mh-source-${source.replace(/\s/g, '_')}" style="color:${labelColor};flex-grow:1;cursor:pointer;">${esc(source)}</label>
        </div>
    `).join('');


    panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <div style="font-weight:700;color:${headerColor};font-size:15px;">Last.fm Artwork Upload Helper</div>
            <div style="display:flex;gap:4px;align-items:center;">
                <button id="mh-settings-btn" style="background:none;border:none;color:#8a8a8a;font-size:20px;cursor:pointer;padding:0;line-height:1;width:17px;height:17px;display:flex;align-items:center;justify-content:center;">⚙️</button>
                <button id="mh-close-btn" style="background:none;border:none;color:#8a8a8a;font-size:20px;cursor:pointer;padding:0;line-height:1;width:17px;height:17px;display:flex;align-items:center;justify-content:center;">×</button>
            </div>
        </div>
        <div style="border-top:1px solid ${topBorderColor};padding-top:10px;">
            <div id="mh-artist-album-info" style="margin-bottom:2px;color:${textColor};">
                Artist: <b style="color:${headerColor}">${esc(currentInfo.artist)}</b><br>
                Album: <b style="color:${headerColor}">${esc(currentInfo.album)}</b>
            </div>

            <div style="display:flex;gap:8px;margin-bottom:12px">
                <button id="mh-puppet-search" style="flex:1;padding:10px 15px;border-radius:5px;background:#337ab7;color:white;border:none;font-weight:bold;cursor:pointer;">
                    Search and Pick an Artwork
                </button>
            </div>

            <div id="mh-status" style="color:${isDark ? '#9aa' : '#666'};margin-top:8px;text-align:center;">Ready for Cover Search Engine.</div>
        </div>

        <div id="mh-settings-panel" style="display:none;border-top:1px solid ${topBorderColor};padding-top:10px;margin-bottom:4px;">
            <div style="font-weight:700;color:${headerColor};margin-bottom:10px;">Settings</div>
            <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:4px;color:${labelColor};">Sources:</label>
                <div id="mh-sources-checkboxes" style="max-height:130px;overflow-y:auto;border:1px solid ${inputBorder};padding:4px;border-radius:4px;background:${inputBg};">
                    ${sourceCheckboxesHtml}
                </div>
            </div>
            <div style="margin-bottom:8px;">
                <label for="mh-res-input" style="display:block;margin-bottom:4px;color:${labelColor};">Minimal Resolution:</label>
                <input type="number" id="mh-res-input" style="width:100%;padding:8px;border-radius:4px;background:${inputBg};border:1px solid ${inputBorder};color:${textColor};">
            </div>
            <div style="margin-bottom:8px;">
                <label for="mh-country-select" style="display:block;margin-bottom:4px;color:${labelColor};">Country:</label>
                <select id="mh-country-select" style="width:100%;padding:8px;border-radius:4px;background:${inputBg};border:1px solid ${inputBorder};color:${textColor};cursor:pointer;">
                    <option value="au">Australia</option>
                    <option value="br">Brazil</option>
                    <option value="ca">Canada</option>
                    <option value="cn">China</option>
                    <option value="fr">France</option>
                    <option value="de">Germany</option>
                    <option value="in">India</option>
                    <option value="it">Italy</option>
                    <option value="jp">Japan</option>
                    <option value="kr">Korea</option>
                    <option value="mx">Mexico</option>
                    <option value="tw">Taiwan</option>
                    <option value="gb">United Kingdom</option>
                    <option value="us">United States</option>
                </select>
            </div>
            <div style="margin-bottom:8px;">
                <label for="mh-theme-select" style="display:block;margin-bottom:4px;color:${labelColor};">Theme:</label>
                <select id="mh-theme-select" style="width:100%;padding:8px;border-radius:4px;background:${inputBg};border:1px solid ${inputBorder};color:${textColor};cursor:pointer;">
                    <option value="dark">Dark Mode</option>
                    <option value="light">Light Mode</option>
                </select>
            </div>
            <button id="mh-save-settings" style="width:100%;padding:8px;border-radius:5px;background:#28a745;color:white;border:none;cursor:pointer;">Save Settings</button>
        </div>
    `;
    document.body.appendChild(panel);

    $('#mh-puppet-search').addEventListener('click', openPuppetSearch);
    $('#mh-settings-btn').addEventListener('click', toggleSettingsPanel);
    $('#mh-save-settings').addEventListener('click', saveAndCloseSettings);
    $('#mh-close-btn').addEventListener('click', () => {
        panel.remove();
    });

    return panel;
}

/* Settings Panel Logic */
function toggleSettingsPanel() {
    const settingsPanel = $('#mh-settings-panel');
    const searchBtn = $('#mh-puppet-search');
    const statusEl = $('#mh-status');
    const artistAlbumInfo = $('#mh-artist-album-info');
    const mainContent = artistAlbumInfo?.parentElement;

    if (settingsPanel.style.display === 'none') {
        loadSettingsIntoPanel();
        settingsPanel.style.display = 'block';
        if (mainContent) mainContent.style.display = 'none';
    } else {
        settingsPanel.style.display = 'none';
        if (mainContent) mainContent.style.display = 'block';
    }
}

function loadSettingsIntoPanel() {
    // Populate checkboxes based on current config
    ALL_SOURCES.forEach(source => {
        const checkbox = $(`#mh-source-${source.replace(/\s/g, '_')}`);
        if (checkbox) {
            checkbox.checked = MH_CONFIG.sources.includes(source);
        }
    });

    $('#mh-country-select').value = MH_CONFIG.country;
    $('#mh-res-input').value = MH_CONFIG.resolution;
    $('#mh-theme-select').value = MH_CONFIG.theme;
}

async function saveAndCloseSettings() {
    // Read selected sources from checkboxes
    const selectedSources = Array.from(document.querySelectorAll('#mh-sources-checkboxes input[name="mh-sources"]:checked'))
                                 .map(checkbox => checkbox.value);
    MH_CONFIG.sources = selectedSources;

    MH_CONFIG.country = $('#mh-country-select').value;
    MH_CONFIG.resolution = $('#mh-res-input').value.trim();

    const oldTheme = MH_CONFIG.theme;
    MH_CONFIG.theme = $('#mh-theme-select').value;

    await saveConfig();

    // Always recreate panel to apply theme changes
    const panel = document.getElementById('mh-cover-panel');
    if (panel) {
        panel.remove();
        setTimeout(() => {
            const newPanel = createPanel();
            if (newPanel) {
                const statusEl = $('#mh-status');
                if (statusEl) statusEl.textContent = 'Settings saved!';
            }
        }, 100);
    }
}

/* Puppet Search Logic */
function openPuppetSearch() {
    if (!currentInfo) {
        alert('Cannot determine artist/album info for this page.');
        return;
    }
    const url = buildMhUrl(currentInfo, { remote: true, remoteText: `Pick cover for ${currentInfo.artist} — ${currentInfo.album}` });

    // Store Last.fm tab reference before opening new window
    if (typeof GM_setValue === 'function') {
        GM_setValue('lastfm_tab_id', window.name || 'lastfm-main-tab');
        if (!window.name) {
            window.name = 'lastfm-main-tab';
        }
    }

    window.open(url, '_blank');
    $('#mh-status').textContent = 'Cover Search Engine opened. Pick an artwork.';
}

/* Communication with Puppet Window */
window.addEventListener('message', async function(event) {
    if (event.origin !== 'https://covers.musichoarders.xyz') {
        return;
    }

    if (MH_CONFIG.debug) console.log('Received message from Cover Search Engine:', event.data);

    if (event.data && event.data.name === 'artworkSelected' && event.data.data && event.data.data.url) {
        const artworkUrl = event.data.data.url;
        const releaseDate = event.data.data.releaseDate || null;
        const statusEl = $('#mh-status');
        if (statusEl) statusEl.textContent = 'Artwork selected! Downloading and setting...';

        // Focus this window (Firefox fix)
        window.focus();

        try {
            const fileInput = await findLastFmFileInput();

            if (fileInput) {
                if (MH_CONFIG.debug) console.log('Found Last.fm file input:', fileInput);
                const file = await downloadImageAsFile(artworkUrl);

                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(file);
                fileInput.files = dataTransfer.files;

                fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                fileInput.dispatchEvent(new Event('input', { bubbles: true }));

                // Fill in Title and Description fields
                await fillLastFmMetadata(releaseDate);

                if (statusEl) statusEl.textContent = '✓ Artwork set! You can now upload on Last.fm.';
                if (MH_CONFIG.debug) console.log('Artwork successfully set to file input.');
            } else {
                const errMsg = 'Last.fm upload input not found. Please ensure the upload dialog is open.';
                if (statusEl) statusEl.textContent = errMsg;
                console.error('CoverFinder:', errMsg);
                if (confirm('Could not auto-fill. Open artwork URL in new tab?')) {
                    window.open(artworkUrl, '_blank');
                }
            }
        } catch (e) {
            console.error('CoverFinder: Failed to set artwork:', e);
            if (statusEl) statusEl.textContent = `Error: ${e.message}`;
            if (confirm('Error setting artwork. Open URL in new tab?')) {
                window.open(artworkUrl, '_blank');
            }
        }
    }
});

async function fillLastFmMetadata(releaseDate) {
    try {
        // Wait a bit for the form to be ready
        await sleep(500);

        // Find Title field (id="id_title" or name="title")
        const titleInput = document.querySelector('input#id_title[name="title"], input[name="title"]');

        // Find Description field (id="id_description" or name="description")
        const descriptionInput = document.querySelector('textarea#id_description[name="description"], textarea[name="description"]');

        if (currentInfo && titleInput) {
            const titleValue = `${currentInfo.artist} - ${currentInfo.album}`;
            titleInput.value = titleValue;
            titleInput.dispatchEvent(new Event('input', { bubbles: true }));
            titleInput.dispatchEvent(new Event('change', { bubbles: true }));
            if (MH_CONFIG.debug) console.log('CoverFinder: Set title to:', titleValue);
        }

        if (descriptionInput) {
            let descValue = '';
            if (releaseDate) {
                descValue = `Released: ${releaseDate}`;
            } else {
                // Fallback description if no release date
                descValue = `Album artwork for ${currentInfo.album} by ${currentInfo.artist}`;
            }
            descriptionInput.value = descValue;
            descriptionInput.dispatchEvent(new Event('input', { bubbles: true }));
            descriptionInput.dispatchEvent(new Event('change', { bubbles: true }));
            if (MH_CONFIG.debug) console.log('CoverFinder: Set description to:', descValue);
        }
    } catch (e) {
        console.warn('CoverFinder: Error filling metadata fields:', e);
    }
}

async function findLastFmFileInput(timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const fileInput = document.querySelector('input#id_image[type="file"][name="image"]');

        if (fileInput && fileInput.offsetParent !== null) {
            if (MH_CONFIG.debug) console.log('Found Last.fm file input:', fileInput);
            return fileInput;
        }
        await sleep(500);
    }
    if (MH_CONFIG.debug) console.warn('findLastFmFileInput: File input not found within timeout.');
    return null;
}

function getExtensionFromUrl(url) {
    try {
        const urlParts = url.split('?')[0].split('.');
        if (urlParts.length > 1) {
            const extension = urlParts[urlParts.length - 1].toLowerCase();
            // Common image extensions
            if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'svg'].includes(extension)) {
                return extension;
            }
        }
    } catch (e) {
        console.warn('Error extracting extension from URL:', e);
    }
    return null;
}

function getExtensionFromMime(mime) {
    const mimeToExt = {
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/bmp': 'bmp',
        'image/tiff': 'tiff',
        'image/svg+xml': 'svg'
    };
    return mimeToExt[mime.toLowerCase()] || null;
}

function downloadImageAsFile(url) {
    return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest === 'function') {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'arraybuffer',
                onload: function (res) {
                    try {
                        const arr = res.response;
                        const hdrs = res.responseHeaders || '';
                        const m = hdrs.match(/content-type:\s*([^\r\n;]+)/i);
                        const mime = (m && m[1]) || 'image/jpeg';

                        // Try to get extension from URL first, then from MIME type
                        let extension = getExtensionFromUrl(url) || getExtensionFromMime(mime) || 'jpg';

                        const baseFileName = "Uploaded With Last.fm Artwork Upload Helper";
                        const fileName = `${baseFileName}.${extension}`;

                        const blob = new Blob([arr], { type: mime });

                        let file;
                        try { file = new File([blob], fileName, { type: mime }); }
                        catch (e) {
                            file = blob;
                            file.name = fileName;
                            file.type = mime;
                        }
                        resolve(file);
                    } catch (e) {
                        console.error('Error processing GM_xmlhttpRequest response:', e);
                        reject(e);
                    }
                },
                onerror: function (err) {
                    console.error('GM_xmlhttpRequest error:', err);
                    reject(new Error(`Failed to download image: ${err.status || 'network error'}`));
                },
                ontimeout: function () {
                    reject(new Error('Image download timed out.'));
                }
            });
        } else {
            fetch(url, { credentials: 'omit' }).then(r => {
                if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
                return r.blob();
            }).then(blob => {
                const mime = blob.type || 'image/jpeg';

                // Try to get extension from URL first, then from MIME type
                let extension = getExtensionFromUrl(url) || getExtensionFromMime(mime) || 'jpg';

                const baseFileName = "Uploaded With Last.fm Artwork Upload Helper";
                const fileName = `${baseFileName}.${extension}`;

                let file;
                try { file = new File([blob], fileName, { type: mime }); }
                catch (e) {
                    file = blob;
                    file.name = fileName;
                    file.type = mime;
                }
                resolve(file);
            }).catch(e => {
                console.error('Fetch API error:', e);
                reject(new Error(`Failed to download: ${e.message}`));
            });
        }
    });
}

// --- Function to inject script into the puppet window ---
function injectArtworkSelectionScript() {
    const debug = DEFAULT_CONFIG.debug;
    if (debug) console.log('Cover Search Engine Puppet: Injecting selection script...');

    const scriptContent = `
        (function() {
            const debug = ${debug};
            const targetOrigin = 'https://www.last.fm';

            if (debug) console.log('MH Puppet: Script starting, waiting for images...');

            function waitForImages(callback, maxWait = 10000) {
                const startTime = Date.now();
                const checkInterval = setInterval(() => {
                    const images = document.querySelectorAll('img[src*="cover"], img[src*="album"], img[src*="artwork"], .cover img, .album-art img, a > img, button img');

                    if (images.length > 0 || Date.now() - startTime > maxWait) {
                        clearInterval(checkInterval);
                        if (debug) console.log('MH Puppet: Found', images.length, 'potential artwork images');
                        callback();
                    }
                }, 300);
            }

            function getLargestImageUrl(element) {
                if (!element) return null;

                if (element.tagName === 'IMG') {
                    const img = element;

                    if (img.dataset.fullsize) return img.dataset.fullsize;
                    if (img.dataset.full) return img.dataset.full;
                    if (img.dataset.original) return img.dataset.original;
                    if (img.dataset.hires) return img.dataset.hires;

                    const parentLink = img.closest('a');
                    if (parentLink && parentLink.href) {
                        if (/\\.(jpg|jpeg|png|webp|gif)(\\?|$)/i.test(parentLink.href)) {
                            return parentLink.href;
                        }
                    }

                    if (img.dataset.src) return img.dataset.src;

                    if (img.srcset) {
                        const sources = img.srcset.split(',').map(s => s.trim().split(' '));
                        let largestUrl = '';
                        let largestWidth = 0;
                        for (const source of sources) {
                            const url = source[0];
                            const widthMatch = source[1] ? source[1].match(/(\\d+)w/) : null;
                            if (widthMatch) {
                                const width = parseInt(widthMatch[1], 10);
                                if (width > largestWidth) {
                                    largestWidth = width;
                                    largestUrl = url;
                                }
                            }
                        }
                        if (largestUrl) return largestUrl;
                    }

                    let imgSrc = img.src;
                    imgSrc = imgSrc.replace(/\\._[A-Z]{2}\\d+_\\./, '.');
                    imgSrc = imgSrc.replace(/\\._AC_UL\\d+_\\./, '.');
                    imgSrc = imgSrc.replace(/\\/image\\/[a-f0-9]+\\/\\d+x\\d+/, (match) => {
                        return match.replace(/\\/\\d+x\\d+/, '');
                    });

                    return imgSrc;
                }

                const bgStyle = window.getComputedStyle(element);
                if (bgStyle.backgroundImage && bgStyle.backgroundImage !== 'none') {
                    const match = bgStyle.backgroundImage.match(/url\\(["']?(.+?)["']?\\)/);
                    if (match && match[1]) return match[1];
                }

                const childImg = element.querySelector('img');
                if (childImg) return getLargestImageUrl(childImg);

                return null;
            }

            function setupClickHandlers() {
                // AGGRESSIVE APPROACH: Add a global click interceptor
                document.addEventListener('click', function(e) {
                    // Check if the click target is or contains an image
                    let targetImg = null;

                    if (e.target.tagName === 'IMG') {
                        targetImg = e.target;
                    } else {
                        targetImg = e.target.querySelector('img');
                    }

                    if (targetImg) {
                        // STOP EVERYTHING
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();

                        const imageUrl = getLargestImageUrl(targetImg);

                        // Try to extract release date from the page
                        let releaseDate = null;
                        try {
                            const dateElements = document.querySelectorAll('[data-date], [data-release], [data-year], td, dd, p, span, div');
                            for (const elem of dateElements) {
                                const text = elem.textContent || elem.innerText || '';
                                const datePatterns = [
                                    /(?:^|\\s)(\\d{4}-\\d{2}-\\d{2})(?:\\s|$)/,
                                    /(?:^|\\s)(\\d{1,2}\\.\\d{1,2}\\.\\d{4})(?:\\s|$)/,
                                    /(?:^|\\s)(\\d{1,2}\\/\\d{1,2}\\/\\d{4})(?:\\s|$)/,
                                    /(?:^|\\s)([A-Z][a-z]+ \\d{1,2},? \\d{4})(?:\\s|$)/,
                                    /(?:^|\\s)(\\d{1,2} [A-Z][a-z]+ \\d{4})(?:\\s|$)/,
                                    /(?:^|\\s)(\\d{4})(?:\\s|$)/
                                ];

                                for (const pattern of datePatterns) {
                                    const match = text.match(pattern);
                                    if (match && match[1]) {
                                        const potentialDate = match[1].trim();
                                        if (/19\\d{2}|20\\d{2}/.test(potentialDate)) {
                                            releaseDate = potentialDate;
                                            break;
                                        }
                                    }
                                }
                                if (releaseDate) break;
                            }

                            if (!releaseDate) {
                                const metaDate = document.querySelector('meta[property="music:release_date"], meta[name="music:release_date"], meta[property="release_date"]');
                                if (metaDate && metaDate.content) {
                                    releaseDate = metaDate.content;
                                }
                            }

                            if (debug && releaseDate) console.log('MH Puppet: Found release date:', releaseDate);
                        } catch (err) {
                            if (debug) console.warn('MH Puppet: Error extracting release date:', err);
                        }

                        if (imageUrl && window.opener && !window.opener.closed) {
                            if (debug) console.log('MH Puppet: Sending artwork URL:', imageUrl, 'with release date:', releaseDate);

                            window.opener.postMessage({
                                name: 'artworkSelected',
                                data: {
                                    url: imageUrl,
                                    releaseDate: releaseDate
                                }
                            }, targetOrigin);

                            targetImg.dataset.selected = 'true';
                            targetImg.style.outline = '3px solid #00ff00 !important';
                            targetImg.style.boxShadow = '0 0 20px rgba(0,255,0,0.5) !important';

                            try {
                                window.opener.focus();
                            } catch (e) {
                                if (debug) console.warn('Could not focus opener:', e);
                            }

                            setTimeout(() => window.close(), 500);
                        } else {
                            if (debug) console.warn('MH Puppet: Could not extract image URL or no opener');
                        }

                        return false;
                    }
                }, true); // Use capture phase

                // Also block mousedown and mouseup on all images
                document.addEventListener('mousedown', function(e) {
                    if (e.target.tagName === 'IMG' || e.target.querySelector('img')) {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                    }
                }, true);

                document.addEventListener('mouseup', function(e) {
                    if (e.target.tagName === 'IMG' || e.target.querySelector('img')) {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                    }
                }, true);

                // Add visual feedback to all images
                const allImages = document.querySelectorAll('img');
                allImages.forEach(img => {
                    img.style.cursor = 'pointer';

                    img.addEventListener('mouseenter', function() {
                        if (!this.dataset.selected) {
                            this.style.outline = '3px solid #00ff00 !important';
                            this.style.boxShadow = '0 0 15px rgba(0,255,0,0.5) !important';
                            this.style.filter = 'brightness(1.1)';
                        }
                    });

                    img.addEventListener('mouseleave', function() {
                        if (!this.dataset.selected) {
                            this.style.outline = '';
                            this.style.boxShadow = '';
                            this.style.filter = '';
                        }
                    });
                });

                if (debug) console.log('MH Puppet: Global click interceptor installed for', allImages.length, 'images');
            }

            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;background:linear-gradient(135deg, #00c853 0%, #00e676 100%);color:white;text-align:center;padding:12px;z-index:999999;font-size:15px;font-weight:600;box-shadow:0 2px 10px rgba(0,0,0,0.3);font-family:system-ui,-apple-system,sans-serif;';
            overlay.innerHTML = '✨ Click any artwork to select it for Last.fm ✨';
            document.body.prepend(overlay);

            waitForImages(setupClickHandlers);

            if (debug) console.log('MH Puppet: Script fully initialized');
        })();
    `;

    const scriptElement = document.createElement('script');
    scriptElement.textContent = scriptContent;
    scriptElement.id = 'mh-puppet-injector-script';
    document.head.appendChild(scriptElement);

    if (debug) console.log('Cover Search Engine Puppet: Script injected into page');
}

/* init */
(async () => {
    await loadConfig();

    function checkAndCreatePanel() {
        const currentlyOnUploadPath = isUploadPath();
        const panelExists = !!document.getElementById('mh-cover-panel');

        if (currentlyOnUploadPath && !panelExists) {
            setTimeout(() => {
                if (isUploadPath()) {
                    const panel = createPanel();
                    if (MH_CONFIG.debug && panel) {
                        console.log('CoverFinder: Panel created for upload page');
                    } else if (MH_CONFIG.debug && !panel) {
                        console.log('CoverFinder: Could not create panel (missing artist/album info)');
                    }
                }
            }, 500);
        } else if (!currentlyOnUploadPath && panelExists) {
            const existingPanel = document.getElementById('mh-cover-panel');
            if (existingPanel) {
                existingPanel.remove();
                if (MH_CONFIG.debug) console.log('CoverFinder: Panel removed (not on upload page)');
            }
        }
    }

    checkAndCreatePanel();

    let lastUrl = location.href;
    new MutationObserver(() => {
        const currentUrl = location.href;
        if (currentUrl !== lastUrl) {
            lastUrl = currentUrl;
            if (MH_CONFIG.debug) console.log('CoverFinder: URL changed to', currentUrl);
            checkAndCreatePanel();
        }
    }).observe(document.body, { subtree: true, childList: true });

    window.addEventListener('popstate', () => {
        if (MH_CONFIG.debug) console.log('CoverFinder: Popstate event detected');
        checkAndCreatePanel();
    });

    window._CoverFinder = {
        buildMhUrl: () => {
            const info = extractArtistAlbum();
            return info ? buildMhUrl(info) : 'Artist/Album info not available';
        },
        config: MH_CONFIG,
        saveConfig,
        loadConfig,
        findLastFmFileInput,
        downloadImageAsFile,
        createPanel
    };

    if (MH_CONFIG.debug) console.log('CoverFinder Initialized:', {
        isUploadPath: isUploadPath(),
        currentUrl: location.href
    });
})();

})();
