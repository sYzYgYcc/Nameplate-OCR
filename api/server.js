import express from "express";
import { randomUUID } from "node:crypto";
import { Firestore } from "@google-cloud/firestore";
import { Storage } from "@google-cloud/storage";
import vision from "@google-cloud/vision";

const app = express();
const client = new vision.ImageAnnotatorClient();
const storage = new Storage();
const firestore = new Firestore();
const configBucket = process.env.CONFIG_BUCKET || "";
const configObject = process.env.CONFIG_OBJECT || "nameplate-config.json";
const inspectionImageBucket = process.env.INSPECTION_IMAGE_BUCKET || "";
const inspectionsCollection = process.env.INSPECTIONS_COLLECTION || "inspections";
const geminiModel = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const allowedOrigins = new Set([
  "https://syzygycc.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
]);

app.use(express.json({ limit: "12mb" }));
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && origin !== "null" && !allowedOrigins.has(origin)) {
    return res.status(403).json({ error: "Origin not allowed." });
  }
  if (origin && origin !== "null") {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  } else {
    res.set("Access-Control-Allow-Origin", "*");
  }
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "nameplate-ocr-api" });
});

const lines = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"];
function emptyConfig() {
  return {
    version: 1,
    thresholdPercent: 85,
    lineBindings: Object.fromEntries(lines.map(line => [line, ""])),
    standards: []
  };
}
function normalizeConfig(input) {
  const base = emptyConfig();
  const standards = Array.isArray(input?.standards) ? input.standards : [];
  const lineBindings = { ...base.lineBindings, ...(input?.lineBindings || {}) };
  const validIds = new Set(standards.map(item => String(item.id || "")).filter(Boolean));
  for (const line of lines) {
    if (!validIds.has(lineBindings[line])) lineBindings[line] = "";
  }
  return {
    version: 1,
    thresholdPercent: Math.max(50, Math.min(100, Number(input?.thresholdPercent || base.thresholdPercent))),
    lineBindings,
    standards: standards.map(item => ({
      id: String(item.id || randomUUID()),
      name: String(item.name || "Untitled Standard").trim(),
      brandLabel: String(item.brandLabel || "").trim(),
      productTypes: Array.isArray(item.productTypes) ? item.productTypes.map(String).map(x => x.trim()).filter(Boolean) : [],
      originLines: Array.isArray(item.originLines) ? item.originLines.map(String).map(x => x.trim()).filter(Boolean) : [],
      generalSpecs: Array.isArray(item.generalSpecs) ? item.generalSpecs.map(spec => ({
        label: String(spec?.label || "").trim(),
        value: String(spec?.value || "").trim()
      })).filter(spec => spec.label || spec.value) : [],
      performanceMode: item.performanceMode === "STC_BNPI" ? "STC_BNPI" : "STC_ONLY",
      performanceSpecs: Array.isArray(item.performanceSpecs) ? item.performanceSpecs.map(spec => ({
        label: String(spec?.label || "").trim(),
        stc: String(spec?.stc || "").trim(),
        bnpi: String(spec?.bnpi || "").trim(),
        unit: String(spec?.unit || "").trim()
      })).filter(spec => spec.label || spec.stc || spec.bnpi) : []
    }))
  };
}
async function readConfig() {
  if (!configBucket) return emptyConfig();
  const file = storage.bucket(configBucket).file(configObject);
  const [exists] = await file.exists();
  if (!exists) return emptyConfig();
  const [contents] = await file.download();
  return normalizeConfig(JSON.parse(contents.toString("utf8")));
}
async function writeConfig(config) {
  if (!configBucket) throw new Error("CONFIG_BUCKET is not configured.");
  await storage.bucket(configBucket).file(configObject).save(JSON.stringify(normalizeConfig(config), null, 2), {
    contentType: "application/json",
    resumable: false
  });
}

app.get("/config", async (_req, res) => {
  try {
    res.json(await readConfig());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Could not read config." });
  }
});

app.put("/config", async (req, res) => {
  try {
    const config = normalizeConfig(req.body || {});
    await writeConfig(config);
    res.json(config);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Could not save config." });
  }
});

