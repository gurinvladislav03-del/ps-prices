// Telegram front end for the same price lookup the website uses.
//
// It shares server.js outright (catalogue, resolver, extractor, cross-region
// reconciliation), so a fix to prices is a fix here too.
//
//   INLINE     "@yourbot ghost" in any chat gives a live list of titles.
//   BUTTONS    Sending a title prices it; several matches are offered as buttons.
//   EDITIONS   After a game is priced, its editions are offered as a menu.
//              Picking one prices that exact edition in every region.
//   COMMANDS   /start, /help, /top, /new, /cur, and pasted store URLs or IDs.
//
// Prices take 10-40 seconds, so each lookup first posts "Looking up..." and
// then edits that same message when the results land.
//
// Long polling by default. Set TELEGRAM_WEBHOOK_SECRET to use a webhook.

// Held as a module reference, not destructured: server.js requires this file
// back, so at load time its exports may not exist yet. Reading through S at
// call time picks up the real functions.
const S = require('./server.js');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const API = process.env.TELEGRAM_API || 'https://api.telegram.org';
const FX_URL = process.env.FX_URL || 'https://open.er-api.com/v6/latest/USD';

const TOP = 5;                       // regions shown before "Show More"
const SUGGEST = 8;                   // buttons offered when a title is ambiguous
const INLINE = 20;                   // Telegram's cap on inline results
const TOP_N = 20;                    // entries in /top and /new
const EDITIONS_MAX = 12;             // product pages read when building the menu
const FX_TTL = 6 * 3600 * 1000;      // rates are daily
const CACHE_TTL = 10 * 60 * 1000;    // how long a "Show More" stays valid

// ---------------------------------------------------------------- transport

async function tg(method, body, ms = 20000) {
  if (!TOKEN) return null;
  try {
    const r = await fetch(API + '/bot' + TOKEN + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms)
    });
    const j = await r.json().catch(() => null);
    if (j && j.ok) return j.result;
    console.error('telegram: ' + method + ' -> ' +
      ((j && (j.description || j.error_code)) || 'HTTP ' + r.status));
    return null;
  } catch (e) {
    console.error('telegram: ' + method + ' -> ' + (e.name === 'TimeoutError' ? 'timed out' : e.message));
    return null;
  }
}

// ---------------------------------------------------------------- currency

let fxCache = { rates: null, ts: 0 };
async function getFx() {
  if (fxCache.rates && Date.now() - fxCache.ts < FX_TTL) return fxCache;
  try {
    const j = await (await fetch(FX_URL, { signal: AbortSignal.timeout(10000) })).json();
    if (j && j.rates) fxCache = { rates: j.rates, ts: Date.now() };
  } catch (e) { /* keep the old rates: stale rates beat no prices */ }
  return fxCache;
}

// Rates are quoted against USD, so any pair is one divide and one multiply.
const convert = (price, from, to, rates) =>
  (rates && rates[from] && rates[to]) ? (price / rates[from]) * rates[to] : null;

function money(cur, n, narrow) {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency', currency: cur,
      currencyDisplay: narrow ? 'narrowSymbol' : 'symbol',
      maximumFractionDigits: n >= 1000 ? 0 : 2
    }).format(n);
  } catch (e) { return cur + ' ' + n; }
}

// Compact, unambiguous symbols for the converted column.
const COMPACT = { SGD: 'S$', USD: 'US$', AUD: 'A$', CAD: 'C$', NZD: 'NZ$', HKD: 'HK$', TWD: 'NT$' };
function converted(cur, n) {
  const p = COMPACT[cur];
  if (!p) return money(cur, n, true);
  const digits = n >= 1000 ? 0 : 2;
  return p + new Intl.NumberFormat('en', {
    minimumFractionDigits: digits, maximumFractionDigits: digits
  }).format(n);
}

const REGION_NAMES = {
  US: 'United States', UA: 'Ukraine', IN: 'India', JP: 'Japan', BR: 'Brazil',
  TR: 'Turkey', ID: 'Indonesia', MY: 'Malaysia', TW: 'Taiwan', HK: 'Hong Kong',
  KR: 'South Korea', ZA: 'South Africa', PL: 'Poland', NO: 'Norway',
  CA: 'Canada', AU: 'Australia', MX: 'Mexico', GB: 'United Kingdom',
  DE: 'Germany', SG: 'Singapore'
};

