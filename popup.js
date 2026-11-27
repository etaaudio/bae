// SPDX-License-Identifier: MPL-2.0
// BAE. Copyright (C) 2026 ETA Audio LLC.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const api = globalThis.browser || globalThis.chrome;
const DEFAULTS = {
  audioCodec: 'auto', videoCodec: 'auto',
  trueVolume: true, showCodec: true, showAttenuation: true, showSpeed: true, showBuffer: false,
  speed: 1, pitchCorrection: true, unity: false, crossfeed: 'off', beef: 'off', guardMode: 'limiter', audioPath: 'tap',
  outputId: '', outputLabel: ''
};
const settings = { ...DEFAULTS };
const el = id => document.getElementById(id);
const switches = Array.from(document.querySelectorAll('.switch[data-key]'));
const percent = value => Math.round(value * 100) + '%';
const MINUS = '\u2212';

let tabId = null;
let reloadingUntil = 0;
let site = 'youtube'; // which player the popup is looking at: 'youtube' | 'spotify' | 'other'

async function ask(message) {
  if (tabId === null) return null;
  try {
    return (await api.tabs.sendMessage(tabId, message)) || null;
  } catch (_) {
    return null; // no YouTube page in this tab, or no access to it
  }
}

function showSwitches() {
  for (const button of switches) {
    button.setAttribute('aria-checked', String(!!settings[button.dataset.key]));
    // 0 dB bypass overrides the ordinary attenuation bypass, so that one is
    // greyed out while 0 dB is on.
    if (button.dataset.key === 'trueVolume') button.disabled = !!settings.unity;
    if (button.dataset.key === 'pitchCorrection') button.disabled = !!settings.unity;
  }
  // Purist supersedes everything that alters the sound: those sections are
  // dimmed and locked while it is on. Their own settings are kept for later.
  const purist = !!settings.unity;
  el('puristNote').hidden = !purist;
  for (const key of ['speed', 'attenuation', 'experimental']) {
    const section = document.querySelector('section[data-group="' + key + '"]');
    section.classList.toggle('superseded', purist);
    for (const control of section.querySelectorAll('button, input, select')) control.disabled = purist;
  }
  speedRange.disabled = !!settings.unity;
  el('speedZone').classList.toggle('off', !!settings.unity);
  for (const preset of presets) preset.disabled = !!settings.unity;
  foldForPurist();
}

function say(id, text, tone) {
  el(id).textContent = text;
  el(id).className = 'line' + (tone ? ' ' + tone : '');
}

/* ------------------------------- codec ------------------------------- */

const CODEC_NAMES = [
  ['mp4a.40.29', 'HE-AAC v2'], ['mp4a.40.5', 'HE-AAC'], ['mp4a.40.2', 'AAC-LC'], ['mp4a', 'AAC'],
  ['opus', 'Opus'], ['vorbis', 'Vorbis'], ['ec-3', 'E-AC-3'], ['ac-3', 'AC-3'], ['flac', 'FLAC'], ['alac', 'ALAC'],
  ['av01', 'AV1'], ['vp09', 'VP9'], ['vp9', 'VP9'], ['vp8', 'VP8'],
  ['avc1', 'H.264'], ['avc3', 'H.264'], ['hev1', 'HEVC'], ['hvc1', 'HEVC']
];

// "audio/mp4; codecs=\"mp4a.40.2\"" -> { name: "AAC-LC", id: "mp4a.40.2" }
function codec(mime) {
  if (!mime) return null;
  const match = /codecs\s*=\s*"?([^";]+)/i.exec(mime);
  const id = (match ? match[1] : mime).split(',')[0].trim();
  const low = id.toLowerCase();
  const hit = CODEC_NAMES.find(([prefix]) => low.startsWith(prefix));
  return { name: hit ? hit[1] : id, id };
}

function showFact(id, info) {
  const cell = el(id);
  cell.textContent = '';
  if (!info) {
    cell.textContent = 'Not detected';
    return;
  }
  cell.append(info.name);
  if (info.id !== info.name) {
    const raw = document.createElement('small');
    raw.textContent = ' ' + info.id;
    cell.append(raw);
  }
}

