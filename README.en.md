# web-player

[中文](README.md) | English

A minimal video player for kids: **a folder is a show**.

A home player built for kids learning a foreign language (original-language cartoons, nursery rhymes, picture-book videos…).
Sort downloaded videos into folders, run it on your Mac / PC, and open it in the browser on an iPad, phone, TV or Android tablet:
no ads, no recommendations, no autoplay into random videos — kids only watch what you put in.
Supports resume playback, favorites, watch history, and searching by subtitle lines.

Parents are welcome to use it, open issues and send PRs.

- Every folder that directly contains videos is a show. The folder name is the show name, and the cover is grabbed from the first episode automatically. Names and covers are not editable.
- Folders can be nested to any depth. Cards show only the innermost folder name; hover to see the full path and episode count.
- Click a cover to play. Choose between "Play all" (continuous) and "Play one".
- Click 🤍 in the top-left of a card (or "Like" on the player page) to like a show. Liked shows come first, most recently liked at the front. Stored in `data/favorites.json` and shared by all devices.
- Works in the browser of any iPad / phone / TV on the LAN.
- mp4 / mov / webm play directly; mkv / flv / avi etc. are transcoded to an mp4 stream on the fly by the bundled ffmpeg.
- The UI comes in Chinese and English. It follows the browser language by default; you can switch it under Settings → Language (per browser).

## Download and run (recommended)

Grab the package for your platform from [Releases](https://github.com/codewithyou365/web-player/releases/latest). No Node install, no `npm install`:

- **Mac / Windows / Linux**: download the matching `web-player-*.zip`, unzip it and double-click `start.command` (Mac) / `start.bat` (Windows) / `start.sh` (Linux). The browser opens automatically.
  On Mac, if the first launch says the developer cannot be verified, right-click → Open.
- **Android tablet / phone**: download and install `web-player-android.apk`.

Put videos into the `kids-videos` folder in your home directory (or add folders on the Settings page) and you're done.

## Run from source

Requires Node.js 22.13 or later.

```bash
npm install
npm start
```

Open http://localhost:8080. The terminal prints the LAN addresses. The library is scanned automatically on first start.

## Fixed address for the iPad (Tailscale)

LAN IPs change, and the subnet is different when you're on a phone hotspot, so the iPad always goes through Tailscale:

1. Install the official Tailscale app on the iPad, sign in with the same account as the Mac, and keep it on.
2. In Safari, open `http://<Mac's MagicDNS name>:8080`, e.g. `http://macbook-pro.tailxxxxx.ts.net:8080`. If that doesn't work, use the 100.x address printed after `Tailscale:` in the terminal.
3. Share → "Add to Home Screen". Opened from the home-screen icon it runs full screen, and the same icon works on home Wi-Fi and on a hotspot.

At home, Tailscale connects directly over the LAN, so there is no detour.

## Configuration

`config.json` (generated on first start; by default it scans the `kids-videos` folder in your home directory):

```json
{ "port": 8080, "scanDirs": ["/Users/me/kids-videos"] }
```

You can also add/remove folders and rescan from ⚙️ Settings in the top-right corner.

## Search

Click 🔍 in the top-right of the home page and type a show name, episode title, folder name or **a line from the subtitles**. Separate words with spaces to require all of them (e.g. `peppa muddy`).
Case-insensitive, ignoring spaces and punctuation; results where the whole phrase appears in order rank first.

- Match on show name / folder → opens the show; match on episode title → plays that episode directly.
- Match on text in a show folder (srt / ass / ssa / vtt / lrc / txt / nfo / md, only from folders that directly contain videos) → shows the show and the matching line.
  Opening it does not autoplay; pick an episode from the list yourself. Subtitles in UTF-8 / UTF-16 / GBK are all detected.

The first time, **build the search index** (button on the Settings or Search page; it reads subtitles, so a few thousand text files take a few seconds to a few dozen seconds). The index lives in `data/search.db` (Node's built-in SQLite, nothing else to install).
Once built, it updates automatically on rescans and deletions. No AI model, no network access, almost no memory. The Android version supports it too, using the system SQLite.

## Data

`data/library.json` is the scan result, `data/covers/` the cover cache, and `data/search.db` the search index. Delete `data/` and restart for a full rescan.

## Admin mode

After turning on "Admin mode" in Settings (applies only to the current browser):

- **Archive**: the 🗂 on a show card lets you pick a parent folder to collapse into a single folder card; every show under it goes inside. Can be nested; 📂 on a folder card unarchives it. Archiving only affects display and never touches files on disk. Stored in `data/folders.json`.
- **Delete forever**: 🗑 deletes an episode or a whole show (including subtitles with the same name) from disk. Cannot be undone. Only the show's own files are deleted, and a folder is removed only once it's empty.
- **Resume / Continue watching**: progress is stored in `data/progress.json` and shared by all devices.
- **History**: 🕘 in the top-right of the home page lists every show you've played (one entry per show, with the last episode and time). Click to continue. Entries are kept forever and can only be removed manually with ✕ or "Clear all"; removing an entry also clears its resume position.

## Android tablet version (`android/`)

The same frontend (`public/`) is packed into the APK, with the backend rewritten in Kotlin (NanoHTTPD + ffmpeg-kit).
The tablet listens on a port itself, so other devices on the LAN can watch in a browser as well; on the tablet it opens in a built-in WebView.

- Data (`config.json`, `data/`) lives in the app's private directory and is wiped on uninstall. By default it scans `/sdcard/Movies` and `/sdcard/kids-videos`; change this on the Settings page.
- Needs "All files access" (the first launch guides you to system settings) to scan folders, grab covers and delete files.
- Runs as a foreground service, so the port keeps listening in the background and with the screen off; starts on boot. The LAN address is shown on the Settings page and in the notification.
- Non-native formats are transcoded live: `h264_mediacodec` hardware encoding first, falling back to `libx264` (capped at 720p when re-encoding).

### Build

```bash
cd android
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`sdk.dir` in `local.properties` points to your Android SDK; dependencies are fetched through the Aliyun mirror. Only arm64-v8a is built.

`assembleRelease` reads `android/keystore.properties` (or the file pointed to by the `KEYSTORE_PROPERTIES` environment variable) for release signing,
and falls back to the debug signature if it's missing.

## Releases

Pushing a `v*` tag makes GitHub Actions (`.github/workflows/release.yml`) build the desktop zips for four platforms plus the APK and publish them to Releases:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

Desktop packages are built with `scripts/package-desktop.sh <mac-arm64|mac-x64|win-x64|linux-x64>`, which also works locally.

## License

[MIT](LICENSE)
