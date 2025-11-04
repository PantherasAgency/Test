import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const WAVESPEED_API_KEY = process.env.WAVESPEED_API_KEY;

if (!AIRTABLE_TOKEN) console.error("Missing AIRTABLE_TOKEN");
if (!WAVESPEED_API_KEY) console.error("Missing WAVESPEED_API_KEY");

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
      return json?.data?.outputs || [];
    }
    if (status === "failed") {
      const err = json?.data?.error || "unknown";
      throw new Error(`Wavespeed task failed: ${err}`);
    }
    await sleep(1000);
  }
  throw new Error("Wavespeed poll timed out");
}

app.get("/", (_, res) => res.type("text/plain").send("running"));

// Main automation endpoint
app.get("/v1/automations/webhookSeedanceEditGen", async (req, res) => {
  const baseId = req.query.baseId;
  const recordId = req.query.recordId;
  const tableIdOrName = req.query.tableIdOrName || "IMG GEN";
  const fieldName = req.query.fieldName || "Attachments";
  const statusField = "Status";
  const errField = "err_msg";

  if (!baseId || !recordId)
    return res.status(400).json({ ok: false, error: "baseId and recordId are required" });
  if (!AIRTABLE_TOKEN || !WAVESPEED_API_KEY)
    return res.status(500).json({ ok: false, error: "Server missing AIRTABLE_TOKEN or WAVESPEED_API_KEY" });

  console.log("[seedance-edit] received:", { baseId, recordId, tableIdOrName, fieldName });

  try {
    // mark as Generating
    await patchAirtableRecord(baseId, tableIdOrName, recordId, {
      [statusField]: "Generating",
      [errField]: ""
    });

    // read record
    const record = await getAirtableRecord(baseId, tableIdOrName, recordId);
    const fields = record?.fields || {};

    const faceRef = fields["face_reference"];
    const prompt = fields["prompt"] || "";
    const resolution = fields["resolution"] || fields["Resolution"] || "2160x3840";
    const size = resolutionToSize(resolution);
    const amount = Math.max(1, Math.min(8, parseInt(fields["amount_outputs"] || "4", 10))); // default 4

    const inputUrls =
      Array.isArray(faceRef)
        ? faceRef.filter(x => x && x.url).map(x => x.url).slice(0, 10)
        : [];

    if (inputUrls.length === 0)
      throw new Error("No input images in 'face_reference'");

    // submit multiple tasks
    console.log(`[seedance-edit] submitting ${amount} tasks...`);
    const taskIds = await Promise.all(
      Array.from({ length: amount }, () => submitEditTask({ images: inputUrls, prompt, size }))
    );
    console.log("[seedance-edit] task ids:", taskIds);

    // poll them all
    const allOutputs = await Promise.all(taskIds.map(pollResult));
    const outputs = allOutputs.flat();
    if (!outputs.length) throw new Error("Model returned no outputs");

    // get current attachments (to append new images)
    const existing = Array.isArray(fields[fieldName])
      ? fields[fieldName].map(x => ({ url: x.url }))
      : [];

    const newAttachments = outputs.map(url => ({ url }));
    const finalAttachments = [...existing, ...newAttachments];

    // write back
    await patchAirtableRecord(baseId, tableIdOrName, recordId, {
      [fieldName]: finalAttachments,
      [statusField]: "Success",
      [errField]: ""
    });

    console.log(`[seedance-edit] finished ${outputs.length} outputs for record:`, recordId);
    res.json({ ok: true, recordId, outputs: outputs.length });
  } catch (err) {
    console.error("[seedance-edit] ERROR:", err?.message || err);
    try {
      await patchAirtableRecord(baseId, tableIdOrName, recordId, {
        [errField]: String(err?.message || err),
        [statusField]: "Error"
      });
    } catch (_) {}
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP listening on ${PORT}`);
});