function stripImagePrefix(value) {
  return String(value || "").replace(/^data:image\/[^;]+;base64,/, "");
}
function asBox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const box = value.map(Number);
  if (box.some(item => !Number.isFinite(item))) return null;
  return box.map(item => Math.max(0, Math.min(1000, Math.round(item))));
}
function cleanGeminiRegion(region) {
  return {
    label: String(region?.label || "text_block").toLowerCase().replace(/\s+/g, "_").slice(0, 80),
    text: String(region?.text || "").slice(0, 1000),
    box2d: asBox(region?.box2d || region?.box_2d),
    confidenceNote: String(region?.confidenceNote || region?.confidence_note || "").slice(0, 300)
  };
}
function parseGeminiJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return {};
    return JSON.parse(match[0]);
  }
}
function calculatePixelDeviation(nameplateBox, textBox) {
  if (!nameplateBox || !textBox) {
    return {
      mode: "PIXEL_ONLY",
      nameplateBox,
      textBox,
      topGapPx: null,
      bottomGapPx: null,
      result: "NEEDS_REVIEW"
    };
  }
  return {
    mode: "PIXEL_ONLY",
    nameplateBox,
    textBox,
    topGapPx: Math.round(textBox[0] - nameplateBox[0]),
    bottomGapPx: Math.round(nameplateBox[2] - textBox[2]),
    result: "INFO_ONLY"
  };
}
function cleanInspectionItem(item) {
  return {
    group: String(item?.group || "").slice(0, 80),
    attribute: String(item?.attribute || "").slice(0, 120),
    expected: String(item?.expected || "").slice(0, 500),
    actual: String(item?.actual || "").slice(0, 1000),
    score: Math.max(0, Math.min(1, Number(item?.score || 0))),
    pass: Boolean(item?.pass)
  };
}
function publicInspection(record) {
  const { text, ...summary } = record;
  return summary;
}
async function saveInspectionImage(id, imageBase64, contentType) {
  if (!inspectionImageBucket || !imageBase64) return null;
  const raw = stripImagePrefix(imageBase64);
  if (!raw) return null;
  const bytes = Buffer.from(raw, "base64");
  if (!bytes.length) return null;
  if (bytes.length > 10 * 1024 * 1024) throw new Error("Inspection image must be 10 MB or smaller.");
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const type = String(contentType || "image/jpeg");
  const extension = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
  const objectPath = `inspections/${yyyy}/${mm}/${dd}/${id}.${extension}`;
  await storage.bucket(inspectionImageBucket).file(objectPath).save(bytes, {
    contentType: type,
    resumable: false,
    metadata: { cacheControl: "private, max-age=0" }
  });
  return {
    bucket: inspectionImageBucket,
    path: objectPath,
    sizeBytes: bytes.length,
    contentType: type
  };
}
function normalizeInspection(input, id, imageInfo) {
  const items = Array.isArray(input?.items) ? input.items.map(cleanInspectionItem) : [];
  const createdAt = String(input?.createdAt || new Date().toISOString());
  const passed = Boolean(input?.passed);
  return {
    id,
    createdAt,
    line: String(input?.line || "").slice(0, 20),
    fileName: String(input?.fileName || "").slice(0, 300),
    standardId: String(input?.standardId || "").slice(0, 120),
    standardName: String(input?.standardName || "").slice(0, 300),
    score: Math.max(0, Math.min(100, Math.round(Number(input?.score || 0)))),
    passed,
    result: passed ? "PASS" : "FAIL",
    items,
    text: String(input?.text || "").slice(0, 25000),
    image: imageInfo,
    appVersion: "v1.5"
  };
}

app.post("/inspections", async (req, res) => {
  try {
    const doc = firestore.collection(inspectionsCollection).doc();
    const imageInfo = await saveInspectionImage(doc.id, req.body?.imageBase64, req.body?.imageContentType);
    const record = normalizeInspection(req.body || {}, doc.id, imageInfo);
    await doc.set(record);
    res.status(201).json(publicInspection(record));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Could not save inspection." });
  }
});

app.get("/inspections", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 100)));
    const snapshot = await firestore.collection(inspectionsCollection).orderBy("createdAt", "desc").limit(200).get();
    let items = snapshot.docs.map(doc => publicInspection({ id: doc.id, ...doc.data() }));
    if (req.query.line) items = items.filter(item => item.line === String(req.query.line));
    if (req.query.result) items = items.filter(item => item.result === String(req.query.result).toUpperCase());
    if (req.query.from) items = items.filter(item => item.createdAt >= String(req.query.from));
    if (req.query.to) items = items.filter(item => item.createdAt <= String(req.query.to));
    res.json({ items: items.slice(0, limit) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Could not read inspections." });
  }
});

app.get("/inspections/:id", async (req, res) => {
  try {
    const doc = await firestore.collection(inspectionsCollection).doc(String(req.params.id)).get();
    if (!doc.exists) return res.status(404).json({ error: "Inspection not found." });
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Could not read inspection." });
  }
});

