<div align="center">

<img src="https://github.com/chr1sx/Last.fm-Artwork-Upload-Helper/blob/main/Images/logo.png?raw=true" width="200" alt="Logo">

# Last.fm Artwork Upload Helper

[![Install Script](https://img.shields.io/badge/Install%20Script-brightgreen?style=for-the-badge)](https://raw.githubusercontent.com/chr1sx/Last.fm-Artwork-Upload-Helper/main/Last.fm%20Artwork%20Upload%20Helper.user.js)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)]([https://opensource.org/license/mit](https://github.com/chr1sx/Last.fm-Artwork-Upload-Helper/tree/main?tab=MIT-1-ov-file#))

*A userscript that streamlines uploading album artwork to Last.fm with one click.*

</div>

---

## Features

- **Seamless Integration** - Automatically detects Last.fm upload pages and injects a helper panel  
- **Automatic Artist/Album Detection** - Extracts metadata from the current Last.fm page  
- **Multi-Source Search** - Search across 30+ platforms via [COV - Cover Search Engine](https://covers.musichoarders.xyz/)  
- **Direct Upload** - Upload artwork directly from the search results without downloading manually  

---

## Requirements

- A userscript manager extension:  
  - [Violentmonkey](https://violentmonkey.github.io/) (recommended)
  - [Tampermonkey](https://www.tampermonkey.net/)

---

## Installation

1. Install a userscript manager for your browser.  
2. [Click here to install the userscript](https://raw.githubusercontent.com/chr1sx/Last.fm-Artwork-Upload-Helper/main/Last.fm%20Artwork%20Upload%20Helper.user.js).  
3. Your userscript manager will open and prompt you to install.  
4. Click **Install**.

---

## Usage

<img src="https://github.com/chr1sx/Last.fm-Artwork-Upload-Helper/blob/main/Images/screenshot1.png?raw=true" width="240" align="right" alt="Helper panel on Last.fm">

1. Navigate to an upload page on Last.fm ([Example page](https://www.last.fm/music/Front+Line+Assembly/Civilization/+images/upload))  
2. The helper panel appears automatically on the right side of the page.  
3. Click **Search and Pick an Artwork**.  
   - A new window opens with **COV - Cover Search Engine**.  
   - Results are pre-filtered based on your settings.  
4. Click the best artwork result.  
   - It’s automatically set in the Last.fm upload field.  
   - The search window closes automatically.  
5. Complete the upload as usual.

---

## Settings Configuration

<img src="https://github.com/chr1sx/Last.fm-Artwork-Upload-Helper/blob/main/Images/screenshot2.png?raw=true" width="240" align="right" alt="Settings panel">

### Sources
Select which platforms to search:
- **Streaming**: Amazon, Amazon Music, Apple Music, Deezer, Spotify, Tidal, FLO  
- **Stores**: Bandcamp, Beatport, BOOTH, iTunes, OTOTOY, RecoChoku, Qobuz  
- **Databases**: Discogs, Last.fm, MusicBrainz, Metal Archives, VGMdb, THWiki  
- **Regional**: Bugs, Gaana, KKBOX, KuGou, LINE MUSIC, Melon, NetEase  
- **Other**: Fanart.tv, SoundCloud, Soulseek  
_Default_: Bandcamp, Deezer, Discogs, Spotify, Qobuz, Tidal

### Minimal Resolution
Set the minimum image resolution (e.g. 600 for 600×600px or higher).  
Images below the requirement appear blurred in search results.

### Country
Select your preferred country for localized results:  
Australia, Brazil, Canada, China, France, Germany, India, Italy, Japan, Korea, Mexico, Taiwan, UK, US  
_Default_: United States

### Theme
Choose between Dark Mode and Light Mode.

---

## License

This userscript is available under the [MIT License]([https://opensource.org/license/mit](https://github.com/chr1sx/Last.fm-Artwork-Upload-Helper/tree/main?tab=MIT-1-ov-file#)).

---
