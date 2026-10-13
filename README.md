# Nuvio UWP VLC

Nuvio for **Xbox Developer Mode** with **VLC built in**, plus the same Nuvio web app for any browser.

Nuvio has no web or Xbox version, so this project is a Nuvio client written as a web app (`web/`) and packaged in a UWP app (`Nuvio/`) that plays everything with LibVLC. Debrid links in any format play: MKV, HEVC/H.265, 4K, Dolby Vision/HDR10, AV1, and TrueHD/Atmos/DTS-HD/EAC3 audio, because VLC does the decoding instead of the Edge engine. Nothing is torrented on the console; it only plays HTTP links served by your addons or debrid service.

> **VLC is wrapped into the app.** The package contains LibVLC (the engine behind VLC media player). You don't need to install anything else.

## Features
- **Nuvio's layout for the TV**: Home with featured titles, Continue Watching (with Next Up) and your addons' catalogs; Search; Library; details with seasons and episodes; per-addon stream lists with quality, HDR/DV, audio and size badges.
- **Stremio addons**: install any addon by its manifest URL (Cinemeta and OpenSubtitles are installed by default), reorder, enable/disable, configure.
- **Nuvio account sync**: sign in with a code (approve on your phone) or email, pick a profile, and your addons, library, Continue Watching and watched marks sync with your other Nuvio apps. See [Nuvio account](#nuvio-account).
- **Built-in debrid**: connect TorBox, Real-Debrid or Premiumize and plain torrent results play too: the service fetches the torrent and the console plays the file it serves.
- **Player**: VLC with Nuvio-style controls, audio track and subtitle menus, addon subtitles drawn by the app (size, colour, background, position, delay), speed, aspect ratio, switching sources, episode list, resume, and next episode with a countdown (same addon and release group).
- If a stream's connection drops partway through, playback reconnects and carries on.
- Full controller support, including typing with the on-screen keyboard.

## Install on Xbox
This app is for Xbox consoles in **Developer Mode**, which is how Xbox lets you install apps from outside the Store.

1. **Turn on Developer Mode.** Follow Microsoft's guide: [Xbox Developer Mode activation](https://learn.microsoft.com/windows/uwp/xbox-apps/devkit-activation).
2. **Download the app.** On your PC, open this repository's [Releases](../../releases/latest) page, download `NuvioUWPVLC-x64.zip` and unzip it. Inside is the app (`Nuvio_…_x64.msix`) and a `Dependencies` folder with its 5 dependency packages (`.appx`). Every build in the [Actions](../../actions) tab also has the same files as its `NuvioUWPVLC-x64` artifact.
3. **Open the Device Portal.** On the Xbox, in **Dev Home**, open **Remote Access Settings**, turn on the Xbox Device Portal and set a username and password. On your PC, open the address it shows, e.g. `https://192.168.1.20:11443` (a certificate warning is expected).
4. **Install.** In the Device Portal, under **My games & apps**, choose **Add**:
   - Choose the `.msix` file and select **Next**.
   - Add the 5 files from the `Dependencies` folder and select **Next**.
   - Select **Start** and wait for the install to finish.
5. **Open it.** In Dev Home the app appears as **Nuvio**.

**Updating:** install a newer build the same way. It replaces the old version and keeps your data.

## Getting streams to play
- **Debrid addons (recommended):** set up Torrentio, Comet, MediaFusion, AIOStreams or similar with Real-Debrid, AllDebrid, TorBox, Premiumize etc. on their configure page, and install the manifest URL it gives you (Settings → Addons → Install Addon). Their links play straight away.
- **Built-in debrid:** Settings → Debrid → connect TorBox, Real-Debrid or Premiumize with your API key. Torrent results from any addon then show "via TB/RD/PM" and play if the service has them cached.
- **Without typing on the TV:** Settings → Account → **Import from Stremio** copies the addons (already set up with your debrid service), library and Continue Watching from a Stremio account. Or sign in to a Nuvio account (below).
- Torrents can't be streamed on the console itself; without debrid they're hidden (Settings → Playback → Show torrent results lists them anyway).

## Nuvio account
Settings → Account → **Sign in with a code** (scan the QR code, or enter the code at the link shown, on your phone or computer) or **Sign in with email**. Your addons, library, Continue Watching and watched marks then sync with your other Nuvio apps; profiles with *uses primary addons* use profile 1's addons, and PIN-locked profiles ask for the PIN.

Which Nuvio server the app signs in to:
- **Built in:** a build can include a server, so sign-in needs no setup. Nothing private is committed to this repository; the server's details go in `web/js/config.local.js` (ignored by git):
  - **For builds you make yourself:** create `web/js/config.local.js` with `export default { officialServer: { backendUrl: 'https://api.nuvio.tv', publishableKey: '…' } };`
  - **For the GitHub builds and releases:** add a repository secret `NUVIO_PUBLISHABLE_KEY` (and `NUVIO_BACKEND_URL` if it isn't `https://api.nuvio.tv`); the workflow writes the file before building. Anything built in can be read by anyone who downloads the package, as with any app.
- **Self-hosted Nuvio server:** Settings → Account → Server → *Self-hosted server*, and enter its address; the app reads `/.well-known/nuvio` like the official apps do.
- **Any other server:** *Enter server details*: the backend URL and its publishable (anon) key.

Sync is gentle with the server, like Nuvio's own apps: progress goes up at most once a minute while playing (straight away on pause or stop), the library is re-read every 15 minutes while the app is open, and when the server says "too many requests" the app waits as long as it asks.

**TMDB (optional):** with a TMDB key (Settings → Integrations, or the `TMDB_API_KEY` secret / `tmdbApiKey` in `config.local.js`), details screens get cast photos, a "More like this" row, and logos and backdrops the addons lack.

## Controller
| Button | Action |
| --- | --- |
| D-pad / left stick | Move the highlight. In the player with the controls hidden: left/right seek, up/down show the controls |
| A | Select. On a text box it opens the on-screen keyboard |
| B | Close the open menu, otherwise go back. Press twice on Home to exit |
| X | Play / pause in the player |
| Y | More options on a Continue Watching card or episode; subtitles menu in the player |
| View / Menu | Audio menu in the player |
| LT / RT | Seek back / forward 30 seconds |
| RB | Next episode |

A USB keyboard works too (arrows, Enter, Escape/Backspace, Space).

## Troubleshooting
The app writes a log you can download from the Device Portal: **File explorer → LocalAppData →** the Nuvio package folder (`b7f0f2ee-…`) **→ LocalState → `nuvio-vlc.log`**. Include it when reporting a problem.

Known limitations:
- Subtitle styling applies to addon subtitles; subtitles built into the video file use VLC's default style.
- Streams that need browser DRM won't play.
- On Xbox the controller's pointer is turned off (it's the browser engine's, and fought with the D-pad); Settings → Device → Controller cursor brings it back.
- Trakt, Simkl, MDBList, Jellyfin/Emby servers and Nuvio's JavaScript provider plugins aren't implemented yet.

## Development
The web app has no build step: plain ES modules, served as files.

```bash
node tools/serve.mjs
```

Then open http://localhost:8080. In a browser the player uses `<video>` (MP4/WebM only); in the app it uses VLC.

- **Try changes on the Xbox without reinstalling:** run `tools/serve.mjs` on your PC, then on the Xbox go to Settings → Device → Web app address and enter `http://<your PC's IP>:8080`. The app loads the web app from your PC; clear the address to go back to the built-in one.
- **Native code paths in a browser:** open http://localhost:8080/?mockNative. `web/dev/mock-native.js` pretends to be the UWP app (Xbox mode, VLC events, text input) and plays video behind the transparent page like VLC does.
- **Streams without a debrid account:** `node tools/dev-addon.mjs` serves sample videos (WebM, MP4, a redirect, MKV, HEVC, a broken link, a torrent-only result) and subtitles; install `http://localhost:7001/manifest.json`.
- **Account sync without a real server:** `node tools/dev-sync-server.mjs` is an in-memory stand-in for a Nuvio server. Connect to `http://localhost:7002` as a self-hosted server; sign in with `test@example.com` / `test`, or with a code approved at `http://localhost:7002/approve?code=…`. Opening `http://localhost:7002/ratelimit?count=3` makes the next three requests fail with "429, retry after 2 seconds", to try the backoff.

## Building
Every push builds signed packages with GitHub Actions (`.github/workflows/build.yml`), and pushing a tag such as `v1.0.0` publishes a release. To build locally you need Visual Studio 2022 with the **Universal Windows Platform development** workload: open `NuvioUWP.sln` and build `Release | x64` (or run the `msbuild` command from the workflow).

### Deploy from Visual Studio to the Xbox
Visual Studio can install and debug the app on a Dev Mode Xbox directly:
1. In **Dev Home** on the Xbox, note the console's IP address (and under **Remote Access Settings**, remote access can stay as it is).
2. In Visual Studio, set the configuration to `Debug | x64` (or `Release | x64`), open the target dropdown next to the green ▶ and choose **Remote Machine**.
3. Enter the Xbox's IP address, with **Authentication Mode: Universal (Unencrypted Protocol)**.
4. Press ▶. The first time, Visual Studio asks for a PIN: on the Xbox, in Dev Home, select **Pair with Visual Studio** to show it.

Visual Studio then deploys and starts the app on every run (Debug builds attach the debugger). A Visual Studio deployment and a Device Portal install use different signing certificates, so uninstall one before switching to the other.

For changes to the web app only, no reinstall is needed at all: run `node tools/serve.mjs` on the PC and point the Xbox at it (Settings → Device → Web app address), then just reload.

## How it works
- The web app (`web/`) is packaged into the app and served to a WebView2 at `https://app.nuvio.local/`. It talks to the app through `window.chrome.webview` messages ([docs/bridge.md](docs/bridge.md); `Nuvio/Bridge/AppBridge.cs`).
- VLC draws the video underneath the page (`Nuvio/Playback/VlcPlayer.cs`), and the page turns transparent while a stream plays, so the Nuvio controls and addon subtitles appear on top.
- Streams are downloaded with Windows' own HTTP stack and fed to VLC (`Nuvio/Playback/HttpMediaInput.cs`): it handles TLS and the redirects debrid links use, and sends any request headers an addon asks for. HLS/DASH playlists use VLC's own networking.
- The controller is read natively (`Nuvio/Input/ControllerBridge.cs`) and handed to the page's spatial navigation (`web/js/core/focus.js`).

## Credits and license
- Based on [Nuvio](https://github.com/NuvioMedia/NuvioMobile) by NuvioMedia (GPL-3.0): design, icons and the account and debrid protocols follow it.
- The UWP shell, VLC playback and packaging come from Stremio UWP VLC (GPL-3.0).
- Video playback by [LibVLC](https://www.videolan.org/vlc/libvlc.html) and [LibVLCSharp](https://code.videolan.org/videolan/LibVLCSharp) from VideoLAN (LGPL-2.1-or-later).
- Some icons are Material Design icons (Apache-2.0).
- Licensed under [GPLv3](LICENSE).
- Unofficial. This project is not affiliated with NuvioMedia, Stremio or VideoLAN, and doesn't host or provide any content.
