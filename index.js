// Minimal “ack fast” server
const express = require("express");

const app = express();

// Hello / health
app.get("/", (_req, res) => res.type("text/plain").send("running"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Airtable webhook endpoint
app.get("/v1/automations/webhookSeedanceEditGen", (req, res) => {
  const { baseId, recordId, tableIdOrName, fieldName } = req.query;

  // Bare minimum validation
  if (!baseId || !recordId) {
    return res.status(400).json({ ok: false, error: "Missing baseId or recordId" });
  }

  // Log so you can see it in Railway logs
  console.log("[seedance-edit] received:", {
    baseId,
    recordId,
    tableIdOrName: tableIdOrName || "(default)",
    fieldName: fieldName || "(default)"
  });

  // 1) ACK IMMEDIATELY so Airtable is happy
  res.status(200).json({ ok: true, recordId });

  // 2) Do your heavy work *after* responding (non-blocking)
  //    Replace this with your real job (Airtable API, Seedream, etc.)
  queueMicrotask(async () => {
    try {
      // Example placeholder
      console.log("[seedance-edit] starting async work for record:", recordId);
      // ... your async pipeline goes here ...
      console.log("[seedance-edit] finished async work for record:", recordId);
    } catch (err) {
      console.error("[seedance-edit] async error:", err);
    }
  });
});

// Bind to Railway’s port on 0.0.0.0 (you already fixed the domain to 8080)
const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`HTTP listening on ${port}`);
});
