import { h, img, icon, clear, append } from '../core/dom.js';
import { focus } from '../core/focus.js';
import { router } from '../core/router.js';
import { events, settings } from '../core/store.js';
import { bridge } from '../core/bridge.js';
import { formatClock, formatEpisodeCode } from '../core/format.js';
import { createEngine } from '../player/engines.js';
import { fetchSubtitles, fetchStreams, enabledAddons } from '../services/addons.js';
import { describeStream, streamHeaders, isPlayable } from '../services/streams.js';
import { saveProgress, resumeSeconds, parseVideoId } from '../services/progress.js';
import { fetchMeta, nextEpisode, sortedVideos, isReleased } from '../services/meta.js';
import { loadSubtitleCues, cuesAt, languageName, languageMatches } from '../services/subtitles.js';
import { spinner, choicePanel, toast, button } from '../components/ui.js';
import { debridAccount, resolveTorrent } from '../services/debrid.js';

const HIDE_CONTROLS_MS = 4000;
const SAVE_EVERY_MS = 5000;
const SEEK_STEP = 10;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const ASPECTS = [['fit', 'Fit'], ['fill', 'Fill (crop)'], ['stretch', 'Stretch'], ['16:9', '16:9'], ['4:3', '4:3'], ['21:9', '21:9']];

