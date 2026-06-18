import express from "express";
import { randomUUID } from "node:crypto";
import { Storage } from "@google-cloud/storage";
import vision from "@google-cloud/vision";

const app = express();
const client = new vision.ImageAnnotatorClient();
const storage = new Storage();
const configBucket = process.env.CONFIG_BUCKET || "";
const configObject = process.env.CONFIG_OBJECT || "nameplate-config.json";
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

const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => {
  console.log(`Nameplate OCR API listening on ${port}`);
});