// US -> flag emoji. Telegram draws these on every platform.
const flag = r => String.fromCodePoint(...[...r.toUpperCase()]
  .map(c => 0x1f1e6 + c.charCodeAt(0) - 65));

// ---------------------------------------------------------------- matching

function suggest(q, limit = SUGGEST) {
  const cat = S.getCatalog();
  const k = S.keyName(q || '');
  if (!cat || k.length < 2) return [];
  const starts = [], has = [];
  for (const [name, id] of cat) {
    if (name.startsWith(k)) starts.push([name, id]);
    else if (name.includes(k)) has.push([name, id]);
    if (starts.length >= limit) break;
  }
  return [...starts, ...has].slice(0, limit).map(([name, id]) => ({
    conceptId: id,
    name: (cat.names && cat.names.get(id)) || name
  }));
}

// ---------------------------------------------------------------- rendering

const esc = s => ('' + s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function rankRows(results, target, rates) {
  return results
    .filter(x => x.price != null && !x.redirected)
    .map(x => ({ ...x, conv: convert(x.price, x.currency, target, rates) }))
    .sort((a, b) => (a.conv == null) - (b.conv == null) || (a.conv - b.conv));
}

function homeRegion(target) {
  return Object.keys(S.EXPECT).find(r => S.EXPECT[r] === target) || null;
}

function homeButton(pr, target, rates) {
  const home = homeRegion(target);
  if (!home) return null;
  const row = pr.results.find(x => x.region === home && x.price != null);
  if (!row || !row.url) return null;
  const conv = convert(row.price, row.currency, target, rates);
  return {
    text: flag(home) + ' ' + (conv != null ? converted(target, conv) : money(row.currency, row.price)),
    url: row.url
  };
}

const FIGURE_SPACE = '\u2007';

function rankLabel(i, total) {
  const n = String(i + 1);
  return FIGURE_SPACE.repeat(Math.max(0, String(total).length - n.length)) + n + '.';
}

function line(x, target, i, total) {
  const place = REGION_NAMES[x.region] || x.region;
  const link = t => x.url ? '<a href="' + esc(x.url) + '">' + esc(t) + '</a>' : esc(t);

  const head = '<b>' + rankLabel(i, total) + '  ' + flag(x.region) + ' ' + esc(place) +
               '  ·  ' + (x.conv != null ? link(converted(target, x.conv)) : '—') + '</b>';

  const bits = [];
  if (x.original != null) bits.push('<s>' + esc(money(x.currency, x.original)) + '</s>');
  bits.push(esc(money(x.currency, x.price)));
  if (x.english === false) bits.push('🚫 ENG');
  return head + '\n    <i>' + bits.join('  ') + '</i>';
}

function editionSummary(results) {
  const counts = new Map();
  for (const x of results || []) {
    const n = (x.editions || []).length;
    if (!n) continue;
    if (!counts.has(n)) counts.set(n, []);
    counts.get(n).push(x.region);
  }
  if (!counts.size) return null;

  const common = [...counts.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0][0];
  const plural = n => n + (n === 1 ? ' Edition' : ' Editions');

  const odd = [...counts.entries()]
    .filter(([n]) => n !== common)
    .sort((a, b) => a[0] - b[0])
    .map(([n, regions]) => plural(n) + ' in ' + regions.map(flag).join(' '));

  return [plural(common) + ' Found.', ...odd].join(' ');
}

function formatPrices(pr, target, rates, limit) {
  const rows = rankRows(pr.results, target, rates);
  if (!rows.length) {
    return { text: '<b>' + esc(pr.title) + '</b>\nNo region has a price for this one.', rows: 0 };
  }
  const shown = rows.slice(0, limit);
  const body = shown.map((x, i) => line(x, target, i, shown.length)).join('\n');
  const head = '🎮 <b>' + esc(pr.title) + '</b>' +
    (rates ? '' : '\n<i>Local prices only — no live exchange rates</i>');
  const foot = [pr.priced + '/' + pr.total + ' Regions Priced.', editionSummary(pr.results)]
    .filter(Boolean).join('\n');
  return {
    text: head + '\n\n' + body + '\n\n<i>' + esc(foot) + '</i>',
    rows: rows.length,
    home: homeButton(pr, target, rates)
  };
}

function keyboard(out, token) {
  const row = [];
  if (out.home) row.push(out.home);
  if (token) row.push({ text: 'Show More', callback_data: 'm:' + token });
  return row.length ? { inline_keyboard: [row] } : undefined;
}

const preview = image => image
  ? { url: image, prefer_large_media: true, show_above_text: true }
  : { is_disabled: true };

// ---------------------------------------------------------------- state

const target = new Map();            // chat id -> currency to convert into
const recent = new Map();            // token -> finished lookup, for "Show More"

function remember(pr) {
  const token = Math.random().toString(36).slice(2, 10);
  recent.set(token, { pr, ts: Date.now() });
  for (const [k, v] of recent) if (Date.now() - v.ts > CACHE_TTL) recent.delete(k);
  return token;
}

// ---------------------------------------------------------------- editions

// Prices one exact product (edition) in every storefront. A region that does
// not sell this product ID shows no price. It never falls back to another
// edition of the same game.
async function editionLookup(pid) {
  const keys = Object.keys(S.LOCALES);
  const rows = await S.pool(keys, 6, async rk => {
    const path = '/' + S.LOCALES[rk] + '/product/' + pid;
    const r = await S.priceAt(path, S.acceptLang(S.LOCALES[rk]));
    return { rk, path, r };
  });
  const results = rows.map(({ rk, path, r }) => ({
    region: rk,
    currency: r ? r.cur : null,
    price: r ? r.price : null,
    original: r ? r.original : null,
    discount: r ? r.discount : null,
    english: r ? r.english : null,
    screenLanguages: r ? r.screenLanguages : null,
    voiceLanguages: r ? r.voiceLanguages : null,
    redirected: !!r && r.cur != null && !S.isAccepted(rk, r.cur),
    foreign: !!r && S.isForeign(rk, r.cur),
    editions: [],
    suspect: !!(r && r.suspect),
    via: r ? 'product' : null,
    productId: pid,
    url: r ? S.BASE + path : null
  }));
  const named = rows.find(x => x.r && x.r.name);
  const pic = rows.find(x => x.r && x.r.image);
  return {
    title: named ? named.r.name : pid,
    productId: pid,
    conceptId: null,
    image: pic ? pic.r.image : null,
    results,
    priced: results.filter(x => x.price != null).length,
    total: results.length
  };
}

// Editions of a game, read from its concept page in en-us. Each product link
// there is one edition or add-on. Only products whose own page names the game
// being looked up are kept, because the concept page also carries
// recommendation strips for other games.
async function editionChoices(cid, cur, rates, title) {
  const hub = await S.getText(S.BASE + '/en-us/concept/' + cid);
  if (!hub) return [];
  const pids = S.productIds(hub).slice(0, EDITIONS_MAX);
  const pages = await S.pool(pids, 4, async pid =>
    ({ pid, h: await S.getText(S.BASE + '/en-us/product/' + pid) }));

  const out = [];
  const seen = new Set();
  for (const { pid, h } of pages) {
    if (!h) continue;
    const g = S.grab(h);
    if (g.price == null) continue;
    if (title && !S.sameGame(g.name, title)) continue;

    const conv = convert(g.price, g.cur || 'USD', cur, rates);
    const shown = conv != null ? converted(cur, conv) : money(g.cur || 'USD', g.price, true);
    const tail = ' · ' + shown;
    const name = g.name || pid;
    const room = 60 - tail.length;
    const label = (name.length > room ? name.slice(0, Math.max(1, room - 1)) + '…' : name) + tail;

    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ pid, label });
  }
  return out;
}

