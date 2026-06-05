# Nameplate Product Info OCR Checker

A standalone browser MVP for checking nameplate images with Tesseract.js.

The app currently focuses on product information only. Each saved standard has separately editable attributes:

- allowed product types on the left side of the nameplate, one model per line;
- product origin line 1, for example `Product of Turkey`;
- product origin line 2, for example `Assembled by Illuminate USA LLC`.

To reduce OCR confusion, the app runs layout-aware OCR:

- after upload, the app auto-detects the long nameplate label and asks the user to confirm or adjust the crop;
- OCR runs against the confirmed nameplate crop, not the full photo;
- product type is read from the product/model region inside the confirmed crop;
- product origin is read from the assembled/origin region inside the confirmed crop;
- the cropped regions are moderately enlarged before OCR to improve small-text recognition without over-blurring;
- product type uses Tesseract single-line mode with an alphanumeric/dash character whitelist;
- product origin uses Tesseract block mode with a text-friendly character whitelist;
- each crop is converted to a milder black/white image before OCR;
- the app tries multiple OCR variants and crop positions for each region and keeps the one closest to the expected standard;
- common OCR mistakes like `Illurninate`, `Assembied`, and `USALLC` are cleaned before comparison.

Product type passes when the OCR text matches any configured product type for the selected standard.

Electrical specs are intentionally ignored for now.

## Run

Open `index.html` in a modern browser while connected to the internet. The first OCR run downloads the Tesseract.js English language model and may take longer than later runs.

No images are uploaded to a server. OCR runs inside the browser. Standards and results are saved only in that browser.

## Use

1. Select or create a nameplate standard.
2. Click **Edit** to modify allowed product types, origin line 1, and origin line 2.
3. Upload a nameplate image, drag/drop one, or click **Take Photo** on a phone.
4. Adjust the red crop rectangle if needed and click **Use this crop**.
5. Click **Run OCR and compare**.

The result table reports each attribute independently with expected value, pass/fail result, score, and the closest OCR text. The **Best OCR match** column always shows OCR text rather than placeholder wording.

Because the app now runs multiple OCR passes for better accuracy, each image may take longer than the first simple prototype.

## Install on iPhone as a PWA

1. Host or open the app URL in Safari on iPhone.
2. Tap **Share**.
3. Tap **Add to Home Screen**.
4. Launch **Nameplate OCR** from the Home Screen.

This is the current iPhone export path. A native App Store/TestFlight version would be a later step using a wrapper such as Capacitor plus Xcode and an Apple Developer Program account.