// The codec menus list what the page found: codecs the site offered first,
// then the others this browser plays. Rebuilt only when that list changes.
function fillPicker(select, list, chosen) {
  const key = JSON.stringify([list, chosen]);
  if (select.dataset.key === key) return;
  select.dataset.key = key;
  select.textContent = '';
  select.append(new Option('Auto', 'auto'));
  const group = (label, items, disabled) => {
    if (!items.length) return;
    const box = document.createElement('optgroup');
    box.label = label;
    for (const c of items) {
      const option = new Option(c.name, c.id);
      option.disabled = !!disabled;
      box.append(option);
    }
    select.append(box);
  };
  group('Offered by this site', list.filter(c => c.site && c.browser));
  group('This browser also plays', list.filter(c => !c.site && c.browser));
  group("Offered, but this browser can't play", list.filter(c => c.site && !c.browser), true);
  if (chosen !== 'auto' && !list.some(c => c.id === chosen)) select.append(new Option(chosen.toUpperCase() + ' (not found)', chosen));
  select.value = chosen;
}

// "FLAC · 24-bit · 96 kHz · 2116 kbps"
const audioLine = s => [s.audioName, s.audioBits ? s.audioBits + '-bit' : '',
  s.audioRate ? s.audioRate / 1000 + ' kHz' : '', s.audioKbps ? s.audioKbps + ' kbps' : ''].filter(Boolean).join(' · ');

// One sentence about a forced codec, or '' when there is nothing to say.
function forcedNote(kind, chosen, status) {
  if (chosen === 'auto') return '';
  const list = (status.choices && status.choices[kind]) || [];
  const found = list.find(c => c.id === chosen);
  const name = found ? found.name : chosen.toUpperCase();
  const now = kind === 'audio' ? status.audioId : status.videoId;
  if (found && !found.browser) return "This browser can't play " + name + ', so ' + kind + ' stays on Auto.';
  if (now === chosen) return '';
  if (!found || !found.site) return 'This site hasn\'t offered ' + name + ' yet. If nothing plays, set ' + kind + ' back to Auto.';
  return now ? 'Reload the tab to switch ' + kind + ' to ' + name + '.' : '';
}

const pickers = { audioCodec: el('audioCodec'), videoCodec: el('videoCodec') };
let lastChoices = { audio: [], video: [] };

function showPickers() {
  fillPicker(pickers.audioCodec, lastChoices.audio, settings.audioCodec);
  fillPicker(pickers.videoCodec, lastChoices.video, settings.videoCodec);
}

for (const [key, select] of Object.entries(pickers)) {
  select.addEventListener('change', async () => {
    settings[key] = select.value;
    try { await api.storage.local.set(settings); } catch (_) { /* keep going */ }
    const reply = await ask({ type: 'yta-apply', settings });
    if (reply) {
      // Players pick their formats when the page loads, so load it again.
      reloadingUntil = Date.now() + 5000;
      try { await api.tabs.reload(tabId); } catch (_) { /* keep going */ }
      render(null);
      return;
    }
    render(reply);
  });
}

function showCodec(status) {
  const audio = codec(status.audio) || (status.audioName ? { name: status.audioName, id: status.audioName } : null);
  const video = codec(status.video);
  showFact('audio', audio && { ...audio, name: audioLine({ ...status, audioName: audio.name }) });
  showFact('video', video);
  if (status.choices) lastChoices = status.choices;
  showPickers();
  if (!audio && !video) {
    say('codec', 'Play something, or reload the tab, to detect the codec.');
    return;
  }
  const notes = [forcedNote('audio', settings.audioCodec, status), forcedNote('video', settings.videoCodec, status)].filter(Boolean);
  say('codec', notes.join(' '), notes.length ? 'bad' : '');
}

/* ----------------------------- attenuation ----------------------------- */

function level(name, value) {
  const row = document.querySelector('[data-level="' + name + '"]');
  const known = typeof value === 'number' && isFinite(value);
  row.querySelector('.fill').style.width = known ? percent(Math.min(1, Math.max(0, value))) : '0';
  row.querySelector('.value').textContent = known ? percent(value) : '';
}

function clearMeter() {
  el('meter').classList.remove('bad');
  for (const name of ['user', 'asked', 'real']) level(name);
}

function showDb(main, detail) {
  const box = el('db');
  box.textContent = main;
  if (detail) {
    const small = document.createElement('small');
    small.textContent = ' ' + detail;
    box.append(small);
  }
}

// Shown whenever playback sits below full level: turning a digital signal
// down throws away resolution.
function showBitsWarning(status) {
  const below = status && typeof status.real === 'number' && !status.muted &&
    status.real > 0 && status.real < 0.995;
  el('bits').hidden = !below;
}

