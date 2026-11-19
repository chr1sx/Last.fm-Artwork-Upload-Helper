// ==UserScript==
// @name         Last.fm Artwork Upload Helper
// @namespace    https://github.com/chr1sx/Last.fm-Artwork-Upload-Helper
// @version      2.0.2
// @description  A userscript that streamlines the process of uploading album artwork to Last.fm with visual missing artwork detection and batch mode support
// @author       chr1sx
// @match        https://www.last.fm/*
// @match        https://covers.musichoarders.xyz/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      covers.musichoarders.xyz
// @connect      *
// @run-at       document-idle
// @inject-into  content
// @license      MIT
// @icon         https://raw.githubusercontent.com/chr1sx/Last.fm-Artwork-Upload-Helper/refs/heads/main/Images/logo-128.png
// @downloadURL https://update.greasyfork.org/scripts/554242/Lastfm%20Artwork%20Upload%20Helper.user.js
// @updateURL https://update.greasyfork.org/scripts/554242/Lastfm%20Artwork%20Upload%20Helper.meta.js
// ==/UserScript==

(function () {
    'use strict';

    if (document.documentElement.hasAttribute('data-mh-helper-loaded')) {
        console.warn('[MH] Another copy of Last.fm Artwork Upload Helper is already running on this page (userscript and extension both enabled?). Disable one of them.');
        return;
    }
    document.documentElement.setAttribute('data-mh-helper-loaded', '2.0.2');

    const DEFAULT_CONFIG = {
        theme: 'auto',
        resolution: '0',
        sources: ['Bandcamp', 'Deezer', 'Discogs', 'iTunes', 'KuGou', 'Qobuz', 'Spotify'],
        country: 'us',
        remoteAgent: 'lastfm-mh-integration/3.4',
        showMissingIndicators: true,
        openInNewTab: true,
        openCovInstead: false,
        compressImages: true,
        animate: true,
        batchOnlyMissing: true,
        hideUploadedNextRun: true,
        batchPages: 9,
        showBatchPanel: true,
        startCollapsedBatch: true
    };

    let MH_CONFIG = {};

    const BATCH_STATE_KEY = 'mh_batch_state';

    const BATCH = {
        active: false,
        auto: false,
        popup: null,
        watcher: null,
        user: null,
        queue: [],
        pending: null,
        done: new Set(),
        runDone: new Set(),
        uploaded: {},
        pages: {},
        skipped: new Set(),
        scope: null,
        scanning: false,
        scanToken: 0,
        scanNext: 1,
        scanBy: null,
        scanPromise: null,
        scanProgress: null,
        lastScan: null,
        runId: 0,
        runPicks: 0,
        finishPending: false,
        openBlocked: false,
        single: false,
        stats: { uploaded: 0, failed: 0 }
    };

    const BATCH_ALIVE_MS = 8000;
    const BATCH_MAX_PARALLEL_UPLOADS = 6;
    const UPLOAD_STAGGER_MS = 800;

    const UI = { collapsed: null };

    function trimStatus(text) {
        return String(text == null ? '' : text).replace(/[.\s]+$/, '');
    }

    const TAB_ID = (() => {
        try {
            let id = sessionStorage.getItem('mh-batch-tab');
            if (!id) {
                id = Math.random().toString(36).slice(2) + Date.now().toString(36);
                sessionStorage.setItem('mh-batch-tab', id);
            }
            return id;
        } catch (e) { return 'tab'; }
    })();

    let nextUploadAt = 0;
    let activeUploads = 0;
    const uploadWaiters = [];
    let lastSelectionUrl = null;
    let lastSelectionAt = 0;

    const ALL_SOURCES = [
        'Amazon Music', 'Apple Music', 'Bandcamp', 'Beatport', 'BOOTH', 'Bugs', 'Deezer', 'Discogs',
        'Fanart.tv', 'FLO', 'Gaana', 'iTunes', 'KKBOX', 'KuGou', 'LINE MUSIC', 'Melon',
        'MusicBrainz', 'OTOTOY', 'Qobuz', 'Soulseek', 'Spotify', 'THWiki', 'TIDAL', 'VGMdb', 'SoundCloud'
    ];

    function createSourceSlug(sourceName) {
        return sourceName.replace(/[^a-zA-Z0-9_]/g, '_');
    }

    const $mh = (s, r = document) => r.querySelector(s);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const esc = s => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
    const escapeRegExp = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    async function getImageDimensions(blob) {
        return new Promise((resolve) => {
            if (!blob || blob.size === 0) {
                resolve({ width: 0, height: 0 });
                return;
            }
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(img.src);
                resolve({ width: img.width, height: img.height });
            };
            img.onerror = () => {
                URL.revokeObjectURL(img.src);
                resolve({ width: 0, height: 0 });
            };
            img.src = URL.createObjectURL(blob);
        });
    }

    async function compressImage(blob, maxSizeMB = 5, forceResize = true, targetMimeType = 'image/jpeg') {
        const sizeInMB = blob.size / (1024 * 1024);

        if (!forceResize && sizeInMB <= maxSizeMB && blob.type === targetMimeType) {
            return { blob, wasModified: false };
        }

        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');

                let width = img.width;
                let height = img.height;
                const maxDimension = 1400;

                if (forceResize && (width > maxDimension || height > maxDimension)) {
                    if (width > height) {
                        height = (height / width) * maxDimension;
                        width = maxDimension;
                    } else {
                        width = (width / height) * maxDimension;
                        height = maxDimension;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                ctx.drawImage(img, 0, 0, width, height);

                let quality = 0.92;
                const originalBlob = blob;

                const tryCompress = () => {
                    canvas.toBlob((compressedBlob) => {
                        if (!compressedBlob) {
                            reject(new Error('Compression failed'));
                            return;
                        }

                        const compressedSizeMB = compressedBlob.size / (1024 * 1024);

                        if (compressedSizeMB > maxSizeMB && quality > 0.5) {
                            quality -= 0.05;
                            tryCompress();
                        } else {
                            const wasModified = originalBlob.size > compressedBlob.size + 1024 || originalBlob.type !== compressedBlob.type;
                            resolve({ blob: compressedBlob, wasModified });
                        }
                    }, targetMimeType, quality);
                };

                tryCompress();
            };

            img.onerror = () => reject(new Error('Failed to load image for compression'));
            img.src = URL.createObjectURL(blob);
        });
    }

    function encodeSources(list) {
        return list.map(s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')).join(',');
    }

    async function saveConfig() {
        await GM_setValue('mh_config', JSON.stringify(MH_CONFIG));
    }

    async function loadConfig() {
        const storedConfig = await GM_getValue('mh_config');
        let loadedConfig = storedConfig ? JSON.parse(storedConfig) : {};

        MH_CONFIG = Object.assign({}, DEFAULT_CONFIG, loadedConfig);

        if (!MH_CONFIG.hasOwnProperty('compressImages')) {
            MH_CONFIG.compressImages = DEFAULT_CONFIG.compressImages;
        }

        if (!MH_CONFIG.hasOwnProperty('animate')) {
            MH_CONFIG.animate = DEFAULT_CONFIG.animate;
        }

        if (!MH_CONFIG.country) {
            MH_CONFIG.country = DEFAULT_CONFIG.country;
        }

        if (MH_CONFIG.hasOwnProperty('autoHighlightMissing')) {
            delete MH_CONFIG.autoHighlightMissing;
        }

        if (!MH_CONFIG.hasOwnProperty('startCollapsedBatch')) {
            MH_CONFIG.startCollapsedBatch = DEFAULT_CONFIG.startCollapsedBatch;
        }

        let configChanged = false;
        if (!MH_CONFIG.hasOwnProperty('themeMigratedToAuto')) {
            if (MH_CONFIG.theme === 'light') MH_CONFIG.theme = 'auto';
            MH_CONFIG.themeMigratedToAuto = true;
            configChanged = true;
        }

        if (!MH_CONFIG.batchPagesDefault9) {
            if (MH_CONFIG.batchPages === 10) MH_CONFIG.batchPages = 9;
            MH_CONFIG.batchPagesDefault9 = true;
            configChanged = true;
        }

        if (!storedConfig || configChanged) await saveConfig();
    }

    async function loadBatchState() {
        try {
            const raw = await GM_getValue(BATCH_STATE_KEY);
            const state = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
            const fresh = Date.now() - (state.lastAlive || 0) < BATCH_ALIVE_MS;
            const ownedHere = !state.owner || state.owner === TAB_ID;
            BATCH.active = !!state.active && fresh && ownedHere && !state.busy;
            BATCH.done = new Set(Array.isArray(state.done) ? state.done : []);
            BATCH.runDone = new Set(Array.isArray(state.runDone) ? state.runDone : []);
            BATCH.uploaded = state.uploaded || {};
            BATCH.pages = state.pages || {};
            BATCH.skipped = new Set(Array.isArray(state.skipped) ? state.skipped : []);
            BATCH.stats = Object.assign({ uploaded: 0, failed: 0 }, state.stats || {});
            if (state.active && !BATCH.active && (ownedHere || !fresh)) await saveBatchState();
            syncBatchHeartbeat();
        } catch (e) {
            console.warn('[MH] Could not load batch state:', e);
        }
    }

    let batchHeartbeat = null;

    function syncBatchHeartbeat() {
        if (BATCH.active && !batchHeartbeat) {
            batchHeartbeat = setInterval(() => {
                if (BATCH.active) saveBatchState();
            }, 2000);
        } else if (!BATCH.active && batchHeartbeat) {
            clearInterval(batchHeartbeat);
            batchHeartbeat = null;
        }
    }

    async function saveBatchState() {
        syncBatchHeartbeat();
        try {
            await GM_setValue(BATCH_STATE_KEY, JSON.stringify({
                active: BATCH.active,
                lastAlive: Date.now(),
                    owner: TAB_ID,
                    busy: !!(BATCH.auto || BATCH.scanning || BATCH.pending),
                done: Array.from(BATCH.done),
                runDone: Array.from(BATCH.runDone),
                uploaded: BATCH.uploaded,
                    pages: BATCH.pages,
                    skipped: Array.from(BATCH.skipped),
                stats: BATCH.stats
            }));
        } catch (e) {
            console.warn('[MH] Could not save batch state:', e);
        }
    }

    function buildMhUrl({ artist, album }, opts = {}) {
        const params = new URLSearchParams();
        const cfg = Object.assign({}, MH_CONFIG, opts || {});

        if (cfg.theme) params.set('theme', cfg.theme);
        if (cfg.resolution) params.set('resolution', cfg.resolution);
        if (cfg.sources && cfg.sources.length) params.set('sources', encodeSources(cfg.sources));
        if (cfg.country) params.set('country', cfg.country.toLowerCase());
        if (artist) params.set('artist', artist);
        if (album) params.set('album', album);

        params.set('remote.port', 'browser');
        if (cfg.remoteAgent) params.set('remote.agent', cfg.remoteAgent);
        if (opts.remoteText) params.set('remote.text', opts.remoteText);

        return `https://covers.musichoarders.xyz/?${params.toString()}`;
    }

    function isMissingArtwork(element) {
        if (!element) return false;

        const src = element.src || element.dataset?.src || '';

        const placeholderPatterns = [
            '/defaults/images/album/default_album_300_3.png',
            '/defaults/images/album/default_album_',
            '2a96cbd8b46e442fc41c2b86b821562f.png',
            '2a96cbd8b46e442fc41c2b86b821562f.jpg',
            'c6f59c1e5e7240a4c0d427abd71f3dbb.png',
            'c6f59c1e5e7240a4c0d427abd71f3dbb.jpg',
            'c6f59c1e5e7240a4c0d427abd71f3dbb',
            'default_album'
        ];

        return placeholderPatterns.some(pattern => src.includes(pattern));
    }

    function decodeLastFmSegment(segment) {
        if (!segment) return '';
        try {
            let decoded = decodeURIComponent(segment.replace(/\+/g, '%20'));
            if (/%[0-9a-f]{2}/i.test(decoded)) {
                try { decoded = decodeURIComponent(decoded); } catch {}
            }
            return decoded;
        } catch {
            return segment.replace(/\+/g, ' ');
        }
    }

    function normalizeAlbumUrl(href) {
        if (!href) return null;
        try {
            const u = new URL(href, location.origin);
            if (u.hostname !== 'www.last.fm') return null;

            const path = u.pathname.split('/+')[0].replace(/\/+$/, '');
            const parts = path.split('/').filter(Boolean);
            const musicIndex = parts.indexOf('music');
            if (musicIndex === -1 || parts.length < musicIndex + 3) return null;

            const albumParts = parts.slice(musicIndex);
            if (albumParts.includes('_')) return null;

            return 'https://www.last.fm/' + albumParts.join('/');
        } catch {
            return null;
        }
    }

    function splitAlbumUrl(albumUrl) {
        try {
            const parts = new URL(albumUrl).pathname.split('/').filter(Boolean);
            const musicIndex = parts.indexOf('music');
            return {
                artist: decodeLastFmSegment(parts[musicIndex + 1] || ''),
                album: decodeLastFmSegment(parts[musicIndex + 2] || '')
            };
        } catch {
            return { artist: '', album: '' };
        }
    }

    function libraryFilterParams(search) {
        const source = new URLSearchParams(search);
        const filters = new URLSearchParams();
        ['date_preset', 'from', 'rangetype', 'to'].forEach(name => {
            const value = source.get(name);
            if (value) filters.set(name, value);
        });
        return filters;
    }

    function getBatchScope(pathname = location.pathname, search = location.search) {
        const parts = pathname.split('/').filter(Boolean);
        const lower = parts.map(p => p.toLowerCase());
        const filterKey = libraryFilterParams(search).toString();
        const filterQuery = filterKey ? `${filterKey}&` : '';

        if (lower[0] === 'user' && parts[1]) {
            const user = decodeLastFmSegment(parts[1]);
            if (lower[2] === 'library' && lower[3] === 'music' && parts[4] && !parts[4].startsWith('+') &&
                (parts.length === 5 || parts[5].startsWith('+'))) {
                const artist = decodeLastFmSegment(parts[4]);
                return {
                    type: 'userArtist',
                    user,
                    artist,
                    key: `userartist:${user}:${artist}:${filterKey}`.toLowerCase(),
                    label: artist,
                    tooltip: `${user} · ${artist}`,
                    noun: 'albums',
                    startHint: 'Start batch mode to scan this artist’s albums and pick artwork album by album',
                    emptyHint: 'Start to scan this artist’s albums in this library',
                    pageUrl: page => `https://www.last.fm/user/${encodeURIComponent(user)}/library/music/${parts[4]}/+albums?${filterQuery}page=${page}`
                };
            }
            const section = lower[2] === 'library' ? (lower[3] || '') : '';
            const listPath = section === 'albums' ? 'library/albums' : 'library';
            return {
                type: 'library',
                user,
                artist: null,
                key: `library:${user}:${section}:${filterKey}`.toLowerCase(),
                label: user,
                tooltip: `${user}’s library`,
                noun: 'library',
                startHint: 'Start batch mode to scan this library and pick artwork album by album',
                emptyHint: parts.length === 2 ? 'Start to scan recent tracks' : 'Start to scan this library',
                pageUrl: page => `https://www.last.fm/user/${encodeURIComponent(user)}/${listPath}?${filterQuery}page=${page}`
            };
        }

        if (lower[0] === 'music' && parts[1] && !parts[1].startsWith('+') &&
            (parts.length === 2 || (parts.length === 3 && lower[2] === '+albums'))) {
            const artist = decodeLastFmSegment(parts[1]);
            const order = new URLSearchParams(search).get('order') || '';
            return {
                type: 'artist',
                user: null,
                artist,
                order,
                key: `artist:${artist}:${order}`.toLowerCase(),
                label: artist,
                tooltip: `${artist} · albums`,
                noun: 'albums',
                startHint: 'Start batch mode to scan this artist’s albums and pick artwork album by album',
                emptyHint: 'Start to scan this artist’s albums',
                pageUrl: page => `https://www.last.fm/music/${parts[1]}/+albums?${order ? `order=${encodeURIComponent(order)}&` : ''}page=${page}`
            };
        }

        return null;
    }

    function isBatchListingPath() {
        const scope = getBatchScope();
        if (!scope) return false;
        return scope.type === 'library' ? isUserLibraryPath(location.pathname) : true;
    }

    function collectScopeAlbums(doc) {
        const albums = collectAlbumsFromDocument(doc);
        const scope = BATCH.scope;
        if (!scope || !scope.artist) return albums;
        const wanted = scope.artist.toLowerCase();
        return albums.filter(album => (album.artist || '').toLowerCase() === wanted);
    }

    function isUserLibraryPath(pathname = location.pathname) {
        return /^\/user\/[^/]+\/library(?:\/|$)/i.test(pathname);
    }

    function getCoverImageFromContainer(container) {
        if (!container) return null;
        return container.querySelector('td.chartlist-image img') ||
               container.querySelector('.cover-art img') ||
               container.querySelector('.grid-items-cover-image img') ||
               container.querySelector('.grid-items-cover-image-image') ||
               container.querySelector('img');
    }

    function getAlbumUrlFromContainer(container) {
        if (!container) return null;

        const selectors = [
            'td.chartlist-image a[href*="/music/"]',
            '.cover-art a[href*="/music/"]',
            'a.js-link-block-cover-link[href*="/music/"]',
            'a.cover-art[href*="/music/"]',
            '.grid-items-cover-image a[href*="/music/"]',
            'a.link-block-target[href*="/music/"]',
            'td.chartlist-name a[href*="/music/"]'
        ];

        for (const selector of selectors) {
            const link = container.querySelector(selector);
            const albumUrl = normalizeAlbumUrl(link && link.getAttribute('href'));
            if (albumUrl) return albumUrl;
        }

        for (const link of container.querySelectorAll('a[href*="/music/"]')) {
            const albumUrl = normalizeAlbumUrl(link.getAttribute('href'));
            if (albumUrl) return albumUrl;
        }

        return null;
    }

    function collectAlbumsFromDocument(doc) {
        const found = new Map();

        const addRow = (row) => {
            const albumUrl = getAlbumUrlFromContainer(row);
            if (!albumUrl || found.has(albumUrl)) return;

            const img = getCoverImageFromContainer(row);
            const info = splitAlbumUrl(albumUrl);

            found.set(albumUrl, {
                albumUrl,
                artist: info.artist,
                album: info.album,
                coverUrl: img ? (img.getAttribute('src') || img.src || '') : '',
                missing: isMissingArtwork(img)
            });
        };

        const rows = doc.querySelectorAll('tr.chartlist-row, .chartlist-row, .grid-items-item, .resource-list--release-list-item, .album-item, .recs-feed-item');
        rows.forEach(addRow);

        if (!rows.length) {
            doc.querySelectorAll('td.chartlist-image, .cover-art, .grid-items-cover-image').forEach(el => {
                const container = el.closest('tr, .chartlist-row, li, .grid-items-item') || el.parentElement;
                if (container) addRow(container);
            });
        }

        return Array.from(found.values());
    }

    function clampBatchPages(value) {
        const parsed = parseInt(value, 10);
        if (Number.isNaN(parsed)) return 9;
        return Math.max(1, Math.min(50, parsed));
    }

    function visibleQueue() {
        const onlyMissing = MH_CONFIG.batchOnlyMissing !== false;
        const hideUploaded = MH_CONFIG.hideUploadedNextRun !== false;
        return BATCH.queue.filter(item => {
            if (hideUploaded && (item.done || BATCH.done.has(item.albumUrl)) && !BATCH.runDone.has(item.albumUrl) && item.status !== 'uploading') return false;
            return true;
        }).filter(item =>
            item.done ||
            item.status === 'uploading' ||
            item.status === 'searching' ||
            !onlyMissing ||
            item.missing
        );
    }

    function uploadedPageUrl(albumUrl) {
        const stored = BATCH.pages[albumUrl];
        if (stored && /\/\+images\/[0-9a-f]{32}/i.test(stored)) return stored;
        return String(albumUrl).replace(/\/+$/, '') + '/+images';
    }

    function openItemPage(item) {
        if (!item || !item.albumUrl) return;
        if (item.done || item.status === 'done') {
            openUploadedPage(item.albumUrl);
            return;
        }
        window.open(String(item.albumUrl).replace(/\/+$/, '') + '/+images/upload', '_blank', 'noopener');
    }

    function openUploadedPage(albumUrl) {
        if (!albumUrl) return;
        window.open(uploadedPageUrl(albumUrl), '_blank', 'noopener');
    }

    function ensureBatchItem(albumUrl, opts = {}) {
        let item = BATCH.queue.find(candidate => candidate.albumUrl === albumUrl);
        if (!item) {
            const info = splitAlbumUrl(albumUrl);
            item = {
                albumUrl,
                artist: info.artist,
                album: info.album,
                coverUrl: opts.coverUrl || '',
                missing: true,
                status: 'idle',
                error: null,
                done: BATCH.done.has(albumUrl)
            };
            BATCH.queue.push(item);
        }
        if (BATCH.done.has(item.albumUrl)) item.done = true;
        return item;
    }

    function restingStatus(item) {
        return BATCH.skipped.has(item.albumUrl) ? 'skipped' : 'idle';
    }

    function mergeBatchQueue(found) {
        let added = 0;
        if (!Array.isArray(found)) return added;
        for (const entry of found) {
            if (!entry || !entry.albumUrl) continue;
            const existing = BATCH.queue.find(candidate => candidate.albumUrl === entry.albumUrl);
            if (existing) {
                if (!existing.coverUrl && entry.coverUrl) existing.coverUrl = entry.coverUrl;
                if (existing.missing === undefined) existing.missing = entry.missing;
                else if (existing.missing && entry.missing === false && existing.status !== 'uploading' && existing.status !== 'searching') {
                    existing.missing = false;
                    if (entry.coverUrl) existing.coverUrl = entry.coverUrl;
                }
                if (BATCH.done.has(existing.albumUrl)) existing.done = true;
                continue;
            }
            const item = Object.assign({ status: 'idle', error: null, done: false }, entry);
            item.done = BATCH.done.has(item.albumUrl);
            if (item.done) item.status = 'done';
            else if (BATCH.skipped.has(item.albumUrl)) item.status = 'skipped';
            BATCH.queue.push(item);
            added++;
        }
        return added;
    }

    function refreshBatchQueueView() {
        if (BATCH.scope && isBatchListingPath()) mergeBatchQueue(collectScopeAlbums(document));
        renderBatchQueue();
    }

    function getUploadUrlFromElement(element) {
    try {
        const container = element.closest('tr') ||
                          element.closest('.chartlist-row') ||
                          element.closest('.album-item') ||
                          element.closest('.grid-items-item') ||
                          element.closest('.grid-items-item-main-text') ||
                          element.closest('.resource-list--release-list-item') ||
                          element.closest('.recs-feed-item') ||
                          element.closest('li') ||
                          element.closest('section');

        if (!container) return null;

        let albumLink = null;
        let hasTrackLink = false;
        const allLinks = container.querySelectorAll('a[href*="/music/"]');

        for (const link of allLinks) {
            const href = link.getAttribute('href');
            if (!href) continue;

            if (href.includes('/_/')) {
                hasTrackLink = true;
                continue;
            }

            const pathParts = href.split('/').filter(Boolean);
            const musicIndex = pathParts.findIndex(p => p === 'music');

            if (musicIndex >= 0 && pathParts.length >= musicIndex + 3) {
                albumLink = link;
                break;
            }
        }

        if (albumLink) {
            const href = albumLink.getAttribute('href');
            if (!href) return null;

            let cleanHref = href.split('#')[0].split('?')[0].replace(/\/$/, '');
            if (cleanHref.startsWith('/')) {
                cleanHref = 'https://www.last.fm' + cleanHref;
            }

            const pathParts = cleanHref.split('/').filter(Boolean);
            const musicIndex = pathParts.indexOf('music');

            if (musicIndex >= 0 && pathParts.length >= musicIndex + 3) {
                const albumPath = pathParts.slice(musicIndex).join('/');
                return `https://www.last.fm/${albumPath}/+images/upload`;
            }
        }

        if (!albumLink && !hasTrackLink) {
            const albumTitleLink = container.querySelector('a.link-block-target');
            if (albumTitleLink) {
                let href = albumTitleLink.getAttribute('href');
                if (href) {
                    let cleanHref = href.split('#')[0].split('?')[0].replace(/\/$/, '');
                    if (cleanHref.startsWith('/')) {
                        cleanHref = 'https://www.last.fm' + cleanHref;
                    }

                    const pathParts = cleanHref.split('/').filter(Boolean);
                    const musicIndex = pathParts.indexOf('music');

                    if (musicIndex >= 0 && pathParts.length >= musicIndex + 3) {
                        const albumPath = pathParts.slice(musicIndex).join('/');
                        return `https://www.last.fm/${albumPath}/+images/upload`;
                    }
                }
            }

            const currentPath = window.location.pathname;
            if (currentPath.includes('/+albums')) {
                const pathParts = currentPath.split('/').filter(Boolean);
                const musicIndex = pathParts.indexOf('music');

                if (musicIndex >= 0 && pathParts.length > musicIndex + 1) {
                    const artistName = pathParts[musicIndex + 1];

                    const albumNameElement = container.querySelector('.link-block-target');
                    if (albumNameElement) {
                        const albumName = albumNameElement.textContent.trim();
                        if (albumName) {
                            const encodedAlbum = encodeURIComponent(albumName).replace(/%20/g, '+');
                            return `https://www.last.fm/music/${artistName}/${encodedAlbum}/+images/upload`;
                        }
                    }
                }
            }
        }

        if (!albumLink && hasTrackLink) {
            for (const link of allLinks) {
                const href = link.getAttribute('href');
                if (!href || href.includes('/_/')) continue;

                const pathParts = href.split('/').filter(Boolean);
                const musicIndex = pathParts.findIndex(p => p === 'music');

                if (musicIndex >= 0 && pathParts.length === musicIndex + 2) {
                    let cleanHref = href.split('#')[0].split('?')[0].replace(/\/$/, '');
                    if (cleanHref.startsWith('/')) {
                        cleanHref = 'https://www.last.fm' + cleanHref;
                    }
                    return `${cleanHref}/+albums`;
                }
            }
        }

        return null;

    } catch (e) {
        console.warn('[MH] Error getting upload URL:', e);
        return null;
    }
}
function addMissingArtworkIndicator(element, uploadUrl) {
    if (element.dataset.missingIndicatorAdded) return;
    element.dataset.missingIndicatorAdded = 'true';

    let container = element.closest('.cover-art') ||
                    element.closest('.album-cover-art') ||
                    element.closest('.header-new-background-image') ||
                    element.closest('.chartlist-image') ||
                    element.closest('.grid-items-cover-image') ||
                    element.closest('.resource-list--release-list-item-preview') ||
                    element.closest('.recs-feed-cover-image') ||
                    element.closest('.layout-image') ||
                    element.parentElement;

    if (!container) return;

    ensurePanelStyles();

    const position = window.getComputedStyle(container).position;
    if (position === 'static') {
        container.style.position = 'relative';
    }

    const borderOverlay = document.createElement('div');
    borderOverlay.className = 'mh-missing-border';

    const badge = document.createElement('div');
    badge.className = 'mh-missing-badge';
    badge.textContent = '+';
    badge.title = 'Missing Artwork - Click to upload';
    badge.dataset.uploadUrl = uploadUrl;

    const albumUrl = normalizeAlbumUrl(uploadUrl);
    let state = 'idle';
    if (albumUrl && BATCH.done.has(albumUrl)) {
        state = 'done';
        badge.textContent = '✓';
        badge.title = 'Uploaded · click to view on Last.fm';
        badge.dataset.mhBatchDone = 'true';
    } else if (BATCH.active) {
        badge.title = 'Batch mode - click to choose artwork';
    }
    badge.dataset.mhState = state;
    borderOverlay.dataset.mhState = state;

    container.appendChild(borderOverlay);
    container.appendChild(badge);
}

    function scanPageForMissingArtwork(force = false) {
    if (!MH_CONFIG.showMissingIndicators && !force && !BATCH.active) {
        return;
    }

    const allImages = Array.from(document.querySelectorAll('img[src*="lastfm"]'));

    const coverImages = allImages.filter(img => {
        const classList = img.className || '';
        const parentClass = img.parentElement?.className || '';

        const isAvatar = classList.includes('avatar') ||
                         parentClass.includes('avatar') ||
                         img.closest('.avatar');

        if (isAvatar) return false;

        const isAlbumCover = classList.includes('cover-art') ||
                             classList.includes('album-cover') ||
                             classList.includes('chartlist-image') ||
                             classList.includes('grid-items-cover-image-image') ||
                             classList.includes('resource-list--release-list-item-preview-image') ||
                             classList.includes('layout-image-image') ||
                             parentClass.includes('cover-art') ||
                             parentClass.includes('album') ||
                             parentClass.includes('chartlist-image') ||
                             parentClass.includes('grid-items-cover-image') ||
                             parentClass.includes('resource-list--release-list-item-preview') ||
                             parentClass.includes('layout-image');

        const hasAlbumContainer = img.closest('.cover-art') ||
                                  img.closest('.album-cover-art') ||
                                  img.closest('.chartlist-image') ||
                                  img.closest('.grid-items-cover-image') ||
                                  img.closest('.header-new-background-image') ||
                                  img.closest('.resource-list--release-list-item-preview') ||
                                  img.closest('.recs-feed-cover-image');

        const parentRow = img.closest('tr');
        if (parentRow) {
            const hasMusicLink = parentRow.querySelector('a[href*="/music/"]');
            if (hasMusicLink) return true;
        }

        return isAlbumCover || hasAlbumContainer;
    });

    coverImages.forEach(img => {
        if (img.dataset.missingIndicatorAdded) {
            return;
        }

        const isMissing = isMissingArtwork(img);
        if (isMissing) {
            const uploadUrl = getUploadUrlFromElement(img);
            if (uploadUrl) {
                addMissingArtworkIndicator(img, uploadUrl);
            }
        }
    });

    if (BATCH.active) applyBatchModeStyles();
}

    function isUploadPath(pathname = location.pathname) {
        if (/\/settings\/profile\/images\/upload(\/|$|\?)/i.test(pathname)) {
            return true;
        }

        if (!/\/\+images\/upload(\/|$|\?)/i.test(pathname)) {
            return false;
        }

        const parts = pathname.split('/').filter(Boolean);
        const musicIndex = parts.indexOf('music');

        if (musicIndex === -1) {
            return false;
        }

        const imagesIndex = parts.indexOf('+images');
        if (imagesIndex === -1) return false;

        const segmentsBetween = imagesIndex - musicIndex - 1;
        return segmentsBetween >= 1;
    }

    function isArtistUploadPath(pathname = location.pathname) {
        return /^\/music\/[^/]+\/\+images\/upload(\/|$)/i.test(pathname);
    }

    function extractArtistAlbum() {
        try {
            if (isArtistUploadPath()) {
                const artistPart = location.pathname.split('/').filter(Boolean)[1];
                return { artist: decodeLastFmSegment(artistPart), album: '' };
            }

            const metaArtist = document.querySelector('meta[property="music:musician"], meta[name="music:musician"]')?.content;
            const metaOgTitle = document.querySelector('meta[property="og:title"], meta[name="og:title"]')?.content;

            if (metaArtist && metaOgTitle) {
                let artist = metaArtist.trim();
                let album = metaOgTitle.trim();

                const byArtistPattern = new RegExp(` by ${escapeRegExp(artist)}`, 'i');
                if (byArtistPattern.test(album)) {
                    album = album.replace(byArtistPattern, '').trim();
                } else {
                    const dashIdx = album.indexOf(' — ');
                    if (dashIdx !== -1) {
                        const potentialArtist = album.substring(0, dashIdx).trim();
                        if (potentialArtist.toLowerCase() === artist.toLowerCase()) {
                            album = album.substring(dashIdx + 3).trim();
                        }
                    }
                }
                return { artist, album };
            }

            const artistLink = document.querySelector('a.header-new-crumb[href*="/music/"]');
            const albumHeading = document.querySelector('h1.header-new-title');

            if (artistLink && albumHeading) {
                return {
                    artist: artistLink.textContent.trim(),
                    album: albumHeading.textContent.trim()
                };
            }

            const parts = location.pathname.split('/').filter(Boolean);
            const mi = parts.indexOf('music');
            if (mi >= 0 && parts.length > mi + 2) {
                const d = s => {
                    try {
                        let normalized = s.replace(/\+/g, '%20');
                        let decoded = decodeURIComponent(normalized);
                        while (decoded.includes('%')) {
                            const next = decodeURIComponent(decoded);
                            if (next === decoded) break;
                               decoded = next;
                        }
                        return decoded;
                    } catch {
                        return s.replace(/\+/g, ' ');
                    }
                };
                return { artist: d(parts[mi + 1]), album: d(parts[mi + 2]) };
            }
        } catch (e) {
            console.warn('Error extracting artist/album:', e);
        }
        return null;
    }

    const isMHPage = location.hostname === 'covers.musichoarders.xyz';

    if (isMHPage) {
        (function initMHPageHandlers() {
            const imageSizeCache = new Map();

            function getLargestImageUrl(element) {
                if (!element) return null;

                let imageUrl = null;

                if (element.tagName === 'IMG') {
                    const img = element;
                    const src = img.src;

                    try {
                        const domain = new URL(src).hostname;

                        if (domain === 'resource-jp-linemusic.line-scdn.net') {
                            imageUrl = src.replace(/:\/\/[^/]+\/+/, '://obs.line-scdn.net/');
                            imageUrl = imageUrl.replace(/\/m\d+x\d+/, '');
                        }
                        else if (domain === 'coverartarchive.org' || domain.includes('musicbrainz.org')) {
                            imageUrl = src.replace(/-\d+(x\d+)?(\.jpg|\.png|\.gif)?$/, '$2');
                            if (!imageUrl || imageUrl === src) {
                                if (!src.endsWith('/full')) {
                                    imageUrl = src.split('?')[0].replace(/\/(\d+)(\.jpg|\.png|\.gif)?$/, '/$1/full$2');
                                    if (!imageUrl || imageUrl === src) {
                                        imageUrl = src;
                                    }
                                } else {
                                    imageUrl = src;
                                }
                            }
                        }
                        else if (domain.includes('scdn.co') && img.closest('a')?.href) {
                            imageUrl = img.closest('a').href;
                        }
                        else if (img.dataset.fullsize) imageUrl = img.dataset.fullsize;
                        else if (img.dataset.full) imageUrl = img.dataset.full;
                        else if (img.dataset.original) imageUrl = img.dataset.original;
                        else if (img.dataset.hires) imageUrl = img.dataset.hires;
                        else if (img.closest('a')?.href && /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(img.closest('a').href)) {
                            imageUrl = img.closest('a').href;
                        }
                        else if (img.dataset.src) imageUrl = img.dataset.src;
                        else if (img.srcset) {
                            const sources = img.srcset.split(',').map(s => s.trim().split(' '));
                            let largestUrl = '', largestWidth = 0;
                            for (const [url, descriptor] of sources) {
                                const widthMatch = descriptor?.match(/(\d+)w/);
                                if (widthMatch) {
                                    const width = parseInt(widthMatch[1], 10);
                                    if (width > largestWidth) {
                                        largestWidth = width;
                                        largestUrl = url;
                                    }
                                }
                            }
                            if (largestUrl) imageUrl = largestUrl;
                        }

                        if (!imageUrl) imageUrl = src;

                    } catch (e) {
                        imageUrl = src;
                    }

                } else {
                    const bgStyle = window.getComputedStyle(element);
                    if (bgStyle.backgroundImage && bgStyle.backgroundImage !== 'none') {
                        const match = bgStyle.backgroundImage.match(/url\(["']?(.+?)["']?\)/);
                        if (match?.[1]) imageUrl = match[1];
                    }
                    const childImg = element.querySelector('img');
                    if (childImg) imageUrl = getLargestImageUrl(childImg);
                }

                return imageUrl;
            }

            async function checkImageSize(url) {
                if (imageSizeCache.has(url)) {
                    return imageSizeCache.get(url);
                }

                return new Promise((resolve) => {
                    if (typeof GM_xmlhttpRequest === 'function') {
                        GM_xmlhttpRequest({
                            method: 'HEAD',
                            url: url,
                            onload: (response) => {
                                const contentLength = response.responseHeaders.match(/content-length:\s*(\d+)/i);
                                const sizeInMB = contentLength ? parseInt(contentLength[1]) / (1024 * 1024) : 0;
                                imageSizeCache.set(url, sizeInMB);
                                resolve(sizeInMB);
                            },
                            onerror: () => {
                                imageSizeCache.set(url, 0);
                                resolve(0);
                            },
                            ontimeout: () => {
                                imageSizeCache.set(url, 0);
                                resolve(0);
                            }
                        });
                    } else {
                        fetch(url, { method: 'HEAD' })
                            .then(response => {
                                const contentLength = response.headers.get('content-length');
                                const sizeInMB = contentLength ? parseInt(contentLength) / (1024 * 1024) : 0;
                                imageSizeCache.set(url, sizeInMB);
                                resolve(sizeInMB);
                            })
                            .catch(() => {
                                imageSizeCache.set(url, 0);
                                resolve(0);
                            });
                    }
                });
            }

            function createSizeWarningBadge(sizeInMB) {
                const badge = document.createElement('div');
                badge.className = 'mh-size-warning';
                badge.style.cssText = `
                    position: absolute;
                    top: 8px;
                    right: 8px;
                    background: rgba(255, 107, 107, 0.95);
                    color: white;
                    padding: 4px 8px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: bold;
                    z-index: 1000;
                    pointer-events: none;
                    box-shadow: 0 0 1px rgba(0,0,0,0.03);
                `;
                badge.textContent = `⚠️ ${sizeInMB.toFixed(1)}MB`;
                badge.title = `This image may exceed Last.fm's 5MB limit`;
                return badge;
            }
			let mhSelectionSent = false;
			function setupClickHandlers() {
                const processedElements = new Set();
                const allImages = document.querySelectorAll('img');

                allImages.forEach(img => {
                    const parentLink = img.closest('a');
                    if (parentLink && !processedElements.has(parentLink)) {
                        processedElements.add(parentLink);
                        attachHandlers(parentLink, img);
                    } else if (!parentLink && !processedElements.has(img)) {
                        processedElements.add(img);
                        attachHandlers(img, img);
                    }
                });

                function attachHandlers(clickTarget, imageElement) {
                    clickTarget.style.cursor = 'pointer';
                    imageElement.style.cursor = 'pointer';

                    if (getComputedStyle(clickTarget).position === 'static') {
                        clickTarget.style.position = 'relative';
                    }

                    clickTarget.querySelectorAll('*').forEach(child => {
                        if (child !== imageElement) child.style.pointerEvents = 'none';
                    });

                    const hoverHandler = async () => {
                        if (!clickTarget.querySelector('.mh-size-warning')) {
                            const imageUrl = getLargestImageUrl(imageElement);
                            if (imageUrl) {
                                const sizeInMB = await checkImageSize(imageUrl);
                                if (sizeInMB > 5) {
                                    const badge = createSizeWarningBadge(sizeInMB);
                                    clickTarget.appendChild(badge);
                                }
                            }
                        }
                    };

                    const unhoverHandler = () => {};

                    clickTarget.addEventListener('mouseenter', hoverHandler, true);
                    imageElement.addEventListener('mouseenter', hoverHandler, true);
                    clickTarget.addEventListener('mouseleave', unhoverHandler, true);
                    imageElement.addEventListener('mouseleave', unhoverHandler, true);

                    const handleSelection = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();

                        const imageUrl = getLargestImageUrl(imageElement);

                        let source = 'Unknown Source';
                        const article = clickTarget.closest('article');
                        if (article) {
                            const detailsElement = article.closest('details');
                            if (detailsElement) {
                                const summary = detailsElement.querySelector('summary');
                                if (summary) {
                                    const titleSpan = summary.querySelector('span.title');
                                    if (titleSpan) {
                                        const titleText = titleSpan.childNodes[0]?.textContent?.trim() || titleSpan.textContent.replace(/\s*\([^)]*\)\s*/g, '').trim();
                                        source = titleText;
                                    }
                                }
                            }
                        }

                        if (e.type !== 'click' || mhSelectionSent) return false;
                        if (imageUrl && window.opener && !window.opener.closed) {
                            mhSelectionSent = true;
                            window.opener.postMessage({
                                type: 'LASTFM_ARTWORK_SELECTED',
                                url: imageUrl,
                                source: source
                            }, 'https://www.last.fm');

                            imageElement.dataset.selected = 'true';

                awaitOpenerAck('Artwork sent');
                        }
                        return false;
                    };

                    ['mousedown', 'mouseup', 'click'].forEach(eventType => {
                        clickTarget.addEventListener(eventType, handleSelection, true);
                        imageElement.addEventListener(eventType, handleSelection, true);
                    });
                }
            }

            const overlay = document.createElement('div');
            overlay.style.cssText = `position:fixed;top:0;left:0;right:0;background:linear-gradient(135deg,#00c853 0%,#00e676 100%);color:white;display:flex;align-items:center;justify-content:center;gap:14px;padding:12px 130px;z-index:999999;font-size:15px;font-weight:600;box-shadow:0 0 1px rgba(0,0,0,0.03);font-family:system-ui,-apple-system,sans-serif;`;
            const overlayText = document.createElement('span');
            overlayText.textContent = '✨ Click any artwork to select it for Last.fm ✨';
            overlay.appendChild(overlayText);

            document.body.prepend(overlay);

            const MAX_LOCAL_FILE_MB = 50;
            const hasOpener = () => { try { return !!window.opener && !window.opener.closed; } catch (err) { return false; } };

            function finishPicker() {
                try { window.opener.focus(); } catch (err) {}
                window.close();
            }

            const fabHost = document.createElement('div');
            fabHost.id = 'mh-picker-fab';
            fabHost.setAttribute('data-darkreader-ignore', '');
            fabHost.style.cssText = 'all:initial;position:fixed;right:6px;bottom:20px;z-index:2147483647;';
            const fabRoot = fabHost.attachShadow({ mode: 'open' });
            fabRoot.innerHTML = `
                <style>
                    .stack{display:flex;flex-direction:column;align-items:flex-end;gap:12px;font:600 13px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
                    .fab{display:flex;flex-direction:row-reverse;align-items:center;box-sizing:border-box;height:48px;min-width:48px;padding:0;border:none;border-radius:24px;color:#fff;cursor:pointer;overflow:hidden;animation:pop .25s ease-out;transition:filter .15s ease,opacity .15s ease}
                    .fab:hover,.fab:focus-visible{filter:brightness(1.08)}
                    .fab:disabled{opacity:.5;cursor:default;pointer-events:none}
                    .fab[hidden]{display:none}
                    .icon{display:flex;flex:0 0 48px;align-items:center;justify-content:center;width:48px;height:48px}
                    .icon svg{width:22px;height:22px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
                    .label{max-width:0;opacity:0;overflow:hidden;white-space:nowrap;transition:max-width .2s ease,opacity .15s ease,padding .2s ease}
                    .fab:hover .label,.fab:focus-visible .label{max-width:150px;opacity:1;padding-left:18px}
                    .fab-skip{background:linear-gradient(135deg,rgba(255,138,0,.96) 0%,rgba(230,81,0,.97) 100%);-webkit-backdrop-filter:blur(8px) saturate(120%);backdrop-filter:blur(8px) saturate(120%);box-shadow:inset 0 1px 0 rgba(255,255,255,.3)}
                    .fab-file{background:linear-gradient(135deg,rgba(59,130,246,.96) 0%,rgba(30,64,175,.97) 100%);-webkit-backdrop-filter:blur(8px) saturate(120%);backdrop-filter:blur(8px) saturate(120%);box-shadow:inset 0 1px 0 rgba(255,255,255,.3)}
                    @keyframes pop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}
                    @media (prefers-reduced-motion: reduce){.fab{animation:none !important}}
                </style>
                <div class="stack">
                    <button type="button" class="fab fab-skip" id="mh-fab-skip" title="No suitable artwork? Skip this album and continue with the next one" hidden>
                        <span class="icon"><svg viewBox="0 0 24 24"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg></span>
                        <span class="label">Skip</span>
                    </button>
                    <button type="button" class="fab fab-file" id="mh-fab-file" title="Use an image file from your computer" hidden>
                        <span class="icon"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></span>
                        <span class="label">Upload</span>
                    </button>
                </div>
                <input type="file" id="mh-fab-input" accept="image/*" hidden>
            `;
            const skipFab = fabRoot.querySelector('#mh-fab-skip');
            const fileFab = fabRoot.querySelector('#mh-fab-file');
            const fileInput = fabRoot.querySelector('#mh-fab-input');
            const defaultOverlayText = overlayText.textContent;
            let overlayResetTimer = null;

            function ensureFab() {
                if (!fabHost.isConnected) document.documentElement.appendChild(fabHost);
                fileFab.hidden = !hasOpener();
            }

            function setFabBusy(busy) {
                fabRoot.querySelectorAll('.fab').forEach(btn => { btn.disabled = busy; });
            }

            function setBatchMode(on) {
                skipFab.hidden = !on;
            }

            function flashOverlay(text, ms = 3500) {
                overlayText.textContent = trimStatus(text);
                clearTimeout(overlayResetTimer);
                overlayResetTimer = setTimeout(() => {
                    if (!mhSelectionSent) overlayText.textContent = defaultOverlayText;
                }, ms);
            }

            function awaitOpenerAck(prefix, onTimeout) {
                let acked = false;
                setFabBusy(true);
                window.addEventListener('message', (ev) => {
                    if (ev.origin !== 'https://www.last.fm' || !ev.data || ev.data.type !== 'LASTFM_ARTWORK_ACK') return;
                    acked = true;
                    const nextUrl = ev.data.nextUrl;
                    if (ev.data.keepOpen && typeof nextUrl === 'string' && nextUrl.indexOf('https://covers.musichoarders.xyz/') === 0) {
                        try { overlayText.textContent = prefix + ', loading the next album…'; } catch (err) {}
                        location.href = nextUrl;
                    } else if (ev.data.keepOpen && ev.data.waiting) {
                        try { overlayText.textContent = prefix + ', waiting for the next album to be found…'; } catch (err) {}
                    } else {
                        finishPicker();
                    }
                });
                setTimeout(() => {
                    if (acked) return;
                    if (onTimeout) onTimeout(); else finishPicker();
                }, 2500);
            }

            let modeKnown = false;
            let batchSeen = false;
            window.addEventListener('message', (ev) => {
                if (ev.origin !== 'https://www.last.fm' || !ev.data || ev.data.type !== 'LASTFM_PICKER_MODE') return;
                modeKnown = true;
                if (ev.data.batch) batchSeen = true;
                setBatchMode(batchSeen && !mhSelectionSent);
            });

            function onNoOpenerResponse() {
                mhSelectionSent = false;
                setFabBusy(false);
                flashOverlay('The Last.fm tab did not respond, reload it and check that the helper is up to date there.', 8000);
            }

            skipFab.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (mhSelectionSent || !hasOpener()) return;
                mhSelectionSent = true;
                overlayText.textContent = 'Skipping…';
                window.opener.postMessage({ type: 'LASTFM_ARTWORK_SKIP' }, 'https://www.last.fm');
                awaitOpenerAck('Album skipped', onNoOpenerResponse);
            });

            fileFab.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (mhSelectionSent || !hasOpener()) return;
                fileInput.click();
            });

            fileInput.addEventListener('change', async () => {
                const file = fileInput.files && fileInput.files[0];
                fileInput.value = '';
                if (!file || mhSelectionSent || !hasOpener()) return;

                const looksLikeImage = /^image\//i.test(file.type) || /\.(jpe?g|png|gif|webp|bmp|tiff?|avif|heic)$/i.test(file.name);
                if (!looksLikeImage) { flashOverlay('That file is not an image.'); return; }
                if (file.size > MAX_LOCAL_FILE_MB * 1024 * 1024) { flashOverlay(`That file is too large (max ${MAX_LOCAL_FILE_MB} MB).`); return; }

                mhSelectionSent = true;
                overlayText.textContent = `Sending ${file.name}…`;
                try {
                    const buffer = await file.arrayBuffer();
                    window.opener.postMessage({
                        type: 'LASTFM_ARTWORK_FILE',
                        name: file.name,
                        mime: file.type,
                        size: file.size,
                        source: 'Local file',
                        buffer: buffer
                    }, 'https://www.last.fm');
                } catch (err) {
                    mhSelectionSent = false;
                    flashOverlay('Could not read that file.');
                    return;
                }
                awaitOpenerAck('File sent', onNoOpenerResponse);
            });

            function announceReady(attempt) {
                if (modeKnown || attempt > 8) return;
                try {
                    if (hasOpener()) window.opener.postMessage({ type: 'LASTFM_PICKER_READY' }, 'https://www.last.fm');
                } catch (err) {}
                setTimeout(() => announceReady(attempt + 1), 700);
            }

            ensureFab();
            setInterval(ensureFab, 1500);
            announceReady(0);
            setTimeout(() => { if (!modeKnown && !mhSelectionSent && hasOpener()) setBatchMode(true); }, 2500);

            function waitForImages(callback, maxWait = 10000) {
                const startTime = Date.now();
                const checkInterval = setInterval(() => {
                    const images = document.querySelectorAll('img');
                    if (images.length > 0 || Date.now() - startTime > maxWait) {
                        clearInterval(checkInterval);
                        callback();
                    }
                }, 300);
            }

            waitForImages(setupClickHandlers);

            new MutationObserver(() => {
                if (document.querySelectorAll('img:not([data-mh-processed])').length > 0) {
                    setupClickHandlers();
                }
            }).observe(document.body, { childList: true, subtree: true });
        })();

        return;
    }

    let currentInfo = extractArtistAlbum();

    const MH_SETTINGS_ICON = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/></svg>') + '")';
    const MH_COLLAPSE_ICON = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>') + '")';
    const MH_MOON_ICON = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>') + '")';
    const MH_SUN_ICON = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>') + '")';
    const MH_CHEVRON_DOWN_ICON = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>') + '")';
    const FAB_ICON_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAAGVn0euAAAzmElEQVR4nKW9ebxlV3Xf+V37nHvfq6pXg6SSapSqSoMFEmAQxm0weJAQEjYEowiMAeMwJY7dThyThsR25+P+tNN0ko6N6XZjIsB8cOOYOR0bf8ChbcBmMMIIzUJIqnlQiRre/Orec/bqP9Zee+9768l2f/pKr959555h7TX81rDX3lcePrB7hyrLfR9pg4AC6Juj8G9D5GcQvgTQiyABWmA5qi5JgIgqIiDCDQdP8NCBXX8iEVQEESR2kRAB1QiKIgEC3HDwBGtra+y55yFiA4igUZUgBFQQEVWMmhueOMHKygqqymA4Q/fOf0PUiIoSJGjoYieiggJ7H/gOS0tLxBiJfSTGyDVveCNHL9kBCAAhIG8lgL7r16Dv7WRVeo1EjcSovOiLX+LQ4VMoIPfu3r5wrus3P9AOaKTh9Q99ByUafQJbNm/l/Xt3ETVyS6O0QeT1Z0bdH+8cdYwiNhIfkI2XS5aWaQUeCtCe68dfvGzYojFyehRRBY0Koqga3UOBS4cNiNDOhBYJcKEHJaIa6bXHGBEBiChtEIZtQxsQEKQhaK+KxmhPcJoAVaEVOzMYuwREpA0N//NllzE6c5bx2TOsnTnDb4gQQkAkCBqQhw7smUMVEx2o6pIGuYeop4HbAsxFBBoQhFbRpaiRAK8S+C8IDLqOODNL33V+GzHNaGiTTtgHEmhnBuy992FQ4eCN1xojOlWEHyHwl0EEYyFA27D3nodQVZTI/gceRVWINswvI0rQqIoKinDlPQ+aalS6dNW9jwABVIgRDQpEVa6672FUNetPVLULiVz57QcTkxW5b8/l+o0wZBQj2o14w6NPTKjFR2/4PkQCjcILtaM9tHyBS1kjinDiwjipkiJ2P5qFZS5rBBF4IgrtlpkW0chq1xOikSQkJhAQhS1BmGkDitBuaIIAujqORJTY94hIUoqeXhQJwoamIQoSBAiE14oISjBt1WgMiAoqiEIIQRqEVgggfAJpZDBodXT+LNr1iSClCYJII4qxXh4+sHtOYcnsIKJAI4ZPqvrXQfhBRFABCSFbovYRogGNRv15CfJ+Reii0rSCXSDIg/t3zWmvS1qUXE0tFVRREQKBYSNc/dhRLqxdoJ2d4bsH9oKYjAWQYBT3sX+tqHwCASLIQ/t2z6mw1Hfjl0nTfN4pDMmyQtvyjEcPs7qy6sCUrAbO3PttFl5/JyJ2IMZobAEQJEgg9CbQ79CEz0uxYSJw3RPHufKeB1leXiYS0w38RpFLn/Ns9t3/Hb73Yy+jT4TZzRV3AnL/3p0Q0BACXdchIbDt459myzNuNNTPVyWyxBTTtdnfqypf3HEFV++4FI1K2wi9KkG1u4e+o+86lm9/JVfd+whbnnFD5kNE0ahmsZpGEetjiV8IP/bkafZ+60FOHHuSvo/Q9cj9ey7/b6rxpd9eHtETURUCEAWWxx1vOnm6olhdRPmfrVu28P6tmxmmQ2rghajw/LlZ2tOj0a2jiF7RCqINUUAjLERl2ZmgaldHxwA3duOdm+Om1lxYo9ALHB2NaDc0zdyGRt6i6IdQg5oV7dEIEu1v7U24kuwDMRaJg040ygcIs02DmwsqEgZNYNiE359pggzbYBqkIKL0SPKNbtpJixLvDS3SM5MKCsqwCcw0jcwMGkJRCGNqE8KPhxCIEpC2IfZ9+sgZoxMQJ5BihGC42Daimh6ninxj1xVzCEumf0oflcUustD3nO8jY1TF1VMhiBDV2GXQCEMRuSQ0bG4Dm9uGYPqNKshDhkUZY/rYM4iVyYosoboHkf81Ci9HZDFE/TTCO1CGoEMf3DgorTQoYgEMijx0YHcZfB8RcRwCCRY9iYhFLs4oAfoSgmjCB4d5c+B2n6CkaEI1oXdELbBQ146oxu/hG9/E0sHj4E4saZOKakTPphEXWQHywL6dSc/N0TQSVIKivZ0jjSAaOHPN9Tz/T/4U1ci9Gzeydf8euy5FLIamEGOKeRRCEOTB/bshAZibamiaBFiKauDE8gV++PCxjEkalYc2bWTjgV1IpYXa9/ZbkBBMx0I1GE0fJu0WogaOHjrBiw4eoYRxxq4blpfpTp4mmhMx2xBBA6jGjMsBUUTkIVJIIghEi/SOHzrBixeXkiAVolutXf9951cIS8sp8KmwPkiWRUhEPdNMOEGzBJ48dIIXzs+jomjCI/vP0DSidN2Ia0+fo419cpFaVCphcYiqbzbpJEBTmD98kuefOw/um3uH5gLT9Mb8taUlrj18ikFj8RMIks7roiL379uhEoEmoFFZO/kk1z51LlujaOVwXAU1extjV1S2bN3KI9deRTceI41Aryj8ttx/1U4VEQOzpRX2HT6B9l3xZm5Yus4D/G1Spc1bt/Lw1XstgUiXBe06Ytcj446rTz2FdunmKkVuWt2tot6fLUn1F8+f5/ueOGZuo++h72hFhF4jf9HD7IF9dEBI17/4d9/Hvh+/ufgxre9q4/vdq/exbXY2H28RlheWuHnLLKrQqirfWlxjW4B+DYZqT+gQxkvLJrfsd6sRJZd54ex5ZrfMEdLzFbhUhIOrI66ZnaE9vDpmW5Pg1bEHWEq6LRVXyo3LeyV5sqT6PnqNsBh72mEDAw2IKrG1D8e9spxCETMTnZRHUiynWIBZSHGpElToBZb7/hXtTAg7VHkyaSXjLtI75QllVbUoUjJITWG0K1EjyqwEmmC2GyXQCJ9tBxJOZ0RSpW8E7Y360AQbRa9ZsHlM0bxbSwoMVGiCWGKf8EmA0LRC28hLBkGymkcjEsvXdRIuUuShKSCLFKhG7CGDILSNSBOgtZxe/koxikIqFESU2PXExGiVxKRamcQe0KfITlQJEhCR/xJSyB9QSTGOSHAdUIDg1YaiphPqZMdK2CLk/0RebbgFwfVZTf8lhEBoLHRfPnHcEgxJt/FoITl1BMYAQewBQSyhSo5bgNaCEgtDLMNXUfTjLfKaB//dv2fHDTey7YYbkcQ6o9qE+Bf/+l+xd26O1sZ/tRAOmvctMCN/vXsHIWNYZLVTFjqLiVbQP+2jvlwkuT6PdUgGGZVW5I1zEj66rQ1saQPDJqSYKQVmdY6GC7J69X1PQ0AkophBmkMHjQINb0V5L6obk1TRpuRyJVI2uwox6alR+ecgbwU95J/ncBFzOQQrG9QvceeGIUd+gOd9qAV42kca8aTGXYN8lYBGRM1x8wFFNyoQgyXawVSQ0HV0B4/TtI2lwgJRYjIvQLgZ0YMRVVVVgigiP6HJmhsJBKclunK7WdorOJT1qUrRR3svKUuXECDwlYR3qugLbYyaRWnBlyI0hNDS9JHRzbdz7eFTXLeyynWPHmb+4HEgGDeTCfYuIDGVSejwWUs/UGl0P9JYSq2RGHv6FBH00WJ+eXD/rrmocQlAot04hfxISkZFmiJ2pKQ1KgjRqo0E2kHDicEmfvSBh1hbuzChjqqKzs7yUAhsPLA7HTVpxShIo2hMMOJGkMBO4e3AByodSmockAcP7JoDWbKnYNyHvwFu8qE4l3xssTfuhwbQhmbYcvzQMW6+0LG6uppVcuJVxQkrJ09y4tpraPftLirRmU6FVlIFptxGNcV0iBAigTbZgBIUmYhOmhDUiYcSgjq+qipNE5AQkGaG44eOc/13DvFDZ+dZWVnJ4FqFyflHExhv2rmT61ZWGbznd+HsedBAaBqkMQYWr6keJ3ocqo00n7UwIQXuolbSSMNV7f29Ey5FrADSEIOFxdd/9xAvXFxkeXm51uHswSd+SuBgbiz27H7prVx7ZoHVN70VGV1IKhmyilDhsdMUVX8C9JzVjxV5YN+uOWAJEUUi3TjShAlwskcnT33+8EluUqWfXzCPNHXiZFlm+ibrSxVgw9wcX7r9dvY8ch9jdUQEgqaBmQQl0RaELwM/Kg/s22m1UCy+sWhYUmJnslRg6cgpDjz2GBu2b09+N+vlRcRedGwiEtQJpvoJ7uY3b9nCp3fs4FlzQ0Zd55qUrw8pNk1mMif3X7XzcuC0JC43An1vbrcHurPn2fSRP2DnLS8rwURGoykuJ5FfdLwy4AIwVbipSSo5VlG2bt3Gp0V45jV76cadFQsMNYh99BTlfIh9fA9dT+w6dDxm1PUoSly7QP+P3s51p8+x4+Zbk0QKRystKG+qCHYik0uxoH/m7HNjtyxe8n0UYX5+npvPnOX6x45y+MgpkIau6+jGPfQ92nXQddvk/j2Xf09VL9PELlElvvpObvzd9zGiuOqJkDq9RisrxHE3EcPXJ9S1UZ06XgJDZePWrRepVf133/dsahq+PtOy8fJLLXVNtMm9u7cfEeFKgBHwNwtrpj6qKZ+W/HCLNVOQO+744bs+wDWveGXtrqZQY4qa7CRzgs6WLVv4DRF2bJlLCWcqqaSiTC4nieV8s03DTZuGdCm6bwU+EVR+5cHFNSTAtsbCA0SyAwFyGBsRxgorClaTSQY9TTwJNRIDsjEmI9F0TzBba1SYBVoxMXrVTpA8J4UIopEHFtbYPtNwedvSPjXq3zGK8Vc2tUKqhyZiEzKkCDUA4wgjtR+j1a8gG/iETSB5YKUGIUUXJwZs6eJQhIGASEhqYogTwBIDBW2U1S5ydDy+p22CDofCX0VpXkyamBMsFXHykm0ionSkyl6lIwXip6WgRVm0OiepSm0XdjulQRgKpKTHcjA8OnO+WE4QVG9qWwnDVuQliipNzjzSFUrECq4jf3w02UosoYECajHUJHMFM7hpbkfIGYz/GxPGp1MboJWQimVVSJ8eIMhrVCJtFe8npiTlUyUGf57l4jE5t96JC1JSZU9GKgN1tNEpqYBYMT/EclRMVaJA1JScNpJyCxCC5Z92h18R+KQQaJtGMsvSuxHKwMmIqRIX1cp+Fv+mB/WxeOyJ8ECLw3ICJ9DJVbWEIhGIoVzTKQzUmNSENAirw+1A5LTfrvUheb0eGCLsFDipPTSq9GJ1GaKFup7hx5ST1WFH4WhmStF9/zwmlIsOBem8CBoskWqS+gW1WUEbuIhIkl7SgiAucK+eGPqcUkUk8I+thG8PDtjN1ayLSfO1aXw7UrC7ML4q+0wbLxbGkAhPDRVGndWaxBDUJ6fSj6qbkuOOaZuJQlDCXUGCiAQrm6T6RiNCExr+r3/0Fi699FKrU4mVZvxOkkrVIdiPF14shjcUkcGAr334Q1w2M7Sni4AEQhBU5eOBYCxHMrwbtSHfqyXBZZGwVwjtsuj4LgbCIUYa9OhAZO8zNm/mf9+ymW48ZrR2IRE/qUw1ANW/BZjZPIcgzA6HtCI08C6Qf4+EPFFcvLgUqjR7H1pVlnymsVf1UlQu7lhTQ6QVa8tpgzKrzZWiysBvNJy5lOHwV0XkTQKX5zhVTdM02YR6BAp/HdH/BfivCV8YSHJiwSQcEsdzkUldTYtKimLzZTV3zPWnEECtJSIQCBkmnYUZ9ccRLthEld6OyEsj+myCXIfqdkXGIno0RHkA9G6UT6lwLA1yDk2j7H209rtLUBfakJ1ecX6pGodukoe8QpAIr8VupQwLmDLhis0zRAXCHtAPInqbszk2Sf8zR4rOSB8T5CgIFxD5ZXp+j2CFyAwtqYgWNdrEF9XzxSLmxMy5gGNDBSoR86yxJznnZDyS4K/Xn0sp6DHgNnu4oEHNYDPtFnZIzb2AB4ozRH0fjWqM3JOdgoD54eTw+kjO0wvm51PDhF74B2muqkmTZ2UWK9wiJrsPx8Qyrxp4gcuTlaZpGB86AeMRKcA0puBQaAOJPYjwXKBH5FtGYjSscbdRJRDTUUmVlUNMjS5RlIYAEqgy2FOgX4gJ4M1GUrUhRY7uCUWEhceO8OyobPjn7yCsrdkg0oS+V3EiWiavLAJ+XvKKP+OVEgM/IzuHLJQcOiAQY5+mAki9F2lO1IpXO9L5O4oqKhqcYEHVyt4hRS7zTxzjJlVWV9fY/S/fxeh1b6TpOgIBkSbHTyRxrpMj/6EE+ZZXIFCrF7nH771hDggazdq1T9GP5DIuvcaXR5VTNMkZebTqEnNptNZzALBw6BjPVeXCqmV23doFnvlb7+F7L3ghg+QnQ2gJjdf5K70OVu3TJqAqz4satbdphpz8qEKI5BnUkINzD/Ldzyt3BuVPTd72MFP7FBVKIAQMMVLWtXLoODcsr9Cvrpa5e5TR2ho/9KnPcOKKPQwGFplZRK3pfiF77qg5lkVUCCqapeNhS9CMmEERK+tJqB/6XFH9BID2PRrTFGCSr8WRZmp+fO3gcfafOJ4ML8+i5GhpdXWNl3ztrzk8gnbQGjiI2LxDFLz/EjXkiX1fVK2KcS0sKVXuUHpaQsV8ucdHo54LawSx1rfYWcuEpImj/thxdt93L7PbLkncc0MrwR4oK6ur3HLoCEdPnqEdDLByGkTt0c76O5WY5pcqrDTIetTZKz4rieaWACCm2Unrq4i4h3CCUmjRhOQdgzmbp55i7rOfZ8u135fVOb/878RGUVhZXuHm+UUOPnqYZtiiqbAb2oYggdLRU+GfjeU67fvXZE1SNU9NHSWG8BE3RqnDhYQSvcakTkmHFxZp3/cBdv3Ij9p8jT+sxDxTYzHOriwvc5sqhx89TNMO0viU3qZgS74wVT1rB+3Hc08XAQ1491N0Bv+sBnVX76Ow2T9JYXfC/HZtjZV3/ioHXvc6Yte7eZEnsDP3PYjTLHZFWF5a5mWqHH7sMNI0VsCVxq5JoUieC0v0qEaAY2Z60Yw8D0/1hKYMKBtDrrrbg73c0vQd8697I8/5H95JNxplTz3J9HWOZsdnBC0tLXGbKicePwohFA9dcd1a7iS1zAjAHnJYGh08BZBdeAUh20/FAQJRLU898YM/zPN/+3cYraxUxFYS0JpwrY7ncWR1Wlxc4MdVOfXEsVTCl0oD0p9gMN9k1TwJpmkp9NJPpc5km/lXRzT3+1alGwTh8J79/OgnP83a4lKZzHeqSpEhq45rT32sPMCkujw/zw+rcvbQieRvLC2aMAEV+k5RiSjscGGFceyJkTssskvOiYTk+QbCsA080W7k1q98lZWFRXwmJkdXaRHBhAQyx6eOTQ1UJHDh/Dw/MB5z/vBJKgom1G/QNKl0oYC+q9coct9VOxFQd0BRq2EnRzQYDHjgyXPcubjIwvxCEWvxfPkl6xyraEjsqL0DudocY6RbW+PhXbvYZnRlQtz+AqRYLeX8Av8210E1zdJUxtS2Ax55/Ch3Li4yPz+fj/uc2EVwqZXpuqZQqQ7TlxT7CRJoZ2e59v77WT16CrfPGGNqzg6p3xAkRRgBeKOHxl5kaRLnQ9vy8BNH+SlVzp8/nx+XZ1O0wpoqCXP9zmpWVbXcH5RJj8njIsKGK69k+5/9GReeOmN0hID05nU1z98JCNcF4CoD0xTaajTrbhoOPnHMiD93rqRVNQsngMYIzYabCS0SyMauTIlBM03+69L/7ofYdNcHiPMLucyf0/LszHhd8wubZn8jxkhQazNAldC0HDp0gttVWTh7jtDkWkUevdR//v95qVvF1HCisvXGZ7OwaQ794p9D21r/dx8h9pY1qo6CNz+ppGKbBI4fPsGtqiycOZsrxqSR50oeE5pRPbn+e50RXsR9KuYITg+Ajkfs/8X/nrWffQthNDIDTqmoGbReI/fv3p4LAirC6umzvGDUsdpHmmoeeJoUAVbm5wkJ7lwiWp9f/VHbR+1sQ9sws2nTxWOvLm+BR/7VO+EjH0Il+QhARM61mXhgRuCLs7Pct9d6GDqrgXtVuEzOiXJ2eZVfPTfPwsJCBYtuI3LR33lEYo93R3vy7m/wZ6/9hzTDmcwMvzZqZJB68VZGHTfGnu0DSZ1dQozats6hgQjfWhmxSYRu0RyVpLEaBKbqdRLf2vxSJiKz3MpvTOiIR6frcBiEfnWNuLhEMxyXe6RnhzRHESPMivC4wuZhy0wR5UobUrvXY6sjui4yQBhgjf4elpAmQWJCmws1JUk6GYlcHmkseapV02j8QHqrWAA5wEIdccapqbR5ak32KTywsMbzN8+kpEZOtETldNezOo7MSGZAQUa7LvcVdiq2nmJ9llZq44PPFlJujOOY5kMNNrkXMgtcRsW7BwEJgUeWRtw4N0tUfaBdVmV+1DMTxDrrneN43aboZa+SM7WsOlpsaHpAhvueSzzNyw1cfV7M+yHSx4pXb/JEYyPWvrt/4/DT4dxa97lBsObVAVYdHmCcGKYJh0H6aSpKa986HcbX7TXFpV08wrp87kxpgAFKK9CK0IY0MMxOW7GKXSPw5Fr32bZteXdEbu9TfbNJIUWUwmfBGkC6JEY/Vt6VuRlJE+TT0sjLDrO8JNuATcaYnTVixEqoyyuVlN0HCIjEcduIfFlECKJ5psWRVvFSp8U6QTUXl4ttVpxWqJtCJliQfUKxCfXaq1+Xnt2k375yxW0gluyGQPx2QAZt2wSbuJOQJlpJgyENQOkyTWLV5ikWe1RabLYeBBTkd0T1mmha9KNpgiuDmEWmAetmJiFSg9uBAOGOEJgJokor4dZWDAmaYHNVLgl/X5NTz3Vk5nswx0WFtAxp5gzTeemYz0vbetPEpkRsI0LQNCeX6GuTXbYSDgaFtpGAKl/IxaJ0UxVXo5hVJnrYLWZYzv08XaoxL9CgXhUFZa4tcdlm8CWrR1ZETT/JBjwWS5pDAuB3uCRCEKt6i/BzIaQ1QqQ2l6pCFhNLPZHJfsDLKEktiv/Q8nmuDxYHl1PjBJFptgGnNk1YAlppQkgOjd+yXgohBLF2libIRxqS6NJMi+tJnPLI9eoX15UCnLV5xwm4zYPwM7PaJWeZOvlzfSANJASSCikhyKuaYDSHkEr61QzxXAhlPthnY315B875CRSaQvkKibQ+o7Z7KcdjNKxyCTgjQjKkQo9Ba4D/6t5ZJFXm8sSzyDLw4YIYmhCBbMhW/6wrBvUqg0KgmYpMHq7Oc4MtsJtyXCnRJulZ1gZhVSqbTC++IQiSlli5yOTNqowM1koCU4y4KAJQOFtHoRMVrNrbVgPNtqGZ0JgG5vlfSIM2VJbryj2LHYVSLSh1TURmgLRKsei8oDkjql8ebhexuC4rpQiUnpPVR8ogpfwZ8vg1T3QrvA14TCslc9aGqu+oYmTCC5Gkd1bgNYiUyQoEpo++ZsSP231LAmrkp4YQoXhYiyOSIfvfZGhE9B3AB31QZGC0O7bGi6kqmOug8XtZkY15xYY7s4nzBddhTzAzsiSD8OlaKE0bfd+zdPQIoW0z8SHNSqZk9h8g8scFXUsHZW7Bd/aX0CmpgIKYDWwCPijpnCbZxt7ZWf78t/43wuxsYlqZZzDokwy73qpcjNHKN9u3b+djv/hLpgqV+tjAw0yQ8Mc2/1ZwO9OZHIjcvftySqTiF5PtoeuVtT4yUt210scTq1FZRVmNyrmlJa76yZdz23/4j2hj06eS9NAJV2xu1zmsWAP3/COP8IFX/gP2b9lMq7BBhA0ibGzkT2ZCeOWGIBZSt02WKq6MWQw6J9/YfUXhfP5HfeUEXVQuRGUtKqt9ZE31l1ZV3zvSaOvLUS4sLuVHuJJNmnk55qo3mBnSDIcW3wCzIqc3iuyYbQKzQZhNS9Iab8mattPJAUgOpQs4GCqN0wD8Z00ja6qMlTsjfMLWzpD1OhsaLgEtji9J17pzU+Iu8t8a5fYZkTgrwkwIzASYDcHW1HksJEUOGfXQuWA7vmiORwpOF30NYrrfirX/DhAGwieHIDMgQ+QVQ9WvDlWZQZgVYUaEGWBWjZuz/jecGaDvnYErhiBD5WWtEAdiUWcr5JVTIYFDTpI0zdiDJypL8vCB3bnpzs1EnU2VSuRPa25qWhMuZlSNFAlUzgOJCZmSXXiDbe1PFBFEX4zqSwV5HsqNCFf75zH5H0nMVgm5i0UaW9/mdlvP29vFHCLwsKL3IPIF4C/FEsyi34BPuInreZWVFh8mqa88oaAE62DQKV5Vw3Okrx+WTS4v5MtCcLiu7jZ5rTEybS5jD5KJael67fikQWvSTF6OyOuBnwYdlADEOiWrG1kgHLJDdr4kJzXpzOuB2pY0kcZXljk8ex+2uo4IwMeBP9So//cE+GQuVeZX8abXtJgr+eISjpWx1vyT6g6pi3HOO+aWan7n8efYy4MBz70SzqSUQiaoLnfKPl55o6j+OsL1fnOZeJgXLyePeehB0xaJZL+uBU0T/uUlvU5v70ouoJOjy6e6xUr5EziIyLsR7ipcUbzo5pFY2iYmhZUl4J/UdsmeteZtes2F+tTCtqS8EzXB9JmkckETnLnpWsU7NSJsVrhLPHUQ/QMJXJ8xqYYxdxRSSoBR0gYcan2eGq0SIK5xa2uMD55gyy//S7a969cYHTwBy8spiLLzrLctNWSr5rzVp5m8TmQ0+KgtVCBwANH/5ANW5KMR2R6JqPaJEzE7oxAC1oBeuOiszpOPNQ+rv0M51biuCf9UFR3bajvbsSymTUWqaJCQ4pusib+lJrUF4G2+4ZdS8tui+l5jtebxqKl7WErAFyTYOmYEJdD0kYXHj9Ld+TpuUGX7L/0LLn37z/MsVXj7L3D+saM04zGkjK2RYPmyVz3UFCXm92kxcYaKAmVaM1n19ag+BaIqcpdDnmWGoaitWtebRoO/GPvcVZZ5OoVM8uD+3XOI2mLuPuam2OxFauAtMRJk3JfnB+FzKmz37UusZlY5jFysclJdguJg7sqWmlPChN0NBM4cPI78w1dz0yc/jQAXVldtSy1Mw4cbZgnAPW99M6MPfZjt+3bR5R2PnKFp8bKG6tk1xNRjJJXy0+cxZRc55GcZ+EmNfCnPJNe1Pzfx2h/YQk/w7jrVueCVUNVYymgyxXxnVhaGALw2seubqrLdVqqIRQS5dpY0byJJrAZI0g7RdNwTSLOYdhBYPHSco9t38uw+8oJPfprR6qr1yEuVGQuM19ZYW13leR/8fW5S5eQ11zN/8DiDNlQaF4Am1wk0bedYM1y8p9jrLw6bgdSvKb7IZBPKF1Np5i0TIY9fk+WaBKm27V9eg0tqV3Ti8sPiNPMpmqT6MiIqkY9JH8vWH7FLfWhF8zVtMihBcrN0Bt7GhBXy4h3Nc1jNoGX10HGOjuD6s2f5sW98E11bY21ttWjUOi8R4cLaGt3qKi/5f/6CZ62ucXS4iaWDx2mHTSnCqgkgBKmSn+SbpDhTEFSrFT2ahBY7M/WoSB8R5YNp65HXOK+yHDL/Ep/VM+f0rAcP7ElR0PSgJD0sH98KegRki90o0zzp87XSlHQ015kg7cTnlR2hBsR2OGD10cN8b/MmnvM33+bya69lZXX1ohiarJ1T+jERtdkzN27YwNmTJ/j2857LJU8+xabr99GNxgVxwiQtFkgk256KaHztTl1Jn6RMATqQfcAJsLxfcthXUyyAzgWi7ztVRGd+JzWwW7L1O8B5JWzJliBahpoLeaAN9B4L5YeGHC87bKj3FAo0gwF66kmOfucwl331K9wyv8SmPXtZXVnNwUFhvg9UJ/7DoYwyDgFWV1aZ3XYJN586za777uXowWP0x07QDAcpdi9KYHAmlotUjLNZBDXXUdbgTQjfVUKRFjiuGj8SvXktbUOYL1JNPNfkhJGlSs4Up0GLxnOqzGnlSLLJVkrpjJE0x+kzy6GuUWTNNOBsBi16+imOzq+y/1Of4vo77mB1dc2grIoUmNYgYZIDUy9Ng5yoM6pp44YNszzxhS/w3VtvZe+mIc3unXTjLoFvoTHTqhYShxRy5+m7iXG70Au8CSAiHRK2o8znyoKG6nKdy83Fmn5yrBx4vgTGKjKXJ1dC+jz7CL2IAM3DsAHkTZTS8YggTUOzvMKx7x6hf/d/5DZV9v/kK2xTCo3VPStdz/X8ivk69b5iPlTKlOhUjSwvL7P7xS/mNlXC+z/I4e8eIcwvENrWVroCDkq+aDQXYvPYnU8+bi1zV0lAEVCbjD9P4Ba8HOnrBXzNQBmIYw+A3gl8U21XqLKkyGdj8sNrsxJHm/S5xWxWWkjXhcBgNObk40dZ/Cf/lJeqcv3b387S4hJd3+EzMTrB2SlReM1HyUqTuyN9DBe9/HNTjL6PLC0tcfVrf5rbVFn717/OsceO0K6tpd5tG5s4/RMrS9K4y4rsHLkVP5ROKzHJF0D/Ca4cGfJBHrhq15wEK0Ukrr4O9D8jkp1ONv4J068xOQkgW0SSkB8KgbbvOXbkFMM3/xwv+tCHicDa4mJyUtU9pyZ8yuvigsff9qqc4noflD9jZLhpI4PQ8LV/8cssv+d3uHLvFfSDQYHCfI1PAcrFq3QymVods9qWlDrRLwDvy9RF5uT+fbvmRHQp1XReAnzZEMyXqVXwmzfDmnpYDZuUCAGEgSinDp1kfNvLeMnnPs8AWF5YIISmnCXTfLk4yrno4+mgYh3mrn9YJ97arYQYezZs2QLAX77mTvjkp9h91U7GYr17Jc9S/z8NtzA8V4rrRbxiqlOpzytB/yTB6pw8sG/XnCpLiF6qcCbP2QTS8qG0Q+s6e/RcNExJyzuAYRN46uBxVp77/bzo7rvZ2A5YnJ8nhGqNpID+f9Fs+fvZQTVh8Hf56wmfIVi9fm7rVi4AX/2RFzP8y6+wY/9uRtGVxWGu0DH5DPtMPU9omrRatvgzgStF5RjCXIgax9E+/YREr7pg9f22pW3bhOP1Iy7GaNuZXBi0DfNHTvLISscNTz7Jrfd8m35pheWFRQtDK2dp1lVhd6nsTf5UY7top6h1fsrJlAh24qc6t/IZtgJEWFlYZHxunpu//Fd8/+Iij4ZZzh05aVm1OocKbXlj5uwgTVGatk1b0pnaBFV3J5/qiUSNI7n/yp2o8EKBr9aSrEJ4bE2cLSdeT/8UaAcDlg4e5WjT8IK7v8mV3/9czp+fr3qjuOhikXUOrvuS7FL+Pq9aq/9e51cWUBxpimZU2bZtKycf+y5fv+kmdi8usfWaKxmPxqxHvkJqFkhKW7ZxyaiUdOB2gc+nr2rg1/Nz0xvfQTTXvSMQe9TLpZglNIMB4++d5ZHHj3LZ5z7PHaOOzQeuZv78+eJPPSrK733gkxr69CzTCa39Oy3g72K+P8/PTzTlq0RzG5cIzJ+fZ8Pll/PqhUV2f/1rPPz4US48eZpm6HNJ6V+1hQDWO287y0hqkHCZ+vlB+E2sh1RfDvxEdZ8k2bR0WwyOLKps8GV7oWnozy/yyONHGf6fv8dPqXLZD72I8+fPWxefp+tee08Cuxi9JrNZL2A/HRL9nXi+znWKb3tUhaz1YCsFqD4p2p18z/z582x+5o38lCpzH/s4jzx+lNGZc4R2kHgVkNAY46OndjFHGXXApMIPALcHVbkFxyawiQz1OQDou7TrpXodJKArqxw5eJzBb/xPvEqVq+78aVtTE7si7XoANVdcEy52I/kzcQcx9TPRxrnOf/U50z8XzZWsQ1eOverzpDpNBDQyf+4cu265jVepsuk97+XIE8eISyuEtHQyqvGs79NS/hjR2OfNEfBllHBnkL57jvY9fd8R+7F57qiQtholfScAEpBxx9HDJ1h5w5u4RZWrfuGXmD97jjge54SrztEuHmCVzU6b/XqM+ds++9ucdXXe0/msi34nSJpY2uA/UpBTwJSw75k/e449b/hZXqrK+Bf/OYcOnYC1kX2eEq4YI8Ro82oxEvuO2Hc2Xdp1z5b791xxGPQqdxD+ykgvQhuVJ088xewbX8/z/uCjdH3H+Nx5pG2rEEyYKPvk1/qBo1Yjy2H9Oky8KM34e7xqGU8c8PtUPogU27tylCym7lebJEzzxenvvqfdvJmZ4ZBv/9OfZ/H33s/OXZfRNy0+xRimrk8knJL7dm9fADYnsJ9whiKCLC/zWBSe/fWvs/f6Z7J08kTanTHmzlfPEbzWrlTRveZ/TOOjObZ28xa72Nes+yn1ZdMk66QwLpLXehx3YHGInQ7K0rYN46UFo61eJkI9/aoTklMMrlPFxf7pIxt27OCpJ09yzwt+gP0L84RtWyeiLPcnqcKw2AJjdQrTM0RtGnBBIw/Sshx7jtzw7KqR5umdokz9nmZWBE4BP33Xf+IH3/b2vN7M4UjXvUqyxnlqtS5C6ZRYSutDaWGpaAPYsnmO+z/zGT5yxx1cTum+n7a6el3d9HinLbMBmk0b+d5glhti5JJg2ziW9phs8V0LckxEL5X0kAZhhPKd1THnx5FhgLkQiFvmJqKEUux115Vq/EKZsPCSsNhmH6pK13VsXFmj3bCxDEE0m3/RFdf6aYDXi2RTPp5iT47GyvFy53K8nZ1lE7BhZshgZkja7bCcm+7hpMhUw5bzQtJ9LX0SJEYeXBqxZRC4dnbALEIHueEf9Gwr6IMoz7Gtt5RjF0acvtATgjDXSG7psAigMNwceuV0U7dErfnGPyO8x378W/QmGKqle7c+/HSeWJ9GHuv6CD9ZKlz3sVQzW37LoEmDmdTuDKnBVdmvKwwv/qy0884Eq74+tLjG9mHDlbMDRMW/euCJVuFuQX7mXNdz+sIYEDa1Ia+xcidl5V+pukqm2CgyASUxScB7cyB9S4pDTR0OCQU+phQ8j1Qqx00mq7yqiGo9QWTBi5NeXaCTwg9qK+3qHoLULl2igilbnaS6LMWy97Zt+WqnPLp0ge0zAy5pGxT9aruq+kfnLozf0UXdMwxlgVvAF+4kaTvh2UlKxkUoZgpWkFOxnptObBPJOLl0dbLqXMP2FF/zs9ObugN+ksFatPuiVz0zRmaglo/zc7M1qJUUWhLzSWvppIzRFTNIBcdSPSJBk0OxN+wujDqWu37hkmH7n9ulcTwpwkfbIO/0fUklE1Ru40vWfXbLvYh9zYAjoQ3VvmuTtMgvNatXrPVdS5wN5TNhYo/sdEaeWhTNA59+1Qyu9/TLrJVypHiBRIMWKxXK+F1nbAVknOCBr4Py6x3WQkKCPF+ToN1PsYBJEPjIUtd/pw0h0irviug7VaXsbOtfQFiRbQOx3UtiKjipatnvLxHci0ceaWGimmCk5sW6zItl6m8a6POv9f3CeudOhJCVSq1XpHblMea7ldriXhOAW0Ll6CrFslaq6gOSsqYSfe4gVFuNGkR+TbDvct0ssCjIz6vI7+FjD0VDXBtqnPcBKpbA+IYreZmG30irxttqzLoOgxVlAteeltd+fsHYiRr9BNr5s90ZU2DKz4verjjpSNxP14rof+cuqsSQckuHnRQXSZlPduEF+B9BFwJsbgWx7WyR9wOvAF6x7rgDaZ2w1DTm+fkgtj2Ct666tk+uIdPSVDHFLC/UKWpfVlIMmOqMKfNxCKk4XvG50Or47GahkzQ4NChJAQqQa9omykHLeuskMzPvu1nR5fsLlld5jihfR/hNP7XNFRwLI18pcCgK+yZjfH+IZIZKDS+ieT/TXgsf/Jsl/MuBnMlCMdccUWuJs724loFi0vuXYbnw1vG7XpxLty4K4RBT5Qe5OQ7N/slpzKJKJDRJCJIcggh5tyI70bcfWQ/k9KyIvLDMD6htTK5JNOnS/Y3wPZDLKui0Tyqc8zq6m2AMapv1J+Z74c+dkVtK3QnoVHrHQj3X4Oyx9eKTmJ3NfSqUmij0uTUlTc30atH/+oYZTlKS5eFzk8YSk7bbbphVS6PzJ8Nzsdy6C1phGZVdkp6nGIy1PkfrcJlCz+0i+oQgB3ILoiuNkHv3/TOb9LHHWNtMyQwDSudMV3Ktv2ZcjdVW8q7We62n3VpdW72b8D01BDoGZwuoxoNbnFtbuVlwASY29krZ/V+KUxbREt1oQQunS4WnUK6Q/KFZku1iJmVNozTmrW37hXC1KJ/xlSiutb49v4vWGVv2x7IB+f4q0buNnRg39goeJiBkwpz9UT7X67DiJn7RXcs93fQS86sOxMzoTEMsx6PTk3pyy+RQgcRYzzEkTPU6jwvGeKYIfKmBKxrncUjCSQIO2TOnuDZkXFFEuAORO/Le7tQ7H/j6F8P43I/lZleZZ5llsg8j2G6HPmytGEw5PP0+aVNmSG0eWYvXm46M5IV3ZeImlnum1TQpXZqA0OIfyis7bAVb1pz4Ib5bSl5p/BYRfsxGLpO8SwJpJ8y56mOvNhP8DKho5GFEnpH7I9zK0w0CQp+YEgQ6/yq7pLR2jemRYzvV9Xm6sn7pxK/JPzKOUCLQKR/gzK8cStJWxZe3llDAjctPKsImpAar7CuKSNw3hlTWTo85LsKVQsnANGV79fyGXZc12Q6rm3zU3PuP3eOZIC928w6admWpMj/zYen8qmCVoaoCirzbZBXdFAbUfuFprMKHr+t8lrFQJ0frsFM6y0xGWjJVd8gTUOjRHJMTN5akhdxuk9YvvlyQvaTIQtG8biJHZkpakyKEafXJRaRke152SHr6leR33qIpwfB27hKZlHFTka0CWhbAFNdWrRlzhcm4n0WwjiAU6j0TphO7AlfVHVQntLe+Z2a6aPrGVslhqBub26rJKeDfnWRRJL9iQ5PPaTpL65sXliZlsNbPstuCQz+Op0q2KUprXVpl8vvWPi8/4xpum98kL5K+lMRXHRFkQukcjoDkAB0T02aBtkdLFX+kATkXfEOdGgoyrR58VqVy51XiQKlU2isvFZWA1udI2nYjOPzYjeoNfQjydiNbfjtBQHlurqu4pQrl2zbUNt5xiZI3nLAkOyQArMMpyFNpnrb/UdoP5xqQ+9x3lOJZWpiB5Rgitnv7LPDN976HDhhunsMXg5TtvsBLxKWyTt5XvwzLFSc9N0i5PosuMSKBb0jCVo00sxsA+Nq7341gO70HLec405XyjPTU7wo8S8xEPpD9mrrFu1JkQnKDWrH3BGV37758DmGpfOpXaaG/1pfKV/puXb69WReVXvVNPfwfY9XN46h0qoyxLybz9x2wuLrKfNfx6rvezwvf9o8BmPyG0/JygKyh6+lela+deF+/0peF862P/SEfe90b2BQCWzdtYoDaDnuQvism7S0RhAEyagL/rEHe36atRETS9yhJ5eGehmcF5CdYPCff2H3FHMpSLS0h++SLyusKE1/s5ELo1CKfLtrul+MY6dBXdVF/s1N51hhljAkqYsJAhNGFC5wZjWiBuY0boG1zIODUmGWXUDXDS5WV1wFM3tYg5x9ejxek71haXmEEXNa2zGzcANG2OwwYYweIMV74bivyb1rhjwYh0KC0wb7IxwIQtwzS5LxTVjhe1wgn3JiNcU7u3n3FnOLrAyohyDpX+YXVDFLENqTpkhX0bg2q1Q90qrMdvK1D/1lUrksrSJJz08nnagnXyiZOf/urPsU1MVtB5edr4fokiagnRXK4Rd7bwl2tsNgiaQ/KshNKK2VHlCbk/dKceMrElFuB/b3eGATm5Bu7dsyBLmWK84BKHUWmpOgM8265Xi0H6KMLwQTQqy2NHqstcuvS33kCRLgO1TvUWiN/pDCvnvp0VlVRzJRlZqeenFuOTCqxTEdXwNdE+CzIZ1AeygkUicn4lqwyyXTBBIInpQXfpWJWbcQTbTqZIAWYk7t3XrEDYdn3FvQ6jDucibVxFRDXu9v1vWamK8UKeooQ+gRRfSxlioqsCyDjKl+eQfRqQa4V+H6QqwV2IrId1W0Im0R1g9iKRIBOhVVgBTivyvcUngQORvReVB8FDqqymqc3hVZVZ4G0nUHJbdoQEiSlueHkF9rk4Nuk/U25V4nCqnBVs1J7DuDxpAtIN/2/9H9BBl+tGuoAAAAASUVORK5CYII=';

    const PANEL_CSS = `
#mh-cover-panel{--mh-bg: #fff !important;--mh-text: #333 !important;--mh-border: #ccc !important;--mh-header: #000 !important;--mh-input-bg: #f5f5f5 !important;--mh-input-border: #ddd !important;--mh-label: #666 !important;--mh-top-border: #e0e0e0 !important;--mh-status: #666 !important;--mh-hover: rgba(0,0,0,.06) !important;--mh-glass: rgba(255,255,255,.95) !important;--mh-sheen: rgba(255,255,255,.6) !important;color-scheme: light !important}
#mh-cover-panel[data-theme="dark"]{--mh-bg: #0f1113 !important;--mh-text: #ddd !important;--mh-border: #222 !important;--mh-header: #fff !important;--mh-input-bg: #111 !important;--mh-input-border: #222 !important;--mh-label: #bbb !important;--mh-top-border: #1a1a1a !important;--mh-status: #9aa !important;--mh-hover: rgba(255,255,255,.07) !important;--mh-glass: rgba(15,17,19,.95) !important;--mh-sheen: rgba(255,255,255,.08) !important;color-scheme: dark !important}
#mh-cover-panel,#mh-cover-panel *{box-sizing: border-box !important}
#mh-cover-panel{position: fixed !important;right: 12px !important;top: 100px !important;z-index: 2147483647 !important;display: flex !important;flex-direction: column !important;width: 264px !important;max-width: calc(100vw - 24px) !important;max-height: 85vh !important;padding: 10px !important;overflow: visible !important;background: var(--mh-glass) !important;-webkit-backdrop-filter: blur(10px) saturate(120%) !important;backdrop-filter: blur(10px) saturate(120%) !important;color: var(--mh-text) !important;border: 1px solid var(--mh-border) !important;border-radius: 10px !important;box-shadow: inset 0 1px 0 var(--mh-sheen) !important;font: 12px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,Arial !important}
#mh-cover-panel .mh-head{display: flex !important;flex: 0 0 auto !important;justify-content: space-between !important;align-items: center !important;gap: 6px !important;margin-bottom: 8px !important;cursor: pointer !important;-webkit-user-select: none !important;-moz-user-select: none !important;user-select: none !important}
#mh-cover-panel .mh-head *{-webkit-user-select: none !important;-moz-user-select: none !important;user-select: none !important}
#mh-cover-panel .mh-title{flex: 1 1 auto !important;min-width: 0 !important;overflow: hidden !important;white-space: nowrap !important;text-overflow: ellipsis !important;font-size: 11px !important;font-weight: 600 !important;color: var(--mh-header) !important}
#mh-cover-panel .mh-user{font-weight: 400 !important;color: var(--mh-label) !important}
#mh-cover-panel .mh-head-actions{display: flex !important;flex: 0 0 auto !important;gap: 4px !important;align-items: center !important}
#mh-cover-panel .mh-icon-btn{position: relative !important;display: block !important;width: 16px !important;height: 16px !important;padding: 0 !important;margin: 0 !important;border: none !important;background: none !important;color: #8a8a8a !important;cursor: pointer !important}
#mh-cover-panel .mh-icon-btn:hover{color: var(--mh-header) !important}
#mh-cover-panel .mh-icon-settings::before{content: "" !important;position: absolute !important;inset: 0 !important;background: currentColor !important;-webkit-mask:${MH_SETTINGS_ICON} center/contain no-repeat !important;mask:${MH_SETTINGS_ICON} center/contain no-repeat !important}
#mh-cover-panel .mh-icon-collapse::before{content: "" !important;position: absolute !important;inset: 0 !important;background: currentColor !important;-webkit-mask:${MH_COLLAPSE_ICON} center/contain no-repeat !important;mask:${MH_COLLAPSE_ICON} center/contain no-repeat !important}
#mh-cover-panel .mh-icon-theme::before{content: "" !important;position: absolute !important;inset: 0 !important;background: currentColor !important;-webkit-mask:${MH_MOON_ICON} center/contain no-repeat !important;mask:${MH_MOON_ICON} center/contain no-repeat !important}
#mh-cover-panel[data-theme="dark"] .mh-icon-theme::before{-webkit-mask:${MH_SUN_ICON} center/contain no-repeat !important;mask:${MH_SUN_ICON} center/contain no-repeat !important}
#mh-cover-panel .mh-icon-chevron::before{content: "" !important;position: absolute !important;inset: 0 !important;background: currentColor !important;-webkit-mask:${MH_CHEVRON_DOWN_ICON} center/contain no-repeat !important;mask:${MH_CHEVRON_DOWN_ICON} center/contain no-repeat !important}
#mh-cover-panel .mh-icon-close::before,#mh-cover-panel .mh-icon-close::after{content: "" !important;position: absolute !important;left: 1px !important;right: 1px !important;top: 50% !important;height: 2px !important;margin-top: -1px !important;border-radius: 1px !important;background: currentColor !important}
#mh-cover-panel .mh-icon-close::before{transform: rotate(45deg) !important}
#mh-cover-panel .mh-icon-close::after{transform: rotate(-45deg) !important}
#mh-cover-panel .mh-scroll{margin-left: -10px !important;margin-right: -10px !important;padding-left: 10px !important;padding-right: 10px !important;flex: 1 1 auto !important;min-height: 0 !important;overflow: visible !important;scrollbar-width: thin !important;scrollbar-color: var(--mh-border) transparent !important}
#mh-cover-panel .mh-body,#mh-cover-panel #mh-batch-main{border-top: 1px solid var(--mh-top-border) !important;padding-top: 8px !important;margin-left: -10px !important;margin-right: -10px !important;padding-left: 10px !important;padding-right: 10px !important}
#mh-cover-panel .mh-info{margin-bottom: 8px !important;color: var(--mh-text) !important}
#mh-cover-panel .mh-info b{color: var(--mh-header) !important}
#mh-cover-panel .mh-row{display: flex !important;gap: 8px !important;margin-bottom: 8px !important}
#mh-cover-panel .mh-btn,#mh-cover-panel .mh-save{--mh-btn-base: linear-gradient(135deg,#d51007 0%,#ff6a00 100%);border: 1px solid transparent !important;border-radius: 5px !important;background: var(--mh-btn-base) !important;background-origin: border-box !important;background-repeat: no-repeat !important;color: #fff !important;height: 32px !important;padding: 0 12px !important;font-size: 12px !important;font-weight: 600 !important;line-height: 1 !important;box-shadow: 0 1px 5px rgba(213,16,7,.10) !important;text-shadow: none !important;cursor: pointer !important;transition: filter .15s ease, background .13s, border-color .13s !important}
#mh-cover-panel .mh-btn:hover:not(:disabled),#mh-cover-panel .mh-save:hover:not(:disabled){filter: brightness(1.07) !important}
#mh-cover-panel .mh-btn:active:not(:disabled),#mh-cover-panel .mh-save:active:not(:disabled){filter: brightness(.92) !important}
#mh-cover-panel .mh-btn:disabled{opacity: .6 !important;cursor: default !important}
#mh-cover-panel .mh-btn:focus-visible,#mh-cover-panel .mh-save:focus-visible{outline: 2px solid rgba(255,106,0,.45) !important;outline-offset: 1px !important}
#mh-cover-panel .mh-btn-lg{flex: 1 !important}
#mh-cover-panel .mh-btn-blue{--mh-btn-base: linear-gradient(135deg,#d51007 0%,#ff6a00 100%)}
#mh-cover-panel .mh-btn-green{--mh-btn-base: linear-gradient(135deg,#d51007 0%,#ff6a00 100%)}
#mh-cover-panel .mh-btn-red{--mh-btn-base: #b00000}
#mh-cover-panel .mh-save{--mh-btn-base: linear-gradient(135deg,#d51007 0%,#ff6a00 100%)}
#mh-cover-panel .mh-btn-tinted-square{--mh-tint-rgb: 213,16,7;--mh-tint-fg: #d51007;border-radius: 6px !important;background: rgba(var(--mh-tint-rgb), .12) !important;border: 1px solid rgba(var(--mh-tint-rgb), .3) !important;color: var(--mh-tint-fg) !important;transition: background .15s ease, border-color .15s ease, color .15s ease !important}
#mh-cover-panel[data-theme="dark"] .mh-btn-tinted-square{--mh-tint-rgb: 255,138,128;--mh-tint-fg: #ff8a80;background: rgba(var(--mh-tint-rgb), .1) !important;border-color: rgba(var(--mh-tint-rgb), .25) !important}
#mh-cover-panel .mh-btn-tinted-square:hover:not(:disabled){background: rgba(var(--mh-tint-rgb), .22) !important;border-color: rgba(var(--mh-tint-rgb), .5) !important;filter: none !important}
#mh-cover-panel[data-theme="dark"] .mh-btn-tinted-square:hover:not(:disabled){background: rgba(var(--mh-tint-rgb), .2) !important;border-color: rgba(var(--mh-tint-rgb), .45) !important}
#mh-cover-panel .mh-btn-tinted-square:active:not(:disabled){background: rgba(var(--mh-tint-rgb), .3) !important;filter: none !important}
#mh-cover-panel .mh-btn-tinted-square:focus-visible{outline: 2px solid rgba(var(--mh-tint-rgb), .55) !important;outline-offset: 1px !important}
#mh-cover-panel .mh-btn-tinted-square svg{transition: transform .25s ease !important}
#mh-cover-panel .mh-btn-tinted-square:hover:not(:disabled) svg{transform: rotate(-90deg) !important}
@media (prefers-reduced-motion: reduce){#mh-cover-panel .mh-btn-tinted-square svg{transition: none !important}#mh-cover-panel .mh-btn-tinted-square:hover:not(:disabled) svg{transform: none !important}}
#mh-cover-panel .mh-status{margin-top: 6px !important;text-align: center !important;font-size: 12px !important;color: var(--mh-status) !important}
#mh-cover-panel .mh-error{color: #d32f2f !important}
#mh-cover-panel .mh-settings{border-top: 1px solid var(--mh-top-border) !important;padding-top: 8px !important;margin-left: -10px !important;margin-right: -10px !important;padding-left: 10px !important;padding-right: 10px !important}
#mh-cover-panel .mh-field{margin-bottom: 6px !important}
#mh-cover-panel .mh-field>label{display: block !important;margin: 0 0 3px !important;color: var(--mh-label) !important}
#mh-cover-panel .mh-field.mh-field-inline{display: flex !important;align-items: center !important;justify-content: space-between !important;gap: 8px !important}
#mh-cover-panel .mh-field.mh-field-inline>label{flex: 1 1 auto !important;min-width: 0 !important;margin: 0 !important;line-height: 1.25 !important}
#mh-cover-panel .mh-field.mh-field-inline>.mh-input{flex: 0 0 auto !important;width: 58px !important}
#mh-cover-panel .mh-field.mh-field-inline>select.mh-input{width: 120px !important}
#mh-cover-panel .mh-details{margin: 0 0 6px !important}
#mh-cover-panel .mh-details>summary{display: list-item !important;padding: 2px 0 !important;color: var(--mh-label) !important;font-size: 12px !important;cursor: pointer !important;user-select: none !important}
#mh-cover-panel .mh-details>summary:hover{color: var(--mh-header) !important}
#mh-cover-panel .mh-details[open]>summary{margin-bottom: 4px !important}
#mh-cover-panel .mh-field-sm{margin: 0 0 3px !important}
#mh-cover-panel .mh-check{display: flex !important;align-items: center !important;gap: 6px !important;margin: 0 !important;color: var(--mh-label) !important;cursor: pointer !important}
#mh-cover-panel .mh-check input{margin: 0 !important;accent-color: #d51007 !important}
#mh-cover-panel .mh-source-count{font-weight: bold !important;color: var(--mh-header) !important}
#mh-cover-panel .mh-sources{display: flex !important;flex-wrap: wrap !important;max-height: 84px !important;overflow-y: auto !important;padding: 4px !important;border: 1px solid var(--mh-input-border) !important;border-radius: 8px !important;background: var(--mh-input-bg) !important;scrollbar-width: thin !important;scrollbar-color: var(--mh-border) transparent !important}
#mh-cover-panel .mh-source{display: flex !important;align-items: center !important;width: 50% !important;margin: 0 0 3px !important}
#mh-cover-panel .mh-source input{margin: 0 6px 0 0 !important;accent-color: #d51007 !important}
#mh-cover-panel .mh-source label{flex-grow: 1 !important;text-align: left !important;color: var(--mh-label) !important;cursor: pointer !important}
#mh-cover-panel .mh-warn{margin-top: 4px !important;color: #ff6b6b !important;font-size: 11px !important}
#mh-cover-panel .mh-input{width: 100% !important;height: 26px !important;padding: 2px 6px !important;border-radius: 6px !important;background: var(--mh-input-bg) !important;border: 1px solid var(--mh-input-border) !important;color: var(--mh-text) !important;font: inherit !important}
#mh-cover-panel select.mh-input{cursor: pointer !important;outline: none !important}
#mh-cover-panel .mh-input:focus{outline: none !important;border-color: #d51007 !important}
#mh-cover-panel .mh-save{width: 100% !important;margin-top: 2px !important;margin-bottom: 3px !important}
#mh-cover-panel .mh-statusbar{display: flex;flex: 0 0 auto !important;align-items: flex-start !important;gap: 8px !important;margin-top: 8px !important;padding-top: 6px !important;border-top: 1px solid var(--mh-top-border) !important;margin-left: -10px !important;margin-right: -10px !important;padding-left: 10px !important;padding-right: 10px !important}
#mh-cover-panel .mh-batch-status{display: -webkit-box !important;-webkit-box-orient: vertical !important;-webkit-line-clamp: 1 !important;line-clamp: 1 !important;flex: 1 1 auto !important;min-width: 0 !important;margin: 0 !important;overflow: hidden !important;overflow-wrap: anywhere !important;text-align: center !important;font-size: 11px !important;line-height: 15px !important;color: var(--mh-status) !important}
#mh-cover-panel .mh-batch-status.mh-error{color: #d32f2f !important}
#mh-cover-panel .mh-batch-status.is-expanded{display: block !important;-webkit-line-clamp: unset !important;line-clamp: unset !important;overflow: visible !important}
#mh-cover-panel .mh-status-toggle{display: none !important;flex: 0 0 16px !important;margin-top: -1px !important}
#mh-cover-panel .mh-status-toggle.is-on{display: block !important}
#mh-cover-panel .mh-statusbar.is-expanded .mh-status-toggle{transform: rotate(180deg) !important}
#mh-cover-panel .mh-batch-actions{display: flex !important;align-items: stretch !important;gap: 6px !important;margin-bottom: 8px !important}
#mh-cover-panel .mh-split{position: relative !important;display: flex !important;flex: 1 !important;min-width: 0 !important;background: linear-gradient(135deg,#d51007 0%,#ff6a00 100%) !important;border-radius: 5px !important;box-shadow: 0 1px 5px rgba(213,16,7,.10) !important}
#mh-cover-panel .mh-split-main{flex: 1 !important;min-width: 0 !important;border-top-right-radius: 0 !important;border-bottom-right-radius: 0 !important;background: transparent !important;box-shadow: none !important}
#mh-cover-panel .mh-split-arrow{flex: 0 0 30px !important;width: 30px !important;padding: 0 !important;display: flex !important;align-items: center !important;justify-content: center !important;border-top-left-radius: 0 !important;border-bottom-left-radius: 0 !important;border-left: 1px solid rgba(255,255,255,.3) !important;background: transparent !important;box-shadow: none !important}
#mh-cover-panel .mh-split>.mh-btn:hover:not(:disabled){background: rgba(255,255,255,.12) !important;filter: none !important}
#mh-cover-panel .mh-split>.mh-btn:active:not(:disabled){background: rgba(0,0,0,.08) !important;filter: none !important}
#mh-cover-panel .mh-split.is-red{background: #b00000 !important;box-shadow: 0 1px 5px rgba(176,0,0,.10) !important}
#mh-cover-panel .mh-btn svg{display: block !important;width: 16px !important;height: 16px !important;pointer-events: none !important}
#mh-cover-panel .mh-split-menu{position: absolute !important;top: calc(100% + 4px) !important;left: 0 !important;right: 0 !important;z-index: 5 !important;padding: 0 !important;border: 0 !important;border-radius: 5px !important;overflow: hidden !important;background: var(--mh-bg) !important;box-shadow: 0 6px 20px rgba(0,0,0,.22) !important}
#mh-cover-panel .mh-split-menu[hidden]{display: none !important}
#mh-cover-panel .mh-menu-item{display: block !important;width: 100% !important;margin: 0 !important;border-radius: 0 !important;white-space: nowrap !important;overflow: hidden !important;text-overflow: ellipsis !important;font-size: 11px !important}
#mh-cover-panel .mh-icon-action{flex: 0 0 32px !important;width: 32px !important;padding: 0 !important;display: flex !important;align-items: center !important;justify-content: center !important}
#mh-cover-panel #mh-batch-reset svg{width: 22px !important;height: 22px !important}
#mh-cover-panel .mh-batch-actions .mh-btn{padding: 0 10px !important}
#mh-cover-panel .mh-check.is-disabled{opacity: .45 !important;cursor: default !important}
#mh-cover-panel .mh-check input:disabled{cursor: default !important}
#mh-cover-panel .mh-btn-grow{flex: 1 !important}
#mh-cover-panel #mh-batch-list{max-height: 30vh !important;overflow-x: hidden !important;overflow-y: auto !important;padding: 2px !important;border: 1px solid var(--mh-input-border) !important;border-radius: 8px !important;background: var(--mh-input-bg) !important;scrollbar-width: thin !important;scrollbar-color: var(--mh-border) transparent !important}
#mh-cover-panel .mh-empty{padding: 10px 6px !important;text-align: center !important;font-size: 12px !important;color: var(--mh-label) !important}
#mh-cover-panel .mh-batch-item{display: flex !important;align-items: center !important;gap: 7px !important;padding: 3px 4px !important;border-radius: 6px !important;cursor: pointer !important}
#mh-cover-panel .mh-batch-item:hover{background: var(--mh-hover) !important}
#mh-cover-panel .mh-batch-item.mh-done .mh-batch-text,#mh-cover-panel .mh-batch-item.mh-skipped .mh-batch-text{opacity: .7 !important}
#mh-cover-panel[data-theme="dark"] .mh-batch-item.mh-done .mh-batch-text,#mh-cover-panel[data-theme="dark"] .mh-batch-item.mh-skipped .mh-batch-text{opacity: .8 !important}
#mh-cover-panel .mh-thumb{position: relative !important;flex: 0 0 30px !important;width: 30px !important;height: 30px !important;border-radius: 3px !important;overflow: hidden !important;background: var(--mh-hover) !important;transform-origin: center center !important;transition: transform .16s ease, box-shadow .16s ease !important}
#mh-cover-panel .mh-thumb img{display: block !important;width: 100% !important;height: 100% !important;object-fit: cover !important}
#mh-cover-panel .mh-batch-text{flex: 1 !important;min-width: 0 !important;line-height: 1.25 !important}
#mh-cover-panel .mh-batch-album,#mh-cover-panel .mh-batch-artist{white-space: nowrap !important;overflow: hidden !important;text-overflow: ellipsis !important}
#mh-cover-panel .mh-batch-album{font-size: 12px !important;font-weight: 600 !important;color: var(--mh-header) !important}
#mh-cover-panel .mh-batch-artist{font-size: 11px !important;color: var(--mh-label) !important}
#mh-cover-panel .mh-state{position: relative !important;flex: 0 0 14px !important;width: 14px !important;height: 14px !important;border-radius: 50% !important;box-sizing: border-box !important;transition: background-color .2s ease, border-color .2s ease, opacity .2s ease !important}
#mh-cover-panel .mh-state-idle{border: 2px solid rgba(213,16,7,.65) !important}
#mh-cover-panel .mh-state-ok{border: 2px solid #8a8a8a !important}
#mh-cover-panel .mh-state-skipped{border: 2px dashed #8a8a8a !important;opacity: .75 !important}
#mh-cover-panel .mh-state-searching{background: #d51007 !important;transform: scale(.62) !important;animation: mh-ping 1.35s cubic-bezier(.3,.6,.5,1) infinite !important}
#mh-cover-panel .mh-state-uploading{border: 2px solid rgba(213,16,7,.18) !important;border-top-color: #d51007 !important;border-right-color: #ff6a00 !important;animation: mh-spin .9s linear infinite !important}
#mh-cover-panel .mh-state-done{background: transparent !important;border: 2px solid #28a745 !important;background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2328a745' stroke-width='3.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m5 12.5 4.2 4.2L19 7'/%3E%3C/svg%3E") !important;background-repeat: no-repeat !important;background-position: center !important;background-size: 78% !important;animation: mh-pop .38s cubic-bezier(.25,1.5,.45,1) both !important}
#mh-cover-panel .mh-thumb[data-mh-open-idx]{cursor: pointer !important}
#mh-cover-panel .mh-thumb:hover,#mh-cover-panel .mh-thumb:focus-visible{transform: scale(1.07) !important;z-index: 5 !important;box-shadow: 0 2px 6px rgba(0,0,0,.18) !important}
#mh-cover-panel .mh-thumb:focus-visible{outline: 2px solid #ff6a00 !important;outline-offset: 1px !important}
@media (prefers-reduced-motion: reduce){
#mh-cover-panel .mh-thumb{transition: none !important}
#mh-cover-panel .mh-thumb:hover,#mh-cover-panel .mh-thumb:focus-visible{transform: none !important}
}
#mh-cover-panel .mh-state-error{background: #d32f2f !important;animation: mh-shake .45s ease-in-out both !important}
#mh-cover-panel .mh-state-error::after{content: "!" !important;position: absolute !important;inset: 0 !important;font: 700 10px/14px Arial,sans-serif !important;text-align: center !important;color: #fff !important}



#mh-fab{--mh-bg: #fff !important;--mh-border: #ccc !important}
#mh-fab[data-theme="dark"]{--mh-bg: #0f1113 !important;--mh-border: #222 !important}
#mh-fab{position: fixed !important;right: 0 !important;top: 100px !important;z-index: 2147483646 !important;display: flex !important;align-items: center !important;justify-content: flex-start !important;box-sizing: border-box !important;width: 44px !important;height: 50px !important;padding: 0 0 0 1px !important;margin: 0 !important;border: 2px solid var(--mh-border) !important;border-right: 0 !important;border-radius: 12px 0 0 12px !important;background: var(--mh-bg) !important;box-shadow: none !important;cursor: pointer !important;visibility: hidden !important;pointer-events: none !important;transform: translateX(100%) !important;transition: transform .24s cubic-bezier(.5,0,.8,.4),width .18s ease,background-color .18s ease,box-shadow .18s ease,visibility 0s linear .3s !important;opacity: .92 !important}
#mh-fab.is-visible{visibility: visible !important;pointer-events: auto !important;transform: translateX(0) !important;transition: transform .32s cubic-bezier(.2,.9,.3,1.15) .1s,width .18s ease,background-color .18s ease,box-shadow .18s ease,visibility 0s linear 0s !important}
#mh-cover-panel.mh-no-anim,#mh-cover-panel.mh-no-anim.is-collapsed{transition: none !important}
#mh-fab.mh-no-anim{transition: none !important}
#mh-fab:hover{width: 50px !important;box-shadow: 0 0 0 2px rgba(255,106,0,.22),0 0 12px rgba(213,16,7,.12) !important}
#mh-fab:focus-visible{box-shadow: 0 0 0 2px rgba(255,106,0,.35),0 0 14px rgba(213,16,7,.18) !important;outline: none !important}
#mh-fab img{display: block !important;width: 40px !important;height: 40px !important;border-radius: 50% !important;pointer-events: none !important}
#mh-cover-panel{transition: transform .3s cubic-bezier(.2,.8,.3,1),opacity .2s ease,visibility 0s linear 0s !important}
#mh-cover-panel.is-collapsed{transform: translateX(calc(100% + 24px)) !important;opacity: 0 !important;visibility: hidden !important;pointer-events: none !important;transition: transform .26s cubic-bezier(.5,0,.8,.4),opacity .2s ease .08s,visibility 0s linear .3s !important}
html body .mh-missing-border{position: absolute !important;top: 0 !important;left: 0 !important;right: 0 !important;bottom: 0 !important;border: 3px solid #d32f2f !important;border-radius: inherit !important;pointer-events: none !important;z-index: 10 !important}
html body .mh-missing-border[data-mh-state="done"]{border-color: #28a745 !important}
html body .mh-missing-badge{position: absolute !important;top: -10px !important;right: -10px !important;width: 24px !important;height: 24px !important;display: flex !important;align-items: center !important;justify-content: center !important;border: 2px solid #fff !important;border-radius: 50% !important;background: #d32f2f !important;color: #fff !important;font: 300 20px/24px Arial,sans-serif !important;cursor: pointer !important;z-index: 11 !important;box-shadow: 0 0 1px rgba(0,0,0,.04) !important;transition: transform .2s,background .2s !important}
html body .mh-missing-badge:hover{background: #e53935 !important;transform: scale(1.1) !important}
html body .mh-missing-badge[data-mh-state="done"]{background: #28a745 !important;font-size: 15px !important}
html body .mh-missing-badge[data-mh-state="done"]:hover{background: #2e7d32 !important}
@keyframes mh-spin{to{transform: rotate(360deg)}}
@keyframes mh-pulse{0%,100%{opacity: 1}50%{opacity: .35}}
@keyframes mh-ping{0%{box-shadow: 0 0 0 0 rgba(213,16,7,.42)}70%{box-shadow: 0 0 0 7px rgba(213,16,7,0)}100%{box-shadow: 0 0 0 0 rgba(213,16,7,0)}}
@keyframes mh-pop{0%{transform: scale(.4)}60%{transform: scale(1.12)}100%{transform: scale(1)}}
@keyframes mh-shake{0%,100%{transform: translateX(0)}20%{transform: translateX(-2px)}40%{transform: translateX(2px)}60%{transform: translateX(-1.5px)}80%{transform: translateX(1px)}}
@media (prefers-reduced-motion: reduce){
#mh-cover-panel .mh-state,#mh-cover-panel .mh-state::after{animation: none !important}
}
`;

    function ensurePanelStyles() {
        if ($mh('#mh-panel-styles')) return;
        const style = document.createElement('style');
        style.id = 'mh-panel-styles';
        style.setAttribute('data-darkreader-ignore', '');
        style.textContent = PANEL_CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    function panelTheme() {
        if (MH_CONFIG.theme === 'auto') {
            try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
            catch (e) { return 'light'; }
        }
        return MH_CONFIG.theme === 'dark' ? 'dark' : 'light';
    }

    function buildSettingsPanelHtml() {
        return `
            <div id="mh-settings-panel" class="mh-settings" style="display:none;">
                <div class="mh-field">
                    <label>Sources: <span id="mh-source-counter" class="mh-source-count">0/9</span></label>
                    <div id="mh-sources-checkboxes" class="mh-sources">
                        ${ALL_SOURCES.map(source => {
                            const slug = createSourceSlug(source);
                            return `
                                <div class="mh-source">
                                    <input type="checkbox" id="mh-source-${slug}" name="mh-sources" value="${esc(source)}" class="mh-source-checkbox">
                                    <label for="mh-source-${slug}">${esc(source)}</label>
                                </div>
                            `;
                        }).join('')}
                    </div>
                    <div id="mh-source-warning" class="mh-warn" style="display:none;">Maximum 9 sources allowed</div>
                </div>
                <details class="mh-details">
                    <summary>Display &amp; Behaviour</summary>
                    <div class="mh-field-sm">
                        <label class="mh-check"><input type="checkbox" id="mh-show-missing"> Show Missing Artwork Indicators</label>
                    </div>
                    <div class="mh-field-sm">
                        <label class="mh-check"><input type="checkbox" id="mh-open-new-tab"> Open Upload Page In New Tab</label>
                    </div>
                    <div class="mh-field-sm">
                        <label class="mh-check"><input type="checkbox" id="mh-open-cov"> Open COV Instead Of Upload Page</label>
                    </div>
                    <div class="mh-field-sm">
                        <label class="mh-check"><input type="checkbox" id="mh-compress-images"> Compress Large Images</label>
                    </div>
                    <div class="mh-field-sm">
                        <label class="mh-check"><input type="checkbox" id="mh-animate"> Animate FAB/Panel</label>
                    </div>
                    <div class="mh-field-sm">
                        <label class="mh-check"><input type="checkbox" id="mh-show-batch-panel"> Batch Mode: Show Batch Window/FAB</label>
                    </div>
                    <div class="mh-field-sm">
                        <label class="mh-check"><input type="checkbox" id="mh-start-collapsed-batch"> Batch Mode: Start Panel Collapsed</label>
                    </div>
                    <div class="mh-field-sm">
                        <label class="mh-check"><input type="checkbox" id="mh-batch-only-missing"> Batch Mode: Only Missing Artwork</label>
                    </div>
                    <div class="mh-field-sm">
                        <label class="mh-check"><input type="checkbox" id="mh-hide-uploaded-next-run"> Batch Mode: Hide Uploaded Next Run</label>
                    </div>
                </details>
                <div class="mh-field mh-field-inline">
                    <label for="mh-batch-pages">Pages To Scan In Batch Mode:</label>
                    <input type="number" id="mh-batch-pages" class="mh-input" min="1" max="50">
                </div>
                <div class="mh-field mh-field-inline">
                    <label for="mh-res-input">Minimal Resolution:</label>
                    <input type="number" id="mh-res-input" class="mh-input" min="0">
                </div>
                <div class="mh-field mh-field-inline">
                    <label for="mh-country-select">Country:</label>
                    <select id="mh-country-select" class="mh-input">
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
                        <option value="es">Spain</option>
                        <option value="tw">Taiwan</option>
                        <option value="gb">United Kingdom</option>
                        <option value="us">United States</option>
                    </select>
                </div>
                <div class="mh-field mh-field-inline">
                    <label for="mh-theme-select">Theme:</label>
                    <select id="mh-theme-select" class="mh-input">
                        <option value="auto">Auto (System)</option>
                        <option value="dark">Dark Mode</option>
                        <option value="light">Light Mode</option>
                    </select>
                </div>
                <button id="mh-save-settings" class="mh-save">Save Settings</button>
            </div>
        `;
    }

    function buildHeaderActionsHtml() {
        const dark = panelTheme() === 'dark';
        const themeLabel = dark ? 'Switch to light mode' : 'Switch to dark mode';
        return `
                    <button id="mh-theme-btn" class="mh-icon-btn mh-icon-theme" title="${themeLabel}" aria-label="${themeLabel}"></button>
                    <button id="mh-settings-btn" class="mh-icon-btn mh-icon-settings" title="Settings" aria-label="Settings"></button>
                    <button id="mh-collapse-btn" class="mh-icon-btn mh-icon-collapse" title="Collapse" aria-label="Collapse" aria-expanded="true"></button>
                    <button id="mh-close-btn" class="mh-icon-btn mh-icon-close" title="Close" aria-label="Close"></button>`;
    }

    function bindHeaderActions(panel) {
        const head = panel.querySelector('.mh-head');
        if (head) {
            head.addEventListener('click', (e) => {
                if (e.target.closest('.mh-head-actions')) return;
                setPanelCollapsed(true);
            });
            head.addEventListener('mousedown', (e) => {
                if (e.detail > 1 && !e.target.closest('.mh-head-actions')) e.preventDefault();
            });
        }
        $mh('#mh-theme-btn').addEventListener('click', toggleTheme);
        $mh('#mh-settings-btn').addEventListener('click', toggleSettingsPanel);
        $mh('#mh-collapse-btn').addEventListener('click', () => setPanelCollapsed(true));
        $mh('#mh-close-btn').addEventListener('click', () => { panel.remove(); $mh('#mh-fab')?.remove(); });
    }

    function applyPanelTheme() {
        const theme = panelTheme();
        const panel = $mh('#mh-cover-panel');
        if (panel) panel.dataset.theme = theme;
        const fab = $mh('#mh-fab');
        if (fab) fab.dataset.theme = theme;
        const btn = $mh('#mh-theme-btn');
        if (btn) {
            const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
            btn.title = label;
            btn.setAttribute('aria-label', label);
        }
        const select = $mh('#mh-theme-select');
        if (select) select.value = MH_CONFIG.theme;
    }

    async function toggleTheme() {
        MH_CONFIG.theme = panelTheme() === 'dark' ? 'light' : 'dark';
        applyPanelTheme();
        await saveConfig();
    }

    function ensureFab() {
        if ($mh('#mh-fab')) return;
        const fab = document.createElement('button');
        fab.id = 'mh-fab';
        fab.type = 'button';
        fab.title = 'Expand Last.fm Artwork Upload Helper';
        fab.setAttribute('aria-label', 'Expand panel');
        fab.setAttribute('aria-expanded', 'false');
        fab.dataset.theme = panelTheme();
        const img = document.createElement('img');
        img.alt = '';
        img.src = 'data:image/png;base64,' + FAB_ICON_PNG;
        fab.appendChild(img);
        fab.addEventListener('click', () => setPanelCollapsed(false));
        fab.classList.toggle('mh-no-anim', MH_CONFIG.animate === false);
        document.body.appendChild(fab);
    }

    function setPanelCollapsed(collapsed) {
        UI.collapsed = !!collapsed;
        const panel = $mh('#mh-cover-panel');
        const fab = $mh('#mh-fab');
        if (!panel) return;
        panel.classList.toggle('is-collapsed', !!collapsed);
        if (fab) {
            fab.classList.toggle('is-visible', !!collapsed);
            fab.dataset.theme = panel.dataset.theme;
            fab.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        }
        const btn = $mh('#mh-collapse-btn');
        if (btn) {
            btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            btn.title = collapsed ? 'Expand' : 'Collapse';
            btn.setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
        }
    }

    function createPanel() {
        $mh('#mh-cover-panel')?.remove();

        currentInfo = extractArtistAlbum();
        if (!currentInfo) return null;

        ensurePanelStyles();

        const panel = document.createElement('div');
        panel.id = 'mh-cover-panel';
        panel.setAttribute('data-darkreader-ignore', '');
        panel.dataset.theme = panelTheme();
        panel.dataset.mode = 'upload';

        panel.innerHTML = `
            <div class="mh-head">
                <div class="mh-title" title="Last.fm Artwork Upload Helper">Artwork Upload Helper</div>
                <div class="mh-head-actions">${buildHeaderActionsHtml()}
                </div>
            </div>
            <div class="mh-scroll">
            <div class="mh-body">
                <div id="mh-artist-album-info" class="mh-info">
                    Artist: <b>${esc(currentInfo.artist)}</b>${currentInfo.album ? `<br>
                    Album: <b>${esc(currentInfo.album)}</b>` : ''}
                </div>
                <div class="mh-row">
                    <button id="mh-load-images" class="mh-btn mh-btn-lg">Open Artwork Search</button>
                </div>
                <div id="mh-status" class="mh-status">Ready</div>
            </div>
            ${buildSettingsPanelHtml()}
            </div>
        `;
        document.body.appendChild(panel);

        $mh('#mh-load-images').addEventListener('click', loadCoverImages);
        $mh('#mh-save-settings').addEventListener('click', saveAndCloseSettings);
        bindHeaderActions(panel);

        ensureFab();
        panel.classList.toggle('mh-no-anim', MH_CONFIG.animate === false);
        return panel;
    }

    function toggleSettingsPanel() {
        const settingsPanel = $mh('#mh-settings-panel');
        const mainContent = $mh('#mh-batch-main') || $mh('#mh-artist-album-info')?.parentElement;
        if (!settingsPanel) return;

        const statusBar = $mh('#mh-batch-statusbar');
        const opening = settingsPanel.style.display === 'none';
        if (opening) {
            loadSettingsIntoPanel();
            settingsPanel.style.display = 'block';
            if (mainContent) mainContent.style.display = 'none';
            if (statusBar) statusBar.style.display = 'none';
        } else {
            settingsPanel.style.display = 'none';
            if (mainContent) mainContent.style.display = 'block';
            if (statusBar) statusBar.style.display = '';
            syncStatusOverflow();
        }
    }

    function syncOpenCovSetting() {
        const cov = $mh('#mh-open-cov');
        const tab = $mh('#mh-open-new-tab');
        if (!cov || !tab) return;
        tab.disabled = cov.checked;
        const label = tab.closest('label');
        if (label) label.classList.toggle('is-disabled', cov.checked);
        cov.onchange = syncOpenCovSetting;
    }

    function loadSettingsIntoPanel() {
        const showMissingCheckbox = $mh('#mh-show-missing');
        if (showMissingCheckbox) showMissingCheckbox.checked = MH_CONFIG.showMissingIndicators;

        const openNewTabCheckbox = $mh('#mh-open-new-tab');
        if (openNewTabCheckbox) openNewTabCheckbox.checked = MH_CONFIG.openInNewTab;

        const openCovCheckbox = $mh('#mh-open-cov');
        if (openCovCheckbox) openCovCheckbox.checked = !!MH_CONFIG.openCovInstead;
        syncOpenCovSetting();

        const compressImagesCheckbox = $mh('#mh-compress-images');
        if (compressImagesCheckbox) compressImagesCheckbox.checked = MH_CONFIG.compressImages;

        const animateCheckbox = $mh('#mh-animate');
        if (animateCheckbox) animateCheckbox.checked = MH_CONFIG.animate !== false;

        const batchOnlyMissing = $mh('#mh-batch-only-missing');
        if (batchOnlyMissing) batchOnlyMissing.checked = MH_CONFIG.batchOnlyMissing !== false;

        const hideUploadedNextRun = $mh('#mh-hide-uploaded-next-run');
        if (hideUploadedNextRun) hideUploadedNextRun.checked = MH_CONFIG.hideUploadedNextRun !== false;

        const batchPages = $mh('#mh-batch-pages');
        if (batchPages) batchPages.value = MH_CONFIG.batchPages || 9;

        const showBatchPanel = $mh('#mh-show-batch-panel');
        if (showBatchPanel) showBatchPanel.checked = MH_CONFIG.showBatchPanel !== false;

        const startCollapsedBatch = $mh('#mh-start-collapsed-batch');
        if (startCollapsedBatch) startCollapsedBatch.checked = MH_CONFIG.startCollapsedBatch !== false;

        ALL_SOURCES.forEach(source => {
            const slug = createSourceSlug(source);
            const checkbox = $mh(`#mh-source-${slug}`);
            if (checkbox) checkbox.checked = MH_CONFIG.sources.includes(source);
        });
        $mh('#mh-country-select').value = MH_CONFIG.country;
        $mh('#mh-res-input').value = MH_CONFIG.resolution;
        $mh('#mh-theme-select').value = MH_CONFIG.theme;

        updateSourceCounter();
        setupSourceCheckboxListeners();
    }

    function updateSourceCounter() {
        const counter = $mh('#mh-source-counter');
        const warning = $mh('#mh-source-warning');
        if (!counter) return;

        const checkedCount = document.querySelectorAll('#mh-sources-checkboxes input[name="mh-sources"]:checked').length;
        counter.textContent = `${checkedCount}/9`;

        if (warning) {
            warning.style.display = checkedCount > 9 ? 'block' : 'none';
        }

        const allCheckboxes = document.querySelectorAll('#mh-sources-checkboxes input[name="mh-sources"]');
        if (checkedCount >= 9) {
            allCheckboxes.forEach(cb => {
                if (!cb.checked) {
                    cb.disabled = true;
                    cb.style.cursor = 'not-allowed';
                    cb.nextElementSibling.style.opacity = '0.5';
                    cb.nextElementSibling.style.cursor = 'not-allowed';
                }
            });
        } else {
            allCheckboxes.forEach(cb => {
                cb.disabled = false;
                cb.style.cursor = 'pointer';
                cb.nextElementSibling.style.opacity = '1';
                cb.nextElementSibling.style.cursor = 'pointer';
            });
        }
    }

    function setupSourceCheckboxListeners() {
        const checkboxes = document.querySelectorAll('#mh-sources-checkboxes input[name="mh-sources"]');
        checkboxes.forEach(cb => {
            cb.addEventListener('change', updateSourceCounter);
        });
    }

    async function saveAndCloseSettings() {
        const checkedSources = Array.from(document.querySelectorAll('#mh-sources-checkboxes input[name="mh-sources"]:checked'))
            .map(cb => cb.value);

        if (checkedSources.length > 9) {
            alert('Select a maximum of 9 sources');
            return;
        }

        const prevHideUploaded = MH_CONFIG.hideUploadedNextRun !== false;
        const prevOnlyMissing = MH_CONFIG.batchOnlyMissing !== false;

        const showMissingCheckbox = $mh('#mh-show-missing');
        if (showMissingCheckbox) MH_CONFIG.showMissingIndicators = showMissingCheckbox.checked;

        const openNewTabCheckbox = $mh('#mh-open-new-tab');
        if (openNewTabCheckbox) MH_CONFIG.openInNewTab = openNewTabCheckbox.checked;

        const openCovCheckbox = $mh('#mh-open-cov');
        if (openCovCheckbox) MH_CONFIG.openCovInstead = openCovCheckbox.checked;

        const compressImagesCheckbox = $mh('#mh-compress-images');
        if (compressImagesCheckbox) MH_CONFIG.compressImages = compressImagesCheckbox.checked;

        const animateCheckbox = $mh('#mh-animate');
        if (animateCheckbox) MH_CONFIG.animate = animateCheckbox.checked;

        const animateEnabled = MH_CONFIG.animate !== false;
        document.querySelectorAll('#mh-cover-panel, #mh-fab').forEach(el => {
            el.classList.toggle('mh-no-anim', !animateEnabled);
        });

        const batchOnlyMissing = $mh('#mh-batch-only-missing');
        if (batchOnlyMissing) MH_CONFIG.batchOnlyMissing = batchOnlyMissing.checked;

        const hideUploadedNextRun = $mh('#mh-hide-uploaded-next-run');
        if (hideUploadedNextRun) MH_CONFIG.hideUploadedNextRun = hideUploadedNextRun.checked;

        const batchPages = $mh('#mh-batch-pages');
        if (batchPages) MH_CONFIG.batchPages = clampBatchPages(batchPages.value);

        const showBatchPanel = $mh('#mh-show-batch-panel');
        if (showBatchPanel) MH_CONFIG.showBatchPanel = showBatchPanel.checked;
        const startCollapsedBatchEl = $mh('#mh-start-collapsed-batch');
        if (startCollapsedBatchEl) MH_CONFIG.startCollapsedBatch = startCollapsedBatchEl.checked;
        if (MH_CONFIG.showBatchPanel === false && BATCH.active) {
            BATCH.active = false;
            BATCH.auto = false;
            await saveBatchState();
        }

        MH_CONFIG.sources = checkedSources;
        MH_CONFIG.country = $mh('#mh-country-select').value;
        MH_CONFIG.resolution = $mh('#mh-res-input').value.trim();
        MH_CONFIG.theme = $mh('#mh-theme-select').value;

        await saveConfig();

        const panel = $mh('#mh-cover-panel');
        if (panel) {
            panel.remove();
            setTimeout(() => {
                const newPanel = createPagePanel();
                if (newPanel) {
                    setBatchStatus('Settings saved');
                    setTimeout(() => {
                        const statusEl = $mh('#mh-batch-status');
                        if (statusEl && statusEl.textContent === 'Settings saved') showIdleStatus();
                    }, 2500);
                }

                if (MH_CONFIG.showMissingIndicators || BATCH.active) {
                    scanPageForMissingArtwork();
                }
                applyBatchModeStyles();
                if (prevHideUploaded !== (MH_CONFIG.hideUploadedNextRun !== false) || prevOnlyMissing !== (MH_CONFIG.batchOnlyMissing !== false)) refreshBatchQueueView();
            }, 100);
        }
    }

    let singleWatcher = null;

    function stopSingleWatcher() {
        if (singleWatcher) {
            clearInterval(singleWatcher);
            singleWatcher = null;
        }
    }

    function watchSingleSearch(popup) {
        stopSingleWatcher();
        const openedText = 'Search opened, pick an artwork';
        let closedTicks = 0;
        singleWatcher = setInterval(() => {
            const statusEl = $mh('#mh-status');
            if (!statusEl) {
                stopSingleWatcher();
                return;
            }
            let closed = false;
            try { closed = !popup || popup.closed; } catch (e) { closed = true; }
            closedTicks = closed ? closedTicks + 1 : 0;
            if (closedTicks < 2) return;

            stopSingleWatcher();
            if (statusEl.textContent === openedText) {
                statusEl.textContent = 'Search was closed, reopen to continue';
            }
        }, 500);
    }

    async function loadCoverImages() {
        if (!currentInfo) {
            alert('Cannot determine artist/album info for this page');
            return;
        }

        const statusEl = $mh('#mh-status');
        const loadBtn = $mh('#mh-load-images');

        stopSingleWatcher();
        if (statusEl) statusEl.textContent = 'Opening artwork search…';
        if (loadBtn) loadBtn.disabled = true;

        const url = buildMhUrl(currentInfo, {
            remoteText: `Pick an artwork for ${currentInfo.album ? currentInfo.artist + ' - ' + currentInfo.album : currentInfo.artist}`
        });

        const popupWidth = 1000, popupHeight = 800;
        const left = (screen.width - popupWidth) / 2;
        const top = (screen.height - popupHeight) / 2;

        const popup = window.open(url, 'CoverSearchEngine',
            `width=${popupWidth},height=${popupHeight},left=${left},top=${top},resizable=yes,scrollbars=yes`);

        if (!popup) {
            if (statusEl) statusEl.textContent = 'Popup blocked, allow popups for Last.fm and try again';
            if (loadBtn) loadBtn.disabled = false;
            return;
        }

        if (statusEl) statusEl.textContent = 'Search opened, pick an artwork';
        if (loadBtn) {
            loadBtn.textContent = 'Reopen Artwork Search';
            loadBtn.disabled = false;
        }
        watchSingleSearch(popup);
    }

    function getPageMode() {
        if (isUploadPath()) return 'upload';
        if (getBatchScope()) return MH_CONFIG.showBatchPanel === false ? null : 'batch';
        return null;
    }

    function refreshPagePanel() {
        $mh('#mh-cover-panel')?.remove();
        $mh('#mh-fab')?.remove();
        if (getPageMode()) createPagePanel();
    }

    function createPagePanel() {
        const mode = getPageMode();
        if (mode === 'upload') return createPanel();
        if (mode === 'batch') return createBatchPanel();
        return null;
    }

    function showMhToast(text) {
        let el = document.getElementById('mh-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'mh-toast';
            el.style.cssText = 'position:fixed;left:12px;bottom:12px;max-width:320px;z-index:2147483647;background:#d32f2f;color:#fff;border-radius:5px;padding:8px 12px;font:600 12px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,Arial;';
            document.body.appendChild(el);
        }
        el.textContent = trimStatus(text);
        clearTimeout(el._mhTimer);
        el._mhTimer = setTimeout(() => el.remove(), 6000);
    }

    function showIdleStatus() {
        const el = $mh('#mh-batch-status');
        if (!el) return;
        const count = visibleQueue().length;
        el.textContent = count ? `${count} album${count === 1 ? '' : 's'}` : 'Ready';
        el.title = el.textContent;
        el.classList.remove('mh-error');
        el.dataset.idle = '1';
        syncStatusOverflow();
    }

    function setBatchStatus(text, isError = false) {
        text = trimStatus(text);
        const el = $mh('#mh-batch-status') || $mh('#mh-status');
        if (!el) {
            if (isError) showMhToast(text);
            return;
        }
        delete el.dataset.idle;
        el.textContent = text;
        el.classList.toggle('mh-error', !!isError);
        if (el.id === 'mh-batch-status') {
            el.title = text;
            syncStatusOverflow();
            dedupeEmptyStatus();
        }
    }

    function dedupeEmptyStatus() {
        const el = $mh('#mh-batch-status');
        if (!el || el.dataset.idle || el.classList.contains('mh-error')) return;
        if (visibleQueue().length) return;
        const empty = emptyBatchMessage();
        const current = el.textContent;
        if (current === empty) {
            showIdleStatus();
        } else if (current.startsWith(empty + ' (') && current.endsWith(')')) {
            const rest = current.slice(empty.length + 2, -1);
            el.textContent = rest.charAt(0).toUpperCase() + rest.slice(1);
            el.title = el.textContent;
            syncStatusOverflow();
        }
    }

    function syncStatusOverflow() {
        const el = $mh('#mh-batch-status');
        const btn = $mh('#mh-status-toggle');
        const bar = $mh('#mh-batch-statusbar');
        if (!el || !btn || !bar || bar.style.display === 'none') return;

        const wasExpanded = el.classList.contains('is-expanded');
        if (wasExpanded) el.classList.remove('is-expanded');
        btn.classList.remove('is-on');
        const overflows = el.scrollHeight > el.clientHeight + 1;
        if (wasExpanded && overflows) el.classList.add('is-expanded');

        btn.classList.toggle('is-on', overflows);
        bar.classList.toggle('is-expanded', overflows && wasExpanded);
        const expanded = overflows && wasExpanded;
        btn.title = expanded ? 'Show less' : 'Show more';
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }

    function toggleStatusExpanded() {
        const el = $mh('#mh-batch-status');
        if (!el) return;
        el.classList.toggle('is-expanded');
        const bar = $mh('#mh-batch-statusbar');
        const btn = $mh('#mh-status-toggle');
        const expanded = el.classList.contains('is-expanded');
        if (bar) bar.classList.toggle('is-expanded', expanded);
        if (btn) {
            btn.title = expanded ? 'Show less' : 'Show more';
            btn.setAttribute('aria-label', btn.title);
            btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        }
    }

    function uploadingItems() {
        return BATCH.queue.filter(item => item.status === 'uploading');
    }

    function activityText() {
        const uploading = uploadingItems();
        const pending = BATCH.pending;
        const upText = uploading.length === 1
            ? `Uploading “${uploading[0].album}”`
            : `Uploading ${uploading.length} albums`;
        if (pending && uploading.length) return `${upText} · pick artwork for “${pending.album}”`;
        if (pending) return `Pick artwork for “${pending.album}”…`;
        if (uploading.length) return `${upText}…`;
        return '';
    }

    function scanSuffix() {
        const p = BATCH.scanning && BATCH.scanProgress;
        return p ? ` · scanning page ${p.page}${p.pages ? '/' + p.pages : ''}` : '';
    }

    function updateScanStatus() {
        const p = BATCH.scanProgress;
        if (!p) return;
        if (BATCH.pending) {
            setBatchStatus(`Pick artwork for “${BATCH.pending.album}”…${scanSuffix()}`);
        } else if (BATCH.openBlocked) {
            setBatchStatus(`Albums found, click Open Picker to start choosing artwork${scanSuffix()}`);
        } else {
            const pageText = `${p.page}${p.pages ? '/' + p.pages : ''}`;
            if (visibleQueue().length) {
                setBatchStatus(`Scanning ${BATCH.scope && BATCH.scope.noun === 'albums' ? 'albums' : 'library'} page ${pageText}…`);
            } else {
                setBatchStatus(`Page ${pageText}…`);
            }
        }
    }

    function emptyBatchMessage() {
        if (BATCH.scanning) return 'Scanning albums…';
        const scanned = BATCH.scanNext > 1;
        if (!BATCH.active && !scanned) return BATCH.scope ? BATCH.scope.emptyHint : 'Start to scan this library';
        return MH_CONFIG.batchOnlyMissing !== false ? 'No albums with missing artwork found' : 'No albums found';
    }

    function applyBatchModeStyles() {
        document.querySelectorAll('.mh-missing-badge').forEach(badge => {
            const albumUrl = normalizeAlbumUrl(badge.dataset.uploadUrl || '');
            const isDone = (albumUrl && BATCH.done.has(albumUrl)) || badge.dataset.mhBatchDone === 'true';
            let state = 'idle';

            if (isDone) {
                state = 'done';
                badge.dataset.mhBatchDone = 'true';
                badge.textContent = '✓';
                badge.title = 'Uploaded · click to view on Last.fm';
            } else if (BATCH.active) {
                badge.textContent = '+';
                badge.title = 'Batch mode - click to choose artwork';
            } else {
                badge.textContent = '+';
                badge.title = 'Missing Artwork - Click to upload';
            }

            badge.dataset.mhState = state;
            const border = badge.parentElement?.querySelector('.mh-missing-border');
            if (border) border.dataset.mhState = state;
        });

        if (BATCH.active && isBatchListingPath()) {
            document.querySelectorAll('td.chartlist-image, .cover-art, .grid-items-cover-image, .resource-list--release-list-item-preview').forEach(el => {
                el.style.cursor = 'pointer';
            });
            document.querySelectorAll('td.chartlist-image img, .cover-art img, .grid-items-cover-image img, .resource-list--release-list-item-preview img').forEach(img => {
                img.style.cursor = 'pointer';
            });
        }
    }

    function applyUploadedToPage(item) {
        document.querySelectorAll('.mh-missing-badge').forEach(badge => {
            const albumUrl = normalizeAlbumUrl(badge.dataset.uploadUrl || '');
            if (albumUrl !== item.albumUrl) return;

            badge.dataset.mhBatchDone = 'true';
            const img = badge.parentElement?.querySelector('img');
            if (img && item.coverUrl) img.src = item.coverUrl;
        });
        applyBatchModeStyles();
    }

    function batchStateInfo(item) {
        if (item.status === 'uploading') return { cls: 'uploading', text: 'Uploading…' };
        if (item.status === 'searching') return { cls: 'searching', text: 'Pick artwork…' };
        if (item.status === 'error') return { cls: 'error', text: trimStatus(item.error || 'Failed') };
        if (item.status === 'skipped') return { cls: 'skipped', text: 'Skipped · click to pick artwork' };
        if (item.done || item.status === 'done') return { cls: 'done', text: 'Uploaded · click to view on Last.fm' };
        if (item.missing === false) return { cls: 'ok', text: 'Has artwork' };
        return { cls: 'idle', text: 'Missing artwork' };
    }

    function renderBatchQueue() {
        const list = $mh('#mh-batch-list');
        if (!list) return;

        const items = visibleQueue();
        const statusEl = $mh('#mh-batch-status');
        if (statusEl && statusEl.dataset.idle) showIdleStatus();

        if (!items.length) {
            list.innerHTML = `<div class="mh-empty">${emptyBatchMessage()}</div>`;
            dedupeEmptyStatus();
            return;
        }

        const shown = items.slice(0, 150);
        list.innerHTML = shown.map(item => {
            const index = BATCH.queue.indexOf(item);
            const state = batchStateInfo(item);
            const isDone = item.done || item.status === 'done';
            return `
                <div class="mh-batch-item${isDone ? ' mh-done' : (item.status === 'skipped' ? ' mh-skipped' : '')}" data-mh-batch-idx="${index}" title="${esc(item.artist)} – ${esc(item.album)}">
                    <div class="mh-thumb" data-mh-open-idx="${index}" role="link" tabindex="0" title="${isDone ? 'Uploaded · click to view on Last.fm' : 'Open upload page'}">${item.coverUrl ? `<img src="${esc(item.coverUrl)}" alt=""${item.coverUrl.indexOf('data:') === 0 ? '' : ' loading="lazy"'}>` : ''}</div>
                    <div class="mh-batch-text">
                        <div class="mh-batch-album">${esc(item.album)}</div>
                        <div class="mh-batch-artist">${esc(item.artist)}</div>
                    </div>
                    <span class="mh-state mh-state-${state.cls}" title="${esc(state.cls === 'done' ? 'Uploaded' : state.text)}"></span>
                </div>
            `;
        }).join('');

        if (items.length > shown.length) {
            list.innerHTML += `<div class="mh-empty">Showing first ${shown.length} of ${items.length}</div>`;
        }
    }

    function setBatchToggleButton() {
        const btn = $mh('#mh-batch-toggle');
        if (!btn) return;
        const running = BATCH.active || BATCH.starting;
        const waiting = BATCH.active && BATCH.openBlocked;
        const label = waiting ? 'Open Picker' : (running ? 'Stop Batch Mode' : 'Start Batch Mode');
        if (btn.textContent !== label) btn.textContent = label;
        const splitEl = btn.closest('.mh-split');
        if (splitEl) splitEl.classList.toggle('is-red', running && !waiting);
        const arrow = $mh('#mh-batch-menu-btn');
        const scanItem = $mh('#mh-batch-scan');
        [btn, arrow, scanItem].forEach(el => {
            if (!el) return;
            el.classList.toggle('mh-btn-red', running && !waiting);
            el.classList.toggle('mh-btn-green', !running || waiting);
        });
    }

    function createBatchPanel() {
        $mh('#mh-cover-panel')?.remove();

        const scope = getBatchScope();
        if (!scope) return null;

        BATCH.scope = scope;
        ensurePanelStyles();

        const panel = document.createElement('div');
        panel.id = 'mh-cover-panel';
        panel.setAttribute('data-darkreader-ignore', '');
        const startCollapsed = UI.collapsed === null
            ? (MH_CONFIG.startCollapsedBatch !== false && !BATCH.active)
            : UI.collapsed;
        UI.collapsed = startCollapsed;

        panel.className = 'mh-batch' + (startCollapsed ? ' is-collapsed' : '');
        panel.classList.toggle('mh-no-anim', MH_CONFIG.animate === false);
        panel.dataset.theme = panelTheme();
        panel.dataset.mode = 'batch';
        panel.dataset.scope = scope.key;

        const presetMenuHtml = scope.type === 'library'
            ? '<button class="mh-btn mh-menu-item mh-preset-item" data-mh-preset="LAST_7_DAYS" role="menuitem">Batch Last 7 Days Top Albums</button>'
              + '<button class="mh-btn mh-menu-item mh-preset-item" data-mh-preset="LAST_30_DAYS" role="menuitem">Batch Last 30 Days Top Albums</button>'
              + '<button class="mh-btn mh-menu-item mh-preset-item" data-mh-preset="LAST_90_DAYS" role="menuitem">Batch Last 90 Days Top Albums</button>'
              + '<button class="mh-btn mh-menu-item mh-preset-item" data-mh-preset="LAST_180_DAYS" role="menuitem">Batch Last 180 Days Top Albums</button>'
              + '<button class="mh-btn mh-menu-item mh-preset-item" data-mh-preset="LAST_365_DAYS" role="menuitem">Batch Last 365 Days Top Albums</button>'
              + '<button class="mh-btn mh-menu-item mh-preset-item" data-mh-preset="ALL" role="menuitem">Batch All Time Top Albums</button>'
            : '';

        panel.innerHTML = `
            <div class="mh-head">
                <div class="mh-title" title="${esc(scope.tooltip)}">${scope.type === 'library' ? 'Batch Mode' : 'Batch'} <span class="mh-user">· ${esc(scope.label)}</span></div>
                <div class="mh-head-actions">${buildHeaderActionsHtml()}
                </div>
            </div>
            <div class="mh-scroll">
            <div id="mh-batch-main">
            <div class="mh-batch-actions">
                <div class="mh-split${(BATCH.active || BATCH.starting) ? ' is-red' : ''}">
                    <button id="mh-batch-toggle" class="mh-btn mh-btn-grow mh-split-main ${(BATCH.active || BATCH.starting) ? 'mh-btn-red' : 'mh-btn-green'}">${(BATCH.active || BATCH.starting) ? 'Stop Batch Mode' : 'Start Batch Mode'}</button>
                    <button id="mh-batch-menu-btn" class="mh-btn mh-split-arrow ${(BATCH.active || BATCH.starting) ? 'mh-btn-red' : 'mh-btn-green'}" title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
                    <div id="mh-batch-menu" class="mh-split-menu" role="menu" hidden>
                        <button id="mh-batch-scan" class="mh-btn mh-menu-item ${(BATCH.active ||
           BATCH.starting) ? 'mh-btn-red' : 'mh-btn-green'}" role="menuitem">Scan Only (Non-Batch Mode)</button>
                        ${presetMenuHtml}
                    </div>
                </div>
                <button id="mh-batch-reset" class="mh-btn mh-btn-tinted-square mh-icon-action" title="Reset scan" aria-label="Reset scan"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg></button>
            </div>
            <div id="mh-batch-list"></div>
            </div>
            ${buildSettingsPanelHtml()}
            </div>
            <div id="mh-batch-statusbar" class="mh-statusbar">
                <div id="mh-batch-status" class="mh-batch-status"${BATCH.active ? '' : ' data-idle="1"'}>${BATCH.active ? 'Batch mode active' : ''}</div>
                <button id="mh-status-toggle" class="mh-icon-btn mh-icon-chevron mh-status-toggle" title="Show more" aria-label="Show more" aria-expanded="false"></button>
            </div>
        `;

        document.body.appendChild(panel);

        $mh('#mh-batch-toggle').addEventListener('click', toggleBatchMode);
        $mh('#mh-batch-menu-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleBatchMenu();
        });
        $mh('#mh-batch-scan').addEventListener('click', () => {
            closeBatchMenu();
            scanLibrary({ fresh: true });
        });
        $mh('#mh-batch-menu').querySelectorAll('.mh-preset-item').forEach(btn => {
            btn.addEventListener('click', async () => {
                closeBatchMenu();
                const preset = btn.dataset.mhPreset;
                const user = scope.user;
                const presetScope = getBatchScope(`/user/${encodeURIComponent(user)}/library/albums`, `?date_preset=${preset}`);
                if (!presetScope) return;
                BATCH.scope = presetScope;
                const panelEl = $mh('#mh-cover-panel');
                if (panelEl) panelEl.dataset.scope = presetScope.key;
                const titleEl = $mh('#mh-cover-panel .mh-title');
                if (titleEl) titleEl.innerHTML = `${presetScope.type === 'library' ? 'Batch Mode' : 'Batch'} <span class="mh-user">\u00b7 ${esc(presetScope.label)}</span}`;
                resetBatchContext();
                const runId = ++BATCH.runId;
                BATCH.starting = true;
                BATCH.runPicks = 0;
                BATCH.runDone.clear();
                BATCH.skipped.clear();
                BATCH.queue.forEach(item => {
                    if (item.status === 'skipped') item.status = 'idle';
                });
                BATCH.finishPending = false;
                BATCH.openBlocked = false;
                BATCH.active = true;
                BATCH.auto = true;
                if (BATCH.scanning) BATCH.scanBy = 'batch';
                applyBatchModeStyles();
                setBatchToggleButton();
                renderBatchQueue();
                tryStartAutoSearch(true);
                BATCH.starting = false;
                if (!BATCH.active) {
                    setBatchToggleButton();
                    return;
                }
                await saveBatchState();
                if (runId !== BATCH.runId || !BATCH.active) return;
                const needsScan = BATCH.scanning || BATCH.scanNext <= clampBatchPages(MH_CONFIG.batchPages || 9);
                if (needsScan) {
                    await scanLibrary({ by: 'batch' });
                }
                if (runId === BATCH.runId) settleAutoRun();
            });
        });
        $mh('#mh-batch-reset').addEventListener('click', () => {
            closeBatchMenu();
            resetBatchScan();
        });
        if (!BATCH.menuBound) {
            BATCH.menuBound = true;
            document.addEventListener('click', (e) => {
                if (!e.target.closest('.mh-split')) closeBatchMenu();
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') closeBatchMenu();
            });
        }
        $mh('#mh-save-settings').addEventListener('click', saveAndCloseSettings);
        $mh('#mh-status-toggle').addEventListener('click', toggleStatusExpanded);
        bindHeaderActions(panel);
        if (BATCH.scanning) $mh('#mh-batch-scan').disabled = true;

        ensureFab();
        if (startCollapsed) {
            const collapsedPanel = $mh('#mh-cover-panel');
            if (collapsedPanel) collapsedPanel.classList.add('is-collapsed');
            UI.collapsed = true;
            const collapsedBtn = $mh('#mh-collapse-btn');
            if (collapsedBtn) {
                collapsedBtn.setAttribute('aria-expanded', 'false');
                collapsedBtn.title = 'Expand';
                collapsedBtn.setAttribute('aria-label', 'Expand');
            }
            const collapsedFab = $mh('#mh-fab');
            if (collapsedFab) {
                collapsedFab.classList.remove('is-visible');
                collapsedFab.dataset.theme = collapsedPanel ? collapsedPanel.dataset.theme : collapsedFab.dataset.theme;
                if (MH_CONFIG.animate === false) {
                    collapsedFab.classList.add('is-visible');
                    collapsedFab.setAttribute('aria-expanded', 'false');
                } else {
                    void collapsedFab.offsetWidth;
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            collapsedFab.classList.add('is-visible');
                            collapsedFab.setAttribute('aria-expanded', 'false');
                        });
                    });
                }
            }
        }

        const batchList = $mh('#mh-batch-list');
        batchList.addEventListener('click', (e) => {
            const open = e.target.closest('[data-mh-open-idx]');
            if (open) {
                e.preventDefault();
                e.stopPropagation();
                const doneItem = BATCH.queue[parseInt(open.dataset.mhOpenIdx, 10)];
                if (doneItem) openItemPage(doneItem);
                return;
            }
            const row = e.target.closest('[data-mh-batch-idx]');
            if (!row) return;
            const item = BATCH.queue[parseInt(row.dataset.mhBatchIdx, 10)];
            if (item) startBatchSearch(item);
        });
        batchList.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const open = e.target.closest('[data-mh-open-idx]');
            if (!open) return;
            e.preventDefault();
            const doneItem = BATCH.queue[parseInt(open.dataset.mhOpenIdx, 10)];
            if (doneItem) openItemPage(doneItem);
        });

        if (BATCH.active) {
            if (isBatchListingPath()) {
                mergeBatchQueue(collectScopeAlbums(document));
                scanPageForMissingArtwork(true);
            }
            applyBatchModeStyles();
        }

        renderBatchQueue();
        syncStatusOverflow();
        return panel;
    }

    function nextAutoItem() {
        return visibleQueue().find(item => !item.done && item.status === 'idle' && item.missing !== false) || null;
    }

    function cancelBatchScan(force = false) {
        if (!force && (!BATCH.scanning || BATCH.scanBy !== 'batch')) return;
        BATCH.scanToken++;
        BATCH.scanning = false;
        BATCH.scanPromise = null;
        BATCH.scanProgress = null;
        const scanBtn = $mh('#mh-batch-scan');
        if (scanBtn) scanBtn.disabled = false;
    }

    function closeBatchMenu() {
        const menu = $mh('#mh-batch-menu');
        const btn = $mh('#mh-batch-menu-btn');
        if (menu) menu.hidden = true;
        if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    function toggleBatchMenu() {
        const menu = $mh('#mh-batch-menu');
        const btn = $mh('#mh-batch-menu-btn');
        if (!menu || !btn) return;
        const open = menu.hidden;
        menu.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    async function resetBatchScan() {
        resetBatchContext();
        BATCH.starting = false;
        BATCH.active = false;
        BATCH.skipped.clear();
        BATCH.runPicks = 0;
        setBatchToggleButton();
        renderBatchQueue();
        setBatchStatus('Scan reset');
        await saveBatchState();
    }

    function resetBatchContext() {
        cancelBatchScan(true);
        BATCH.runId++;
        BATCH.auto = false;
        BATCH.finishPending = false;
        BATCH.openBlocked = false;
        BATCH.single = false;
        if (BATCH.pending && BATCH.pending.status === 'searching') BATCH.pending.status = restingStatus(BATCH.pending);
        BATCH.pending = null;
        closeSearchWindow();
        BATCH.queue = [];
        BATCH.scanNext = 1;
        BATCH.lastScan = null;
    }

    function closeSearchWindow() {
        try {
            if (BATCH.popup && !BATCH.popup.closed) BATCH.popup.close();
        } catch (e) {}
        BATCH.popup = null;
    }

    function openSearchWindow(url) {
        const width = 1000, height = 800;
        const features = `width=${width},height=${height},left=${(screen.width - width) / 2},top=${(screen.height - height) / 2},resizable=yes,scrollbars=yes`;

        const existing = BATCH.popup;
        if (existing && !existing.closed) {
            try {
                if (url !== 'about:blank') existing.location.href = url;
                existing.focus();
                return existing;
            } catch (e) {}
        }

        const popup = window.open(url, 'CoverSearchEngine', features);
        BATCH.popup = popup || null;
        return popup;
    }

    function ensureBatchWatcher() {
        if (BATCH.watcher) return;
        let closedTicks = 0;
        BATCH.watcher = setInterval(() => {
            let open = false;
            try { open = !!BATCH.popup && !BATCH.popup.closed; } catch (e) { open = false; }
            if (open) {
                closedTicks = 0;
                return;
            }
            closedTicks++;
            if (closedTicks < 2) return;

            clearInterval(BATCH.watcher);
            BATCH.watcher = null;
            BATCH.popup = null;

            const pending = BATCH.pending;
            const interrupted = BATCH.auto || (!!pending && pending.status === 'searching');
            BATCH.auto = false;

            if (pending && pending.status === 'searching') {
                pending.status = restingStatus(pending);
                BATCH.pending = null;
            }

            if (interrupted && BATCH.active) {
                stopBatchRun('Search was closed, press Start to continue');
            }
        }, 1000);
    }

    async function stopBatchRun(message, isError = false) {
        BATCH.runId++;
        BATCH.starting = false;
        BATCH.active = false;
        BATCH.auto = false;
        BATCH.finishPending = false;
        BATCH.openBlocked = false;
        BATCH.single = false;
        if (BATCH.pending && BATCH.pending.status === 'searching') BATCH.pending.status = restingStatus(BATCH.pending);
        BATCH.pending = null;
        cancelBatchScan();
        closeSearchWindow();
        setBatchToggleButton();
        applyBatchModeStyles();
        renderBatchQueue();
        if (message) setBatchStatus(message, isError);
        await saveBatchState();
    }

    function maybeFinishBatchRun(prefix = '') {
        if (!BATCH.finishPending || !BATCH.active) return false;
        if (BATCH.auto || BATCH.pending || BATCH.scanning || uploadingItems().length) return false;

        BATCH.finishPending = false;
        const failed = BATCH.queue.filter(item => item.status === 'error').length;
        const parts = [];
        if (prefix) parts.push(trimStatus(prefix));
        parts.push('Batch finished');
        if (failed) parts.push(`${failed} upload${failed === 1 ? '' : 's'} failed, click an album to retry`);
        else if (!prefix) parts.push('all selected artwork uploaded');
        const message = parts.join(' · ');

        const popup = BATCH.popup;
        BATCH.popup = null;
        stopBatchRun(message, failed > 0);
        setTimeout(() => { try { if (popup && !popup.closed) popup.close(); } catch (e) {} }, 3000);
        return true;
    }

    function tryStartAutoSearch(viaClick = false) {
        if (!BATCH.active || !BATCH.auto || BATCH.pending || BATCH.openBlocked) return false;
        const next = nextAutoItem();
        if (!next) return false;
        startBatchSearch(next, { auto: true, viaClick });
        return !!BATCH.pending;
    }

    function openPickerFromClick() {
        if (!BATCH.active || !BATCH.openBlocked) return;
        BATCH.openBlocked = false;
        setBatchToggleButton();
        tryStartAutoSearch(true);
        if (BATCH.active && !BATCH.pending) settleAutoRun();
    }


    function settleAutoRun() {
        if (!BATCH.active || !BATCH.auto || BATCH.pending || BATCH.openBlocked) return;
        if (tryStartAutoSearch()) return;
        if (!BATCH.auto) return;
        if (BATCH.scanning) return;

        BATCH.auto = false;

        if (BATCH.runPicks === 0) {
            const scan = BATCH.lastScan;
            if (scan && scan.fetched === 0 && scan.error) {
                stopBatchRun(`Scan failed: ${scan.error}`, true);
                return;
            }
            let text = MH_CONFIG.batchOnlyMissing !== false ? 'No albums with missing artwork found' : 'No albums found';
            if (scan && scan.failed > 0) text += ` (${scan.failed} page${scan.failed === 1 ? '' : 's'} could not be read)`;
            stopBatchRun(text);
            return;
        }

        closeSearchWindow();
        const activity = activityText();
        setBatchStatus(activity || 'No more albums with missing artwork.');
        BATCH.finishPending = true;
        maybeFinishBatchRun('No more albums with missing artwork.');
    }

    async function toggleBatchMode() {
        if (BATCH.active) {
            if (BATCH.openBlocked) {
                openPickerFromClick();
                return;
            }
            await stopBatchRun('Batch mode stopped.');
            return;
        }

        const needsScan = BATCH.scanning || BATCH.scanNext <= clampBatchPages(MH_CONFIG.batchPages || 9);

        const runId = ++BATCH.runId;
        BATCH.starting = true;
        BATCH.runPicks = 0;
        BATCH.runDone.clear();
        BATCH.skipped.clear();
        BATCH.queue.forEach(item => {
            if (item.status === 'skipped') item.status = 'idle';
        });
        BATCH.finishPending = false;
        BATCH.openBlocked = false;
        BATCH.active = true;
        BATCH.auto = true;
        BATCH.scope = BATCH.scope || getBatchScope();
        if (BATCH.scanning) BATCH.scanBy = 'batch';

        if (isBatchListingPath()) {
            scanPageForMissingArtwork(true);
            mergeBatchQueue(collectScopeAlbums(document));
        }
        applyBatchModeStyles();
        setBatchToggleButton();
        renderBatchQueue();

        tryStartAutoSearch(true);
        BATCH.starting = false;
        if (!BATCH.active) {
            setBatchToggleButton();
            return;
        }

        await saveBatchState();
        if (runId !== BATCH.runId || !BATCH.active) return;

        if (needsScan) {
            await scanLibrary({ by: 'batch' });
        }
        if (runId === BATCH.runId) settleAutoRun();
    }

    function scanLibrary(opts = {}) {
        if (!BATCH.scope) return Promise.resolve();
        if (BATCH.scanning) return BATCH.scanPromise || Promise.resolve();
        BATCH.scanPromise = runLibraryScan(BATCH.scope, opts);
        return BATCH.scanPromise;
    }

    async function runLibraryScan(scope, opts = {}) {
        if (opts.fresh) BATCH.scanNext = 1;

        const maxPages = clampBatchPages(MH_CONFIG.batchPages || 9);
        if (BATCH.scanNext > maxPages) return;
        let pages = maxPages;
        let totalPages = 0;

        BATCH.scanning = true;
        BATCH.scanBy = opts.by || (BATCH.active ? 'batch' : 'manual');
        const token = ++BATCH.scanToken;
        const scanBtn = $mh('#mh-batch-scan');
        if (scanBtn) scanBtn.disabled = true;
        renderBatchQueue();

        let fetched = 0;
        let failed = 0;
        let consecutiveFailures = 0;
        let firstError = null;
        let lastError = null;
        let stopped = false;
        let resumeAt = null;
        let ended = false;
        let rateLimited = false;

        const aborter = new AbortController();
        const fetchPage = async (page) => {
            const res = await fetch(scope.pageUrl(page), {
                credentials: 'same-origin',
                signal: aborter.signal
            });

            if (res.status === 429) {
                throw makeRateLimitError(parseInt(res.headers.get('retry-after'), 10) || 0);
            }
            if (res.status === 404 && page > 1) return null;
            if (!res.ok) {
                let body = '';
                try { body = await res.text(); } catch (e) {}
                if (isRateLimitedResponse(body, res.status)) throw makeRateLimitError();
                throw new Error(`HTTP ${res.status}`);
            }

            const html = await res.text();
            if (isRateLimitedResponse(html, res.status)) throw makeRateLimitError();
            if (isDbErrorResponse(html)) {
                const dbErr = new Error('Last.fm database error: "There was a problem loading your top albums"');
                dbErr.dbError = true;
                throw dbErr;
            }
            if (isBlockedResponse(html)) {
                throw new Error('Last.fm is temporarily blocking requests (anti-bot page)');
            }

            return new DOMParser().parseFromString(html, 'text/html');
        };

        const lookahead = new Map();
        const requestPage = (page) => {
            if (!lookahead.has(page)) {
                const request = fetchPage(page);
                request.catch(() => {});
                lookahead.set(page, request);
            }
        };

        try {
            for (let page = BATCH.scanNext; page <= pages; page++) {
                if (BATCH.scanToken !== token) return;
                BATCH.scanProgress = { page, pages: totalPages ? pages : null };
                updateScanStatus();

                try {
                    let pageDoc;
                    let rateWaits = 0;
                    let attempt = 0;
                    let dbRetries = 0;
                    while (true) {
                        try {
                            const early = lookahead.get(page);
                            lookahead.delete(page);
                            pageDoc = await (early || fetchPage(page));
                            break;
                        } catch (attemptError) {
                            if (BATCH.scanToken !== token) return;
                            if (attemptError && attemptError.rateLimited) {
                                lookahead.clear();
                                if (rateWaits >= RATE_LIMIT_MAX_WAITS) throw attemptError;
                                rateWaits++;
                                const waitS = Math.max(RATE_LIMIT_COOLDOWN_S, attemptError.retryAfter || 0);
                                console.warn(`[MH] Rate limited on page ${page}, waiting ${waitS}s (${rateWaits}/${RATE_LIMIT_MAX_WAITS})`);
                                for (let left = waitS; left > 0; left--) {
                                    if (BATCH.scanToken !== token) return;
                                    setBatchStatus(`Rate limited at page ${page} \u00b7 resuming in ${left}s (${rateWaits}/${RATE_LIMIT_MAX_WAITS})`, true);
                                    await sleep(1000);
                                }
                                continue;
                            }
                            if (attemptError && attemptError.dbError) {
                                if (dbRetries >= DB_ERROR_MAX_RETRIES) throw attemptError;
                                dbRetries++;
                                console.warn(`[MH] Last.fm database error on page ${page}, retrying (${dbRetries}/${DB_ERROR_MAX_RETRIES})`);
                                setBatchStatus(`Last.fm database error at page ${page} \u00b7 retrying (${dbRetries}/${DB_ERROR_MAX_RETRIES})`, true);
                                continue;
                            }
                            if (attempt++ >= 1) throw attemptError;
                            await sleep(1500);
                        }
                    }

                    if (BATCH.scanToken !== token) return;
                    if (pageDoc === null) {
                        ended = true;
                        break;
                    }
                    const lastPage = detectLastPage(pageDoc);
                    if (lastPage) totalPages = lastPage;
                    else if (page === 1) totalPages = 1;
                    if (totalPages) {
                        pages = Math.min(maxPages, totalPages);
                        BATCH.scanProgress = { page, pages };
                        updateScanStatus();
                        for (let ahead = page + 1; ahead <= Math.min(pages, page + 3); ahead++) requestPage(ahead);
                    }
                    const pageAlbums = collectScopeAlbums(pageDoc);
                    const added = mergeBatchQueue(pageAlbums);

                    BATCH.scanNext = resumeAt !== null ? resumeAt : page + 1;
                    fetched++;
                    consecutiveFailures = 0;
                    if (totalPages && page >= totalPages) ended = true;
                    const pastEnd = scope.type === 'library' ? pageAlbums.length === 0 : (page > 1 && added === 0);
                    if (pastEnd) {
                        ended = true;
                        break;
                    }
                } catch (e) {
                    failed++;
                    consecutiveFailures++;
                    lastError = e.message || String(e);
                    if (!firstError) firstError = lastError;
                    if (resumeAt === null) resumeAt = page;
                    console.warn('[MH] Batch scan failed for page', page, e);
                    if (e && e.rateLimited) {
                        rateLimited = true;
                        stopped = true;
                        break;
                    }
                    if (consecutiveFailures >= 3) {
                        stopped = true;
                        break;
                    }
                }

                renderBatchQueue();
                tryStartAutoSearch();
                if (!lookahead.has(page + 1)) await sleep(350);
            }

            if (BATCH.scanToken !== token) return;

            if (resumeAt !== null) BATCH.scanNext = resumeAt;
            else if (ended) BATCH.scanNext = maxPages + 1;
            BATCH.lastScan = { fetched, failed, stopped, error: firstError };

            const missing = visibleQueue().length;
            const albumText = `${missing} album${missing === 1 ? '' : 's'}`;

            let text;
            let isError = false;
            if (rateLimited) {
                text = `Rate limited by Last.fm at page ${resumeAt || BATCH.scanNext} \u00b7 scanned ${fetched} page${fetched === 1 ? '' : 's'}${missing ? ` \u00b7 ${albumText} found` : ''} \u00b7 wait a few minutes, then scan again to resume`;
                isError = true;
            } else if (fetched === 0) {
                text = `Scan failed: ${firstError || 'no library pages could be read'}`;
                isError = true;
            } else if (stopped && failed > 0) {
                text = `Scanned ${fetched} page${fetched === 1 ? '' : 's'}${missing ? ` \u00b7 ${albumText} found` : ''} \u00b7 scan stopped: ${lastError}`;
                isError = true;
            } else if (failed > 0) {
                text = `Scanned ${fetched}/${pages} pages${missing ? ` \u00b7 ${albumText} to review` : ''} (${failed} skipped)`;
            } else {
                text = `Scanned ${fetched} page${fetched === 1 ? '' : 's'}${missing ? ` \u00b7 ${albumText} to review` : ''}`;
            }

            if (BATCH.pending && !isError) {
                setBatchStatus(`Pick artwork for “${BATCH.pending.album}”… \u00b7 ${albumText} to review.`);
            } else if (BATCH.openBlocked && !isError) {
                setBatchStatus(`${albumText} to review, click Open Picker to start choosing artwork`);
            } else {
                setBatchStatus(text, isError);
            }
        } finally {
            try { aborter.abort(); } catch (e) {}
            if (BATCH.scanToken === token) {
                BATCH.scanning = false;
                BATCH.scanProgress = null;
                const btn = $mh('#mh-batch-scan');
                if (btn) btn.disabled = false;
                renderBatchQueue();
                settleAutoRun();
            }
        }
    }

    function startCoverOnlySearch(badge) {
        const albumUrl = normalizeAlbumUrl(badge.dataset.uploadUrl || '');
        if (!albumUrl) return false;
        const img = badge.parentElement?.querySelector('img');
        const item = ensureBatchItem(albumUrl, { coverUrl: img ? img.src : '' });
        BATCH.auto = false;
        startBatchSearch(item, { single: true });
        return true;
    }

    function startBatchSearch(item, opts = {}) {
        if (!item) return;
        if (item.status === 'uploading') return;

        if (!opts.auto) BATCH.auto = false;

        const previous = BATCH.pending;
        if (previous && previous !== item && previous.status === 'searching') {
            previous.status = restingStatus(previous);
        }

        BATCH.pending = item;
        BATCH.single = !!opts.single;
        item.status = 'searching';
        item.error = null;
        renderBatchQueue();
        setBatchStatus(`Pick artwork for “${item.album}”…${scanSuffix()}`);

        const url = buildMhUrl({ artist: item.artist, album: item.album }, {
            remoteText: `Pick an artwork for ${item.artist} - ${item.album}`
        });

        const popup = openSearchWindow(url);

        if (!popup) {
            BATCH.pending = null;
            BATCH.single = false;

            if (opts.auto && !opts.viaClick) {
                item.status = restingStatus(item);
                item.error = null;
                BATCH.openBlocked = true;
                setBatchToggleButton();
                setBatchStatus(`Found “${item.album}”, click Open Picker to start choosing artwork`);
                renderBatchQueue();
                return;
            }

            if (opts.auto) {
                item.status = restingStatus(item);
                item.error = null;
                stopBatchRun('Popup blocked, allow popups for Last.fm and press Start again', true);
                return;
            }

            item.status = 'error';
            item.error = 'Popup blocked';
            BATCH.auto = false;
            setBatchStatus('Popup blocked, allow popups for Last.fm and try again', true);
            renderBatchQueue();
            return;
        }

        ensureBatchWatcher();
        pushPickerMode(popup);
    }

    function detectLastPage(doc) {
        let last = 0;
        doc.querySelectorAll('.pagination a[href], nav[class*="pagination"] a[href], [class*="pagination-list"] a[href], [class*="pagination-page"] a[href]').forEach(a => {
            const m = /[?&]page=(\d+)/i.exec(a.getAttribute('href') || '');
            if (m) last = Math.max(last, parseInt(m[1], 10));
        });
        if (!last) {
            doc.querySelectorAll('[class*="pagination-page"]').forEach(el => {
                const n = parseInt((el.textContent || '').trim(), 10);
                if (n > last) last = n;
            });
        }
        return last;
    }

    const DB_ERROR_MAX_RETRIES = 3;
    const RATE_LIMIT_COOLDOWN_S = 10;
    const RATE_LIMIT_MAX_WAITS = 6;

    function isRateLimitedResponse(html, status) {
        if (status === 429) return true;
        return /requesting too many pages|requesting a lot of pages|enjoy a cup of tea|too many requests/i.test(html || '');
    }

    function isDbErrorResponse(html) {
        return /there was a problem loading your/i.test(html || '');
    }

    function makeRateLimitError(retryAfterS) {
        const err = new Error('Last.fm rate limit: "You\u2019re requesting too many pages"');
        err.rateLimited = true;
        err.retryAfter = retryAfterS || 0;
        return err;
    }

    function isBlockedResponse(html) {
        const head = (html || '').slice(0, 4000);
        return /<title>\s*(Client Challenge|Last\.fm - Temporarily Unavailable|Just a moment\.\.\.|Attention Required)/i.test(head) ||
               /client challenge|temporarily unavailable|cf-browser-verification|cf-challenge|challenge-platform/i.test(head);
    }

    const pageFetch = (typeof content !== 'undefined' && content && typeof content.fetch === 'function')
        ? content.fetch.bind(content)
        : fetch;

    function uploadViaHiddenForm(uploadUrl, file, meta = {}) {
        return new Promise((resolve) => {
            const iframe = document.createElement('iframe');
            iframe.setAttribute('aria-hidden', 'true');
            iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
            let stage = 'load';
            let finished = false;
            const timer = setTimeout(() => finish({ success: false, error: 'Timed out waiting for Last.fm to answer the upload' }), 60000);

            function finish(result) {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                setTimeout(() => { try { iframe.remove(); } catch (e) {} }, 500);
                resolve(result);
            }

            iframe.addEventListener('load', () => {
                try {
                    const win = iframe.contentWindow;
                    const href = win.location.href;
                    if (!href || href === 'about:blank') return;
                    const doc = iframe.contentDocument;

                    if (stage === 'load') {
                        const fileInput = doc.querySelector('input#id_image[type="file"][name="image"]') ||
                                          doc.querySelector('input[type="file"][name="image"]');
                        const form = fileInput && fileInput.closest('form');
                        if (!form) return finish({ success: false, error: 'Upload form not found (are you signed in to Last.fm?)' });

                        const titleField = form.querySelector('[name="title"]');
                        const descField = form.querySelector('[name="description"]');
                        if (titleField && meta.title != null) titleField.value = meta.title;
                        if (descField && meta.description != null) descField.value = meta.description;

                        const dt = new DataTransfer();
                        dt.items.add(file);
                        fileInput.files = dt.files;
                        if (!fileInput.files || !fileInput.files.length) {
                            return finish({ success: false, error: 'Could not attach the image to the upload form' });
                        }

                        stage = 'submit';
                        win.HTMLFormElement.prototype.submit.call(form);
                        return;
                    }

                    if (/\/\+images\/[0-9a-f]{32}/i.test(href)) return finish({ success: true, url: href });
                    const title = (doc.title || '').trim();
                    const errs = Array.from(doc.querySelectorAll('.errorlist li, .errorlist, .alert-danger, [role="alert"]'))
                        .map(el => el.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean);
                    console.warn('[MH] Hidden-form upload response:', { url: href, title, errs });
                    finish({ success: false, error: errs.length ? errs.join(' ') : `Last.fm rejected the upload (\u201c${title}\u201d)` });
                } catch (e) {
                    finish({ success: false, error: `Hidden-form upload failed (${e.message})` });
                }
            });

            iframe.src = uploadUrl;
            document.body.appendChild(iframe);
        });
    }

    async function uploadArtworkToLastFm(albumUrl, file, meta = {}, attempt = 0) {
        const startAt = Math.max(Date.now(), nextUploadAt);
        nextUploadAt = startAt + UPLOAD_STAGGER_MS;
        const wait = startAt - Date.now();
        if (wait > 0) await sleep(wait);

        const uploadUrl = albumUrl.replace(/\/+$/, '') + '/+images/upload';

        const retryLater = async (message) => {
            if (attempt >= 1) return { success: false, error: message };
            console.warn('[MH] Retrying upload in a moment:', message);
            await sleep(3500);
            return uploadArtworkToLastFm(albumUrl, file, meta, attempt + 1);
        };

        let pageRes;
        try {
            pageRes = await pageFetch(uploadUrl, { credentials: 'same-origin' });
        } catch (e) {
            return retryLater(`Could not open the upload page (${e.message})`);
        }

        if (!pageRes.ok) return { success: false, error: `Upload page HTTP ${pageRes.status}` };
        if (/\/login(\?|$)/i.test(pageRes.url)) return { success: false, error: 'You are not signed in to Last.fm' };

        const html = await pageRes.text();
        if (isBlockedResponse(html)) {
            return retryLater('Last.fm is temporarily blocking requests (anti-bot page), wait a minute and try again');
        }

        const doc = new DOMParser().parseFromString(html, 'text/html');

        const fileInput = doc.querySelector('input#id_image[type="file"][name="image"]') ||
                          doc.querySelector('input[type="file"][name="image"]');
        const form = fileInput?.closest('form');
        if (!form) return { success: false, error: 'Upload form not found (are you signed in to Last.fm?)' };

        const formData = new FormData();
        const appended = new Set();

        const appendField = (name, value) => {
            formData.append(name, value);
            appended.add(name);
        };

        form.querySelectorAll('input[name], textarea[name], select[name]').forEach(field => {
            const name = field.getAttribute('name');
            if (!name) return;
            if (field.tagName === 'INPUT' && field.type === 'file') return;
            if ((field.type === 'checkbox' || field.type === 'radio') && !field.checked) return;

            if (name === 'title' && meta.title != null) {
                appendField(name, meta.title);
            } else if (name === 'description' && meta.description != null) {
                appendField(name, meta.description);
            } else if (field.tagName === 'SELECT') {
                const option = field.options[field.selectedIndex];
                appendField(name, option ? option.value : '');
            } else {
                appendField(name, field.value);
            }
        });

        if (!appended.has('title') && meta.title != null) appendField('title', meta.title);
        if (!appended.has('description') && meta.description != null) appendField('description', meta.description);

        formData.append(fileInput.getAttribute('name') || 'image', file, file.name);

        const action = new URL(form.getAttribute('action') || uploadUrl, uploadUrl).href;

        let postRes;
        try {
            postRes = await pageFetch(action, {
                method: 'POST',
                body: formData,
                credentials: 'same-origin',
                redirect: 'follow'
            });
        } catch (e) {
            return retryLater(`Upload request failed (${e.message})`);
        }

        const postHtml = await postRes.text();
        if (isBlockedResponse(postHtml)) {
            return retryLater('Last.fm blocked the upload (anti-bot page), wait a minute and try again');
        }
        if (/\/login(\?|$)/i.test(postRes.url)) return { success: false, error: 'You are not signed in to Last.fm' };

        const postDoc = new DOMParser().parseFromString(postHtml, 'text/html');

        const errors = Array.from(postDoc.querySelectorAll('.errorlist li, .errorlist, .alert-danger, [role="alert"]'))
            .map(el => el.textContent.trim().replace(/\s+/g, ' '))
            .filter(Boolean)
            .filter((text, index, list) => list.indexOf(text) === index);

        console.warn('[MH] Upload response:', { status: postRes.status, redirected: postRes.redirected, url: postRes.url, title: postDoc.title, errors });

        if (postRes.redirected && /\/\+images\/[0-9a-f]{32}/i.test(postRes.url)) {
            return { success: true, url: postRes.url };
        }

        if (errors.length) return { success: false, error: errors.join(' ') };
        if (!postDoc.querySelector('input#id_image') && !/\/\+images\/upload/i.test(postRes.url)) {
            return { success: true, url: postRes.url };
        }

        const pageTitle = postDoc.title ? ` — \u201c${postDoc.title.trim()}\u201d` : '';
        console.warn('[MH] Upload response body:', postHtml.slice(0, 600));
        if (!errors.length && /error/i.test(postDoc.title || '')) {
            console.warn('[MH] Direct upload was rejected; retrying through a hidden native form');
            return uploadViaHiddenForm(uploadUrl, file, meta);
        }
        const retryable = postRes.status >= 500;
        if (retryable && attempt < 1) {
            return retryLater('Last.fm returned an error page, retrying once');
        }
        const bodySnippet = postDoc.body ? (postDoc.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
        return { success: false, error: `Last.fm did not confirm the upload (HTTP ${postRes.status}${pageTitle})${bodySnippet ? ' · ' + trimStatus(bodySnippet) : ''}, try again or choose a different image` };
    }

    function claimBatchSelection() {
        const item = BATCH.pending;
        if (!item || item.status !== 'searching') return null;

        item.status = 'uploading';
        item.error = null;
        BATCH.pending = null;

        BATCH.runPicks++;
        if (BATCH.skipped.delete(item.albumUrl)) saveBatchState();

        const { next, waiting, ranOut } = advanceAutoRun();
        if (ranOut) BATCH.finishPending = true;
        return { item, next, waiting };
    }

    function advanceAutoRun() {
        let next = null;
        let waiting = false;
        let ranOut = false;
        if (BATCH.auto && BATCH.active) {
            next = nextAutoItem();
            if (next) {
                next.status = 'searching';
                next.error = null;
                BATCH.pending = next;
            } else if (BATCH.scanning) {
                waiting = true;
            } else {
                BATCH.auto = false;
                ranOut = true;
            }
        }
        return { next, waiting, ranOut };
    }

    function handleBatchSkip(event) {
        const item = BATCH.pending;
        if (!item || item.status !== 'searching') {
            ackSelection(event, { keepOpen: false });
            return;
        }

        item.status = 'skipped';
        item.error = null;
        BATCH.skipped.add(item.albumUrl);
        BATCH.pending = null;
        BATCH.runPicks++;

        const { next, waiting, ranOut } = advanceAutoRun();
        ackSelection(event, {
            keepOpen: !!next || waiting,
            waiting,
            nextUrl: next ? buildMhUrl({ artist: next.artist, album: next.album }, {
                remoteText: `Pick an artwork for ${next.artist} - ${next.album}`
            }) : null
        });

        renderBatchQueue();
        saveBatchState();
        const activity = activityText();
        setBatchStatus(`Skipped “${item.album}”${activity ? ' · ' + activity : '.'}${waiting ? scanSuffix() : ''}`);
        if (ranOut) {
            BATCH.finishPending = true;
            maybeFinishBatchRun(`Skipped “${item.album}”.`);
        }
    }

    function pickerModeNow() {
        return !!(BATCH.pending && BATCH.pending.status === 'searching') && !BATCH.single;
    }

    function pushPickerMode(win) {
        if (!win) return;
        try {
            if (win.location && win.location.origin && win.location.origin !== 'https://covers.musichoarders.xyz') return;
        } catch (e) {}
        [500, 1200, 2400, 4000, 6000].forEach(delay => setTimeout(() => {
            try {
                if (win.closed) return;
                win.postMessage({ type: 'LASTFM_PICKER_MODE', batch: pickerModeNow() }, 'https://covers.musichoarders.xyz');
            } catch (e) {}
        }, delay));
    }

    function replyPickerMode(event) {
        try {
            if (!event.source) return;
            const searching = pickerModeNow();
            event.source.postMessage({ type: 'LASTFM_PICKER_MODE', batch: searching }, event.origin);
        } catch (e) {}
    }

    function ackSelection(event, payload) {
        try {
            if (event.source) {
                event.source.postMessage(Object.assign({ type: 'LASTFM_ARTWORK_ACK' }, payload), event.origin);
                if (payload && payload.nextUrl) pushPickerMode(event.source);
            }
        } catch (e) {
            console.warn('[MH] Could not acknowledge selection:', e);
        }
    }

    async function acquireUploadSlot() {
        if (activeUploads < BATCH_MAX_PARALLEL_UPLOADS) {
            activeUploads++;
            return;
        }
        await new Promise(resolve => uploadWaiters.push(resolve));
    }

    function releaseUploadSlot() {
        const next = uploadWaiters.shift();
        if (next) next();
        else activeUploads = Math.max(0, activeUploads - 1);
    }

    function queueBatchUpload(item, data) {
        return uploadBatchItem(item, data);
    }

    async function makeThumbDataUrl(file, max = 256) {
        try {
            const bitmap = await createImageBitmap(file);
            const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            if (bitmap.close) bitmap.close();
            return canvas.toDataURL('image/jpeg', 0.85);
        } catch (e) {
            return '';
        }
    }

    async function uploadBatchItem(item, data) {
        await acquireUploadSlot();
        try {
            const { file } = await resolveSelectionFile(data);

            const result = await uploadArtworkToLastFm(item.albumUrl, file, {
                title: `${item.artist} - ${item.album}`,
                description: `Artwork of "${item.album}" by ${item.artist}`
            });

            if (!result.success) throw new Error(result.error || 'Upload failed');

            const thumb = await makeThumbDataUrl(file);
            item.done = true;
            item.missing = false;
            item.status = 'done';
            item.coverUrl = thumb || data.url || URL.createObjectURL(file) || item.coverUrl;
            BATCH.done.add(item.albumUrl);
            BATCH.runDone.add(item.albumUrl);
            BATCH.uploaded[item.albumUrl] = data.url || 'local-file';
            if (result.url && /\/\+images\/[0-9a-f]{32}/i.test(result.url)) {
                BATCH.pages[item.albumUrl] = result.url;
            }
            BATCH.stats.uploaded = (BATCH.stats.uploaded || 0) + 1;

            await saveBatchState();
            applyUploadedToPage(item);
            setBatchStatus(activityText() || `Uploaded “${item.album}”.`);
        } catch (e) {
            console.error('[MH] Batch upload failed:', e);
            item.status = 'error';
            item.error = e.message;
            BATCH.stats.failed = (BATCH.stats.failed || 0) + 1;
            await saveBatchState();
            setBatchStatus(`Upload failed for “${item.album}”: ${e.message}`, true);
        } finally {
            releaseUploadSlot();
        }
        renderBatchQueue();
        maybeFinishBatchRun();
    }

    window.addEventListener('message', async (event) => {
        if (event.origin !== 'https://covers.musichoarders.xyz') return;
        if (event.data?.type === 'LASTFM_PICKER_READY') { replyPickerMode(event); return; }
        if (event.data?.type === 'LASTFM_ARTWORK_SKIP') { handleBatchSkip(event); return; }
        if ((event.data?.type === 'LASTFM_ARTWORK_SELECTED' && event.data.url) || (event.data?.type === 'LASTFM_ARTWORK_FILE' && event.data.buffer)) {
            const selectionKey = event.data.url || `file:${event.data.name}:${event.data.size}`;
            const nowTs = Date.now();
            if (selectionKey === lastSelectionUrl && nowTs - lastSelectionAt < 3000) {
                console.warn('[MH] Ignoring duplicate artwork selection');
                return;
            }
            lastSelectionUrl = selectionKey;
            lastSelectionAt = nowTs;

            const claim = BATCH.pending ? claimBatchSelection() : null;
        if (claim) {
            const next = claim.next;
            ackSelection(event, {
                keepOpen: !!next || claim.waiting,
                waiting: claim.waiting,
                nextUrl: next ? buildMhUrl({ artist: next.artist, album: next.album }, {
                    remoteText: `Pick an artwork for ${next.artist} - ${next.album}`
                }) : null
            });
            renderBatchQueue();
            setBatchStatus((activityText() || `Uploading “${claim.item.album}”…`) + (claim.waiting ? scanSuffix() : ''));
            await queueBatchUpload(claim.item, event.data);
            return;
        }

        if (BATCH.pending) {
            ackSelection(event, { keepOpen: false });
            return;
        }

        ackSelection(event, { keepOpen: false });

            const statusEl = $mh('#mh-status');
            try {
                const fileInput = await findLastFmFileInput();
                if (!fileInput) {
                    const errMsg = 'Upload input not found, open the upload dialog first';
                    if (statusEl) statusEl.textContent = trimStatus(errMsg);
                    return;
                }

                if (statusEl) statusEl.textContent = 'Artwork selected, processing…';

                const { file } = await resolveSelectionFile(event.data);

                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(file);
                fileInput.files = dataTransfer.files;
                fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                fileInput.dispatchEvent(new Event('input', { bubbles: true }));
                await fillLastFmMetadata();

                if (statusEl) statusEl.textContent = '✓ Artwork set, you can now upload';
            } catch (e) {
                console.error('Failed to set artwork:', e);
                if (statusEl) statusEl.textContent = trimStatus(`Error: ${e.message}`);
            }
        }
    });

    async function fillLastFmMetadata() {
        try {
            await sleep(500);
            const pageInfo = extractArtistAlbum();
            if (!pageInfo) return;

            const titleInput = $mh('input#id_title[name="title"], input[name="title"]');
            const descInput = $mh('textarea#id_description[name="description"], textarea[name="description"]');

            if (titleInput) {
                const titleValue = pageInfo.album ? `${pageInfo.artist} - ${pageInfo.album}` : pageInfo.artist;
                titleInput.value = titleValue;
                titleInput.dispatchEvent(new Event('input', { bubbles: true }));
                titleInput.dispatchEvent(new Event('change', { bubbles: true }));
            }

            if (descInput) {
                const descValue = pageInfo.album ? `Artwork of "${pageInfo.album}" by ${pageInfo.artist}` : `Artwork of ${pageInfo.artist}`;
                descInput.value = descValue;
                descInput.dispatchEvent(new Event('input', { bubbles: true }));
                descInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (e) {
            console.warn('Error filling metadata:', e);
        }
    }

    async function findLastFmFileInput(timeout = 10000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const fileInput = $mh('input#id_image[type="file"][name="image"]');
            if (fileInput?.offsetParent !== null) return fileInput;
            await sleep(500);
        }
        return null;
    }

    function getExtensionFromUrl(url) {
        try {
            const parts = url.split('?')[0].split('.');
            if (parts.length > 1) {
                const ext = parts[parts.length - 1].toLowerCase();
                if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'svg'].includes(ext)) return ext;
            }
        } catch {}
        return null;
    }

    function getExtensionFromMime(mime) {
        const map = {
            'image/jpeg': 'jpg',
            'image/jpg': 'jpg',
            'image/png': 'png',
            'image/gif': 'gif',
            'image/webp': 'webp',
            'image/bmp': 'bmp',
            'image/tiff': 'tiff',
            'image/svg+xml': 'svg'
        };
        return map[mime.toLowerCase()] || null;
    }
    async function prepareLocalFile(data) {
        if (!data.buffer || !data.buffer.byteLength) throw new Error('The selected file is empty.');
        if (data.buffer.byteLength > 80 * 1024 * 1024) throw new Error('The selected file is too large.');
        const blob = new Blob([data.buffer], { type: data.mime || 'application/octet-stream' });
        return processImageBlob(blob, data.name || '', { local: true, source: data.source || 'Local file' });
    }

    async function resolveSelectionFile(data) {
        if (data.buffer) return prepareLocalFile(data);
        return downloadImageAsFile(data.url, data.source);
    }

    function upgradeItunesArtworkUrl(url) {
        if (!url || url.indexOf('mzstatic.com') === -1) return url;
        const qIdx = url.indexOf('?');
        const base = qIdx === -1 ? url : url.slice(0, qIdx);
        const qs = qIdx === -1 ? '' : url.slice(qIdx);

        let path = base.replace(/^https?:\/\/[^/]+\//i, '');
        path = path.replace(/^r\d+\//i, '');
        path = path.replace(/^image\/thumb\//i, '');

        path = path.replace(/\/\d+x\d+[a-z0-9-]*\.[a-zA-Z]+$/i, '');
        path = path.replace(/\.[a-zA-Z]+$/, (m) => m);
        const full = 'https://is1-ssl.mzstatic.com/image/thumb/' + path + '/10000x0w-999.png';
        return full + qs;
    }

    async function downloadImageAsFile(url, source = 'Unknown Source') {
        const candidates = [];
        const upgraded = upgradeItunesArtworkUrl(url);
        if (upgraded && upgraded !== url) candidates.push(upgraded);
        candidates.push(url);

        let lastError = null;
        for (const cand of candidates) {
            try {
                const fetchBlob = () => {
                    if (typeof GM_xmlhttpRequest === 'function') {
                        return new Promise((resolve, reject) => {
                            GM_xmlhttpRequest({
                                method: 'GET',
                                url: cand,
                                responseType: 'arraybuffer',
                                onload: (res) => {
                                    const hdrs = res.responseHeaders || '';
                                    const m = hdrs.match(/content-type:\s*([^\r\n;]+)/i);
                                    const mime = m?.[1] || 'image/jpeg';
                                    resolve(new Blob([res.response], { type: mime }));
                                },
                                onerror: (err) => reject(new Error(`Failed to download: ${err.status || 'network error'}`)),
                                ontimeout: () => reject(new Error('Download timed out'))
                            });
                        });
                    } else {
                        return fetch(cand, { credentials: 'omit' })
                            .then(r => r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`)));
                    }
                };
                const blob = await fetchBlob();
                return await processImageBlob(blob, cand, { source });
            } catch (e) {
                lastError = e;
            }
        }
        throw lastError || new Error('Download failed');
    }

    async function processImageBlob(originalBlob, nameHint = '', opts = {}) {
        let wasModified = false;
        const url = nameHint;
        const detectImageType = async (blob) => {
            if (!blob || blob.size < 12) return null;
            const buf = await blob.slice(0, 12).arrayBuffer();
            const b = new Uint8Array(buf);
            if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
            if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
            if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
            if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
            if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
            if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0x00) || (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00 && b[3] === 0x2A)) return 'image/tiff';
            if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
                const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
                if (brand === 'avif' || brand === 'avis') return 'image/avif';
                if (brand === 'heic' || brand === 'heix') return 'image/heic';
            }
            return null;
        };

        const sniffedType = await detectImageType(originalBlob);
    if (!sniffedType) {
        throw new Error(opts.local ? 'That file is not a valid image (got ' + (originalBlob.type || 'unknown type') + ').' : 'The downloaded file is not a valid image (got ' + (originalBlob.type || 'unknown type') + '). The source may be blocking downloads; try another artwork.');
    }
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
        if (sniffedType && !allowedTypes.includes(sniffedType)) {
            try {
                const converted = await compressImage(originalBlob, 5, false, 'image/jpeg');
                originalBlob = converted.blob;
                wasModified = converted.wasModified || true;
            } catch (e) {
                console.warn('[MH] Could not convert image to JPEG:', e);
            }
        } else if (sniffedType && originalBlob.type !== sniffedType) {
            originalBlob = new Blob([originalBlob], { type: sniffedType });
        }

        let processedBlob = originalBlob;
        const originalSizeMB = originalBlob.size / (1024 * 1024);

        try {
            if (MH_CONFIG.compressImages && originalSizeMB > 5) {
                const result = await compressImage(originalBlob, 5, true, 'image/jpeg');
                processedBlob = result.blob;
                wasModified = result.wasModified;
            } else if (!MH_CONFIG.compressImages && (processedBlob.type !== 'image/jpeg' || originalSizeMB > 5)) {
                const result = await compressImage(processedBlob, 5, false, 'image/jpeg');
                processedBlob = result.blob;
                wasModified = result.wasModified;
            }
        } catch (e) {
            console.error('[MH] Image processing failed:', e);
            processedBlob = originalBlob;
            wasModified = false;
        }

        const dimensions = await getImageDimensions(processedBlob);
        const mime = processedBlob.type || 'image/jpeg';
        const ext = getExtensionFromUrl(url) || getExtensionFromMime(mime) || 'jpg';

        const fileSizeMB = Math.max(0.1, parseFloat((processedBlob.size / (1024 * 1024)).toFixed(1)));
        const sourceName = opts.source || 'Unknown Source';

        const fileName = `${sourceName}, ${dimensions.width}x${dimensions.height}, ${fileSizeMB}MB${wasModified ? ' (Compressed)' : ''}.${ext}`;

        try {
            return { file: new File([processedBlob], fileName, { type: mime }), wasModified };
        } catch {
            processedBlob.name = fileName;
            processedBlob.type = mime;
            return { file: processedBlob, wasModified };
        }
    }

    (async () => {
        await loadConfig();
        await loadBatchState();
        ensurePanelStyles();

        try {
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            const onScheme = () => { if (MH_CONFIG.theme === 'auto') applyPanelTheme(); };
            if (mq.addEventListener) mq.addEventListener('change', onScheme);
            else if (mq.addListener) mq.addListener(onScheme);
        } catch (e) {}

        function shouldScanForMissing() {
            return MH_CONFIG.showMissingIndicators || BATCH.active;
        }

        function checkAndCreatePanel() {
            const mode = getPageMode();
            const panel = $mh('#mh-cover-panel');

            if (!mode) {
                if (panel) {
                    panel.remove();
                    $mh('#mh-fab')?.remove();
                }
                return;
            }

            if (!panel) {
                setTimeout(() => {
                    if (getPageMode() === mode && !$mh('#mh-cover-panel')) createPagePanel();
                }, 500);
                return;
            }

            const pageScope = getBatchScope();
            const scopeChanged = mode === 'batch' && !!pageScope && panel.dataset.scope !== pageScope.key;

            if (panel.dataset.mode !== mode || scopeChanged) {
                const wasBusy = BATCH.auto || BATCH.scanning || !!BATCH.pending;
                if (scopeChanged) resetBatchContext();
                if (scopeChanged && wasBusy && BATCH.active) stopBatchRun();
                refreshPagePanel();
                if (scopeChanged && BATCH.active && BATCH.scope) scanLibrary({ by: 'batch' });
            }
        }

        checkAndCreatePanel();

        document.addEventListener('click', (e) => {
            const badge = e.target.closest('.mh-missing-badge');

            if (badge && badge.dataset.mhState === 'done') {
                const doneAlbumUrl = normalizeAlbumUrl(badge.dataset.uploadUrl || '');
                if (doneAlbumUrl) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    openUploadedPage(doneAlbumUrl);
                    return;
                }
            }

            if (BATCH.active && isBatchListingPath()) {
                const cover = e.target.closest('.mh-missing-badge, td.chartlist-image, .cover-art, .grid-items-cover-image, .resource-list--release-list-item-preview');

                if (cover) {
                    const uploadUrl = badge?.dataset.uploadUrl || '';
                    let albumUrl = normalizeAlbumUrl(uploadUrl);

                    if (!albumUrl) {
                        const row = cover.closest('tr, .chartlist-row, li, .grid-items-item') || cover;
                        albumUrl = getAlbumUrlFromContainer(row);
                    }

                    const container = cover.closest('td.chartlist-image, .cover-art, .grid-items-cover-image, .resource-list--release-list-item-preview') || cover;
                    const img = container.querySelector('img');

                    if (albumUrl && (badge || !MH_CONFIG.batchOnlyMissing || (img && isMissingArtwork(img)))) {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();

                        const item = ensureBatchItem(albumUrl, { coverUrl: img ? img.src : '' });
                        startBatchSearch(item);
                        return;
                    }
                }
            }

            if (!badge) return;
            e.preventDefault();
            e.stopPropagation();
            const url = badge.dataset.uploadUrl;
            if (url) {
                if (MH_CONFIG.openCovInstead && startCoverOnlySearch(badge)) return;
                if (MH_CONFIG.openInNewTab) {
                    window.open(url, '_blank');
                } else {
                    window.location.href = url;
                }
            }
        }, { capture: true });

        setTimeout(() => {
            if (shouldScanForMissing()) {
                scanPageForMissingArtwork();
            }

            if (BATCH.active && isBatchListingPath()) {
                mergeBatchQueue(collectScopeAlbums(document));
                applyBatchModeStyles();
                renderBatchQueue();
            }
        }, 2500);

        let lastUrl = location.href;
        let scanTimeout = null;

        const observer = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                checkAndCreatePanel();

                if (shouldScanForMissing()) {
                    setTimeout(() => scanPageForMissingArtwork(), 1500);
                }
            } else {
                if (shouldScanForMissing()) {
                    if (scanTimeout) clearTimeout(scanTimeout);

                    scanTimeout = setTimeout(() => {
                        scanPageForMissingArtwork();
                    }, 500);
                }
            }
        });

        observer.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: false
        });

        window.addEventListener('popstate', () => {
            checkAndCreatePanel();
            if (shouldScanForMissing()) {
                setTimeout(() => scanPageForMissingArtwork(), 1000);
            }
        });

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && shouldScanForMissing()) {
                setTimeout(() => scanPageForMissingArtwork(), 500);
            }
        });

        window._CoverFinder = {
            buildMhUrl: () => {
                const info = extractArtistAlbum();
                return info ? buildMhUrl(info) : 'Artist/Album info not available';
            },
            config: MH_CONFIG,
            saveConfig,
            loadConfig,
            createPanel,
            createPagePanel,
            scanForMissing: scanPageForMissingArtwork,
            batch: BATCH
        };
    })();

})();
