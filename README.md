# Nameplate OCR Inspection App

A browser-based nameplate inspection app using Google Cloud Vision OCR through a Cloud Run backend.

Current inspection scope:

- product type matching, with multiple valid model values per standard;
- product origin matching, with editable origin lines.
- cloud inspection history, including compressed inspection photos.

Electric spec extraction is intentionally deferred.

## Live App

- Operator page: `https://syzygycc.github.io/Nameplate-OCR/index.html`
- Admin page: `https://syzygycc.github.io/Nameplate-OCR/admin.html`

Operators select line `L1-L8`, upload or take a full photo, and run OCR. The app loads the standard bound to that line from shared Cloud Run config.

## Google Vision Backend

The frontend calls:

`https://nameplate-ocr-api-906417989527.us-east1.run.app`

The Node.js backend is stored in `api/`. It uses the Cloud Run runtime service account and does not expose an API key in the browser.

Endpoints:

- `POST /ocr`: runs Google Vision `DOCUMENT_TEXT_DETECTION` and returns full text plus normalized word bounding boxes.
- `GET /config`: reads shared admin/operator config.
- `PUT /config`: saves shared admin/operator config.
- `POST /inspections`: saves one inspection record and compressed photo.
- `GET /inspections`: lists recent cloud inspection records.
- `GET /inspections/:id`: reads one full inspection record.

To redeploy:

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

## Admin Configuration

Open `admin.html` to configure:

- standards and brand labels;
- allowed product types;
- origin wording lines;
- L1-L8 line bindings;
- global product/origin pass threshold percentage.

The admin setup is stored by Cloud Run in a Google Cloud Storage JSON config object, so all devices share the same standards and line bindings.

## Inspection Data Storage

Each completed inspection is saved to Google Cloud:

- Firestore stores the inspection record, line, standard, result, score, OCR text, and field-level expected/actual/pass data.
- Cloud Storage stores the compressed uploaded photo.
- The operator history table loads recent records from Cloud Run.
- If cloud saving fails, the app keeps that run in local pending history so the operator can still see the result.

## Operator Workflow

1. Admin creates standards and binds each line.
2. Operator opens `index.html`.
3. Operator selects `L1-L8`.
4. Operator uploads or takes a full photo.
5. Operator clicks **Run OCR and compare**.
6. App reports product/origin result and saves the run to cloud history.
7. Operator can export the current history table as CSV.

## Roadmap

- V2: restore admin-configured electric spec extraction and comparison.
- V3: investigate printing deviation detection as a separate experimental flow.

## Install on iPhone as a PWA

1. Open the app URL in Safari on iPhone.
2. Tap **Share**.
3. Tap **Add to Home Screen**.
4. Launch **Nameplate OCR** from the Home Screen.

This is the current iPhone export path. A native App Store/TestFlight version would be a later step using a wrapper such as Capacitor plus Xcode and an Apple Developer Program account.