// Edits one message into the price table.
async function renderInto(chatId, messageId, pr, cur) {
  const { rates } = await getFx();
  const out = formatPrices(pr, cur, rates, TOP);
  const token = remember(pr);
  return tg('editMessageText', {
    chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
    link_preview_options: preview(pr.image),
    text: out.text,
    reply_markup: keyboard(out, out.rows > TOP ? token : null)
  });
}

// Posts the edition menu right after a game is priced. A game with a single
// edition gets no menu.
async function offerEditions(chatId, pr, cur) {
  if (!pr.conceptId) return;
  const { rates } = await getFx();
  const eds = await editionChoices(pr.conceptId, cur, rates, pr.title);
  if (eds.length < 2) return;
  return tg('sendMessage', {
    chat_id: chatId,
    text: 'Choose an edition:',
    reply_markup: { inline_keyboard: eds.map(e => [{ text: e.label, callback_data: 'e:' + e.pid }]) }
  });
}

async function startEdition(chatId, pid, cur) {
  const msg = await tg('sendMessage', { chat_id: chatId, text: 'Looking up that edition…' });
  if (!msg) return;
  return renderInto(chatId, msg.message_id, await editionLookup(pid), cur);
}

// ---------------------------------------------------------------- flows

function storeLink(r, loc) {
  return '<a href="https://store.playstation.com/' + (loc || 'en-us') + '/concept/' + r.conceptId +
         '"><b>' + esc(r.name) + '</b></a>';
}

