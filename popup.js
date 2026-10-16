import { isListingUrl, readPageContext, fetchReviewsPage, runInTab } from './lib/etsy.js';

const $ = (id) => document.getElementById(id);
const DEFAULTS = { scope: 'listing', sort: 'Relevancy', maxPages: 0, delay: 1.5 };

let tab;
let info;
let settings = { ...DEFAULTS };

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = false;
}

function applySettings() {
  for (const b of $('scope').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === settings.scope);
  $('sort').value = settings.sort;
  $('maxPages').value = settings.maxPages;
  $('delay').value = settings.delay;
}

function saveSettings() {
  settings.sort = $('sort').value;
  settings.maxPages = Math.max(0, parseInt($('maxPages').value, 10) || 0);
  settings.delay = Math.max(0, parseFloat($('delay').value) || 0);
  chrome.storage.local.set({ settings });
}

// Probe page 1 for the chosen scope/sort to show totals before committing.
async function loadStats() {
  $('stats').textContent = 'Checking reviews…';
  try {
    const page = await runInTab(tab.id, fetchReviewsPage, {
      ...info, scope: settings.scope, sort: settings.sort, page: 1,
    });
    if (!page || page.error) throw new Error(page ? page.error : 'No response');
    const parts = [];
    if (page.totalReviews) {
      parts.push(`${page.totalReviews.toLocaleString()} ${settings.scope === 'shop' ? 'shop' : 'item'} reviews`);
    }
    if (page.averageRating) parts.push(`★ ${Number(page.averageRating).toFixed(2)}`);
    if (page.totalPages) parts.push(`${page.totalPages} pages`);
    $('stats').textContent = parts.length ? parts.join(' · ') : `${page.reviews.length} reviews on page 1`;
  } catch (e) {
    $('stats').textContent = 'Could not read review totals (you can still try exporting).';
    console.warn(e);
  }
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !isListingUrl(tab.url)) {
    $('not-listing').hidden = false;
    return;
  }
  $('main').hidden = false;

  const stored = await chrome.storage.local.get('settings');
  settings = { ...DEFAULTS, ...(stored.settings || {}) };
  applySettings();

  try {
    info = await runInTab(tab.id, readPageContext);
  } catch (e) {
    showError('Could not access this tab. Reload the Etsy page and try again.');
    return;
  }
  $('title').textContent = info.title;
  $('title').title = info.title;
  if (!info.listingId || !info.csrf) {
    showError('This page is missing the data Etsy needs for reviews. Reload the page and try again.');
    return;
  }
  if (!info.shopId) showError('Could not find the shop id on this page; export may fail.');

  $('start').disabled = false;
  loadStats();

  $('scope').addEventListener('click', (e) => {
    const v = e.target.dataset && e.target.dataset.v;
    if (!v || v === settings.scope) return;
    settings.scope = v;
    applySettings();
    saveSettings();
    loadStats();
  });
  $('sort').addEventListener('change', () => { saveSettings(); loadStats(); });
  $('maxPages').addEventListener('change', saveSettings);
  $('delay').addEventListener('change', saveSettings);

  // Hand the job to the results page via session storage (survives the popup
  // closing, dies with the browser — nothing about the export is persisted).
  $('start').addEventListener('click', async () => {
    saveSettings();
    const job = { tabId: tab.id, info, ...settings, startedAt: Date.now() };
    const jobId = String(job.startedAt);
    await chrome.storage.session.set({ ['job:' + jobId]: job });
    chrome.tabs.create({ url: chrome.runtime.getURL('results.html?job=' + jobId) });
    window.close();
  });
}

init();
