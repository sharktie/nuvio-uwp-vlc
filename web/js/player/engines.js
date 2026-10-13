// Playback engines with one interface. In the app, NativeEngine plays through VLC (drawn under
// the page); in a browser, Html5Engine uses a <video> element.
//
// Events: state {state: opening|buffering|playing|paused}, time {time, duration}, duration
// {duration}, buffering {percent}, tracks {audio, subtitles, audioId, subtitleId}, ready, ended
// {reason: eof|error, message}.

import { bridge } from '../core/bridge.js';
import { events } from '../core/store.js';

class Emitter {
  constructor() {
    this.handlers = {};
  }
  on(type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
  }
  emit(type, data = {}) {
    for (const fn of this.handlers[type] || []) {
      try {
        fn(data);
      } catch (error) {
        console.error('Player event handler failed', type, error);
      }
    }
  }
}

export class NativeEngine extends Emitter {
  constructor() {
    super();
    this.id = null;
    this.drawsUnderPage = true;
    this.hasEmbeddedTracks = true;
    this.offs = ['state', 'time', 'duration', 'buffering', 'tracks', 'ready', 'ended', 'video'].map((name) =>
      events.on('native:player.' + name, (message) => {
        if (message.id === this.id) this.emit(name, message);
      }));
  }

  open({ url, start = 0, headers = {}, hwdec = true }) {
    this.id = 'load-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    bridge.send('player.open', { id: this.id, url, start, headers, hwdec });
  }
  play() { bridge.send('player.play'); }
  pause() { bridge.send('player.pause', { paused: true }); }
  toggle() { bridge.send('player.toggle'); }
  seek(time) { bridge.send('player.seek', { time: Math.max(0, time) }); }
  setRate(rate) { bridge.send('player.rate', { rate }); }
  setAudioTrack(trackId) { bridge.send('player.audioTrack', { trackId }); }
  setSubtitleTrack(trackId) { bridge.send('player.subtitleTrack', { trackId }); }
  setSubtitleDelay(ms) { bridge.send('player.subtitleDelay', { ms }); }
  setAspect(mode) { bridge.send('player.aspect', { mode }); }
  stop() {
    this.id = null;
    bridge.send('player.stop');
  }
  destroy() {
    this.stop();
    this.offs.forEach((off) => off());
  }
}

export class Html5Engine extends Emitter {
  constructor(container) {
    super();
    this.drawsUnderPage = false;
    this.hasEmbeddedTracks = false;
    this.video = document.createElement('video');
    this.video.className = 'player-video';
    this.video.playsInline = true;
    this.video.preload = 'auto';
    container.appendChild(this.video);
    this.readySent = false;
    this.aspect = 'fit';
    const v = this.video;
    v.addEventListener('playing', () => {
      this.emit('state', { state: 'playing' });
      if (!this.readySent) {
        this.readySent = true;
        this.emit('ready');
      }
    });
    v.addEventListener('pause', () => {
      if (!v.ended) this.emit('state', { state: 'paused' });
    });
    v.addEventListener('waiting', () => this.emit('buffering', { percent: 0 }));
    v.addEventListener('canplay', () => this.emit('buffering', { percent: 100 }));
    v.addEventListener('timeupdate', () => this.emit('time', { time: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : 0 }));
    v.addEventListener('durationchange', () => {
      if (Number.isFinite(v.duration) && v.duration > 0) this.emit('duration', { duration: v.duration });
    });
    v.addEventListener('loadedmetadata', () => this.emit('tracks', { audio: [], subtitles: [], audioId: -1, subtitleId: -1 }));
    v.addEventListener('ended', () => this.emit('ended', { reason: 'eof' }));
    v.addEventListener('error', () => {
      const code = v.error ? v.error.code : 0;
      this.emit('ended', {
        reason: 'error',
        message: code === 4
          ? 'Your browser can\'t play this format. In the Xbox app, VLC plays it.'
          : 'This stream could not be played.',
      });
    });
  }

  open({ url, start = 0 }) {
    this.readySent = false;
    this.emit('state', { state: 'opening' });
    this.video.src = url;
    if (start > 0) {
      this.video.addEventListener('loadedmetadata', () => (this.video.currentTime = start), { once: true });
    }
    this.video.play().catch(() => this.emit('state', { state: 'paused' }));
  }
  play() { this.video.play().catch(() => {}); }
  pause() { this.video.pause(); }
  toggle() { if (this.video.paused) this.play(); else this.pause(); }
  seek(time) { this.video.currentTime = Math.max(0, time); }
  setRate(rate) { this.video.playbackRate = rate; }
  setAudioTrack() {}
  setSubtitleTrack() {}
  setSubtitleDelay() {}
  setAspect(mode) {
    this.aspect = mode;
    this.video.style.objectFit = mode === 'fill' ? 'cover' : mode === 'stretch' ? 'fill' : 'contain';
  }
  stop() {
    this.video.removeAttribute('src');
    this.video.load();
  }
  destroy() {
    this.stop();
    this.video.remove();
  }
}

export function createEngine(container) {
  return bridge.native ? new NativeEngine() : new Html5Engine(container);
}