function topList(limit, days) {
  const cat = S.getCatalog();
  if (!cat || !cat.rows) return [];
  const cutoff = days
    ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
    : null;
  return cat.rows
    .filter(r => r.rank && !r.free && (!cutoff || (r.releaseDate && r.releaseDate >= cutoff)))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit);
}

const HELP = [
  '<b>PlayStation price check</b>',
  '',
  'Send a game title and I will price it in 20 regions, cheapest first.',
  'After that, pick an edition from the menu to price just that one.',
  '',
  '· Type <code>@BOT ghost of</code> in any chat for a live list of titles.',
  '· A concept ID, a store URL, or an edition URL works too.',
  '· <code>/top</code> — what is popular now.  <code>/new</code> — popular recent releases.',
  '· <code>/cur USD</code> changes the currency I convert into (default SGD).'
].join('\n');

async function priceInto(chatId, messageId, query, cur) {
  const pr = await S.lookup(query);
  if (pr.error) {
    return tg('editMessageText', {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      text: esc(pr.error)
    });
  }
  await renderInto(chatId, messageId, pr, cur);
  return offerEditions(chatId, pr, cur);
}

async function startLookup(chatId, query, label, cur) {
  const msg = await tg('sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
    text: 'Looking up <b>' + esc(label || query) + '</b>…'
  });
  if (!msg) return;
  return priceInto(chatId, msg.message_id, query, cur);
}

async function onText(chatId, text) {
  const cur = target.get(chatId) || 'SGD';
  const t = text.trim();

  const started = t.match(/^\/start\s+(\d{5,})$/);
  if (started) {
    const cat0 = S.getCatalog();
    const known = cat0 && cat0.names && cat0.names.get(started[1]);
    return startLookup(chatId, started[1], known || started[1], cur);
  }
  if (/^\/(start|help)/.test(t)) {
    return tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: HELP });
  }

  if (/^\/(top|new)\b/i.test(t)) {
    const days = /^\/new/i.test(t) ? 30 : 0;
    const n = Math.min(parseInt((t.match(/\s(\d+)/) || [])[1], 10) || TOP_N, 40);
    const list = topList(n, days);
    if (!list.length) {
      return tg('sendMessage', { chat_id: chatId,
        text: 'No popularity data yet — the catalogue needs a ranking run.' });
    }
    const loc = S.LOCALES[homeRegion(cur)] || 'en-us';
    const rows = list.map((r, i) => rankLabel(i, list.length) + '  ' + storeLink(r, loc) +
      (days && r.releaseDate ? '  <i>' + esc(r.releaseDate) + '</i>' : ''));
    return tg('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      text: '<b>' + (days ? 'Best selling, released in the last 30 days' : 'Best selling right now') +
            '</b>\n\n' + rows.join('\n') +
            '\n\n<i>Tap a title for its store page, or send it to me to price it.</i>'
    });
  }

  if (/^\/cur/i.test(t)) {
    const c = (t.split(/\s+/)[1] || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) {
      return tg('sendMessage', { chat_id: chatId, text: 'Currency now: ' + cur + '. Use e.g. /cur USD' });
    }
    target.set(chatId, c);
    return tg('sendMessage', { chat_id: chatId, text: 'Converting into ' + c + ' from now on.' });
  }

  // A product link is one edition: price exactly that product.
  const direct = t.replace(/^\/p\s+/, '');
  const pm = direct.match(/\/product\/([A-Z0-9][\w-]{6,})/i);
  if (pm) return startEdition(chatId, pm[1], cur);

  // A bare ID or a concept URL goes straight to the game lookup.
  if (/^\d{5,}$/.test(direct) || /store\.playstation\.com/.test(direct)) {
    return startLookup(chatId, direct, direct, cur);
  }

  const cat = S.getCatalog();
  const exact = cat && (cat.get(S.keyName(t)) || S.catalogPrefix(t));
  if (exact) return startLookup(chatId, t, t, cur);

  const hits = suggest(t);
  if (hits.length === 1) return startLookup(chatId, hits[0].conceptId, hits[0].name, cur);
  if (hits.length) {
    return tg('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: 'Which one?',
      reply_markup: {
        inline_keyboard: hits.map(h => [{
          text: h.name.length > 60 ? h.name.slice(0, 57) + '…' : h.name,
          callback_data: 'g:' + h.conceptId
        }])
      }
    });
  }
  return startLookup(chatId, t, t, cur);
}