function showAttenuation(status) {
  showBitsWarning(status);
  const unity = settings.unity && status.canPatch;
  if (site !== 'youtube') {
    clearMeter();
    level('real', status.real);
    if (unity && typeof status.real === 'number') {
      const full = Math.abs(status.real - 1) < 0.01;
      showDb(status.muted || status.real === 0 ? '–' : full ? '0 dB' : '–', full ? 'full level' : '');
      say('verdict', status.muted || status.real === 0 ? 'Muted.'
        : full ? "Purist: playing at full level; this player's volume slider is ignored."
        : 'Not at full level yet. Nudge the volume slider, or reload the tab.', full ? 'good' : '');
    } else {
      showDb('–');
      say('verdict', 'Attenuation bypass is a YouTube feature. Turn on Purist to play at full level here.');
    }
    return;
  }
  if (typeof status.real !== 'number') {
    clearMeter();
    showDb('–');
    say('verdict', 'No video on this page yet.');
    return;
  }
  level('user', status.user);
  level('asked', status.asked);
  level('real', status.real);
  el('meter').classList.remove('bad');

  if (!status.canPatch) {
    showDb('–');
    say('verdict', "This browser doesn't let the extension control the volume.", 'bad');
    return;
  }
  if (typeof status.user !== 'number') {
    showDb('–');
    say('verdict', "Can't read your volume setting on this page.");
    return;
  }
  if (status.muted || status.user === 0 || status.asked === 0) {
    showDb('–', 'muted');
    say('verdict', 'Muted or at zero volume, so there is nothing to measure.');
    return;
  }

  let db = 20 * Math.log10(status.asked / status.user);
  if (Math.abs(db) < 0.05) db = 0;
  const amount = Math.abs(db).toFixed(1) + ' dB';
  const reduced = db < 0;
  const honored = Math.abs(status.real - (unity ? 1 : status.user)) < 0.01;
  showDb(reduced ? MINUS + amount : '0 dB', reduced ? 'to ' + percent(status.asked / status.user) : 'none');

  if (unity) {
    if (!honored) el('meter').classList.add('bad');
    say('verdict', honored
      ? 'Purist: playing at full level; the volume slider is ignored.'
      : 'Not at full level yet. Nudge the volume slider, or reload the tab.', honored ? 'good' : 'bad');
  } else if (!status.trueVolume) {
    say('verdict', reduced
      ? 'YouTube is turning this video down by ' + amount + '.'
      : "YouTube isn't attenuating this video.");
  } else if (honored) {
    say('verdict', reduced
      ? 'Bypassed. Playing at your setting.'
      : 'Nothing to bypass on this video.', 'good');
  } else {
    el('meter').classList.add('bad');
    say('verdict', 'Still attenuated. Nudge the volume slider, or reload the tab.', 'bad');
  }
}

/* -------------------------------- speed -------------------------------- */

const speedRange = el('speed');
const presets = Array.from(document.querySelectorAll('[data-speed]'));
const times = value => String(Math.round(value * 100) / 100) + '\u00d7';

function showSpeed() {
  const speed = Number(settings.speed) || 1;
  speedRange.value = String(speed);
  el('speedNow').textContent = times(speed);
  for (const button of presets) {
    button.setAttribute('aria-pressed', String(Math.abs(Number(button.dataset.speed) - speed) < 0.001));
  }
}

async function setSpeed(value) {
  const speed = Math.round(Math.min(3, Math.max(0.25, value)) * 100) / 100;
  if (!isFinite(speed) || speed === settings.speed) return;
  settings.speed = speed;
  showSpeed();
  try { await api.storage.local.set(settings); } catch (_) { /* keep going */ }
  render(await ask({ type: 'yta-apply', settings }));
}

speedRange.addEventListener('input', () => setSpeed(parseFloat(speedRange.value)));
for (const button of presets) {
  button.addEventListener('click', () => setSpeed(Number(button.dataset.speed)));
}

// Scroll over the speed readout or the slider to change the speed: up is
// faster, down is slower, 0.05x per notch. Trackpads send many small
// movements, so they are added up until they amount to one notch.
let wheelTravel = 0;
function onSpeedWheel(event) {
  event.preventDefault();
  if (settings.unity) return;
  const delta = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
  if (delta * wheelTravel < 0) wheelTravel = 0; // changed direction: start counting afresh
  wheelTravel += delta;
  const notches = Math.trunc(wheelTravel / 40);
  if (!notches) return;
  wheelTravel -= notches * 40;
  setSpeed((Number(settings.speed) || 1) - notches * 0.05);
}
for (const zone of [el('speedZone'), speedRange]) {
  zone.addEventListener('wheel', onSpeedWheel, { passive: false });
}

// The speed can also change on the page while the popup is open.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.speed) return;
  const speed = Number(changes.speed.newValue);
  if (isFinite(speed) && speed !== settings.speed) {
    settings.speed = speed;
    showSpeed();
  }
});

