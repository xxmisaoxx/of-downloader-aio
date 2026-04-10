# OF Media Downloader

A Chrome extension to download images and videos from OnlyFans creator profile pages. It captures your existing session auth headers automatically—no separate login required.

## Features

- **One-click download** — A "Download All Media" button appears on any creator's profile page
- **Images & videos** — Downloads both photos and videos at highest available quality
- **Organized by creator** — Files are saved to `OnlyFans/<creator_name>/` in your downloads folder
- **Duplicate detection** — Skips media you've already downloaded on subsequent runs
- **Cancel support** — Stop a download in progress at any time
- **Auto-retry** — Failed downloads retry up to 3 times with exponential backoff
- **Rate-limited** — API calls are throttled (500ms between requests) to avoid rate limits
- **SPA-aware** — Detects page navigation within OnlyFans' single-page app

## Installation

1. Download or clone this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the `onlyfans-media-downloader` directory

## Usage

1. Log into [onlyfans.com](https://onlyfans.com) as you normally would
2. Browse the site briefly so the extension can capture your session headers
3. Navigate to a creator's profile page (e.g. `onlyfans.com/username`)
4. Click the **Download All Media** button in the top-right corner
5. Monitor progress in the inline progress bar
6. Click **Cancel** to stop at any time
7. Re-run on the same creator to download only new media (duplicates are skipped)

## How It Works

The extension intercepts auth headers (`sign`, `time`, `app-token`, `user-id`, `x-bc`) from your browser's API requests to OnlyFans. It then uses these headers to paginate through the creator's posts via OnlyFans' internal API, extracts media URLs, and downloads them using Chrome's downloads API.

## Permissions

| Permission | Reason |
|---|---|
| `activeTab` | Access the current OnlyFans tab |
| `downloads` | Save media files to your computer |
| `storage` | Track downloaded media IDs for duplicate detection |
| `webRequest` | Capture auth headers from your active session |
| `host_permissions` (onlyfans.com) | Required for API access and content script injection |

## File Structure

```
onlyfans-media-downloader/
  manifest.json       Extension manifest (Manifest V3)
  background.js       Service worker: auth capture, download queue, retry logic
  content.js          Content script: UI injection, API pagination, media extraction
  styles.css          Styles for the injected download button and progress bar
  icons/              Extension icons (16px, 48px, 128px)
```

## Limitations

- Only downloads media from **feed posts** (not messages/DMs, stories, or highlights)
- OnlyFans may change their API at any time, which could break functionality
- Large creator profiles with thousands of posts will take time to scan and download
- The extension must capture auth headers from your active session—clearing cookies or logging out resets them

## License

MIT