async function onCallback(cb) {
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const data = cb.data || '';
  await tg('answerCallbackQuery', { callback_query_id: cb.id });
  if (!chatId) return;
  const cur = target.get(chatId) || 'SGD';

  if (data.startsWith('g:')) {                       // a title was picked
    const cat = S.getCatalog();
    const id = data.slice(2);
    const name = (cat && cat.names && cat.names.get(id)) || id;
    return tg('editMessageText', {
      chat_id: chatId, message_id: cb.message.message_id, parse_mode: 'HTML',
      text: 'Looking up <b>' + esc(name) + '</b>…'
    }).then(() => priceInto(chatId, cb.message.message_id, id, cur));
  }

  if (data.startsWith('e:')) {                       // one edition, all regions
    return startEdition(chatId, data.slice(2), cur);
  }

  if (data.startsWith('m:')) {                        // show every region
    const hit = recent.get(data.slice(2));
    if (!hit) {
      return tg('sendMessage', { chat_id: chatId, text: 'That search has expired — send the title again.' });
    }
    const { rates } = await getFx();
    const out = formatPrices(hit.pr, cur, rates, Object.keys(S.LOCALES).length);
    return tg('editMessageText', {
      chat_id: chatId, message_id: cb.message.message_id, parse_mode: 'HTML',
      link_preview_options: preview(hit.pr.image), text: out.text,
      reply_markup: keyboard(out, null)
    });
  }
}

async function onInline(q) {
  const hits = suggest(q.query, INLINE);
  return tg('answerInlineQuery', {
    inline_query_id: q.id,
    cache_time: 60,
    results: hits.map(h => ({
      type: 'article',
      id: String(h.conceptId),
      title: h.name,
      description: 'Price it in 20 regions',
      input_message_content: { message_text: '/p ' + h.conceptId }
    }))
  });
}

async function handleUpdate(u) {
  try {
    const what = u.inline_query ? 'inline ' + JSON.stringify(u.inline_query.query)
      : u.callback_query ? 'button ' + u.callback_query.data
      : (u.message && u.message.text) ? 'text ' + JSON.stringify(u.message.text)
      : Object.keys(u).filter(k => k !== 'update_id').join(',');
    console.log('telegram: ' + what);
    if (u.inline_query) return await onInline(u.inline_query);
    if (u.callback_query) return await onCallback(u.callback_query);
    const m = u.message || u.edited_message;
    if (m && m.text && m.chat) return await onText(m.chat.id, m.text);
  } catch (e) {
    console.error('bot: ' + (e && e.message));
  }
}

// ---------------------------------------------------------------- polling

const POLL = 25;

async function startPolling() {
  if (!TOKEN) return;
  await tg('deleteWebhook', { drop_pending_updates: false });
  let offset = 0;
  console.log('telegram: polling');
  for (;;) {
    const ups = await tg('getUpdates',
      { offset, timeout: POLL, allowed_updates: ['message', 'callback_query', 'inline_query'] },
      (POLL + 15) * 1000);
    if (!ups) { await new Promise(r => setTimeout(r, 3000)); continue; }
    for (const u of ups) {
      offset = u.update_id + 1;
      handleUpdate(u);
    }
  }
}

module.exports = {
  handleUpdate, startPolling, suggest, rankRows, formatPrices,
  convert, money, converted, flag, rankLabel, editionSummary, preview, topList, storeLink,
  homeButton, homeRegion, keyboard, remember, recent, target, tg,
  editionLookup, editionChoices,
  hasToken: () => !!TOKEN
};