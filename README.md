# SLR Expense Helper

A single-page web app that reads dates, totals, vendors, and categories off
photos or PDFs of receipts and renames the files for expense reports.
Everything runs in the browser — no uploads, no API keys, no backend.

## How it works

1. Take pictures of all your receipts, naming each with what the expense is
   about (e.g. `team-dinner.jpg`).
2. Open `index.html` in a browser.
3. Drag the receipts onto the drop zone.
4. Hit **Download all (ZIP)** when processing finishes.

Each file comes back named like:

```
2026-05-20_team-dinner_42.50_The-Bistro_Food.jpg
[ date ]   [ original ] [total]  [vendor]   [category].ext
```

If OCR can't find a date on the receipt, the app falls back to the file's
modification time and uses tildes instead of dashes
(`2026~05~20_…`) so you know to double-check that one. The Date column
in the UI also wraps inferred dates in a red box on hover.

## Stack

Pure client side, three files:

| File | Purpose |
|---|---|
| `index.html` | layout, drop zone, files table |
| `styles.css` | SLR Consulting branding (Heavy Metal / Yellow Green / Cararra) |
| `app.js`     | file intake, parsing, renaming, ZIP packaging |

Libraries are loaded from CDN at runtime:

- [Tesseract.js](https://tesseract.projectnaptha.com/) — OCR for image-based receipts
- [PDF.js](https://mozilla.github.io/pdf.js/) — text extraction from PDFs (with OCR fallback for scanned PDFs)
- [JSZip](https://stuk.github.io/jszip/) — bundling renamed files for download

## Running locally

Just open `index.html` in a browser:

```
open index.html
```

Or, if your browser is fussy about `file://` URLs:

```
python3 -m http.server 8080
# then visit http://localhost:8080
```

## Field extraction notes

- **Date** — tries ISO, US `MM/DD/YYYY`, `Month DD, YYYY`, and `DD Month YYYY`.
  Falls back to the file's `lastModified` timestamp when nothing is found.
- **Total** — prefers lines labeled `Total` / `Grand Total` / `Amount Due` /
  `Balance Due`. Skips `Subtotal`. Falls back to the largest dollar amount on
  the receipt.
- **Vendor** — first short, alpha-heavy line near the top of the receipt,
  ignoring street addresses and phone numbers.
- **Category** — keyword-based: Travel, Fuel, Food, Grocery, Office, Tech,
  Shipping, Parking, Other. Easy to extend in `parseCategory()` in `app.js`.

## Customizing

- **Logo:** the brand image at the top of `index.html` is hot-linked. Save a
  copy locally and point the `src` at it if you want this to work offline.
- **Brand colors:** the three SLR Consulting hex codes are in the `:root`
  block at the top of `styles.css`.
- **Category vendors:** add keywords to the `rules` array in `parseCategory`
  for vendors you see often.

## Privacy

Nothing leaves your browser. Tesseract.js downloads the English language
model from CDN on first use (~10 MB), then caches it. Subsequent runs
work offline.