function showSpeedStatus(status) {
  if (settings.unity) {
    say('speedNote', 'Purist is on: playing at 1×, pitch untouched.');
    return;
  }
  if (typeof status.rate !== 'number') {
    say('speedNote', '');
    return;
  }
  const off = Math.abs(status.rate - settings.speed) > 0.01;
  const notes = [];
  let tone = '';
  if (settings.speed !== 1 && off) {
    notes.push('The player is at ' + times(status.rate) + '. Reload the tab.');
    tone = 'bad';
  } else if (settings.speed === 1 && off) {
    notes.push("Using YouTube's own speed, " + times(status.rate) + '.');
  }
  if (status.pitch === null) {
    notes.push("This browser can't switch pitch correction.");
  } else if (Math.abs(status.rate - 1) > 0.01) {
    notes.push(status.pitch ? 'Pitch is corrected.' : 'Pitch follows the speed.');
  }
  say('speedNote', notes.join(' '), tone);
}

/* -------------------------------- output -------------------------------- */

const outputSelect = el('output');
const unlockButton = el('unlock');

function option(value, text) {
  const item = document.createElement('option');
  item.value = value;
  item.textContent = text;
  return item;
}

// info comes from bridge.js: { supported, devices: [{id, label}], named, selected, current, error? }
function showOutputs(info) {
  outputSelect.textContent = '';
  outputSelect.append(option('', 'System default'));
  unlockButton.hidden = true;

  if (!info) {
    outputSelect.disabled = true;
    say('outputNote', '');
    return;
  }
  if (!info.supported) {
    outputSelect.disabled = true;
    say('outputNote', "This browser can't send a tab's sound to a chosen device. Pick the output in your system sound settings instead.");
    return;
  }

  info.devices.forEach((device, index) => {
    outputSelect.append(option(device.id, device.label || 'Output ' + (index + 1)));
  });
  const selected = info.selected || '';
  if (selected && !info.devices.some(device => device.id === selected)) {
    outputSelect.append(option(selected, (settings.outputLabel || 'Saved device') + ' (not connected)'));
  }
  outputSelect.value = selected;
  outputSelect.disabled = false;

  if (info.error) {
    say('outputNote', info.error === 'NotAllowedError'
      ? 'Microphone permission was declined, so the device list stays hidden.'
      : "Couldn't read the device list (" + info.error + ').', 'bad');
    unlockButton.hidden = info.named;
  } else if (!info.named) {
    unlockButton.hidden = false;
    say('outputNote', 'Browsers only list output devices for sites allowed to use the microphone. This asks for it on this site once, then turns the microphone straight off.');
  } else if (selected && info.current !== selected) {
    say('outputNote', "Couldn't switch to that output. It will be tried again when a video plays.", 'bad');
  } else {
    say('outputNote', selected ? 'This tab plays through the chosen device.' : '');
  }
}

async function loadOutputs() {
  showOutputs(await ask({ type: 'yta-outputs' }));
}

outputSelect.addEventListener('change', async () => {
  const chosen = outputSelect.options[outputSelect.selectedIndex];
  settings.outputId = outputSelect.value;
  settings.outputLabel = settings.outputId ? chosen.textContent.replace(/ \(not connected\)$/, '') : '';
  showOutputs(await ask({ type: 'yta-output-set', id: settings.outputId, label: settings.outputLabel }));
});

unlockButton.addEventListener('click', async () => {
  say('outputNote', 'Answer the microphone prompt in the browser window.');
  showOutputs(await ask({ type: 'yta-output-unlock' }));
});

/* -------------------- experimental: padded bits (gain above 0 dB) -------------------- */

const padRange = el('pad');
let padDb = 0;

function showPad() {
  padRange.value = String(padDb);
  el('padNow').textContent = padDb > 0 ? '+' + padDb + ' dB' : '0 dB';
}

async function setPad(value) {
  if (settings.unity) return; // Purist adds no gain
  const db = Math.round(Math.min(20, Math.max(0, value)));
  if (!isFinite(db) || db === padDb) return;
  padDb = db;
  showPad();
  render(await ask({ type: 'yta-pad', db }));
}

padRange.addEventListener('input', () => setPad(parseFloat(padRange.value)));

// Crossfeed, for headphones.
const feedSelect = el('crossfeed');
const FEED_NAMES = { light: 'light', medium: 'medium', strong: 'strong' };
function showFeed() {
  feedSelect.value = FEED_NAMES[settings.crossfeed] ? settings.crossfeed : 'off';
}
feedSelect.addEventListener('change', async () => {
  settings.crossfeed = feedSelect.value;
  try { await api.storage.local.set(settings); } catch (_) { /* keep going */ }
  render(await ask({ type: 'yta-apply', settings }));
});

