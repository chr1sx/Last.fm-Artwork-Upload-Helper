// ==UserScript==
// @name         Last.fm Artwork Upload Helper
// @namespace    https://github.com/chr1sx/Last.fm-Artwork-Upload-Helper
// @version      2.0
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
    document.documentElement.setAttribute('data-mh-helper-loaded', '2.0');

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
        return BATCH.queue.filter(item =>
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
    const FAB_ICON_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAAGVn0euAAAACXBIWXMAAAsTAAALEwEAmpwYAAAF0WlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNS42LWMxNDUgNzkuMTYzNDk5LCAyMDE4LzA4LzEzLTE2OjQwOjIyICAgICAgICAiPiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIgeG1sbnM6cGhvdG9zaG9wPSJodHRwOi8vbnMuYWRvYmUuY29tL3Bob3Rvc2hvcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RFdnQ9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZUV2ZW50IyIgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQaG90b3Nob3AgQ0MgMjAxOSAoV2luZG93cykiIHhtcDpDcmVhdGVEYXRlPSIyMDI1LTExLTA2VDIxOjM4OjM0KzAyOjAwIiB4bXA6TW9kaWZ5RGF0ZT0iMjAyNS0xMS0wNlQyMjowMzoxMiswMjowMCIgeG1wOk1ldGFkYXRhRGF0ZT0iMjAyNS0xMS0wNlQyMjowMzoxMiswMjowMCIgZGM6Zm9ybWF0PSJpbWFnZS9wbmciIHBob3Rvc2hvcDpDb2xvck1vZGU9IjMiIHhtcE1NOkluc3RhbmNlSUQ9InhtcC5paWQ6MmVlYTRiMWYtMTlhZS03YTQ2LWJhY2YtY2U1MjJkNzQ1NDg1IiB4bXBNTTpEb2N1bWVudElE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';

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

        const fetchPage = async (page) => {
            const res = await fetch(scope.pageUrl(page), {
                credentials: 'same-origin'
            });

            if (res.status === 404 && page > 1) return null;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const html = await res.text();
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
                    try {
                        const early = lookahead.get(page);
                        lookahead.delete(page);
                        pageDoc = await (early || fetchPage(page));
                    } catch (firstAttemptError) {
                        await sleep(1500);
                        pageDoc = await fetchPage(page);
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
            if (fetched === 0) {
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
