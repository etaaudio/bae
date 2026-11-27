// SPDX-License-Identifier: MPL-2.0
// BAE. Copyright (C) 2026 ETA Audio LLC.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// background.js: keeps the toolbar icon's colour in step with the settings.
//   green    Purist is on: nothing is processed
//   blue     something is changing the sound: the attenuation bypass,
//            crossfeed or B-Mode (padded bits is per tab; the popup paints that)
//   default  none of the above
// It does nothing else, and wakes only when a setting changes.
(() => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const action = api && (api.action || api.browserAction);
  if (!action || typeof action.setIcon !== 'function') return;

  const WATCHED = { unity: false, trueVolume: true, crossfeed: 'off', beef: 'off' };
  const paths = name => (name === 'default'
    ? { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png' }
    : { 16: 'icons/state-' + name + '-16.png', 32: 'icons/state-' + name + '-32.png', 48: 'icons/state-' + name + '-48.png' });

  function stateOf(settings) {
    if (settings.unity) return 'green';
    const feed = ['light', 'medium', 'strong'].includes(settings.crossfeed);
    const beef = ['10', '20', '40'].includes(String(settings.beef));
    return settings.trueVolume || feed || beef ? 'blue' : 'default';
  }

  function refresh() {
    Promise.resolve(api.storage.local.get(WATCHED))
      .then(settings => action.setIcon({ path: paths(stateOf(settings)) }))
      .catch(() => { /* the icon keeps its last colour */ });
  }

  api.storage.onChanged.addListener((_changes, area) => { if (area === 'local') refresh(); });
  if (api.runtime.onStartup) api.runtime.onStartup.addListener(refresh);
  if (api.runtime.onInstalled) api.runtime.onInstalled.addListener(refresh);
  refresh();
})();