app.post("/ocr", async (req, res) => {
  try {
    const raw = String(req.body?.imageBase64 || "").replace(/^data:image\/[^;]+;base64,/, "");
    if (!raw) return res.status(400).json({ error: "imageBase64 is required." });

    const image = Buffer.from(raw, "base64");
    if (!image.length) return res.status(400).json({ error: "Image data is invalid." });
    if (image.length > 10 * 1024 * 1024) {
      return res.status(413).json({ error: "Image must be 10 MB or smaller." });
    }

    const [result] = await client.documentTextDetection({
      image: { content: image },
      imageContext: { languageHints: ["en"] }
    });
    if (result.error) throw new Error(result.error.message || "Vision OCR failed.");

    const annotation = result.fullTextAnnotation;
    const pages = annotation?.pages || [];
    const words = [];

    for (const page of pages) {
      const pageWidth = page.width || 1;
      const pageHeight = page.height || 1;
      for (const block of page.blocks || []) {
        for (const paragraph of block.paragraphs || []) {
          for (const word of paragraph.words || []) {
            const text = (word.symbols || []).map(symbol => symbol.text || "").join("");
            if (!text) continue;
            const vertices = word.boundingBox?.vertices || [];
            const xs = vertices.map(v => Number(v.x || 0));
            const ys = vertices.map(v => Number(v.y || 0));
            const x1 = Math.min(...xs);
            const y1 = Math.min(...ys);
            const x2 = Math.max(...xs);
            const y2 = Math.max(...ys);
            words.push({
              text,
              x: x1 / pageWidth,
              y: y1 / pageHeight,
              w: (x2 - x1) / pageWidth,
              h: (y2 - y1) / pageHeight,
              confidence: word.confidence ?? null
            });
          }
        }
      }
    }

    res.json({
      text: annotation?.text || result.textAnnotations?.[0]?.description || "",
      words
    });
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: error.message || "Vision OCR request failed." });
  }
});

app.post("/gemini-ocr-trial", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY || "";
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY is not configured." });

    const raw = stripImagePrefix(req.body?.imageBase64);
    if (!raw) return res.status(400).json({ error: "imageBase64 is required." });

    const image = Buffer.from(raw, "base64");
    if (!image.length) return res.status(400).json({ error: "Image data is invalid." });
    if (image.length > 10 * 1024 * 1024) {
      return res.status(413).json({ error: "Image must be 10 MB or smaller." });
    }

    const imageContentType = String(req.body?.imageContentType || "image/jpeg");
    const prompt = `You are analyzing a solar module nameplate inspection photo.
Return only JSON. Do not include markdown.
Coordinate convention: every box2d must be [ymin, xmin, ymax, xmax] normalized from 0 to 1000.
Identify:
1. fullText: all readable OCR text.
2. regions: product_type, origin, text_block, and nameplate regions when visible. Each region label must be one of: product_type, origin, text_block, nameplate.
3. deviation.nameplateBox: the full physical nameplate or label strip if visible.
4. deviation.textBox: the tight overall printed text/ink region, excluding the physical label background if possible.
This is an experimental pixel-only coordinate trial, not a millimeter judgement.
JSON shape:
{
  "fullText": "string",
  "regions": [
    {"label": "product_type", "text": "string", "box2d": [0,0,0,0], "confidenceNote": "string"}
  ],
  "deviation": {
    "nameplateBox": [0,0,0,0],
    "textBox": [0,0,0,0]
  }
}`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: imageContentType, data: raw } },
            { text: prompt }
          ]
        }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0
        }
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message || `Gemini returned HTTP ${response.status}.`;
      throw new Error(message);
    }

    const text = payload?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("\n").trim() || "";
    const parsed = parseGeminiJson(text);
    const regions = Array.isArray(parsed.regions) ? parsed.regions.map(cleanGeminiRegion).filter(region => region.box2d) : [];
    const nameplateRegion = regions.find(region => region.label.includes("nameplate"));
    const textRegion = regions.find(region => region.label.includes("text_block") || region.label.includes("printed") || region.label.includes("ink"));
    const nameplateBox = asBox(parsed?.deviation?.nameplateBox || parsed?.deviation?.nameplate_box) || nameplateRegion?.box2d || null;
    const textBox = asBox(parsed?.deviation?.textBox || parsed?.deviation?.text_box) || textRegion?.box2d || null;

    res.json({
      engine: "gemini",
      model: geminiModel,
      text: String(parsed.fullText || parsed.full_text || "").trim(),
      regions,
      deviation: calculatePixelDeviation(nameplateBox, textBox),
      rawJson: parsed
    });
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: error.message || "Gemini OCR trial request failed." });
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => {
  console.log(`Nameplate OCR API listening on ${port}`);
});
