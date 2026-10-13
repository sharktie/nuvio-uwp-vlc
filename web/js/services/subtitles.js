// Addon subtitles are drawn by the app over the video (VLC draws subtitles built into the file).
// This parses SRT, WebVTT and (simply) ASS/SSA into cues.

import { getText } from '../core/http.js';

const LANGUAGES = {
  eng: 'English', en: 'English', spa: 'Spanish', es: 'Spanish', spn: 'Spanish', fre: 'French', fra: 'French', fr: 'French',
  ger: 'German', deu: 'German', de: 'German', ita: 'Italian', it: 'Italian', por: 'Portuguese', pt: 'Portuguese',
  pob: 'Portuguese (BR)', 'pt-br': 'Portuguese (BR)', rus: 'Russian', ru: 'Russian', ara: 'Arabic', ar: 'Arabic',
  hin: 'Hindi', hi: 'Hindi', jpn: 'Japanese', ja: 'Japanese', kor: 'Korean', ko: 'Korean', chi: 'Chinese', zho: 'Chinese',
  zh: 'Chinese', ze: 'Chinese', zht: 'Chinese (Traditional)', zhs: 'Chinese (Simplified)', chs: 'Chinese (Simplified)', cht: 'Chinese (Traditional)', 'zh-tw': 'Chinese (Traditional)', 'zh-cn': 'Chinese (Simplified)', dut: 'Dutch', nld: 'Dutch', nl: 'Dutch', pol: 'Polish', pl: 'Polish', tur: 'Turkish', tr: 'Turkish',
  swe: 'Swedish', sv: 'Swedish', nor: 'Norwegian', nob: 'Norwegian', no: 'Norwegian', dan: 'Danish', da: 'Danish', fin: 'Finnish',
  fi: 'Finnish', gre: 'Greek', ell: 'Greek', el: 'Greek', heb: 'Hebrew', he: 'Hebrew', hun: 'Hungarian', hu: 'Hungarian',
  cze: 'Czech', ces: 'Czech', cs: 'Czech', rum: 'Romanian', ron: 'Romanian', ro: 'Romanian', bul: 'Bulgarian', bg: 'Bulgarian',
  hrv: 'Croatian', hr: 'Croatian', srp: 'Serbian', sr: 'Serbian', slv: 'Slovenian', slo: 'Slovak', slk: 'Slovak',
  ukr: 'Ukrainian', uk: 'Ukrainian', vie: 'Vietnamese', vi: 'Vietnamese', tha: 'Thai', th: 'Thai', ind: 'Indonesian',
  id: 'Indonesian', may: 'Malay', msa: 'Malay', per: 'Persian', fas: 'Persian', fa: 'Persian', ben: 'Bengali', bn: 'Bengali',
  tam: 'Tamil', ta: 'Tamil', tel: 'Telugu', te: 'Telugu', mal: 'Malayalam', ml: 'Malayalam', urd: 'Urdu', ur: 'Urdu',
  cat: 'Catalan', baq: 'Basque', eus: 'Basque', glg: 'Galician', est: 'Estonian', lav: 'Latvian', lit: 'Lithuanian',
  ice: 'Icelandic', isl: 'Icelandic', alb: 'Albanian', sqi: 'Albanian', mac: 'Macedonian', mkd: 'Macedonian', bos: 'Bosnian',
  tgl: 'Filipino', fil: 'Filipino',
};

export function languageName(code) {
  if (!code) return 'Unknown';
  const key = String(code).toLowerCase();
  return LANGUAGES[key] || LANGUAGES[key.split(/[-_]/)[0]] || code;
}

/** Whether a track/subtitle language matches a preferred ISO 639-2 code such as "eng". */
export function languageMatches(code, preferred) {
  if (!code || !preferred) return false;
  return languageName(code).toLowerCase() === languageName(preferred).toLowerCase();
}

export const LANGUAGE_CHOICES = [
  ['eng', 'English'], ['spa', 'Spanish'], ['fre', 'French'], ['ger', 'German'], ['ita', 'Italian'], ['por', 'Portuguese'],
  ['pob', 'Portuguese (BR)'], ['rus', 'Russian'], ['ara', 'Arabic'], ['hin', 'Hindi'], ['jpn', 'Japanese'], ['kor', 'Korean'],
  ['chi', 'Chinese'], ['dut', 'Dutch'], ['pol', 'Polish'], ['tur', 'Turkish'], ['swe', 'Swedish'], ['nor', 'Norwegian'],
  ['dan', 'Danish'], ['fin', 'Finnish'], ['gre', 'Greek'], ['heb', 'Hebrew'], ['hun', 'Hungarian'], ['cze', 'Czech'],
  ['rum', 'Romanian'], ['ukr', 'Ukrainian'], ['vie', 'Vietnamese'], ['tha', 'Thai'], ['ind', 'Indonesian'], ['per', 'Persian'],
  ['tam', 'Tamil'], ['tel', 'Telugu'], ['mal', 'Malayalam'], ['ben', 'Bengali'], ['urd', 'Urdu'],
];

export async function loadSubtitleCues(url) {
  const text = await getText(url);
  return parseSubtitles(text);
}

export function parseSubtitles(text) {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (/^\s*\[Script Info\]/i.test(clean) || /^Dialogue:/m.test(clean)) return parseAss(clean);
  return parseSrtOrVtt(clean);
}

function toSeconds(stamp) {
  const match = stamp.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/);
  if (!match) return NaN;
  const [, h, m, s, ms] = match;
  return (Number(h) || 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
}

function cleanText(text) {
  return text
    .replace(/<\/?(i|b|u|em|strong)>/gi, (tag) => tag.toLowerCase().replace('em', 'i').replace('strong', 'b'))
    .replace(/<(?!\/?(i|b|u)>)[^>]*>/gi, '')
    .replace(/\{\\[^}]*\}/g, '')
    .trim();
}

function parseSrtOrVtt(text) {
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timeIndex = lines.findIndex((l) => l.includes('-->'));
    if (timeIndex < 0) continue;
    const [from, to] = lines[timeIndex].split('-->');
    const start = toSeconds(from);
    const end = toSeconds(to.trim().split(/\s+/)[0]);
    const body = cleanText(lines.slice(timeIndex + 1).join('\n'));
    if (Number.isFinite(start) && Number.isFinite(end) && body) cues.push({ start, end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function parseAss(text) {
  const cues = [];
  let format = null;
  for (const line of text.split('\n')) {
    if (/^Format:/i.test(line) && !format) {
      const fields = line.slice(7).split(',').map((s) => s.trim().toLowerCase());
      if (fields.includes('text')) format = fields;
      continue;
    }
    if (!/^Dialogue:/i.test(line)) continue;
    const fields = format || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const parts = line.slice(9).split(',');
    const value = (name) => parts[fields.indexOf(name)];
    const body = parts.slice(fields.length - 1).join(',')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/gi, '\n')
      .replace(/\\h/g, ' ')
      .trim();
    const start = toSeconds(value('start') || '');
    const end = toSeconds(value('end') || '');
    if (Number.isFinite(start) && Number.isFinite(end) && body) cues.push({ start, end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** The cues showing at time t (seconds). */
export function cuesAt(cues, t) {
  let lo = 0;
  let hi = cues.length - 1;
  // Last cue starting at or before t.
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) lo = mid + 1;
    else hi = mid - 1;
  }
  const active = [];
  for (let i = hi; i >= 0 && i > hi - 8; i--) {
    if (cues[i].end > t) active.unshift(cues[i]);
  }
  return active;
}
