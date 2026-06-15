# Nameplate Product Info OCR Checker

A browser-based nameplate checker using Google Cloud Vision OCR with Tesseract.js as an automatic fallback.

The app currently focuses on product information only. Each saved standard has separately editable attributes:

- allowed product types on the left side of the nameplate, one model per line;
- product origin line 1, for example `Product of Turkey`;
- product origin line 2, for example `Assembled by Illuminate USA LLC`.

To reduce OCR confusion, the app runs layout-aware OCR:

- after upload, the app auto-detects the long nameplate label and asks the user to confirm or adjust the crop;
- OCR runs against the confirmed nameplate crop, not the full photo;
- product type is read from the product/model region inside the confirmed crop;
- product origin is read from the assembled/origin region inside the confirmed crop;
- the confirmed nameplate crop is sent once to a secure Cloud Run endpoint backed by Google Cloud Vision;
- Google Vision word coordinates are used to reconstruct the product type and origin regions;
- if Google Vision is unavailable, the app automatically runs its previous layout-aware Tesseract OCR variants;
- common OCR mistakes like `Illurninate`, `Assembied`, and `USALLC` are cleaned before comparison.

Product type passes when the OCR text matches any configured product type for the selected standard.

Electrical specs are intentionally ignored for now.

## Run

Open the hosted HTTPS app in a modern browser while connected to the internet.

The confirmed nameplate crop is sent to the project's Google Cloud Run OCR endpoint for processing. Standards and results remain stored only in the browser. When the cloud endpoint is unavailable, the Tesseract fallback runs locally in the browser.

## Google Vision backend

The frontend calls:

`https://nameplate-ocr-api-906417989527.us-east1.run.app`

The Node.js backend is stored in `api/`. It uses the Cloud Run runtime service account and does not expose an API key in the browser.

To redeploy it:

```powershell
gcloud run deploy nameplate-ocr-api `
  --source api `
  --project project-b0668fa5-84f3-4ee4-879 `
  --region us-east1 `
  --allow-unauthenticated `
  --build-service-account projects/project-b0668fa5-84f3-4ee4-879/serviceAccounts/nameplate-ocr-build@project-b0668fa5-84f3-4ee4-879.iam.gserviceaccount.com `
  --service-account nameplate-ocr-runtime@project-b0668fa5-84f3-4ee4-879.iam.gserviceaccount.com `
  --max-instances 1
```

The app submits one confirmed nameplate crop per inspection. Google Vision returns full OCR text and normalized word coordinates; the frontend uses those coordinates to reconstruct the product-type and origin regions.

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
