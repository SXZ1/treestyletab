/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import * as TSTAPI from '/common/tst-api.js';

import {
  configs
} from '/common/common.js';
import { DOMUpdater } from '/extlib/dom-updater.js';

import {
  kTAB_ELEMENT_NAME,
} from './components/TabElement.js';

import Tab from '/common/Tab.js';

const mAddonsWithExtraContents = new Set();

TSTAPI.onRegistered.addListener(addon => {
  // Install stylesheet always, even if the addon is not allowed to access
  // private windows, because the client addon can be alloed on private
  // windows by Firefox itself and extra context menu commands may be called
  // via Firefox's native context menu (or shortcuts).
  if (addon.style)
    installStyle(addon.id, addon.style);
});

TSTAPI.onUnregistered.addListener(addon => {
  clearAllExtraContents(addon.id);
  uninstallStyle(addon.id)
});

TSTAPI.onMessageExternal.addListener((message, sender) => {
  if ((!configs.incognitoAllowedExternalAddons.includes(sender.id) &&
       document.documentElement.classList.contains('incognito')))
    return;

  if (message.type == TSTAPI.kCLEAR_ALL_EXTRA_TAB_CONTENTS) {
    clearAllExtraContents(sender.id);
    return;
  }

  Tab.waitUntilTracked(message.id, { element: true }).then(() => {
    const tabElement = document.querySelector(`#tab-${message.id}`);
    if (!tabElement)
      return;

    switch (message.type) {
      case TSTAPI.kSET_EXTRA_TAB_CONTENTS:
        setExtraContents(tabElement, sender.id, message);
        break;

      case TSTAPI.kCLEAR_EXTRA_TAB_CONTENTS:
        clearExtraContents(tabElement, sender.id);
        break;
    }
  });
});

// https://developer.mozilla.org/docs/Web/HTML/Element
const SAFE_CONTENTS = `
a
abbr
acronym
address
//applet
area
article
aside
b
//base
//basefont
bdi
bdo
//bgsound
big
blink
blockquote
//body
br
button
canvas
caption
center
cite
code
col
colgroup
command
//content
data
datalist
dd
del
details
dfn
dialog
dir
div
dl
dt
//element
em
//embed
fieldset
figcaption
figure
font
footer
//form
//frame
//frameset
h1
//head
header
hgroup
hr
//html
i
//iframe
image
img
input
ins
isindex
kbd
keygen
label
legend
li
//link
listing
main
map
mark
marquee
menu
menuitem
//meta
//meter
multicol
nav
nextid
nobr
//noembed
//noframes
//noscript
object
ol
optgroup
option
output
p
param
picture
plaintext
pre
progress
q
rb
rp
rt
rtc
duby
s
samp
//script
section
select
//shadow
slot
small
source
spacer
span
strike
strong
//style
sub
summary
sup
table
tbody
td
template
textarea
tfoot
th
thead
time
//title
tr
track
tt
u
ul
var
//video
wbr
xmp
`.trim().split('\n').filter(selector => !selector.startsWith('//'));
const DANGEROUS_CONTENTS_SELECTOR = SAFE_CONTENTS.map(selector => `:not(${selector})`).join('');

function setExtraContents(tabElement, id, params) {
  let container;
  switch (String(params.place).toLowerCase()) {
    case 'behind':
      container = tabElement.extraItemsContainerBehindRoot;
      break;

    case 'front':
    default:
      container = tabElement.extraItemsContainerFrontRoot;
      break;
  }

  if (!container)
    return;

  let item = container.itemById.get(id);
  if (!params.style &&
      item &&
      item.styleElement &&
      item.styleElement.parentNode) {
    container.removeChild(item.styleElement);
    item.styleElement = null;
  }
  if (!params.contents) {
    if (item) {
      if (item.styleElement)
        container.removeChild(item.styleElement);
      container.removeChild(item);
      container.itemById.delete(id);
    }
    return;
  }

  const extraContentsPartName = getExtraContentsPartName(id);

  if (!item) {
    item = document.createElement('span');
    item.setAttribute('part', `${extraContentsPartName} container`);
    item.classList.add('extra-item');
    item.classList.add(extraContentsPartName);
    item.dataset.owner = id;
    container.itemById.set(id, item);
  }
  if ('style' in params && !item.styleElement) {
    const style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    item.styleElement = style;
  }

  const range = document.createRange();
  range.selectNodeContents(item);
  const contents = range.createContextualFragment(String(params.contents || '').trim());
  range.detach();

  const dangerousContents = contents.querySelectorAll(DANGEROUS_CONTENTS_SELECTOR);
  for (const node of dangerousContents) {
    node.parentNode.removeChild(node);
  }
  if (dangerousContents.length > 0)
    console.log(`Could not include some elements as extra tab contents. tab=#${tabElement.id}, provider=${id}:`, dangerousContents);

  // Sanitize remote resources
  for (const node of contents.querySelectorAll('*[href], *[src], *[srcset], *[part]')) {
    for (const attribute of node.attributes) {
      if (attribute.name == 'part')
        attribute.value += ` ${extraContentsPartName}`;
      if (/^(href|src|srcset)$/.test(attribute.name) &&
          attribute.value &&
          !/^(data|resource|chrome|about|moz-extension):/.test(attribute.value)) {
        attribute.value = '#';
        node.setAttribute('part', `${node.getAttribute('part') || ''} sanitized`);
      }
    }
  }
  // We don't need to handle inline event handlers because
  // they are blocked by the CSP mechanism.

  if ('style' in params)
    item.styleElement.textContent = (params.style || '')
      .replace(/%EXTRA_CONTENTS_PART%/gi, `${extraContentsPartName}`);

  DOMUpdater.update(item, contents);

  if (item.styleElement &&
      !item.styleElement.parentNode)
    container.appendChild(item.styleElement);
  if (!item.parentNode)
    container.appendChild(item);

  mAddonsWithExtraContents.add(id);
}

function getExtraContentsPartName(id) {
  return `extra-contents-by-${id.replace(/[^-a-z0-9_]/g, '_')}`;
}

function clearExtraContents(tabElement, id) {
  setExtraContents(tabElement, id, { place: 'front' });
  setExtraContents(tabElement, id, { place: 'behind' });
}

function clearAllExtraContents(id) {
  if (!mAddonsWithExtraContents.has(id))
    return;

  for (const tabElement of document.querySelectorAll(kTAB_ELEMENT_NAME)) {
    clearExtraContents(tabElement, id);
  }
  mAddonsWithExtraContents.delete(id);
}

const mAddonStyles = new Map();

function installStyle(id, style) {
  let styleElement = mAddonStyles.get(id);
  if (!styleElement) {
    styleElement = document.createElement('style');
    styleElement.setAttribute('type', 'text/css');
    document.head.insertBefore(styleElement, document.querySelector('#addons-style-rules'));
    mAddonStyles.set(id, styleElement);
  }
  styleElement.textContent = (style || '').replace(/%EXTRA_CONTENTS_PART%/gi, getExtraContentsPartName(id));
}

function uninstallStyle(id) {
  const styleElement = mAddonStyles.get(id);
  if (!styleElement)
    return;
  document.head.removeChild(styleElement);
  mAddonStyles.delete(id);
}
