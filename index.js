import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "10mb" }));
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.get("/", (_req, res) => res.json({ ok: true })); // health check

// POST JSON worker: submit to WaveSpeed, poll, then update Airtable
app.post("/seedream/generate-and-update", async (req, res) => {
  try {
    const {
      baseId,
      tableIdOrName,
      recordId,
      fieldName = "Attachments",
      prompt,
      size = "1024*1024"
    } = req.body || {};

    if (!baseId || !tableIdOrName || !recordId || !prompt) {
      return res.status(400).json({ error: "Missing baseId, tableIdOrName, recordId, or prompt" });
    }

    // 1) submit job
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

    // 2) poll for result
    let resultJson = null, imageUrl = null;
    for (let i = 0; i < 30; i++) {
      const r = await fetch(`https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`, {
        headers: { "Authorization": `Bearer ${process.env.WAVESPEED_API_KEY}` }
      });
      resultJson = await r.json();
      const status = resultJson?.status || resultJson?.data?.status;

      const images =
        resultJson?.images ||
        resultJson?.data?.images ||
        resultJson?.data?.output ||
        resultJson?.output ||
        [];

      imageUrl = Array.isArray(images) ? images[0] : (images?.url || null);
      if (imageUrl || (status && ["succeeded","completed","success"].includes(status))) break;
      await sleep(2000);
    }
    if (!imageUrl) return res.status(502).json({ error: "No imageUrl", raw: resultJson });

    // 3) update Airtable (attachment)
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
    console.error(e);
    res.status(500).json({ error: "generate-and-update failed", detail: String(e) });
  }
});

// “Their-style” GET webhook. Pulls prompt from Airtable if not provided.
app.get("/v1/automations/webhookSeedanceEditGen", async (req, res) => {
  const baseId = req.query.baseId;
  const recordId = req.query.recordId;
  const tableIdOrName = req.query.tableIdOrName || "tblrTdaEKwrnLq1Jq"; // your table ID
  const fieldName = req.query.fieldName || "Attachments";
  const size = req.query.size || "2048*2048";

  try {
    // get prompt from record if not passed in query
    let finalPrompt = req.query.prompt;
    if (!finalPrompt) {
      const rec = await fetch(`https://api.airtable.com/v0/${baseId}/${tableIdOrName}/${recordId}`, {
        headers: { "Authorization": `Bearer ${process.env.AIRTABLE_TOKEN}` }
      });
      const recJson = await rec.json();
      finalPrompt = recJson?.fields?.prompt || "";
      if (!finalPrompt) {
        return res.status(400).json({ error: "No prompt provided and record.fields.prompt is empty" });
      }
    }

    const r = await fetch("https://test-production-2ff9.up.railway.app/seedream/generate-and-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseId,
        tableIdOrName,
        recordId,
        fieldName,
        prompt: finalPrompt,
        size
      })
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "webhookSeedanceEditGen failed", detail: String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Seedream proxy listening on ${port}`));
