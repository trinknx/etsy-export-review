import { fetchReviewsPage, readPageContext, runInTab } from './lib/etsy.js';
import { toCsv, toXlsx, toJson, photosZip, downloadBlob } from './lib/export.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const reviews = [];
const seen = new Set();
let job = null;
let stopped = false;
let running = false;

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').className = isError ? 'error' : '';
}

function stars(n) {
  const r = Math.round(Number(n) || 0);
  return '★'.repeat(r) + '☆'.repeat(Math.max(0, 5 - r));
}

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) e.append(c);
  return e;
}

// "Original text" toggle decides which language is the display/export text.
function textOf(r) {
  return $('f-original').checked ? (r.originalText || r.text) : (r.text || r.originalText);
}

function filtered() {
  const rating = $('f-rating').value;
  const rec = $('f-rec').value;
  const photos = $('f-photos').value;
  const resp = $('f-resp').value;
  const from = $('f-from').value;
  const to = $('f-to').value;
  const q = $('f-text').value.trim().toLowerCase();

  return reviews.filter((r) => {
    if (rating && String(r.rating) !== rating) return false;
    if (rec === 'yes' && r.recommends !== true) return false;
    if (rec === 'no' && r.recommends !== false) return false;
    if (photos === 'yes' && !r.photos.length) return false;
    if (photos === 'no' && r.photos.length) return false;
    if (resp === 'yes' && !r.sellerResponse) return false;
    if (resp === 'no' && r.sellerResponse) return false;
    if (from && r.date && r.date < from) return false;
    if (to && r.date && r.date > to) return false;
    if (q) {
      const hay = [r.text, r.originalText, r.author, r.itemTitle, r.variation, r.sellerResponse]
        .join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// Export functions read r.text, so project the toggle choice onto the rows.
function exportRows(list) {
  return list.map((r) => ({ ...r, text: textOf(r) }));
}

function rowFor(r, i) {
  const textCell = el('td', { class: 'text' }, [
    el('div', { text: textOf(r) || '—' }),
    r.originalText && !$('f-original').checked
      ? el('div', { class: 'orig', text: 'Original: ' + r.originalText })
      : null,
    r.sellerResponse ? el('div', { class: 'resp', text: 'Seller: ' + r.sellerResponse }) : null,
  ]);
  const author = r.authorUrl
    ? el('a', { href: r.authorUrl, target: '_blank', rel: 'noopener', text: r.author || 'Buyer' })
    : el('span', { text: r.author });
  const item = el('td', {}, [
    r.itemUrl
      ? el('a', { href: r.itemUrl, target: '_blank', rel: 'noopener', text: r.itemTitle || 'Item' })
      : el('span', { text: r.itemTitle }),
    r.variation ? el('div', { class: 'muted-small', text: r.variation }) : null,
    r.recommends === '' ? null : el('div', {
      class: 'muted-small',
      text: r.recommends ? 'Recommends' : "Doesn't recommend",
    }),
  ]);
  const thumbs = el('td', { class: 'thumbs' },
    r.photos.map((src) => el('a', { href: src, target: '_blank', rel: 'noopener' },
      [el('img', { src, loading: 'lazy', alt: '' })])));
  return el('tr', {}, [
    el('td', { class: 'num', text: String(i + 1) }),
    el('td', { class: 'stars', text: stars(r.rating), title: String(r.rating) }),
    el('td', { text: r.date }),
    textCell,
    el('td', {}, [author]),
    item,
    thumbs,
  ]);
}

function render() {
  const list = filtered();
  $('rows').replaceChildren(...list.map(rowFor));
  $('filter-count').textContent = `${list.length} of ${reviews.length} shown`;

  const photoCount = reviews.reduce((n, r) => n + r.photos.length, 0);
  const avg = reviews.length
    ? reviews.reduce((n, r) => n + (Number(r.rating) || 0), 0) / reviews.length
    : 0;
  const dates = reviews.map((r) => r.date).filter(Boolean).sort();
  $('summary').replaceChildren(
    el('div', { class: 'chip' }, [el('b', { text: String(reviews.length) }), ' reviews']),
    el('div', { class: 'chip' }, [el('b', { text: avg ? avg.toFixed(2) : '—' }), ' avg rating']),
    el('div', { class: 'chip' }, [el('b', { text: String(photoCount) }), ' photos']),
    dates.length
      ? el('div', { class: 'chip' }, [el('b', { text: `${dates[0]} → ${dates[dates.length - 1]}` }), ' span'])
      : null,
  );

  // 1–5 star distribution bars.
  const counts = [1, 2, 3, 4, 5].map(() => 0);
  for (const r of reviews) {
    const n = Math.round(Number(r.rating) || 0);
    if (n >= 1 && n <= 5) counts[n - 1]++;
  }
  const max = Math.max(1, ...counts);
  const dist = [5, 4, 3, 2, 1].map((star) => {
    const c = counts[star - 1];
    const fill = el('div', { class: 'fill' });
    fill.style.height = Math.round((c / max) * 44) + 'px';
    return el('div', { class: 'r' + (star === Math.round(avg) ? ' top' : '') }, [
      fill,
      el('span', { text: `${star}★ ${c}` }),
    ]);
  });
  $('distribution').replaceChildren(...dist);

  const hasData = list.length > 0;
  for (const id of ['csv', 'xlsx', 'json']) $(id).disabled = !hasData;
  $('photos').disabled = !hasData || running || !list.some((r) => r.photos.length);
}

function baseName(ext) {
  const date = new Date().toISOString().slice(0, 10);
  const id = job.scope === 'shop' ? 'shop-' + (job.info.shopId || 'x') : job.info.listingId;
  return `etsy-reviews-${id}-${date}.${ext}`;
}

// A stale CSRF token can appear as an HTTP error mid-export; re-read it from
// the tab (cheap) before burning a retry.
async function refreshCsrf() {
  try {
    const ctx = await runInTab(job.tabId, readPageContext);
    if (ctx && ctx.csrf) job.info.csrf = ctx.csrf;
  } catch (e) { /* tab gone; the fetch loop will report it */ }
}

async function run() {
  running = true;
  const maxPages = job.maxPages || Infinity;
  let page = 1;
  let totalPages = 0;
  let retries = 0;

  while (!stopped && page <= maxPages) {
    setStatus(`Fetching page ${page}${totalPages ? ' of ' + Math.min(totalPages, maxPages) : ''}…`);
    let result;
    try {
      result = await runInTab(job.tabId, fetchReviewsPage, {
        listingId: job.info.listingId,
        shopId: job.info.shopId,
        csrf: job.info.csrf,
        scope: job.scope,
        sort: job.sort,
        page,
      });
    } catch (e) {
      setStatus('Lost access to the Etsy tab. Keep it open on the listing page, then export again.', true);
      break;
    }

    if (!result || result.error) {
      const status = result && result.status;
      if (status === 401 || status === 403 || status === 419) await refreshCsrf();
      if (retries < 3) {
        retries++;
        const wait = 5000 * retries;
        setStatus(`Etsy returned ${result ? result.error : 'nothing'}; retrying in ${wait / 1000}s…`);
        await sleep(wait);
        continue;
      }
      setStatus(`Stopped: ${result ? result.error : 'no response'} on page ${page}.`, true);
      break;
    }
    retries = 0;

    let added = 0;
    for (const r of result.reviews) {
      const key = r.id || JSON.stringify([r.author, r.date, r.text]);
      if (seen.has(key)) continue;
      seen.add(key);
      reviews.push(r);
      added++;
    }
    if (result.totalPages) totalPages = result.totalPages;
    const target = Math.min(totalPages || 0, maxPages === Infinity ? totalPages : maxPages);
    if (target) $('bar').style.width = Math.min(100, (page / target) * 100) + '%';
    render();

    // Stop when Etsy says there is no next page, or a page adds nothing new
    // (the legacy HTML format repeats the last page instead of returning empty).
    if (!result.hasMore || added === 0) break;
    page++;
    if (job.delay) await sleep(job.delay * 1000 * (0.75 + Math.random() * 0.5));
  }

  running = false;
  $('stop').disabled = true;
  $('bar').style.width = '100%';
  if ($('status').className !== 'error') {
    setStatus(`${stopped ? 'Stopped' : 'Done'} — ${reviews.length} reviews collected.`);
  }
  render();
}

async function init() {
  const jobId = new URLSearchParams(location.search).get('job');
  const stored = await chrome.storage.session.get('job:' + jobId);
  job = stored['job:' + jobId];
  if (!job) {
    $('listing-title').textContent = 'Export not found';
    setStatus('Start a new export from the extension popup on an Etsy listing.', true);
    $('stop').disabled = true;
    return;
  }

  document.title = `Reviews — ${job.info.title}`;
  $('listing-title').textContent = job.info.title;
  $('listing-link').href = job.info.url;
  $('listing-link').textContent = job.info.url;
  $('scope-label').textContent =
    (job.scope === 'shop' ? 'All shop reviews' : 'Item reviews') + ' · sorted by ' + job.sort;

  $('stop').addEventListener('click', () => { stopped = true; $('stop').disabled = true; });
  for (const id of ['f-rating', 'f-rec', 'f-photos', 'f-resp', 'f-from', 'f-to', 'f-text', 'f-original']) {
    $(id).addEventListener('input', render);
  }

  $('csv').addEventListener('click', () => downloadBlob(toCsv(exportRows(filtered())), baseName('csv')));
  $('xlsx').addEventListener('click', () => downloadBlob(toXlsx(exportRows(filtered())), baseName('xlsx')));
  $('json').addEventListener('click', () => downloadBlob(toJson(exportRows(filtered())), baseName('json')));
  $('photos').addEventListener('click', async () => {
    const list = filtered();
    const total = list.reduce((n, r) => n + r.photos.length, 0);
    $('photos').disabled = true;
    const { blob, count, failed } = await photosZip(list, (done, remaining) =>
      setStatus(`Downloading photos ${done}/${done + remaining}…`));
    downloadBlob(blob, baseName('zip').replace(/\.zip$/, '-photos.zip'));
    setStatus(`Saved ${count} of ${total} photos${failed ? ` (${failed} failed)` : ''}.`);
    $('photos').disabled = false;
    render();
  });

  run();
}

init();