function showFeedStatus(status) {
  showFeed();
  const on = !!FEED_NAMES[settings.crossfeed];
  if (!on) say('feedNote', '');
  else if (settings.unity) say('feedNote', 'Purist is on: crossfeed is off.');
  else if (status.padCan === false) say('feedNote', 'This browser has no audio engine to do this with.');
  else if (!status.padOn) say('feedNote', 'Click the video once to start it. Browsers hold new audio processing until you touch the page.', 'bad');
  else say('feedNote', 'Crossfeed is on, for headphones.', 'good');
}

// B-Mode: a bass shelf.
const beefSelect = el('beef');
const BEEF_NAMES = { 10: '10 Hz', 20: '20 Hz', 40: '40 Hz' };
function showBeef() {
  beefSelect.value = BEEF_NAMES[settings.beef] ? String(settings.beef) : 'off';
}
beefSelect.addEventListener('change', async () => {
  settings.beef = beefSelect.value;
  try { await api.storage.local.set(settings); } catch (_) { /* keep going */ }
  render(await ask({ type: 'yta-apply', settings }));
});

function showBeefStatus(status) {
  showBeef();
  const on = !!BEEF_NAMES[settings.beef];
  if (!on) say('beefNote', '');
  else if (settings.unity) say('beefNote', 'Purist is on: B-Mode is off.');
  else if (status.padCan === false) say('beefNote', 'This browser has no audio engine to do this with.');
  else if (!status.padOn) say('beefNote', 'Click the video once to start it. Browsers hold new audio processing until you touch the page.', 'bad');
  else say('beefNote', 'B-Mode is on: +12 dB at ' + BEEF_NAMES[settings.beef] + ', overall level down ' + (status.beefRoom || 12) + ' dB.', 'good');
}

// Clip guard: which kind, whether it is doing anything, and how much.
const guardSelect = el('guardMode');
const GUARD_NAMES = { limiter: 'Intelligent', cap: 'Gain limit', off: 'Off' };
function showGuard() {
  guardSelect.value = GUARD_NAMES[settings.guardMode] ? settings.guardMode : 'limiter';
}
guardSelect.addEventListener('change', async () => {
  settings.guardMode = guardSelect.value;
  try { await api.storage.local.set(settings); } catch (_) { /* keep going */ }
  render(await ask({ type: 'yta-apply', settings }));
});

function showGuardStatus(status) {
  showGuard();
  const minus = '\u2212';
  const mode = GUARD_NAMES[settings.guardMode] ? settings.guardMode : 'limiter';
  const beef = !!BEEF_NAMES[settings.beef];
  const canClip = padDb > 0 || beef;
  if (settings.unity) say('guardNote', '');
  else if (mode === 'off') say('guardNote', canClip ? 'Off: peaks past full scale will clip.' : '', 'bad');
  else if (mode === 'cap') {
    if (!canClip) say('guardNote', 'Standing by. Nothing here can clip at these settings.');
    else if (padDb > 0 && typeof status.padApplied === 'number' && status.padApplied < padDb - 0.05) {
      say('guardNote', 'Limiting the gain to +' + status.padApplied.toFixed(1) + ' dB of the +' + padDb + ' asked for. Nothing is processed.', 'good');
    } else say('guardNote', 'All of the gain fits under 0 dB. Nothing is limited or processed.', 'good');
  }
  else if (!status.guard) say('guardNote', 'Standing by. Nothing here can clip at these settings.');
  else if (status.guardDb >= 0.1) say('guardNote', 'Holding peaks back by ' + minus + status.guardDb.toFixed(1) + ' dB right now.', 'good');
  else say('guardNote', 'On. Nothing is being held back right now.', 'good');
}

// Audio path: which way the sound gets into the engine. Read by the page when it loads.
const pathSelect = el('audioPath');
const PATH_NAMES = { tap: 'Tap', capture: 'Stream capture', rebuild: 'Rebuild' };
function showPath() {
  pathSelect.value = PATH_NAMES[settings.audioPath] ? settings.audioPath : 'tap';
}
pathSelect.addEventListener('change', async () => {
  settings.audioPath = pathSelect.value;
  try { await api.storage.local.set(settings); } catch (_) { /* keep going */ }
  render(await ask({ type: 'yta-apply', settings }));
});

// Set out label/value rows in the stats grid. Rows are reused, so a figure
// that changes only rewrites its own cell.
function showStats(id, rows) {
  const list = el(id);
  const labels = rows.map(row => row[0]).join('|');
  if (list.dataset.labels !== labels) {
    list.dataset.labels = labels;
    list.textContent = '';
    for (const [label] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      list.appendChild(dt);
      list.appendChild(document.createElement('dd'));
    }
  }
  const cells = list.querySelectorAll('dd');
  rows.forEach((row, i) => { if (cells[i].textContent !== row[1]) cells[i].textContent = row[1]; });
}

