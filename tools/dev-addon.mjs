// A tiny Stremio addon for testing playback without a debrid account: every movie and episode
// gets a few public sample videos (plus one torrent-only result and a subtitle file).
// node tools/dev-addon.mjs [port]  ->  install http://localhost:7001/manifest.json in the app.
import http from 'node:http';
import os from 'node:os';

const port = Number(process.argv[2] || 7001);

const manifest = {
  id: 'dev.nuvio.samples',
  version: '1.0.0',
  name: 'Sample Streams (dev)',
  description: 'Public sample videos for testing the player.',
  resources: ['stream', 'subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

const streams = (base) => [
  {
    name: 'Samples\n720p VP9',
    title: 'Big.Buck.Bunny.2008.720p.VP9.webm (royalty-free codec, plays in any browser)\n💾 70 MB ⚙️ Wikimedia',
    url: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.720p.vp9.webm',
    behaviorHints: { bingeGroup: 'dev-samples-webm', filename: 'Big_Buck_Bunny_4K.webm.720p.vp9.webm' },
  },
  {
    name: 'Samples\n720p',
    title: 'Big.Buck.Bunny.2008.720p.H264.AAC.mp4 (plays in any browser)\n💾 64 MB ⚙️ W3C',
    url: 'https://media.w3.org/2010/05/bunny/movie.mp4',
    behaviorHints: { bingeGroup: 'dev-samples-720p', filename: 'movie.mp4' },
  },
  {
    name: '[RD+] Samples\n1080p',
    title: 'Big.Buck.Bunny.720p.surround.mp4 (redirects, like a debrid link)\n💾 210 MB',
    url: 'https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4',
    behaviorHints: { bingeGroup: 'dev-samples-archive' },
  },
  {
    name: '[RD+] Samples\n4K',
    title: 'Sintel.2010.2048p.surround.mp4\n💾 1.2 GB',
    url: 'https://archive.org/download/Sintel/sintel-2048-surround.mp4',
  },
  {
    name: 'Samples\n1080p MKV',
    title: 'Sintel.2010.1080p.mkv (Matroska: VLC only, browsers refuse it)\n💾 1.1 GB',
    url: 'https://download.blender.org/durian/movies/Sintel.2010.1080p.mkv',
  },
  {
    name: 'Samples\n1080p HEVC',
    title: 'Jellyfish.1080p.HEVC.10s.mp4 (H.265)\n💾 30 MB',
    url: 'https://test-videos.co.uk/vids/jellyfish/mp4/h265/1080/Jellyfish_1080_10s_30MB.mp4',
  },
  {
    name: 'Samples\nbroken link',
    title: 'This link returns 404, to test the error screen',
    url: `${base}/missing.mp4`,
  },
  {
    name: 'Samples\nTorrent',
    title: 'Torrent-only result (needs debrid)\n👤 120 💾 2.4 GB',
    infoHash: '0123456789abcdef0123456789abcdef01234567',
  },
];

function srt() {
  const lines = [];
  for (let i = 0; i < 400; i++) {
    const start = i * 4;
    const stamp = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},000`;
    lines.push(`${i + 1}\n${stamp(start)} --> ${stamp(start + 3)}\nSample subtitle line ${i + 1}\n<i>second line in italics</i>\n`);
  }
  return lines.join('\n');
}

http.createServer((req, res) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
  const base = `http://${req.headers.host}`;
  const path = new URL(req.url, base).pathname;
  const json = (data) => {
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (path === '/manifest.json') return json(manifest);
  if (path.startsWith('/stream/')) return json({ streams: streams(base) });
  if (path.startsWith('/subtitles/')) return json({ subtitles: [{ id: 'dev-eng', url: `${base}/sample.srt`, lang: 'eng' }, { id: 'dev-spa', url: `${base}/sample.srt`, lang: 'spa' }] });
  if (path === '/sample.srt') {
    res.writeHead(200, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(srt());
  }
  res.writeHead(404, headers).end();
}).listen(port, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
  console.log(`Dev addon: http://localhost:${port}/manifest.json${lan ? `  (Xbox: http://${lan.address}:${port}/manifest.json)` : ''}`);
});
