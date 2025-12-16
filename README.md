<div align="center">

<img src="https://github.com/chr1sx/Last.fm-Artwork-Upload-Helper/blob/main/Images/logo.png?raw=true" width="200" alt="Logo">

# Last.fm Artwork Upload Helper

[![Install Script](https://img.shields.io/badge/Install%20Script-brightgreen?style=for-the-badge)](https://raw.githubusercontent.com/chr1sx/Last.fm-Artwork-Upload-Helper/main/Last.fm%20Artwork%20Upload%20Helper.user.js)
[![Firefox Add-on](https://img.shields.io/amo/v/last-fm-artwork-upload-helper?style=for-the-badge&logo=firefox&logoColor=white&color=orange&label=Firefox%20Add-on)](https://addons.mozilla.org/en-US/firefox/addon/last-fm-artwork-upload-helper/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](https://github.com/chr1sx/Last.fm-Artwork-Upload-Helper/tree/main?tab=MIT-1-ov-file)

*A userscript that streamlines uploading album artwork to Last.fm*

</div>

---

## Features

- **Missing Artwork Indicators** - Highlights missing artwork on the page you're on
- **Seamless Integration** - Detects Last.fm upload pages and injects a helper panel
- **Multi-Source Search** - Search across 25 platforms via [COV - Cover Search Engine](https://covers.musichoarders.xyz/)
- **Direct Upload** - Uploads artwork directly from search results without manual downloads
- - **Image Compression** - Automatically compresses images larger than 5 MB
- **Themes** - Choose between light and dark mode

---

## Requirements

- A userscript manager extension for the web browser:  
  - [Violentmonkey](https://violentmonkey.github.io/) (recommended) or [Tampermonkey](https://www.tampermonkey.net/)

---

## Installation

1. Install a userscript manager for your web browser.  
2. [Install the userscript](https://raw.githubusercontent.com/chr1sx/Last.fm-Artwork-Upload-Helper/main/Last.fm%20Artwork%20Upload%20Helper.user.js).  
3. Your userscript manager will open and prompt you to install.  
4. Click Install.

---

## Usage

<img src="https://github.com/chr1sx/Last.fm-Artwork-Upload-Helper/blob/main/Images/screenshot1.png?raw=true" width="240" align="right" alt="Helper panel on Last.fm">

1. Navigate to an upload page on Last.fm ([Example page](https://www.last.fm/music/Front+Line+Assembly/Civilization/+images/upload)).  
2. The helper panel appears automatically on the right side of the page.  
3. Click **Open Artwork Search**.  
   - A new window opens with **COV - Cover Search Engine**.  
   - Results are pre-filtered based on your settings.  
4. Click one of the artwork results.  
   - It’s automatically set in the Last.fm upload field.  
   - The search window closes automatically.  
5. Complete the upload as usual.

---

## Settings Configuration

<img src="https://github.com/chr1sx/Last.fm-Artwork-Upload-Helper/blob/main/Images/screenshot2.png?raw=true" width="240" align="right" alt="Settings panel">

### Sources
Select up to nine platforms to search:
- **Streaming**: Amazon Music, Apple Music, Deezer, Spotify, TIDAL, FLO  
- **Stores**: Bandcamp, Beatport, BOOTH, iTunes, OTOTOY, Qobuz  
- **Databases**: Discogs, Last.fm, MusicBrainz, VGMdb, THWiki  
- **Regional**: Bugs, Gaana, KKBOX, KuGou, LINE MUSIC, Melon  
- **Other**: Fanart.tv, Soulseek  

_Default: Bandcamp, Deezer, Discogs, iTunes, KuGou, Qobuz, Spotify_

### Show Missing Artwork Indicators
Enable or disable indicators on the page you're on.  
_Default: Enabled_

### Open Upload Page In New Tab
Enable or disable opening upload page in new tab via indicator.  
_Default: Enabled_

### Compress Large Images
Enable or disable automatic compression for images that exceed the 5 MB limit.  
_Default: Enabled_

### Minimal Resolution
Set the minimum image resolution (e.g. 600 for 600×600px or higher).  
Images below the requirement appear blurred in search results.  
_Default: 0_

### Country
Select your preferred country for localized results:  
Australia, Brazil, Canada, China, France, Germany, India, Italy, Japan, Korea, Mexico, Taiwan, UK, US  
_Default: United States_

### Theme
Choose between Dark Mode and Light Mode.  
_Default: Light Mode_

---

## License

This userscript is available under the [MIT License](https://github.com/chr1sx/Last.fm-Artwork-Upload-Helper/tree/main?tab=MIT-1-ov-file).

---

## Screenshots

<div align="center">

<img src="https://github.com/chr1sx/Last.fm-Artwork-Upload-Helper/blob/main/Images/screenshot3.png?raw=true" width="380" alt="Screenshot">
<img src="https://github.com/chr1sx/Last.fm-Artwork-Upload-Helper/blob/main/Images/screenshot4.png?raw=true" width="380" alt="Screenshot">
<img src="https://github.com/chr1sx/Last.fm-Artwork-Upload-Helper/blob/main/Images/screenshot5.png?raw=true" width="380" alt="Screenshot">
<img src="https://github.com/chr1sx/Last.fm-Artwork-Upload-Helper/blob/main/Images/screenshot6.png?raw=true" width="380" alt="Screenshot">

</div>

---