function showPathStatus(status) {
  showPath();
  const chosen = PATH_NAMES[settings.audioPath] ? settings.audioPath : 'tap';
  const minus = '\u2212';
  const rows = [];
  let note = '';
  let tone = '';
  const active = status.path && PATH_NAMES[status.path] ? status.path : chosen;
  const figures = status.pathFigures;
  if (settings.unity && active !== 'tap') {
    rows.push(['Path', PATH_NAMES[active] + ', resting']);
    note = 'Purist is on: the video plays its own sound, untouched, as on Tap.';
  } else if (figures) {
    rows.push(['Path', PATH_NAMES[active] + ', ' + figures.state]);
    rows.push(['Frames read', String(figures.frames)]);
    if (typeof figures.decoded === 'number') rows.push(['Decoded ahead', figures.decoded.toFixed(1) + ' s']);
    if (typeof figures.off === 'number') {
      rows.push(['Sync', (figures.off < 0 ? minus : figures.off > 0 ? '+' : '') + Math.abs(figures.off) + ' ms']);
      rows.push(['Re-aligned', figures.lineUps + (figures.lineUps === 1 ? ' time' : ' times')]);
    }
    if (figures.state === 'stopped') {
      note = 'Stopped: ' + figures.why + '. The video is playing its own sound.';
      tone = 'bad';
      // Nothing in this section is being applied, whatever the controls say.
      if (padDb > 0) say('padNote', 'Not applied: Rebuild has stopped, so the video is playing its own sound. See Audio path below.', 'bad');
      if (FEED_NAMES[settings.crossfeed]) say('feedNote', 'Not applied: Rebuild has stopped. See Audio path below.', 'bad');
      if (BEEF_NAMES[settings.beef]) say('beefNote', 'Not applied: Rebuild has stopped. See Audio path below.', 'bad');
    }
    else if (figures.state === 'standing by') note = 'Nothing to process, so the video plays its own sound.';
  } else {
    rows.push(['Path', PATH_NAMES[active]]);
  }
  // The buffer is shown on every path: how far ahead of the playhead is downloaded.
  if (typeof status.buffer === 'number') rows.push(['Buffer ahead', status.buffer.toFixed(1) + ' s']);
  if (status.path && status.path !== chosen) {
    note = 'This tab is still on ' + PATH_NAMES[status.path] + '. Reload it to switch to ' + PATH_NAMES[chosen] + '.';
    tone = 'bad';
  }
  showStats('pathStats', rows);
  say('pathNote', note, tone);
}

// Plain facts about the audio engine, for when something here has no effect.
function showEngineStatus(status) {
  const wanted = padDb > 0 || !!FEED_NAMES[settings.crossfeed] || !!BEEF_NAMES[settings.beef];
  if (status.padDeaf) {
    // Replace the per-control notes: none of them can be true here.
    for (const id of ['padNote', 'feedNote', 'beefNote', 'guardNote']) say(id, '');
    say('engineNote', 'No effect in this browser. It plays the video itself and passes no audio to extensions ' +
      '(a known Safari limitation with streamed video), so padded bits, crossfeed, B-Mode and clip guard cannot ' +
      'change the sound on this audio path. Try Audio path: Rebuild below, then reload the tab.', 'bad');
    return;
  }
  if (!wanted && !status.padOn && !status.padError) { say('engineNote', ''); return; }
  const parts = ['Audio engine: ' + (status.padCan === false ? 'not available' : (status.padState || 'not started'))];
  parts.push(status.padOn ? 'processing this video' : status.padWaiting ? 'waiting to attach' : 'not attached');
  if (status.padOn) parts.push(status.padHeard ? 'audio is reaching it' : 'no audio has reached it yet');
  if (status.padFade) parts.push(status.padFade + ' fades');
  if (status.padMisses) parts.push('corrected: ' + status.padMisses);
  if (status.padError) parts.push('last error: ' + status.padError);
  say('engineNote', parts.join(' \u00b7 '), status.padError ? 'bad' : '');
}

