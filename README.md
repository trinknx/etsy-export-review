# Etsy Export — Reviews

A Manifest V3 Chrome extension that exports reviews from an Etsy product listing
(or the shop's whole review history) to **CSV, Excel (XLSX), or JSON**, and can
download all **review photos as a ZIP**.

It is a clean-room, fully local alternative to commercial "Etsy Reviews
Exporter" extensions: **no account, no backend, no analytics, no tracking**.
Everything runs in your browser against Etsy's own first-party reviews API
using your existing logged-in session.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this `etsy-export` folder
4. Open any Etsy product listing page and click the extension icon

## Use

1. On a listing page, click the extension icon.
2. The popup shows what it found (review count, average rating, page count).
3. Pick **This item** or **Whole shop**, a sort order, max pages (0 = all),
   and a delay between page requests (default 1.5 s — keep it).
4. Click **Export reviews**. A results tab opens and pages through reviews,
   showing live progress and a preview table.
5. Filter what you collected (rating, recommends, photos, seller reply, date
   range, free text, original-language toggle) — **exports respect the filters**.
6. Download as CSV / Excel / JSON, or pull all photos into one ZIP.

Keep the Etsy listing tab open while the export runs — the extension fetches
each page from inside that tab.

## How it works

```
popup.js  ──chrome.scripting.executeScript──▶  Etsy tab
              readPageContext()   → listing id, shop id, csrf nonce
              fetchReviewsPage()  → POST /api/v3/ajax/bespoke/member/neu/
                                    specs/deep_dive_reviews   (Etsy's own
                                    endpoint, same-origin, user cookies)
results.js ── pagination loop: dedupe, retry w/ backoff, CSRF re-read,
              polite delay with jitter, live table + filters
lib/export.js ── CSV (BOM+CRLF), JSON, hand-built XLSX (OOXML) package
lib/zip.js ──── 62-line STORE-method ZIP writer (shared by XLSX + photos)
```

Design notes:

- **Injected functions are self-contained** (`lib/etsy.js`) — they are
  serialized into the page, so they cannot close over module scope.
- **Two response generations are handled**: the current structured
  `jsData.reviews` JSON, and the legacy HTML-fragment format (parsed with
  DOMParser). The legacy format repeats the last page instead of returning
  empty, so pagination also stops when a page adds no new deduped reviews.
- **Excel without SheetJS**: `toXlsx` emits the raw OOXML parts and packs them
  with the built-in ZIP writer — frozen header row, column widths, 32,767-char
  cell cap enforced, UTF-8 BOM'd CSV for Excel.
- **Long-export resilience**: transient errors retry 3× with 5/10/15 s waits;
  auth-ish statuses (401/403/419) first re-read the CSRF nonce from the tab.
- **Permissions are minimal**: `activeTab` (granted by clicking the icon),
  `scripting`, `storage` (settings + job handoff), `downloads`, plus host
  access only to `etsy.com` and `i.etsystatic.com` (photo downloads).

## Limitations

- Depends on Etsy's internal (undocumented) API; if Etsy changes it, the
  extension breaks until updated.
- Review photos are fetched at Etsy's largest published size
  (`iap_fullxfull` / `il_1588xN`); failures are skipped and reported.
- Use respectfully: keep the delay on, and only export data you can already
  see in your own browser session.
