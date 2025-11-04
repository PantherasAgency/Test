// index.js
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "10mb" }));

// Railway assigns a random port via env. Use it or die.
const PORT = process.env.PORT || 8080;

// tiny helper
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.get("/", (_req, res) => {
  // Railway health check hits this. Keep it instant.
  res.status(200).send("ok");
});

app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

// POST /seedream/generate-and-update
// body: { baseId, tableIdOrName, recordId, fieldName, prompt, size }
app.post("/seedream/generate-and-update", async (req, res) => {
  try {
    const {
      baseId,
      tableIdOrName,
      recordId,
      fieldName = "Attachments",
      prompt,
      size = "2048*2048",
    } = req.body || {};

    if (!baseId || !tableIdOrName || !recordId || !prompt) {
      return res.status(400).json({
        error: "Missing baseId, tableIdOrName, recordId, or prompt"
      });
    }

    // 1) submit to WaveSpeed
    const submit = await fetch("https://api.wavespeed.ai/api/v3/bytedance/seedream-v4", {
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

    const submitJson = await submit.json();
    if (!submit.ok) return res.status(submit.status).json(submitJson);

    const requestId = submitJson?.requestId || submitJson?.data?.requestId;
    if (!requestId) return res.status(500).json({ error: "No requestId", raw: submitJson });

    // 2) poll result
    let imageUrl = null, resultJson = null;
    for (let i = 0; i < 30; i++) {
      const r = await fetch(`https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`, {
        headers: { "Authorization": `Bearer ${process.env.WAVESPEED_API_KEY}` }
      });
      resultJson = await r.json();

      const images =
        resultJson?.images ||
        resultJson?.data?.images ||
        resultJson?.data?.output ||
        resultJson?.output ||
        [];

      imageUrl = Array.isArray(images) ? images[0] : (images?.url || null);

      const status = resultJson?.status || resultJson?.data?.status;
      if (imageUrl || (status && ["succeeded","completed","success"].includes(status))) break;
      await sleep(2000);
    }
    if (!imageUrl) return res.status(502).json({ error: "No imageUrl", raw: resultJson });

    // 3) update Airtable
    const at = await fetch(
      `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableIdOrName)}/${recordId}`,
      {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${process.env.AIRTABLE_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields: { [fieldName]: [{ url: imageUrl }] } })
      }
    );

    const atJson = await at.json();
    if (!at.ok) {
      return res.status(at.status).json({ error: "Airtable update failed", atJson });
    }

    res.json({ success: true, requestId, imageUrl, airtable: atJson });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "generate-and-update failed", detail: String(err) });
  }
});

// GET so Airtable can call it with only query params
// /v1/automations/webhookSeedanceEditGen?baseId=...&recordId=...&tableIdOrName=...&fieldName=...
app.get("/v1/automations/webhookSeedanceEditGen", async (req, res) => {
  const {
    baseId,
    recordId,
    tableIdOrName = "tblrTdaEKwrnLq1Jq",
    fieldName = "Attachments",
  } = req.query;

  try {
    // fetch the prompt from the record if not provided
    let finalPrompt = req.query.prompt;
    if (!finalPrompt) {
      const rec = await fetch(
        `https://api.airtable.com/v0/${baseId}/${tableIdOrName}/${recordId}`,
        { headers: { "Authorization": `Bearer ${process.env.AIRTABLE_TOKEN}` } }
      );
      const recJson = await rec.json();
      finalPrompt = recJson?.fields?.prompt || recJson?.fields?.Prompt || "";
      if (!finalPrompt) {
        return res.status(400).json({ error: "No prompt provided and record.fields.prompt is empty" });
      }
    }

    // reuse our JSON endpoint
    const r = await fetch(`${req.protocol}://${req.get("host")}/seedream/generate-and-update`, {
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

    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "webhookSeedanceEditGen failed", detail: String(err) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP listening on ${PORT}`);
});