function showPadStatus(status) {
  padDb = typeof status.pad === 'number' ? status.pad : 0;
  showPad();
  padRange.disabled = status.padCan === false || !!settings.unity;
  if (settings.unity) {
    say('padNote', status.padOn
      ? 'Purist is on: no gain is added. Reload the tab to return to the untouched audio path.'
      : 'Purist is on: no gain is added.');
    return;
  }
  if (status.padCan === false) {
    say('padNote', "This browser has no audio engine to do this with.");
  } else if (padDb > 0 && status.padState === 'suspended') {
    say('padNote', 'The browser is holding the audio. Click the video once to start it.', 'bad');
  } else if (padDb > 0 && !status.padOn) {
    say('padNote', 'Click the video once to start it. Browsers hold new audio processing until you touch the page.', 'bad');
  } else if (padDb > 0 && status.guard && status.guardDb >= 0.5) {
    // Raising the level and holding the peaks down pull against each other.
    // Say so, or the slider looks as though it does nothing.
    say('padNote', '+' + padDb + ' dB asked for, but clip guard is taking ' + status.guardDb.toFixed(1) +
      ' dB of it back right now. This video is already close to full level, so there is little room to get ' +
      'louder without clipping. For the full boost, clipping included, turn clip guard off.', 'bad');
  } else if (padDb > 0 && status.guardMode === 'cap' && typeof status.padApplied === 'number' && status.padApplied < padDb - 0.05) {
    say('padNote', '+' + status.padApplied.toFixed(1) + ' dB of the +' + padDb + ' asked for is applied: that is all the room there is under ' +
      'full level at this volume. Lower the video\'s volume slider to make more, or change Clip guard below.');
  } else if (padDb > 0 && status.guardMode === 'cap') {
    say('padNote', 'Playing +' + padDb + ' dB, all of it under full level.');
  } else if (padDb > 0) {
    say('padNote', 'Playing ' + padDb + ' dB over full level.');
  } else if (status.padOn) {
    say('padNote', 'Back at 0 dB. Reload the tab to return to the untouched audio path.');
  } else {
    say('padNote', '');
  }
}

/* ------------------------------ panel layout ------------------------------ */

// Every section folds away to one line. Which are open, which are hidden
// altogether, and whether help text shows are remembered between openings.
const LAYOUT_KEY = 'mg-layout-2';
const layout = { open: ['speed', 'attenuation', 'codec'], hidden: [], help: false };
try {
  const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
  if (saved && Array.isArray(saved.open) && Array.isArray(saved.hidden)) Object.assign(layout, saved);
} catch (_) { /* first run, or storage unavailable */ }
const saveLayout = () => {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (_) { /* not remembered */ }
};
const groups = Array.from(document.querySelectorAll('section[data-group]'));

function applyLayout() {
  document.body.classList.toggle('with-help', !!layout.help);
  el('showHelp').checked = !!layout.help;
  for (const section of groups) {
    const key = section.dataset.group;
    section.hidden = layout.hidden.includes(key);
    const box = document.querySelector('[data-show="' + key + '"]');
    if (box) box.checked = !section.hidden;
  }
  const count = layout.hidden.length;
  el('peek-customize').textContent = count ? count + ' hidden' : '';
}

for (const section of groups) {
  const key = section.dataset.group;
  const fold = section.querySelector('details');
  fold.open = layout.open.includes(key);
  fold.addEventListener('toggle', () => {
    if (settings.unity) return; // folded for Purist: not the user's own layout, so not remembered
    layout.open = layout.open.filter(name => name !== key);
    if (fold.open) layout.open.push(key);
    saveLayout();
  });
}
for (const box of document.querySelectorAll('[data-show]')) {
  box.addEventListener('change', () => {
    const key = box.dataset.show;
    layout.hidden = layout.hidden.filter(name => name !== key);
    if (!box.checked) layout.hidden.push(key);
    saveLayout();
    applyLayout();
  });
}
el('showHelp').addEventListener('change', () => {
  layout.help = el('showHelp').checked;
  saveLayout();
  applyLayout();
});
applyLayout();

// Purist is the "leave it alone" setting, and the panel follows suit: every
// section folds away to its one-line summary. Turning Purist off puts the
// sections back the way the user had them. A section can still be opened by
// hand while Purist is on; that just isn't remembered.
let foldedForPurist = null;
function foldForPurist() {
  const purist = !!settings.unity;
  if (foldedForPurist === purist) return;
  foldedForPurist = purist;
  for (const section of groups) {
    section.querySelector('details').open = purist ? false : layout.open.includes(section.dataset.group);
  }
  if (purist) el('customize').open = false;
}

