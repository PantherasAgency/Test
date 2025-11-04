// index.js
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "10mb" }));

// simple health/root so Railway's edge gets a 200
app.get("/", (_req, res) => res.status(200).send("OK"));

// Wavespeed proxy endpoint
app.post("/seedream/generate-and-update", async (req, res) => {
  try {
    const {
      baseId,
      tableIdOrName,
      recordId,
      fieldName = "Attachments",
      prompt,
      size = "2048*2048"
    } = req.body || {};

    if (!baseId || !tableIdOrName || !recordId || !prompt) {
      return res.status(400).json({ error: "Missing baseId, tableIdOrName, recordId, or prompt" });
    }

    // 1) submit job
    const sub = await fetch("https://api.wavespeed.ai/api/v3/bytedance/seedream-v4", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.WAVESPEED_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        enable_base64_output: false,
        enable_sync_mode: false,
        prompt,
        size
      })
    });

    const subJson = await sub.json();
    if (!sub.ok) return res.status(sub.status).json({ error: "wavespeed submit failed", subJson });

    const requestId = subJson?.requestId || subJson?.data?.requestId;
    if (!requestId) return res.status(500).json({ error: "No requestId", raw: subJson });

    // 2) poll
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let imageUrl = null, last = null;
    for (let i = 0; i < 30; i++) {
      const r = await fetch(`https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`, {
        headers: { "Authorization": `Bearer ${process.env.WAVESPEED_API_KEY}` }
      });
      last = await r.json();
      const images =
        last?.images ||
        last?.data?.images ||
        last?.data?.output ||
        last?.output || [];
      imageUrl = Array.isArray(images) ? images[0] : (images?.url || null);
      if (imageUrl) break;
      await sleep(2000);
    }
    if (!imageUrl) return res.status(502).json({ error: "No imageUrl", raw: last });

    // 3) update Airtable
    const at = await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableIdOrName)}/${recordId}`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${process.env.AIRTABLE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields: { [fieldName]: [{ url: imageUrl }] } })
    });
    const atJson = await at.json();
    if (!at.ok) return res.status(at.status).json({ error: "Airtable update failed", atJson });

    return res.json({ success: true, requestId, imageUrl, airtable: atJson });
  } catch (e) {
    console.error("generate-and-update failed:", e);
    return res.status(500).json({ error: "generate-and-update failed", detail: String(e) });
  }
});

// GET webhook for Airtable automations
app.get("/v1/automations/webhookSeedanceEditGen", async (req, res) => {
  try {
    const { baseId, recordId, prompt } = req.query;
    const tableIdOrName = req.query.tableIdOrName || "tblrTdaEKwrnLq1Jq";
    const fieldName = req.query.fieldName || "Attachments";
    if (!baseId || !recordId) {
      return res.status(400).json({ error: "Missing baseId or recordId" });
    }

    // if no ?prompt=, fetch it from Airtable "prompt" field
    let finalPrompt = prompt;
    if (!finalPrompt) {
      const r = await fetch(`https://api.airtable.com/v0/${baseId}/${tableIdOrName}/${recordId}`, {
        headers: { "Authorization": `Bearer ${process.env.AIRTABLE_TOKEN}` }
      });
      const j = await r.json();
      finalPrompt = j?.fields?.prompt || "";
      if (!finalPrompt) return res.status(400).json({ error: "No prompt provided and record.fields.prompt empty" });
    }

    // call our POST route
    const resp = await fetch("http://127.0.0.1:" + (process.env.PORT || 8080) + "/seedream/generate-and-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseId,
        tableIdOrName,
        recordId,
        fieldName,
        prompt: finalPrompt,
        size: "2048*2048"
      })
    });

    const data = await resp.json();
    return res.status(resp.status).json(data);
  } catch (e) {
    console.error("webhookSeedanceEditGen failed:", e);
    return res.status(500).json({ error: "webhookSeedanceEditGen failed", detail: String(e) });
  }
});

// don’t let the process die silently
process.on("unhandledRejection", err => { console.error("unhandledRejection", err); });
process.on("uncaughtException", err => { console.error("uncaughtException", err); });

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log("HTTP listening on", PORT);
});