export function playerView({ state }) {
  const meta = state.meta;
  if (!meta || !state.stream) {
    setTimeout(() => router.back(), 0);
    return { el: h('div'), chrome: 'player' };
  }
  let video = state.video || null;
  let stream = state.stream;
  const sources = state.streams || [stream];
  const isSeries = meta.type !== 'movie' && video && video.season != null;
  const contentInfo = video
    ? { contentId: meta.id, season: video.season, episode: video.episode, videoId: video.id }
    : { contentId: meta.id, season: null, episode: null, videoId: meta.id };
  if (video && video.season == null) Object.assign(contentInfo, parseVideoId(video.id, meta.type), { videoId: video.id });

  // ---------- Elements ----------
  const stage = h('div', { class: 'player-stage' });
  const subtitleBox = h('div', { class: 'player-subs' });
  const loadingText = h('div', { class: 'loading-text' }, 'Opening stream…');
  const loading = h('div', { class: 'player-loading' },
    meta.background ? img(meta.background, { class: 'loading-backdrop', loading: 'eager' }) : null,
    h('div', { class: 'loading-content' },
      meta.logo ? img(meta.logo, { class: 'loading-logo', loading: 'eager' }) : h('div', { class: 'loading-title' }, meta.name),
      spinner(),
      loadingText));
  const centerFlash = h('div', { class: 'osd-flash' });
  const seekFill = h('div', { class: 'seek-fill' });
  const seekThumb = h('div', { class: 'seek-thumb' });
  const seekPreview = h('div', { class: 'seek-preview' });
  const seekBar = h('div', { class: 'osd-seek focusable', role: 'slider', 'aria-label': 'Playback position', tabindex: '-1' },
    h('div', { class: 'seek-track' }, seekFill), seekThumb, seekPreview);
  const timeCurrent = h('span', { class: 'time-current' }, '0:00');
  const timeTotal = h('span', { class: 'time-total' }, '');
  const playButton = osdButton('pause', 'Pause', () => togglePause());
  playButton.dataset.autofocus = '';
  const controls = h('div', { class: 'osd-controls', 'data-nav-group': '' },
    h('div', { class: 'osd-group' },
      osdButton('replay10', 'Back 10 seconds', () => seekBy(-10)),
      playButton,
      osdButton('forward10', 'Forward 10 seconds', () => seekBy(10))),
    h('div', { class: 'osd-group' },
      osdButton('subs', 'Subtitles', () => openSubtitleMenu()),
      osdButton('audio', 'Audio', () => openAudioMenu()),
      osdButton('speed', 'Speed', () => openSpeedMenu()),
      osdButton('aspect', 'Aspect ratio', () => openAspectMenu()),
      sources.length > 1 ? osdButton('source', 'Sources', () => openSourcesMenu()) : null,
      isSeries ? osdButton('episodes', 'Episodes', () => openEpisodesMenu()) : null,
      isSeries ? osdButton('skip-next', 'Next episode', () => playNext()) : null));
  const titleBlock = h('div', { class: 'osd-title' },
    h('div', { class: 'osd-name' }, meta.name),
    video && h('div', { class: 'osd-episode' }, [formatEpisodeCode(contentInfo.season, contentInfo.episode), video.name || video.title].filter(Boolean).join(' · ')));
  const sourceLabel = h('div', { class: 'osd-source' });
  const backButton = osdButton('back', 'Back', () => exit(), 'osd-back');
  const osd = h('div', { class: 'player-osd' },
    h('div', { class: 'osd-top' }, backButton, titleBlock, sourceLabel),
    centerFlash,
    h('div', { class: 'osd-bottom' },
      h('div', { class: 'osd-timeline' }, timeCurrent, seekBar, timeTotal),
      controls));
  const nextCard = h('div', { class: 'player-next', hidden: true });
  const errorBox = h('div', { class: 'player-error', hidden: true });
  const el = h('div', { class: 'player' }, stage, subtitleBox, osd, loading, nextCard, errorBox);

  const engine = createEngine(stage);
  const cleanups = [];

  // ---------- Playback state ----------
  let playState = 'opening';
  let ready = false;
  let duration = 0;
  let lastTime = 0;
  let lastTimeAt = performance.now();
  let rate = 1;
  let bufferingPercent = 100;
  let tracks = { audio: [], subtitles: [], audioId: -1, subtitleId: -1 };
  let tracksInitialised = false;
  let addonSubtitles = [];
  let activeAddonSub = null; // { sub, cues }
  let subtitleDelay = 0; // seconds, addon subtitles
  let aspect = 'fit';
  let ended = false;
  let closed = false;
  let lastSaved = 0;
  let nextInfo = null; // { video, countdown, timer }
  let nextDismissed = false;
  let scrubTarget = null;
  let scrubTimer = 0;
  let scrubRepeat = 0;
  let hideTimer = 0;
  let controlsVisible = true;
  let menuOpen = false;
  let sessionStarted = false; // a "playback" start was announced for the current stream

  function osdButton(iconName, label, onClick, cls) {
    return h('button', { class: ['osd-btn', 'focusable', cls], type: 'button', 'aria-label': label, title: label, onClick: (e) => {
      e.preventDefault();
      onClick();
      poke();
    } }, icon(iconName));
  }

  function currentTime() {
    if (playState === 'playing' && ready) return Math.min(duration || Infinity, lastTime + ((performance.now() - lastTimeAt) / 1000) * rate);
    return lastTime;
  }

  // ---------- Engine events ----------
  engine.on('state', ({ state: s }) => {
    const was = playState;
    playState = s;
    if (s === 'playing' || s === 'paused') {
      lastTimeAt = performance.now();
      setIcon(playButton, s === 'playing' ? 'pause' : 'play');
      if (s === 'paused') {
        showControls();
        save(true);
        report('pause');
      } else {
        scheduleHide();
        if (was === 'paused') report('resume');
      }
    }
    if (s === 'buffering') loadingText.textContent = 'Reconnecting…';
    updateLoading();
  });
  engine.on('time', ({ time, duration: d }) => {
    lastTime = time;
    lastTimeAt = performance.now();
    if (d > 0 && !duration) duration = d;
    maybeOfferNext();
    maybeSave();
  });
  engine.on('duration', ({ duration: d }) => {
    duration = d;
  });
  engine.on('buffering', ({ percent }) => {
    bufferingPercent = percent;
    updateLoading();
  });
  engine.on('tracks', (t) => {
    tracks = t;
    if (!tracksInitialised && (t.audio.length || t.subtitles.length)) {
      tracksInitialised = true;
      applyTrackPreferences();
    }
  });
  engine.on('ready', () => {
    ready = true;
    report('start');
    el.classList.add('ready');
    updateLoading();
    // While loading only Back is on screen; now the playback controls are.
    if (!focus.current || focus.current === backButton || !el.contains(focus.current)) focus.set(playButton);
    scheduleHide();
  });
  engine.on('ended', ({ reason, message }) => {
    if (reason === 'eof') {
      ended = true;
      save(true, true);
      report('stop');
      if (isSeries && settings.get('autoplayNext') && !nextDismissed) startNextCountdown(true);
      else exit();
      return;
    }
    showError(message || 'This stream could not be played.');
  });

  function updateLoading() {
    const showSpinner = !ready || playState === 'opening' || (playState === 'playing' && bufferingPercent < 100) || playState === 'buffering';
    el.classList.toggle('buffering', ready && showSpinner);
    loading.hidden = ready;
    if (!ready) {
      if (bufferingPercent < 100 && bufferingPercent > 0) loadingText.textContent = `Buffering… ${bufferingPercent}%`;
    }
  }

  // ---------- Start ----------
  function start(target, at) {
    report('stop');
    stream = target;
    ready = false;
    ended = false;
    tracksInitialised = false;
    bufferingPercent = 0;
    el.classList.remove('ready');
    loading.hidden = false;
    errorBox.hidden = true;
    loadingText.textContent = 'Opening stream…';
    const info = describeStream(stream, stream.addonName || '');
    sourceLabel.textContent = [stream.addonName, info.resolution].filter(Boolean).join(' · ');
    lastTime = at;
    lastTimeAt = performance.now();
    engine.open({ url: stream.url, start: at, headers: streamHeaders(stream), hwdec: settings.get('hardwareDecoding') });
    engine.setAspect(aspect);
    if (rate !== 1) engine.setRate(rate);
  }

  const startAt = state.restart || !settings.get('resumePlayback') ? 0 : resumeSeconds(contentInfo.contentId, contentInfo.season, contentInfo.episode);
  if (startAt > 0) toast(`Resuming from ${formatClock(startAt)}`);
  start(stream, startAt);
  loadAddonSubtitles();

  // ---------- Progress ----------
  function maybeSave() {
    if (performance.now() - lastSaved > SAVE_EVERY_MS) {
      save();
      report('progress');
    }
  }

  /**
   * Tells listeners (Trakt scrobbling, Jellyfin playback reporting) what's playing:
   * phase is start, progress, pause, resume or stop. A stream's session starts once it's ready
   * and stops when playback ends, the source changes or the player closes.
   */
  function report(phase) {
    if (phase === 'start') {
      if (sessionStarted) return;
      sessionStarted = true;
    } else if (!sessionStarted) return;
    if (phase === 'stop') sessionStarted = false;
    events.emit('playback', {
      phase,
      contentId: contentInfo.contentId,
      contentType: meta.type,
      videoId: contentInfo.videoId,
      season: contentInfo.season,
      episode: contentInfo.episode,
      title: meta.name,
      position: ended ? duration : currentTime(),
      duration,
      paused: playState === 'paused',
      stream,
    });
  }

  function save(force = false, finished = false) {
    if (!duration || (!ready && !force)) return;
    const position = finished ? duration : currentTime();
    if (position < 5 && !finished) return;
    lastSaved = performance.now();
    saveProgress({
      contentId: contentInfo.contentId,
      contentType: meta.type,
      videoId: contentInfo.videoId,
      season: contentInfo.season,
      episode: contentInfo.episode,
      position: Math.round(position * 1000),
      duration: Math.round(duration * 1000),
      title: meta.name,
      poster: meta.poster || null,
      background: meta.background || null,
      logo: meta.logo || null,
      episodeTitle: video ? video.name || video.title || null : null,
      thumbnail: video ? video.thumbnail || null : null,
      stream: {
        url: stream.url,
        name: stream.name || null,
        title: stream.title || stream.description || null,
        addonUrl: stream.addonUrl || null,
        addonName: stream.addonName || null,
        behaviorHints: stream.behaviorHints || null,
        jellyfin: stream.jellyfin || null,
      },
    }, { important: force });
  }

  // ---------- Controls ----------
  function setIcon(buttonEl, name) {
    buttonEl.replaceChild(icon(name), buttonEl.firstChild);
  }

  function showControls(focusTarget) {
    controlsVisible = true;
    el.classList.add('controls');
    if (focusTarget) focus.set(focusTarget);
    else if (!osd.contains(focus.current)) focus.set(playButton);
    scheduleHide();
  }

  function hideControls() {
    if (menuOpen || playState !== 'playing' || !ready) return;
    controlsVisible = false;
    el.classList.remove('controls');
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideControls, HIDE_CONTROLS_MS);
  }

  function poke() {
    if (!controlsVisible) showControls();
    else scheduleHide();
  }

  function flash(name) {
    clear(centerFlash).appendChild(icon(name));
    centerFlash.classList.remove('show');
    void centerFlash.offsetWidth;
    centerFlash.classList.add('show');
  }

  function togglePause() {
    if (!ready) return;
    if (playState === 'playing') {
      engine.pause();
      flash('pause');
    } else {
      engine.play();
      flash('play');
    }
  }

  function seekTo(time) {
    const target = Math.max(0, duration ? Math.min(duration - 1, time) : time);
    lastTime = target;
    lastTimeAt = performance.now();
    engine.seek(target);
    renderTimeline();
    if (nextInfo && target < duration - 60) cancelNext(false);
  }

  function seekBy(delta) {
    seekTo(currentTime() + delta);
  }

  // Scrubbing with left/right on the seek bar: move a preview, jump when the user stops.
  function scrub(direction, repeat) {
    scrubRepeat = repeat ? scrubRepeat + 1 : 0;
    const step = scrubRepeat > 20 ? 60 : scrubRepeat > 8 ? 30 : SEEK_STEP;
    const base = scrubTarget == null ? currentTime() : scrubTarget;
    scrubTarget = Math.max(0, Math.min(duration || base + step, base + direction * step));
    el.classList.add('scrubbing');
    renderTimeline();
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(commitScrub, 700);
  }

  function commitScrub() {
    clearTimeout(scrubTimer);
    if (scrubTarget == null) return;
    const target = scrubTarget;
    scrubTarget = null;
    el.classList.remove('scrubbing');
    seekTo(target);
  }

  function renderTimeline() {
    const t = scrubTarget != null ? scrubTarget : currentTime();
    const fraction = duration > 0 ? Math.min(1, t / duration) : 0;
    seekFill.style.width = `${fraction * 100}%`;
    seekThumb.style.left = `${fraction * 100}%`;
    seekPreview.style.left = `${fraction * 100}%`;
    seekPreview.textContent = formatClock(t);
    timeCurrent.textContent = formatClock(t);
    timeTotal.textContent = duration > 0 ? '-' + formatClock(Math.max(0, duration - t)) : '';
  }

  seekBar.addEventListener('click', (e) => {
    if (!duration) return;
    const rect = seekBar.getBoundingClientRect();
    if (e.clientX >= rect.left && e.clientX <= rect.right && e.detail > 0) {
      seekTo(((e.clientX - rect.left) / rect.width) * duration);
    } else commitScrub();
  });

  // ---------- Subtitles drawn by the app ----------
  function renderSubtitles() {
    if (!activeAddonSub || !activeAddonSub.cues) {
      if (subtitleBox.firstChild) clear(subtitleBox);
      return;
    }
    const cues = cuesAt(activeAddonSub.cues, currentTime() - subtitleDelay);
    const html = cues.map((c) => c.text).join('\n');
    if (subtitleBox.__html === html) return;
    subtitleBox.__html = html;
    clear(subtitleBox);
    if (html) {
      const line = h('div', { class: 'sub-line' });
      // Only the simple formatting tags survive parsing; escape everything else.
      line.innerHTML = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/&lt;(\/?)(i|b|u)&gt;/g, '<$1$2>').replace(/\n/g, '<br>');
      subtitleBox.appendChild(line);
    }
  }

  function applySubtitleStyle() {
    const size = settings.get('subtitleSize') / 100;
    subtitleBox.style.setProperty('--sub-size', `${2.4 * size}rem`);
    subtitleBox.style.setProperty('--sub-color', settings.get('subtitleColor'));
    subtitleBox.style.setProperty('--sub-offset', `${settings.get('subtitleOffset')}%`);
    subtitleBox.dataset.background = settings.get('subtitleBackground');
  }
  applySubtitleStyle();
  cleanups.push(events.on('settings', applySubtitleStyle));

  async function loadAddonSubtitles() {
    const fromStream = (stream.subtitles || []).filter((s) => s && s.url).map((s) => ({ ...s, addonName: stream.addonName || 'Stream' }));
    let fromAddons = [];
    try {
      const hints = stream.behaviorHints || {};
      const extra = {};
      if (hints.videoHash) extra.videoHash = hints.videoHash;
      if (hints.videoSize) extra.videoSize = hints.videoSize;
      if (hints.filename) extra.filename = hints.filename;
      fromAddons = await fetchSubtitles(meta.type, contentInfo.videoId, extra);
    } catch (error) {
      console.warn('Subtitles failed to load', error);
    }
    if (closed) return;
    addonSubtitles = [...fromStream, ...fromAddons].map((s, i) => ({ ...s, key: `${i}:${s.url}` }));
    // With VLC, wait for the file's own tracks so a matching built-in track wins.
    if (tracksInitialised || !engine.hasEmbeddedTracks) applySubtitlePreference(false);
  }

  async function selectAddonSubtitle(sub) {
    if (!sub) {
      activeAddonSub = null;
      renderSubtitles();
      return;
    }
    engine.setSubtitleTrack(-1);
    activeAddonSub = { sub, cues: null };
    try {
      const cues = await loadSubtitleCues(sub.url);
      if (activeAddonSub && activeAddonSub.sub === sub) activeAddonSub.cues = cues;
    } catch (error) {
      toast('Couldn\'t load those subtitles', { kind: 'error' });
      if (activeAddonSub && activeAddonSub.sub === sub) activeAddonSub = null;
    }
  }

  function applyTrackPreferences() {
    const audioLang = settings.get('preferredAudioLanguage');
    if (audioLang && tracks.audio.length > 1) {
      const current = tracks.audio.find((t) => t.id === tracks.audioId);
      if (!current || !languageMatches(current.lang || current.name, audioLang)) {
        const wanted = tracks.audio.find((t) => languageMatches(t.lang, audioLang) || languageMatches(t.name, audioLang));
        if (wanted) engine.setAudioTrack(wanted.id);
      }
    }
    applySubtitlePreference(true);
  }

  // Picks subtitles once: built into the file if one matches the language, otherwise from an addon.
  let subtitleChosen = false;
  function applySubtitlePreference(fromTracks) {
    if (subtitleChosen || !settings.get('autoSelectSubtitles')) return;
    const langs = [settings.get('preferredSubtitleLanguage'), settings.get('secondarySubtitleLanguage')].filter(Boolean);
    for (const lang of langs) {
      const embedded = tracks.subtitles.find((t) => languageMatches(t.lang, lang) || languageMatches(t.name, lang));
      if (embedded) {
        subtitleChosen = true;
        engine.setSubtitleTrack(embedded.id);
        return;
      }
      const addon = addonSubtitles.find((s) => languageMatches(s.lang, lang));
      if (addon) {
        subtitleChosen = true;
        selectAddonSubtitle(addon);
        return;
      }
    }
    if (!fromTracks && addonSubtitles.length) subtitleChosen = true;
  }

  // ---------- Menus ----------
  async function menu(options) {
    menuOpen = true;
    clearTimeout(hideTimer);
    el.classList.add('menu-open');
    try {
      return await choicePanel(options);
    } finally {
      menuOpen = false;
      el.classList.remove('menu-open');
      scheduleHide();
    }
  }

  async function openSubtitleMenu() {
    const items = [{ label: 'Off', value: { kind: 'off' }, selected: !activeAddonSub && tracks.subtitleId < 0 }];
    if (tracks.subtitles.length) {
      items.push({ header: 'In the video' });
      for (const t of tracks.subtitles) {
        items.push({ label: trackLabel(t), description: t.codec ? t.codec.toUpperCase() : null, value: { kind: 'track', id: t.id }, selected: !activeAddonSub && t.id === tracks.subtitleId });
      }
    }
    if (addonSubtitles.length) {
      // Preferred languages first, then alphabetical.
      const prefs = [settings.get('preferredSubtitleLanguage'), settings.get('secondarySubtitleLanguage')].filter(Boolean);
      const rank = (s) => {
        const i = prefs.findIndex((p) => languageMatches(s.lang, p));
        return i < 0 ? prefs.length : i;
      };
      const sorted = [...addonSubtitles].sort((a, b) => rank(a) - rank(b) || languageName(a.lang).localeCompare(languageName(b.lang)));
      items.push({ header: 'From addons' });
      const counts = {};
      for (const s of sorted) {
        const name = languageName(s.lang);
        counts[name] = (counts[name] || 0) + 1;
        const label = sorted.filter((x) => languageName(x.lang) === name).length > 1 ? `${name} ${counts[name]}` : name;
        items.push({ label, description: s.addonName, value: { kind: 'addon', sub: s }, selected: activeAddonSub && activeAddonSub.sub.key === s.key });
      }
    }
    items.push({ header: 'Options' });
    items.push({ label: 'Subtitle delay', description: `${subtitleDelay >= 0 ? '+' : ''}${subtitleDelay.toFixed(2)}s`, value: { kind: 'delay' } });
    const choice = await menu({ title: 'Subtitles', items });
    if (!choice) return;
    subtitleChosen = true;
    if (choice.kind === 'off') {
      activeAddonSub = null;
      engine.setSubtitleTrack(-1);
      renderSubtitles();
    } else if (choice.kind === 'track') {
      activeAddonSub = null;
      renderSubtitles();
      engine.setSubtitleTrack(choice.id);
    } else if (choice.kind === 'addon') {
      selectAddonSubtitle(choice.sub);
    } else if (choice.kind === 'delay') {
      openDelayMenu();
    }
  }

  async function openDelayMenu() {
    const steps = [-2, -1, -0.5, -0.25, -0.1, 0, 0.1, 0.25, 0.5, 1, 2];
    const choice = await menu({
      title: 'Subtitle delay',
      items: steps.map((s) => ({
        label: s === 0 ? 'Reset' : `${s > 0 ? '+' : ''}${s}s`,
        description: s === 0 ? 'Back to no delay' : s > 0 ? 'Subtitles later' : 'Subtitles earlier',
        value: s,
      })),
    });
    if (choice == null) return;
    subtitleDelay = choice === 0 ? 0 : subtitleDelay + choice;
    engine.setSubtitleDelay(Math.round(subtitleDelay * 1000));
    toast(`Subtitle delay ${subtitleDelay >= 0 ? '+' : ''}${subtitleDelay.toFixed(2)}s`);
    openDelayMenu();
  }

  async function openAudioMenu() {
    if (!tracks.audio.length) {
      toast(engine.hasEmbeddedTracks ? 'No audio tracks found yet' : 'Audio tracks can be changed in the Xbox app');
      return;
    }
    const choice = await menu({
      title: 'Audio',
      items: tracks.audio.map((t) => ({ label: trackLabel(t), description: t.codec ? t.codec.toUpperCase() : null, value: t.id, selected: t.id === tracks.audioId })),
    });
    if (choice != null) engine.setAudioTrack(choice);
  }

  async function openSpeedMenu() {
    const choice = await menu({ title: 'Playback speed', items: SPEEDS.map((s) => ({ label: s === 1 ? 'Normal' : `${s}×`, value: s, selected: s === rate })) });
    if (choice == null) return;
    rate = choice;
    lastTime = currentTime();
    lastTimeAt = performance.now();
    engine.setRate(rate);
  }

  async function openAspectMenu() {
    const choice = await menu({ title: 'Aspect ratio', items: ASPECTS.map(([value, label]) => ({ label, value, selected: value === aspect })) });
    if (choice == null) return;
    aspect = choice;
    engine.setAspect(aspect);
  }

  async function openSourcesMenu() {
    const items = sources.map((s, i) => {
      const d = describeStream(s, s.addonName || '');
      return {
        label: d.name,
        description: [s.addonName, d.sizeText, ...d.badges].filter(Boolean).join(' · '),
        badge: d.resolution,
        value: i,
        selected: s.url === stream.url,
      };
    });
    const choice = await menu({ title: 'Sources', items });
    if (choice == null || sources[choice].url === stream.url) return;
    save(true);
    start(sources[choice], currentTime());
  }

  async function openEpisodesMenu() {
    let full = meta;
    if (!full.videos) {
      try {
        full = await fetchMeta(meta.type, meta.id);
      } catch {
        toast('Couldn\'t load the episode list', { kind: 'error' });
        return;
      }
    }
    const videos = sortedVideos(full).filter((v) => v.season === contentInfo.season);
    const choice = await menu({
      title: contentInfo.season === 0 ? 'Specials' : `Season ${contentInfo.season}`,
      items: videos.map((v) => ({
        label: `${v.episode}. ${v.name || v.title || 'Episode ' + v.episode}`,
        description: isReleased(v) ? null : 'Not released yet',
        value: v,
        selected: v.episode === contentInfo.episode,
      })),
    });
    if (!choice || choice.episode === contentInfo.episode) return;
    save(true);
    router.replace(`streams/${meta.type}/${encodeURIComponent(meta.id)}/${encodeURIComponent(choice.id)}`, { meta: full, video: choice });
  }

  function trackLabel(t) {
    const lang = t.lang ? languageName(t.lang) : null;
    const name = (t.title || t.name || '').replace(/^Track \d+\s*-?\s*/i, '').replace(/^\[|\]$/g, '');
    return [lang, name && name !== lang ? name : null].filter(Boolean).join(' · ') || `Track ${t.id}`;
  }

  // ---------- Next episode ----------
  function maybeOfferNext() {
    if (!isSeries || !settings.get('autoplayNext') || nextDismissed || nextInfo || !duration || duration < 300) return;
    // Offer the next episode in the last 30 seconds (or 3%, for long episodes with credits).
    const remaining = duration - currentTime();
    if (remaining > 0 && remaining <= Math.max(30, duration * 0.03)) startNextCountdown(false);
  }

  async function findNextVideo() {
    let full = meta;
    if (!full.videos) full = await fetchMeta(meta.type, meta.id);
    const next = nextEpisode(full, contentInfo.season, contentInfo.episode);
    return next && isReleased(next) ? { full, next } : null;
  }

  async function startNextCountdown(atEnd) {
    if (nextInfo) {
      if (atEnd) nextInfo.atEnd = true;
      return;
    }
    nextInfo = { atEnd, countdown: settings.get('nextEpisodeCountdown'), timer: 0 };
    let found;
    try {
      found = await findNextVideo();
    } catch {
      found = null;
    }
    if (!nextInfo || closed) return;
    if (!found) {
      nextInfo = null;
      nextDismissed = true;
      if (atEnd) exit();
      return;
    }
    nextInfo.video = found.next;
    nextInfo.meta = found.full;
    renderNextCard();
    nextInfo.timer = setInterval(() => {
      if (!nextInfo) return;
      // Count down only once the episode has ended, or while it plays its credits.
      if (playState !== 'playing' && !nextInfo.atEnd) return;
      nextInfo.countdown--;
      if (nextInfo.countdown <= 0) playNext();
      else renderNextCard();
    }, 1000);
  }

  function renderNextCard() {
    const v = nextInfo.video;
    clear(nextCard);
    const play = button(`Play now`, { variant: 'primary', icon: 'play', onClick: () => playNext() });
    append(nextCard, [
      v.thumbnail ? img(v.thumbnail, { class: 'next-thumb' }) : null,
      h('div', { class: 'next-info' },
        h('div', { class: 'next-label' }, `Next Episode · ${nextInfo.countdown}s`),
        h('div', { class: 'next-title' }, `${formatEpisodeCode(v.season, v.episode)} ${v.name || v.title || ''}`),
        h('div', { class: 'next-actions' }, play, button('Cancel', { onClick: () => cancelNext(true) })))]);
    const wasHidden = nextCard.hidden;
    nextCard.hidden = false;
    if (wasHidden) focus.set(play);
  }

  function cancelNext(byUser) {
    if (!nextInfo) return;
    clearInterval(nextInfo.timer);
    const atEnd = nextInfo.atEnd;
    nextInfo = null;
    nextDismissed = byUser;
    nextCard.hidden = true;
    if (atEnd && byUser) exit();
    else showControls();
  }

  async function playNext() {
    let target = nextInfo && nextInfo.video ? { full: nextInfo.meta, next: nextInfo.video } : null;
    if (nextInfo) clearInterval(nextInfo.timer);
    nextInfo = null;
    nextCard.hidden = true;
    if (!target) {
      try {
        target = await findNextVideo();
      } catch {
        target = null;
      }
      if (!target) {
        toast('There is no next episode yet');
        return;
      }
    }
    save(true, ended);
    const { full, next } = target;
    loadingText.textContent = 'Finding a source…';
    ready = false;
    loading.hidden = false;
    // Same addon, and the same release group when the addon marks one (behaviorHints.bingeGroup).
    const addon = enabledAddons().find((a) => a.transportUrl === stream.addonUrl);
    const bingeGroup = stream.behaviorHints && stream.behaviorHints.bingeGroup;
    let picked = null;
    let siblings = [];
    if (addon) {
      try {
        // Torrent results count too when they were being played through a debrid service.
        const usable = (s) => isPlayable(s) || (!!s.infoHash && !!stream.infoHash && !!debridAccount());
        const streams = (await fetchStreams(addon, meta.type, next.id)).filter(usable);
        siblings = streams.map((s) => ({ ...s, addonUrl: addon.transportUrl, addonName: stream.addonName }));
        picked = (bingeGroup && siblings.find((s) => s.behaviorHints && s.behaviorHints.bingeGroup === bingeGroup)) || siblings[0] || null;
        if (picked && !isPlayable(picked)) {
          loadingText.textContent = 'Resolving with your debrid service…';
          const link = await resolveTorrent(picked, { season: next.season, episode: next.episode });
          picked = { ...picked, url: link.url, behaviorHints: { ...(picked.behaviorHints || {}), filename: link.filename || undefined } };
        }
        siblings = siblings.filter(isPlayable);
      } catch {
        picked = null;
      }
    }
    if (closed) return;
    if (picked) router.replace('player', { meta: full, video: next, stream: picked, streams: siblings });
    else router.replace(`streams/${meta.type}/${encodeURIComponent(meta.id)}/${encodeURIComponent(next.id)}`, { meta: full, video: next });
  }

  // ---------- Errors ----------
  function showError(message) {
    ready = false;
    loading.hidden = true;
    el.classList.remove('ready');
    if (state.fallbackToStreams) {
      // A saved link from Continue Watching may have expired: pick a fresh one.
      toast('That link no longer works. Pick a source.');
      router.replace(`streams/${meta.type}/${encodeURIComponent(meta.id)}/${encodeURIComponent(contentInfo.videoId)}`, { meta, video });
      return;
    }
    clear(errorBox);
    const index = sources.findIndex((s) => s.url === stream.url);
    const nextSource = sources.slice(index + 1).find(isPlayable);
    errorBox.append(
      icon('warning', 'error-icon'),
      h('h2', null, 'Unable to play this stream'),
      h('p', null, message),
      h('div', { class: 'error-actions' },
        nextSource ? button('Try next source', { variant: 'primary', autofocus: true, onClick: () => start(nextSource, lastTime) }) : null,
        button('Retry', { variant: nextSource ? 'secondary' : 'primary', onClick: () => start(stream, lastTime) }),
        button('Choose another source', { onClick: () => exit() })));
    errorBox.hidden = false;
    focus.restore(errorBox);
  }

  function exit() {
    if (closed) return;
    commitScrub();
    save(true);
    report('stop');
    router.back();
  }

  // ---------- Input ----------
  function onInput(action, repeat) {
    if (!errorBox.hidden) return false;
    if (!nextCard.hidden) {
      if (action === 'back') {
        cancelNext(true);
        return true;
      }
      return false;
    }
    if (action === 'playpause' || action === 'x') {
      togglePause();
      poke();
      return true;
    }
    if (action === 'lt' || action === 'rt') {
      seekBy(action === 'lt' ? -30 : 30);
      showControls(seekBar);
      return true;
    }
    if (action === 'rb' && isSeries) {
      playNext();
      return true;
    }
    if (action === 'y') {
      openSubtitleMenu();
      return true;
    }
    if (action === 'view' || action === 'menu') {
      openAudioMenu();
      return true;
    }
    if (!controlsVisible) {
      if (action === 'left' || action === 'right') {
        showControls(seekBar);
        scrub(action === 'left' ? -1 : 1, repeat);
        return true;
      }
      if (action === 'select') {
        togglePause();
        showControls(playButton);
        return true;
      }
      if (action === 'up' || action === 'down') {
        showControls(playButton);
        return true;
      }
      return false; // back: leave the player
    }
    poke();
    if (focus.current === seekBar && (action === 'left' || action === 'right')) {
      scrub(action === 'left' ? -1 : 1, repeat);
      return true;
    }
    if (focus.current === seekBar && action === 'select') {
      if (scrubTarget != null) commitScrub();
      else togglePause();
      return true;
    }
    return false;
  }

  function onBack() {
    if (scrubTarget != null) {
      scrubTarget = null;
      clearTimeout(scrubTimer);
      el.classList.remove('scrubbing');
      renderTimeline();
      return true;
    }
    if (controlsVisible && ready && playState === 'playing') {
      controlsVisible = false;
      el.classList.remove('controls');
      return true;
    }
    exit();
    return true;
  }

  el.addEventListener('pointermove', () => poke(), { passive: true });

  // ---------- Frame loop: timeline and subtitles ----------
  let frame = 0;
  const tick = () => {
    if (closed) return;
    if (controlsVisible) renderTimeline();
    renderSubtitles();
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  // Pause when the app goes to the background on the console.
  cleanups.push(events.on('native:app.visibility', ({ visible }) => {
    if (!visible && playState === 'playing') engine.pause();
  }));
  const onVisibility = () => {
    if (document.hidden) save(true);
  };
  document.addEventListener('visibilitychange', onVisibility);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

  if (bridge.native) document.documentElement.classList.add('native-video');
  showControls();

  return {
    el,
    chrome: 'player',
    onInput,
    onBack,
    onShow() {
      document.documentElement.classList.add('playing');
    },
    onHide() {
      document.documentElement.classList.remove('playing');
    },
    destroy() {
      closed = true;
      save(true);
      report('stop');
      cancelAnimationFrame(frame);
      clearTimeout(hideTimer);
      clearTimeout(scrubTimer);
      if (nextInfo) clearInterval(nextInfo.timer);
      cleanups.forEach((off) => off());
      engine.destroy();
      document.documentElement.classList.remove('playing');
    },
  };
}
