import express from "express";

// Use Node 18+ global fetch (no node-fetch import nonsense)
const app = express();
const PORT = process.env.PORT || 8080;

// ENV you must set in Railway
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;          // "pat..."
const WAVESPEED_API_KEY = process.env.WAVESPEED_API_KEY;    // wavespeed key

if (!AIRTABLE_TOKEN) console.error("Missing AIRTABLE_TOKEN");
if (!WAVESPEED_API_KEY) console.error("Missing WAVESPEED_API_KEY");

// Helpers
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getAirtableRecord(baseId, tableIdOrName, recordId) {
  const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}/${encodeURIComponent(recordId)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
  });
  if (!resp.ok) throw new Error(`Airtable GET failed ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function patchAirtableRecord(baseId, tableIdOrName, recordId, fields) {
  const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}`;
  const body = { records: [{ id: recordId, fields }] };
  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`Airtable PATCH failed ${resp.status} ${await resp.text()}`);
  return resp.json();
}

function resolutionToSize(resolutionField) {
  // expects "2160x3840" etc; Wavespeed wants "2160*3840"
  if (!resolutionField || typeof resolutionField !== "string") return "2160*3840";
  const parts = resolutionField.toLowerCase().split("x").map(s => s.trim());
  if (parts.length !== 2) return "2160*3840";
  return `${parts[0]}*${parts[1]}`;
}

async function submitEditTask({ images, prompt, size }) {
  const resp = await fetch("https://api.wavespeed.ai/api/v3/bytedance/seedream-v4/edit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${WAVESPEED_API_KEY}`
    },
    body: JSON.stringify({
      enable_base64_output: false,
      enable_sync_mode: false,
      images,
      prompt,
      size
    })
  });
  if (!resp.ok) throw new Error(`Wavespeed submit failed ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  const id = data?.data?.id;
  if (!id) throw new Error(`Wavespeed submit returned no id: ${JSON.stringify(data)}`);
  return id;
}

async function pollResult(requestId, timeoutMs = 5 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await fetch(`https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`, {
      headers: { "Authorization": `Bearer ${WAVESPEED_API_KEY}` }
    });
    const json = await resp.json();

    if (!resp.ok) throw new Error(`Wavespeed poll failed ${resp.status} ${JSON.stringify(json)}`);

    const status = json?.data?.status;
    if (status === "completed") {
      const outputs = json?.data?.outputs || [];
      return outputs;
    }
    if (status === "failed") {
      const err = json?.data?.error || "unknown";
      throw new Error(`Wavespeed task failed: ${err}`);
    }
    await sleep(1000);
  }
  throw new Error("Wavespeed poll timed out");
}

// Health
app.get("/", (_, res) => res.type("text/plain").send("running"));

// Webhook the Airtable script calls:
// GET /v1/automations/webhookSeedanceEditGen?baseId=...&recordId=...&tableIdOrName=...&fieldName=...
app.get("/v1/automations/webhookSeedanceEditGen", async (req, res) => {
  const baseId = req.query.baseId;
  const recordId = req.query.recordId;
  const tableIdOrName = req.query.tableIdOrName || "IMG GEN";
  const fieldName = req.query.fieldName || "Attachments";      // where we write images
  const statusField = "Status";
  const errField = "err_msg";

  if (!baseId || !recordId) {
    return res.status(400).json({ ok: false, error: "baseId and recordId are required" });
  }
  if (!AIRTABLE_TOKEN || !WAVESPEED_API_KEY) {
    return res.status(500).json({ ok: false, error: "Server missing AIRTABLE_TOKEN or WAVESPEED_API_KEY" });
  }

  // Log that we started
  console.log("[seedance-edit] received:", { baseId, recordId, tableIdOrName, fieldName });

  try {
    // mark as Generating
    await patchAirtableRecord(baseId, tableIdOrName, recordId, {
      [statusField]: "Generating",
      [errField]: ""
    });

    // fetch record
    const record = await getAirtableRecord(baseId, tableIdOrName, recordId);
    const fields = record?.fields || {};

    // attachments to edit come from face_reference
    const faceRef = fields["face_reference"];
    const prompt = fields["prompt"] || "";
    const resolution = fields["resolution"] || fields["Resolution"] || "2160x3840";
    const size = resolutionToSize(resolution);

    const inputUrls =
      Array.isArray(faceRef)
        ? faceRef
            .filter(x => x && x.url)
            .map(x => x.url)
            .slice(0, 10)   // API limit
        : [];

    if (inputUrls.length === 0) {
      throw new Error("No input images in 'face_reference'");
    }

    // submit task
    const requestId = await submitEditTask({ images: inputUrls, prompt, size });
    console.log("[seedance-edit] task id:", requestId);

    // poll for result
    const outputs = await pollResult(requestId);
    if (!outputs.length) throw new Error("Model returned no outputs");

    // write back to Airtable as attachments
    const attachments = outputs.map(url => ({ url }));
    await patchAirtableRecord(baseId, tableIdOrName, recordId, {
      [fieldName]: attachments,
      [statusField]: "Success",
      [errField]: "",
      // optional convenience writes:
      "record_id": recordId
    });

    console.log("[seedance-edit] finished async work for record:", recordId);
    res.json({ ok: true, recordId, outputs: outputs.length });

  } catch (err) {
    console.error("[seedance-edit] ERROR:", err?.message || err);
    // try to write the error back so staff see it
    try {
      await patchAirtableRecord(baseId, tableIdOrName, recordId, {
        [errField]: String(err?.message || err),
        "Status": "error"
      });
    } catch (_) { /* swallow secondary errors */ }
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP listening on ${PORT}`);
});
