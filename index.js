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

// === KLING 2.1 VIDEO GENERATOR ===
async function submitKling21Task({ image, prompt, negative_prompt, duration, guidance_scale }) {
  const resp = await fetch("https://api.wavespeed.ai/api/v3/kwaivgi/kling-v2.1-i2v-standard", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${WAVESPEED_API_KEY}` },
    body: JSON.stringify({
      image,
      prompt,
      negative_prompt,
      duration,
      guidance_scale
    })
  });
  if (!resp.ok) throw new Error(`Wavespeed submit failed ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  const id = data?.data?.id;
  if (!id) throw new Error(`Wavespeed submit returned no id: ${JSON.stringify(data)}`);
  return id;
}

app.get("/v1/automations/webhookKling21Std", async (req, res) => {
  const baseId = req.query.baseId;
  const recordId = req.query.recordId;
  const tableIdOrName = req.query.tableIdOrName || "tblaauQEiqREQUhHq"; // 🎥 VID GEN table id
  const fieldName = req.query.fieldName || "generated_outputs";
  const statusField = "Status";
  const errField = "err_msg";

  try {
    await patchAirtableRecord(baseId, tableIdOrName, recordId, { [statusField]: "Generating", [errField]: "" });

    const record = await getAirtableRecord(baseId, tableIdOrName, recordId);
    const fields = record?.fields || {};

    // source image: prefer field id, then name
    const srcArr = Array.isArray(fields["fldpcNNeTNguuAWno"])
      ? fields["fldpcNNeTNguuAWno"]
      : (Array.isArray(fields["sourceImg"]) ? fields["sourceImg"] : []);
    const imageUrl = srcArr[0]?.url;
    if (!imageUrl) throw new Error("No image found in 'sourceImg' field");

    const prompt = (fields["chatgpt_prompt"] || "").toString().trim();
    if (!prompt) throw new Error("Missing chatgpt_prompt field");

    const duration = parseInt(fields["duration"] || "5", 10);
    const guidance_scale = 0.5;
    const negative_prompt = "blur, distort, and low quality";

    // ----- desired outputs: accept query, number, or single-select {name:"2"} -----
    function readDesired(nField) {
      if (typeof nField === "number") return nField;
      if (typeof nField === "string") return parseInt(nField, 10);
      if (nField && typeof nField === "object" && typeof nField.name === "string") return parseInt(nField.name, 10);
      return NaN;
    }
    const desiredRaw = req.query.n ?? fields["amount_outputs"] ?? fields["Amount outputs"] ?? "1";
    let desired = readDesired(desiredRaw);
    if (!Number.isFinite(desired) || desired < 1) desired = 1;
    if (desired > 8) desired = 8;

    const timeoutSec = Math.max(60, Math.min(3600, parseInt(req.query.timeoutSec || "900", 10)));
    const perTaskTimeoutMs = timeoutSec * 1000;
    const MAX_CONCURRENCY = 4;

    // submit N jobs
    const submitPromises = Array.from({ length: desired }, () =>
      submitKling21Task({ image: imageUrl, prompt, negative_prompt, duration, guidance_scale })
    );
    const taskIds = await Promise.all(submitPromises);
    console.log(`[kling21] submitting ${desired} tasks ->`, taskIds);

    // poll in batches
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

    // append videos, don't delete old ones
    const existing = Array.isArray(fields[fieldName]) ? fields[fieldName].map(x => ({ url: x.url })) : [];
    const newFiles = successes.map((url, i) => ({ url, filename: `kling_${Date.now()}_${i}.mp4` }));
    const finalAttachments = [...existing, ...newFiles];

    const hadFailures = failures.length > 0;
    await patchAirtableRecord(baseId, tableIdOrName, recordId, {
      [fieldName]: finalAttachments,
      [statusField]: hadFailures ? `Partial Success (${successes.length}/${desired})` : "Success",
      [errField]: hadFailures ? failures.map(f => `${f.id}: ${f.error}`).join(" | ").slice(0, 1000) : ""
    });

    res.json({ ok: true, recordId, requested: desired, completed: successes.length, failed: failures.length });
  } catch (err) {
    console.error("[kling21] ERROR:", err.message);
    try {
      await patchAirtableRecord(baseId, tableIdOrName, recordId, { [errField]: err.message, [statusField]: "Error" });
    } catch (_) {}
    res.status(500).json({ ok: false, error: err.message });
  }
});

// === KLING 2.5 TURBO helper ===
async function submitKling25TurboTask({ image, prompt, negative_prompt, duration, guidance_scale }) {
  const resp = await fetch("https://api.wavespeed.ai/api/v3/kwaivgi/kling-v2.5-turbo-std/image-to-video", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WAVESPEED_API_KEY}`
    },
    body: JSON.stringify({
      image,
      prompt,
      negative_prompt,
      duration,
      guidance_scale
    })
  });
  if (!resp.ok) throw new Error(`Wavespeed submit failed ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  const id = data?.data?.id;
  if (!id) throw new Error(`Wavespeed submit returned no id: ${JSON.stringify(data)}`);
  return id;
}

// === KLING 2.5 TURBO (image -> video) ===
app.get("/v1/automations/webhookKling25Turbo", async (req, res) => {
  const baseId = req.query.baseId;
  const recordId = req.query.recordId;

  // Default to your dedicated table + output field
  const tableIdOrName = req.query.tableIdOrName || "tbliEm1efdgbRIFMb"; // 🎥 VID GEN Kling 2.5 Turbo
  const fieldName = req.query.fieldName || "generated_outputs";

  const statusField = "Status";
  const errField = "err_msg";

  try {
    if (!baseId || !recordId) return res.status(400).json({ ok: false, error: "baseId and recordId are required" });
    if (!AIRTABLE_TOKEN || !WAVESPEED_API_KEY) return res.status(500).json({ ok: false, error: "Server missing AIRTABLE_TOKEN or WAVESPEED_API_KEY" });

    await patchAirtableRecord(baseId, tableIdOrName, recordId, { [statusField]: "Generating", [errField]: "" });

    const record = await getAirtableRecord(baseId, tableIdOrName, recordId);
    const fields = record?.fields || {};

    // source image: prefer field id (fldxGFYOQAF1voks9), else name "sourceImg"
    const srcArr = Array.isArray(fields["fldxGFYOQAF1voks9"])
      ? fields["fldxGFYOQAF1voks9"]
      : (Array.isArray(fields["sourceImg"]) ? fields["sourceImg"] : []);
    const imageUrl = srcArr[0]?.url;
    if (!imageUrl) throw new Error("No image found in 'sourceImg' field");

    const prompt = (fields["chatgpt_prompt"] || fields["prompt"] || "").toString().trim();
    if (!prompt) throw new Error("Missing chatgpt_prompt field");

    const duration = parseInt(fields["duration"] || req.query.duration || "5", 10);
    const guidance_scale = parseFloat(fields["guidance_scale"] || req.query.guidance_scale || "0.5");
    const negative_prompt = (fields["negative_prompt"] || req.query.negative_prompt || "blur, distort, and low quality").toString();

    // desired outputs: accept query ?n=, number field, or single-select {name:"2"}
    function readDesired(nField) {
      if (typeof nField === "number") return nField;
      if (typeof nField === "string") return parseInt(nField, 10);
      if (nField && typeof nField === "object" && typeof nField.name === "string") return parseInt(nField.name, 10);
      return NaN;
    }
    const desiredRaw = req.query.n ?? fields["amount_outputs"] ?? fields["Amount outputs"] ?? "1";
    let desired = readDesired(desiredRaw);
    if (!Number.isFinite(desired) || desired < 1) desired = 1;
    if (desired > 8) desired = 8;

    const timeoutSec = Math.max(60, Math.min(3600, parseInt(req.query.timeoutSec || "900", 10)));
    const perTaskTimeoutMs = timeoutSec * 1000;
    const MAX_CONCURRENCY = 4;

    // submit N jobs
    const taskIds = await Promise.all(
      Array.from({ length: desired }, () =>
        submitKling25TurboTask({ image: imageUrl, prompt, negative_prompt, duration, guidance_scale })
      )
    );
    console.log(`[kling25] submitting ${desired} tasks ->`, taskIds);

    // poll in batches
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

    // append, don't replace
    const existing = Array.isArray(fields[fieldName]) ? fields[fieldName].map(x => ({ url: x.url })) : [];
    const newFiles = successes.map((url, i) => ({ url, filename: `kling25_${Date.now()}_${i}.mp4` }));
    const finalAttachments = [...existing, ...newFiles];

    const hadFailures = failures.length > 0;
    await patchAirtableRecord(baseId, tableIdOrName, recordId, {
      [fieldName]: finalAttachments,
      [statusField]: hadFailures ? `Partial Success (${successes.length}/${desired})` : "Success",
      [errField]: hadFailures ? failures.map(f => `${f.id}: ${f.error}`).join(" | ").slice(0, 1000) : ""
    });

    res.json({ ok: true, recordId, requested: desired, completed: successes.length, failed: failures.length });
  } catch (err) {
    console.error("[kling25] ERROR:", err.message);
    try {
      await patchAirtableRecord(baseId, tableIdOrName, recordId, { [errField]: err.message, [statusField]: "Error" });
    } catch (_) {}
    res.status(500).json({ ok: false, error: err.message });
  }
});

// === WAN 2.2 Animate (🎥 VID GEN WAN) ===
// Uses table: tblpTowzUx7zqnb1h
// Writes to attachment field: fldrH1H7td2bR7XXH (generated_outputs)
app.get("/v1/automations/webhookWanAnimate", async (req, res) => {
  const baseId    = req.query.baseId;
  const recordId  = req.query.recordId;
  const tableIdOrName = req.query.tableIdOrName || "tblpTowzUx7zqnb1h";
  const fieldName     = req.query.fieldName     || "fldrH1H7td2bR7XXH"; // generated_outputs

  // Field IDs
  const statusField = "fldy8EMZTQUvA4DhJ"; // Status (single select)
  const errField    = "fld5hWtlqovhvT1sQ"; // err_msg (text)

  try {
    if (!baseId || !recordId) {
      return res.status(400).json({ ok: false, error: "baseId and recordId are required" });
    }
    if (!AIRTABLE_TOKEN || !WAVESPEED_API_KEY) {
      return res.status(500).json({ ok: false, error: "Server missing AIRTABLE_TOKEN or WAVESPEED_API_KEY" });
    }

    // Make sure this record actually lives in THIS table
    let record;
    try {
      record = await getAirtableRecord(baseId, tableIdOrName, recordId);
    } catch {
      const msg = `Record ${recordId} does not exist in table ${tableIdOrName}. Triggered from the wrong table/view.`;
      console.error("[wan] GET record failed:", msg);
      return res.status(422).json({ ok: false, error: msg });
    }

    // Flip to Generating first
    await patchAirtableRecord(baseId, tableIdOrName, recordId, {
      [statusField]: "Generating",
      [errField]: ""
    });

    const fields = record?.fields || {};

    // Reference image (attachment). Prefer field ID, fallback by name.
    const refArr = Array.isArray(fields["fldEVHt9vUwp43QHf"])
      ? fields["fldEVHt9vUwp43QHf"]
      : (Array.isArray(fields["sourceImg"]) ? fields["sourceImg"] : []);
    const imageUrl = refArr[0]?.url;
    if (!imageUrl) throw new Error("No reference image found (sourceImg).");

    // Source video: attachment first, then URL-ish text fields, then ?video=
    const vidAttach = Array.isArray(fields["sourceVideo"]) ? fields["sourceVideo"] : [];
    const videoUrl =
      vidAttach[0]?.url ||
      (typeof fields["sourceVideoUrl"] === "string" ? fields["sourceVideoUrl"] : "") ||
      (typeof fields["video"] === "string" ? fields["video"] : "") ||
      req.query.video;
    if (!videoUrl) throw new Error("No source video found (sourceVideo attachment or sourceVideoUrl/text).");

    // Prompt
    const prompt = (fields["fldVsEiInf8zgJbkg"] || fields["chatgpt_prompt"] || req.query.prompt || "")
      .toString().trim();
    if (!prompt) throw new Error("Missing chatgpt_prompt.");

    // Mode / resolution / seed
    let mode = (fields["mode"] || req.query.mode || "replace").toString().toLowerCase();
    if (mode !== "replace" && mode !== "animate") mode = "replace";
    const resolution = (fields["resolution"] || req.query.resolution || "720p").toString(); // "480p" | "720p"
    const seed = parseInt(fields["seed"] ?? req.query.seed ?? "-1", 10);

    // Duration (single select "5","8","10" or plain)
    const durationChoice = fields["fld0903IezfdxheZl"] || fields["duration"] || "5";
    const durationStr = typeof durationChoice === "object" && durationChoice?.name ? durationChoice.name : String(durationChoice);
    const duration = parseInt(durationStr, 10) || 5;

    // Number of outputs (single select 1/2/4 or plain)
    function readDesired(nField) {
      if (typeof nField === "number") return nField;
      if (typeof nField === "string") return parseInt(nField, 10);
      if (nField && typeof nField === "object" && typeof nField.name === "string") return parseInt(nField.name, 10);
      return NaN;
    }
    const desiredRaw = req.query.n ?? fields["fldyEoibZoFAAd5N9"] ?? fields["amount_outputs"] ?? "1";
    let desired = readDesired(desiredRaw);
    if (!Number.isFinite(desired) || desired < 1) desired = 1;
    if (desired > 8) desired = 8;

    // Optional stored picker (we still hit wan-2.2/animate)
    const modelPicked = (fields["fldMXB312vy3JPTq3"] || fields["wan_model_to_use"] || "").toString();

    const timeoutSec = Math.max(60, Math.min(3600, parseInt(req.query.timeoutSec || "900", 10)));
    const perTaskTimeoutMs = timeoutSec * 1000;
    const MAX_CONCURRENCY = 4;

    // Submit jobs
    const basePayload = { image: imageUrl, video: videoUrl, prompt, mode, resolution, seed, duration };
    const taskIds = await Promise.all(
      Array.from({ length: desired }, () => submitWanAnimateTask(basePayload))
    );
    console.log(`[wan] model=${modelPicked || "wan-2.2/animate"} submitting ${desired} ->`, taskIds);

    // Poll in batches
    const idBatches = chunk(taskIds, MAX_CONCURRENCY);
    const successes = [];
    const failures  = [];

    for (const batch of idBatches) {
      const results = await Promise.allSettled(batch.map(id => pollResult(id, perTaskTimeoutMs)));
      results.forEach((r, idx) => {
        const id = batch[idx];
        if (r.status === "fulfilled") successes.push(...r.value);
        else failures.push({ id, error: r.reason?.message || String(r.reason) });
      });
      // tiny breather so Wavespeed doesn't throw a tantrum
      await new Promise(r => setTimeout(r, 1500));
    }

    if (!successes.length && failures.length) {
      throw new Error(`All tasks failed or timed out (${failures.length}/${desired}). Example: ${failures[0].id}: ${failures[0].error}`);
    }

    // Keep existing attachments by ID, append new URLs
    const existing = Array.isArray(fields[fieldName]) ? fields[fieldName].map(x => ({ id: x.id })) : [];
    const newFiles = successes.map((url, i) => ({ url, filename: `wan_${Date.now()}_${i}.mp4` }));
    const finalAttachments = [...existing, ...newFiles];

    const hadFailures = failures.length > 0;
    await patchAirtableRecord(baseId, tableIdOrName, recordId, {
      [fieldName]: finalAttachments,
      [statusField]: hadFailures ? `Partial Success (${successes.length}/${desired})` : "Success",
      [errField]: hadFailures ? failures.map(f => `${f.id}: ${f.error}`).join(" | ").slice(0, 1000) : ""
    });

    res.json({
      ok: true,
      recordId,
      requested: desired,
      completed: successes.length,
      failed: failures.length,
      modelPicked
    });
  } catch (err) {
    console.error("[wan] ERROR:", err?.message || err);
    try {
      await patchAirtableRecord(baseId, tableIdOrName, recordId, {
        [errField]: String(err?.message || err),
        [statusField]: "Error"
      });
    } catch (_) {}
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/** Submit a WAN 2.2 Animate job and return requestId */
async function submitWanAnimateTask({ image, video, prompt, mode, resolution, seed, duration }) {
  const resp = await fetch("https://api.wavespeed.ai/api/v3/wavespeed-ai/wan-2.2/animate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${WAVESPEED_API_KEY}`
    },
    body: JSON.stringify({
      image,
      video,
      prompt,
      mode,        // "replace" | "animate"
      resolution,  // "480p" | "720p"
      seed,        // -1 => random
      duration     // some backends ignore, but we pass it through for billing/variants
    })
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Wavespeed WAN 2.2 API Error (${resp.status}): ${txt || resp.statusText}`);
  }

  const json = await resp.json();
  const requestId = json.requestId || json.id || json.predictionId;
  if (!requestId) throw new Error("Wavespeed WAN 2.2 API: missing requestId in response");
  return requestId;
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP listening on ${PORT}`);
});