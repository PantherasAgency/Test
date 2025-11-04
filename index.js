import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "10mb" }));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- defaults for your base/table/field ---
const TABLE_ID   = "tblrTdaEKwrnLq1Jq";   // IMG GEN
const FIELD_NAME = "Attachments";         // where image goes

// background worker: submit → poll → attach to Airtable
async function generateAndUpdate({ baseId, tableIdOrName, recordId, fieldName, prompt, size }) {
  // 1) submit to WaveSpeed
  const submit = await fetch("https://api.wavespeed.ai/api/v3/bytedance/seedream-v4", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.WAVESPEED_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      enable_base64_output: false,
      enable_sync_mode: true,         // faster path, reduces polling time
      prompt,
      size
    })
  });
  const submitJson = await submit.json();
  if (!submit.ok) throw new Error(`Wavespeed submit failed: ${JSON.stringify(submitJson)}`);

  const requestId = submitJson?.requestId || submitJson?.data?.requestId;
  if (!requestId) throw new Error("No requestId from Wavespeed");

  // 2) poll result (keep under ~45s)
  let imageUrl = null;
  for (let i = 0; i < 20; i++) {       // 20 * 2s ≈ 40s
    const r = await fetch(`https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`, {
      headers: { "Authorization": `Bearer ${process.env.WAVESPEED_API_KEY}` }
    });
    const j = await r.json();

    const images = j?.images || j?.data?.images || j?.data?.output || j?.output || [];
    imageUrl = Array.isArray(images) ? images[0] : (images?.url || null);
    if (imageUrl) break;

    await sleep(2000);
  }
  if (!imageUrl) throw new Error("No imageUrl from Wavespeed within timeout");

  // 3) update Airtable (attachment field)
  const at = await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableIdOrName)}/${recordId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${process.env.AIRTABLE_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ fields: { [fieldName]: [{ url: imageUrl }] } })
  });
  if (!at.ok) throw new Error(`Airtable update failed: ${await at.text()}`);

  console.log("✓ Updated Airtable", { recordId, imageUrl });
}

// health check
app.get("/", (_req, res) => res.json({ ok: true }));

// THEIR-STYLE WEBHOOK: reply immediately (202), do work in background
app.get("/v1/automations/webhookSeedanceEditGen", async (req, res) => {
  try {
    const baseId = req.query.baseId;                 // required
    const recordId = req.query.recordId;             // required (from Airtable)
    const tableIdOrName = req.query.tableIdOrName || TABLE_ID;
    const fieldName     = req.query.fieldName     || FIELD_NAME;
    const size          = req.query.size          || "1024*1024";  // fast default

    if (!baseId || !recordId) {
      return res.status(400).json({ error: "baseId and recordId are required" });
    }

    // get prompt either from query or from the record's 'prompt' field
    let prompt = req.query.prompt;
    if (!prompt) {
      const rec = await fetch(`https://api.airtable.com/v0/${baseId}/${tableIdOrName}/${recordId}`, {
        headers: { "Authorization": `Bearer ${process.env.AIRTABLE_TOKEN}` }
      });
      const j = await rec.json();
      prompt = j?.fields?.prompt || "";   // rename if your column is titled differently
      if (!prompt) return res.status(400).json({ error: "No prompt provided and record.fields.prompt is empty" });
    }

    console.log("Webhook accepted", { recordId, size });

    // fire-and-forget so Airtable doesn't time out
    generateAndUpdate({ baseId, tableIdOrName, recordId, fieldName, prompt, size })
      .catch(err => console.error("BG worker failed", err));

    // acknowledge immediately
    res.status(202).json({ accepted: true });
  } catch (e) {
    console.error("Webhook error", e);
    res.status(400).json({ error: String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Seedream proxy listening on ${port}`));