// The toolbar icon says what BAE is doing: green for Purist, blue while
// something is changing the sound, the usual colours otherwise. background.js
// keeps it right between openings; this paints it at once, and adds padded
// bits, which belongs to this tab alone.
const iconPaths = name => (name === 'default'
  ? { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png' }
  : { 16: 'icons/state-' + name + '-16.png', 32: 'icons/state-' + name + '-32.png', 48: 'icons/state-' + name + '-48.png' });
function iconState(pad) {
  if (settings.unity) return 'green';
  return settings.trueVolume || FEED_NAMES[settings.crossfeed] || BEEF_NAMES[settings.beef] || pad > 0 ? 'blue' : 'default';
}
let painted = '';
let tabPainted = false;
function paintIcon() {
  const action = api.action || api.browserAction;
  if (!action || typeof action.setIcon !== 'function') return;
  const everywhere = iconState(0);
  const here = iconState(padDb);
  const key = everywhere + '/' + here + '/' + tabId;
  if (key === painted) return;
  painted = key;
  try {
    Promise.resolve(action.setIcon({ path: iconPaths(everywhere) })).catch(() => {});
    if (typeof tabId === 'number' && (here !== everywhere || tabPainted)) {
      tabPainted = true;
      Promise.resolve(action.setIcon({ tabId, path: iconPaths(here) })).catch(() => {});
    }
  } catch (_) { /* the icon keeps its last colour */ }
}

// The one-line summary each section shows while folded.
function updatePeeks() {
  paintIcon();
  const text = id => (el(id).firstChild ? el(id).firstChild.textContent : el(id).textContent).trim();
  const speed = Number(settings.speed) || 1;
  el('peek-speed').textContent = settings.unity ? '1× · purist'
    : times(speed) + (settings.pitchCorrection ? '' : ' · pitch free');
  const db = text('db');
  el('peek-attenuation').textContent = settings.unity ? '0 dB · purist'
    : (db === '…' || db === '–' ? '' : db + ' · ') + (settings.trueVolume ? 'bypassed' : 'off');
  const formats = [text('audio'), text('video')].filter(name => name && name !== '…' && name !== '–' && name !== 'Not detected');
  el('peek-codec').textContent = formats.join(' / ');
  const chosen = outputSelect.options[outputSelect.selectedIndex];
  el('peek-output').textContent = chosen ? chosen.textContent : '';
  const shown = ['showCodec', 'showAttenuation', 'showSpeed', 'showBuffer'].filter(key => settings[key]).length;
  el('peek-display').textContent = shown ? shown + ' of 4' : 'off';
  el('peek-experimental').textContent = settings.unity ? 'off · purist'
    : [padDb > 0 ? '+' + padDb + ' dB' : '', FEED_NAMES[settings.crossfeed] ? 'crossfeed' : '',
      BEEF_NAMES[settings.beef] ? 'B-Mode ' + BEEF_NAMES[settings.beef] : ''].filter(Boolean).join(' · ');
}

/* ------------------------------- plumbing ------------------------------- */

function blank(message, tone) {
  clearMeter();
  el('audio').textContent = '–';
  el('video').textContent = '–';
  showDb('–');
  say('codec', '');
  say('speedNote', '');
  say('padNote', '');
  say('feedNote', '');
  say('beefNote', '');
  say('guardNote', '');
  say('engineNote', '');
  say('pathNote', '');
  showStats('pathStats', []);
  el('bits').hidden = true;
  say('verdict', message, tone);
  updatePeeks();
}

function render(reply) {
  if (!reply) {
    if (Date.now() < reloadingUntil) blank('Reloading the tab...');
    else blank("Can't reach a player in this tab. Allow this extension on this site if the browser asks, then reload the page.", 'bad');
    return;
  }
  let status = null;
  try { status = JSON.parse(reply.status); } catch (_) { /* handled below */ }
  if (!reply.pageScript || !status) {
    blank("The extension's page script isn't running. It needs Safari 18.4, Chrome 111 or Firefox 128 or later. Update the browser, then reload this tab.", 'bad');
    return;
  }
  site = status.site || 'youtube';
  showCodec(status);
  showAttenuation(status);
  showSpeedStatus(status);
  showPadStatus(status);
  showFeedStatus(status);
  showBeefStatus(status);
  showGuardStatus(status);
  showEngineStatus(status);
  showPathStatus(status);
  updatePeeks();
}

async function check() {
  render(await ask({ type: 'yta-status' }));
}

async function toggle(key) {
  settings[key] = !settings[key];
  showSwitches();
  try { await api.storage.local.set(settings); } catch (_) { /* keep going */ }
  render(await ask({ type: 'yta-apply', settings }));
}

for (const button of switches) {
  button.addEventListener('click', () => toggle(button.dataset.key));
}

(async () => {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab && typeof tab.id === 'number') tabId = tab.id;
  } catch (_) { /* no tab */ }
  try { Object.assign(settings, await api.storage.local.get(DEFAULTS)); } catch (_) { /* defaults */ }
  showSwitches();
  showPickers();
  showFeed();
  showBeef();
  showPath();
  showGuard();
  showSpeed();
  loadOutputs();
  check();
  setInterval(check, 1000);
})();
