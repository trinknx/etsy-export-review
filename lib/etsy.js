// Everything the extension runs inside the Etsy tab lives here.
//
// Functions marked [injected] are serialized by chrome.scripting.executeScript
// and evaluated in the page's own JS world. They must be fully self-contained:
// no imports, no references to anything in this module's scope.

export const SORT_OPTIONS = ['Relevancy', 'Recency', 'Highest', 'Lowest'];

export function isListingUrl(url) {
  return /^https:\/\/([a-z0-9-]+\.)?etsy\.com\/(?:[a-z-]{2,5}\/)?listing\/\d+/i.test(url || '');
}

/**
 * [injected] Reads everything Etsy's reviews API needs from the listing page:
 * listing id from the URL, shop id from the DOM (three fallbacks), the CSRF
 * nonce from a meta tag, and a human title.
 */
export function readPageContext() {
  const listingId = (location.pathname.match(/\/listing\/(\d+)/) || [])[1] || '';

  let shopId = '';
  const follow = document.querySelector("[data-action='follow-shop-button']");
  if (follow && follow.dataset.shopId) shopId = follow.dataset.shopId;
  if (!shopId) {
    const el = document.querySelector('[data-shop-id]');
    if (el) shopId = el.getAttribute('data-shop-id') || '';
  }
  if (!shopId) {
    for (const s of document.querySelectorAll('script')) {
      const m = (s.textContent || '').match(/"shop_id"\s*:\s*"?(\d+)/);
      if (m) { shopId = m[1]; break; }
    }
  }

  const meta = document.querySelector('meta[name="csrf_nonce"]');
  const h1 = document.querySelector('h1');
  return {
    listingId,
    shopId,
    csrf: meta ? meta.getAttribute('content') : '',
    title: (h1 && h1.textContent.trim()) || document.title,
    url: location.href.split('?')[0],
  };
}

/**
 * [injected] Fetches one page of reviews from Etsy's own first-party endpoint.
 * Runs in the tab, so the request is same-origin and carries the user's Etsy
 * cookies — the extension never handles credentials itself.
 *
 * Handles both response generations: current structured `jsData` JSON, and the
 * legacy HTML-fragment format that some deployments still return.
 */
export async function fetchReviewsPage({ listingId, shopId, csrf, scope, sort, page }) {
  // Upgrade photo URLs to the largest published size. Etsy size tokens look
  // like iap_75x75 / il_340x270 / il_794xN and are followed by "." or "/".
  const fullSize = (u) =>
    String(u || '')
      .replace(/iap_\d+x\d+(?=[./])/, 'iap_fullxfull')
      .replace(/il_\d+x(?:\d+|N)(?=[./])/, 'il_1588xN');

  const decode = (html) => {
    const t = document.createElement('textarea');
    t.innerHTML = html || '';
    return t.value;
  };

  const isoDate = (raw) => {
    if (!raw) return '';
    const d = new Date(typeof raw === 'number' && raw < 1e12 ? raw * 1000 : raw);
    if (isNaN(d.getTime())) return String(raw);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  const absUrl = (u) => (u && !/^https?:/i.test(u) ? 'https://www.etsy.com' + u : u || '');

  const body = {
    log_performance_metrics: false,
    specs: {
      deep_dive_reviews: [
        'Etsy\\Modules\\ListingPage\\Reviews\\DeepDive\\AsyncApiSpec',
        {
          listing_id: listingId,
          shop_id: shopId,
          scope: scope === 'shop' ? 'shopReviews' : 'listingReviews',
          page,
          sort_option: sort || 'Relevancy',
          tag_filters: [],
          should_lazy_load_images: false,
          should_show_variations: true,
        },
      ],
    },
    runtime_analysis: false,
  };

  let res;
  try {
    res = await fetch('/api/v3/ajax/bespoke/member/neu/specs/deep_dive_reviews', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { error: 'Network error', status: 0 };
  }
  if (!res.ok) return { error: 'HTTP ' + res.status, status: res.status };

  let data;
  try {
    data = await res.json();
  } catch (e) {
    return { error: 'Bad JSON from Etsy', status: res.status };
  }

  // ---- Current format: structured JSON under jsData. ----
  const js = data && data.jsData;
  if (js && Array.isArray(js.reviews)) {
    const photosByTxn = {};
    ((js.media && js.media.photos) || []).forEach((p) => {
      if (!p.transactionId || !p.imageUrl) return;
      (photosByTxn[p.transactionId] = photosByTxn[p.transactionId] || []).push(fullSize(p.imageUrl));
    });

    const reviews = js.reviews.map((r) => {
      const info = r.reviewInfo || {};
      const content = r.reviewContent || {};
      const txn = info.transactionData || {};
      const original = decode(content.reviewText);
      const translated = content.reviewTextTranslated ? decode(content.reviewTextTranslated) : '';
      const photos = content.appreciationPhotoUrl
        ? [fullSize(content.appreciationPhotoUrl)]
        : photosByTxn[r.transactionId] || [];
      return {
        id: String(r.transactionId || r.reviewId || ''),
        rating: Number(info.rating) || '',
        date: isoDate(info.reviewDate),
        text: translated || original,
        originalText: translated ? original : '',
        author: (r.buyerInfo && r.buyerInfo.name) || '',
        authorUrl: absUrl(r.buyerInfo && r.buyerInfo.profileUrl),
        recommends: info.isRecommended == null ? '' : !!info.isRecommended,
        variation: (txn.variations || []).map((v) => (v.label ? v.label + ': ' : '') + (v.value || '')).join('; '),
        itemTitle: txn.listingTitle || '',
        itemUrl: absUrl(txn.listingUrl),
        sellerResponse: decode(r.sellerResponse && r.sellerResponse.responseText),
        photos,
      };
    });

    const current = js.currentPage || page;
    const total = js.totalPages || 0;
    return {
      reviews,
      hasMore: total ? current < total : reviews.length > 0,
      totalPages: total,
      totalReviews: js.totalReviews || null,
      averageRating: js.averageRating || null,
    };
  }

  // ---- Legacy format: an HTML fragment of review cards. ----
  const html = data && data.output && (data.output.deep_dive_reviews || data.output.reviews);
  if (!html) return { error: 'Unexpected response from Etsy', status: res.status };

  const doc = new DOMParser().parseFromString(html, 'text/html');
  let cards = doc.querySelectorAll('.review-card');
  if (!cards.length) cards = doc.querySelectorAll('[data-review-region]');

  const reviews = [...cards].map((card) => {
    const ratingInput = card.querySelector('input[name="rating"]');
    let text = '';
    for (const sel of [
      'p[id^="review-preview-toggle"]',
      '.wt-text-truncate--multi-line',
      '.wt-break-word.wt-text-body p',
    ]) {
      const el = card.querySelector(sel);
      if (el && !el.closest('#shop-response-text') && el.textContent.trim()) {
        text = el.textContent.trim();
        break;
      }
    }
    const author = card.querySelector('a[href*="/people/"]');
    const dateMatch = card.textContent.match(/[A-Z][a-z]{2} \d{1,2}, \d{4}/);
    const response = card.querySelector('#shop-response-text');
    const all = card.textContent;
    return {
      id: card.dataset.reviewRegion || '',
      rating: ratingInput ? Number(ratingInput.value) : '',
      date: dateMatch ? isoDate(dateMatch[0]) : '',
      text,
      originalText: '',
      author: author ? author.textContent.trim() : '',
      authorUrl: author ? absUrl(author.getAttribute('href')) : '',
      recommends: all.includes("Doesn't recommend") ? false : all.includes('Recommends') ? true : '',
      variation: '',
      itemTitle: '',
      itemUrl: '',
      sellerResponse: response ? response.textContent.trim() : '',
      // iap_ = review/appreciation photos; avoid il_ here since avatars use it too.
      photos: [...card.querySelectorAll('img[src*="iap_"]')]
        .map((i) => fullSize(i.getAttribute('src'))),
    };
  });

  return { reviews, hasMore: reviews.length > 0, totalPages: 0, totalReviews: null, averageRating: null };
}

/** Runs a self-contained function inside the given tab and returns its result. */
export async function runInTab(tabId, func, arg) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: arg === undefined ? [] : [arg],
  });
  return injection && injection.result;
}
