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
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!resp.ok) throw new Error(`Airtable GET failed ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function patchAirtableRecord(baseId, tableIdOrName, recordId, fields) {
  const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}`;
  const body = { records: [{ id: recordId, fields }] };
  const resp = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
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
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${WAVESPEED_API_KEY}` },
    body: JSON.stringify({
      enable_base64_output: false,
      enable_sync_mode: false,
      images, prompt, size
    })
  });
  if (!resp.ok) throw new Error(`Wavespeed submit failed ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  const id = data?.data?.id;
  if (!id) throw new Error(`Wavespeed submit returned no id: ${JSON.stringify(data)}`);
  return id;
}

async function pollResult(requestId, timeoutMs) {
  const start = Date.now();
  let lastStatus = "unknown";
  while (Date.now() - start < timeoutMs) {
    const resp = await fetch(`https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`, {
      headers: { Authorization: `Bearer ${WAVESPEED_API_KEY}` }
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(`Wavespeed poll failed ${resp.status} ${JSON.stringify(json)}`);
    const status = json?.data?.status;
    if (status !== lastStatus) {
      console.log(`[seedance-edit] ${requestId} -> ${status}`);
      lastStatus = status;
    }
    if (status === "completed") return json?.data?.outputs || [];
    if (status === "failed") throw new Error(`Wavespeed task failed: ${json?.data?.error || "unknown"}`);
    await sleep(1500);
  }
  throw new Error("Wavespeed poll timed out");
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

app.get("/", (_, res) => res.type("text/plain").send("running"));

app.get("/v1/automations/webhookSeedanceEditGen", async (req, res) => {
  const baseId = req.query.baseId;
  const recordId = req.query.recordId;
  const tableIdOrName = req.query.tableIdOrName || "IMG GEN";
  const fieldName = req.query.fieldName || "Attachments";
  const statusField = "Status";
  const errField = "err_msg";

  if (!baseId || !recordId) return res.status(400).json({ ok: false, error: "baseId and recordId are required" });
  if (!AIRTABLE_TOKEN || !WAVESPEED_API_KEY) return res.status(500).json({ ok: false, error: "Server missing AIRTABLE_TOKEN or WAVESPEED_API_KEY" });

  console.log("[seedance-edit] received:", { baseId, recordId, tableIdOrName, fieldName });

  try {
    await patchAirtableRecord(baseId, tableIdOrName, recordId, { [statusField]: "Generating", [errField]: "" });

    const record = await getAirtableRecord(baseId, tableIdOrName, recordId);
    const fields = record?.fields || {};

    const faceRef = fields["face_reference"];
    const prompt = fields["prompt"] || "";
    const resolution = fields["resolution"] || fields["Resolution"] || "2160x3840";
    const size = resolutionToSize(resolution);

    const desired = Math.max(1, Math.min(8, parseInt(req.query.n || fields["amount_outputs"] || "4", 10)));
    const timeoutSec = Math.max(60, Math.min(3600, parseInt(req.query.timeoutSec || "900", 10))); // default 15 min
    const perTaskTimeoutMs = timeoutSec * 1000;
    const MAX_CONCURRENCY = 4;

    const inputUrls = Array.isArray(faceRef) ? faceRef.filter(x => x?.url).map(x => x.url).slice(0, 10) : [];
    if (!inputUrls.length) throw new Error("No input images in 'face_reference'");

    // Submit all tasks
    const submitPromises = Array.from({ length: desired }, () => submitEditTask({ images: inputUrls, prompt, size }));
    const taskIds = await Promise.all(submitPromises);
    console.log(`[seedance-edit] submitting ${desired} tasks ->`, taskIds);

    // Poll with concurrency
    const idBatches = chunk(taskIds, MAX_CONCURRENCY);
    const successes = [];
    const failures = [];

    for (const batch of idBatches) {
      const results = await Promise.allSettled(batch.map(id => pollResult(id, perTaskTimeoutMs)));
      results.forEach((r, idx) => {
        const id = batch[idx];
        if (r.status === "fulfilled") successes.push(...r.value);
        else failures.push({ id, error: r.reason?.message || String(r.reason) });
      });
    }

    if (!successes.length && failures.length) {
      throw new Error(`All tasks failed or timed out (${failures.length}/${desired}). Example: ${failures[0].id}: ${failures[0].error}`);
    }

    // Keep existing attachments and append new
    const existing = Array.isArray(fields[fieldName]) ? fields[fieldName].map(x => ({ url: x.url })) : [];
    const finalAttachments = [...existing, ...successes.map(url => ({ url }))];

    // Write back
    const hadFailures = failures.length > 0;
    await patchAirtableRecord(baseId, tableIdOrName, recordId, {
      [fieldName]: finalAttachments,
      [statusField]: hadFailures ? `Partial Success (${successes.length}/${desired})` : "Success",
      [errField]: hadFailures ? failures.map(f => `${f.id}: ${f.error}`).join(" | ").slice(0, 1000) : ""
    });

    console.log(`[seedance-edit] outputs: ${successes.length}/${desired} for record ${recordId}`);
    res.json({ ok: true, recordId, requested: desired, completed: successes.length, failed: failures.length });
  } catch (err) {
    console.error("[seedance-edit] ERROR:", err?.message || err);
    try {
      await patchAirtableRecord(baseId, tableIdOrName, recordId, { [errField]: String(err?.message || err), [statusField]: "Error" });
    } catch (_) {}
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP listening on ${PORT}`);
});
