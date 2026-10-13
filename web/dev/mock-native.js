// Development only: pretends to be the Nuvio UWP app so the web app's native code paths can be
// tried in a desktop browser. Active only with ?mockNative in the address. It answers the same
// messages as Nuvio/Bridge/AppBridge.cs and plays video in a <video> *behind* the page, the
// way VLC draws under the transparent WebView in the app.
(function () {
  if (!/[?&]mockNative\b/.test(location.search)) return;
  const listeners = [];
  const emit = (message) => setTimeout(() => listeners.forEach((fn) => fn({ data: message })), 0);
  let video = null;
  let loadId = null;
  let readySent = false;

  function ensureVideo() {
    if (video) return video;
    video = document.createElement('video');
    // opacity < 1 keeps Chromium from moving the video to a hardware overlay, which screenshots draw on top.
    video.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:-1;background:#000;object-fit:contain;opacity:.995';
    document.documentElement.appendChild(video);
    const ev = (type, payload = {}) => emit({ type, id: loadId, ...payload });
    video.addEventListener('playing', () => {
      ev('player.state', { state: 'playing' });
      if (!readySent) {
        readySent = true;
        ev('player.ready');
        ev('player.tracks', {
          audio: [{ id: 1, name: 'Track 1 - [English]', lang: 'eng', codec: 'eac3', selected: true }, { id: 2, name: 'Track 2 - [Spanish]', lang: 'spa', codec: 'aac', selected: false }],
          subtitles: [{ id: 3, name: 'Track 1 - [English]', lang: 'eng', title: 'English (SDH)', codec: 'subrip', selected: false }],
          audioId: 1,
          subtitleId: -1,
        });
      }
    });
    video.addEventListener('pause', () => ev('player.state', { state: 'paused' }));
    video.addEventListener('waiting', () => ev('player.buffering', { percent: 30 }));
    video.addEventListener('canplay', () => ev('player.buffering', { percent: 100 }));
    video.addEventListener('timeupdate', () => ev('player.time', { time: video.currentTime, duration: video.duration || 0 }));
    video.addEventListener('durationchange', () => video.duration && ev('player.duration', { duration: video.duration }));
    video.addEventListener('ended', () => ev('player.ended', { reason: 'eof' }));
    video.addEventListener('error', () => ev('player.ended', { reason: 'error', message: 'VLC could not play this stream.' }));
    return video;
  }

  async function handle(message) {
    const v = video;
    switch (message.type) {
      case 'app.hello':
        emit({ type: 'app.hello', platform: 'xbox', appVersion: 'mock', vlcVersion: '3.0 (mock)', webAppUrl: null, bundled: true });
        break;
      case 'app.log':
        console.log('[native log]', message.message);
        break;
      case 'player.open':
        loadId = message.id;
        readySent = false;
        ensureVideo();
        emit({ type: 'player.state', id: loadId, state: 'opening' });
        video.src = message.url;
        if (message.start) video.addEventListener('loadedmetadata', () => (video.currentTime = message.start), { once: true });
        video.play().catch(() => {});
        break;
      case 'player.stop':
        loadId = null;
        if (v) {
          v.removeAttribute('src');
          v.load();
        }
        break;
      case 'player.pause': if (v) v.pause(); break;
      case 'player.play': if (v) v.play(); break;
      case 'player.toggle': if (v) (v.paused ? v.play() : v.pause()); break;
      case 'player.seek': if (v) v.currentTime = message.time; break;
      case 'player.rate': if (v) v.playbackRate = message.rate; break;
      case 'player.audioTrack':
      case 'player.subtitleTrack':
        console.log('[native]', message.type, message.trackId);
        break;
      case 'app.textInput': {
        const text = window.prompt(message.label || 'Enter text', message.value || '');
        emit({ type: 'response', requestId: message.requestId, result: text == null ? null : { text, submitted: true } });
        break;
      }
      case 'net.fetch': {
        try {
          const response = await fetch(message.url, { method: message.method || 'GET', headers: message.headers || {}, body: message.body || undefined });
          const bytes = new Uint8Array(await response.arrayBuffer());
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const headers = {};
          response.headers.forEach((value, key) => (headers[key] = value));
          emit({ type: 'response', requestId: message.requestId, result: { status: response.status, url: response.url, headers, bodyBase64: btoa(binary) } });
        } catch (error) {
          emit({ type: 'response', requestId: message.requestId, result: null, error: error.message });
        }
        break;
      }
      default:
        console.log('[native] unhandled', message);
    }
  }

  window.chrome = window.chrome || {};
  window.chrome.webview = {
    postMessage: (message) => handle(JSON.parse(JSON.stringify(message))),
    addEventListener: (type, fn) => type === 'message' && listeners.push(fn),
    removeEventListener: () => {},
  };
  console.log('Mock native bridge active');
})();
