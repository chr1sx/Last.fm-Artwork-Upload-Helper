# Privacy Policy for Last.fm Artwork Upload Helper

**Effective Date:** 2026

Last.fm Artwork Upload Helper operates entirely within the user's browser.

### Data Collection
This extension does **not** collect, transmit, store, or sell any personal data. All processing is done locally on your device.

### Website Access
The extension reads information from Last.fm pages **only** to detect missing album artwork and assist in uploading images. No data leaves your browser.

### Permissions
- **storage** – Used to save user preferences and settings locally.
- **webRequest** – Used to monitor requests on Last.fm and covers.musichoarders.xyz pages to support the integration between the cover search engine and the Last.fm upload page.
- **tabs** – Used to send configuration update messages to open Last.fm tabs when the user changes settings in the popup, so all tabs reflect the latest preferences without requiring a page reload.
- **host permission (all_urls)** – Required to fetch album artwork images from third-party CDN domains (such as Bandcamp, Spotify, Qobuz, Discogs, etc.) via the background service worker. These domains vary depending on which music source the user selects, so a broad host permission is necessary to download images for upload to Last.fm.

## Third Parties 

The extension does not use analytics, tracking scripts, remote code, or third-party services.

## Contact

For questions, contact: chr1sx (GitHub)
