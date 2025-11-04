// index.js
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "10mb" }));

// Healthcheck/root — Railway should hit this and you should see { ok: true }
app.get("/", (_req, res) => res.json({ ok: true }));

// Diagnostic webhook: ACK immediately and attach a dummy image to prove the path
app.get("/v1/automations/webhookSeedanceEditGen", async (req, res) => {
  const { baseId, recordId } = req.query;
  if (!baseId || !recordId) {
    console.error("❌ Missing baseId/recordId", req.query);
    return res.status(400).json({ error: "baseId and recordId are required" });
  }

  // 1) Reply fast so Airtable doesn’t 502
  res.status(202).json({ accepted: true });

  // 2) Log loudly so you can see it in Railway logs
  console.log("✅ Webhook accepted", { baseId, recordId, t: new Date().toISOString() });

  // 3) Control test: patch a dummy image into Airtable so we know updates work
  try {
    const tableIdOrName = req.query.tableIdOrName || "tblrTdaEKwrnLq1Jq";
    const fieldName     = req.query.fieldName     || "Attachments";
    const testImage     = "https://picsum.photos/1024";

    const r = await fetch(`https://api.airtable.com/v0/${baseId}/${tableIdOrName}/${recordId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields: { [fieldName]: [{ url: testImage }], Status: "Success" } })
    });

    const body = await r.text();
    if (!r.ok) {
      console.error("❌ Airtable update failed", r.status, body);
      return;
    }
    console.log("✅ Airtable updated (control image)", { recordId });
  } catch (e) {
    console.error("❌ Control path failed", e);
  }
});

const PORT = process.env.PORT || 3000;            // Railway injects PORT
app.listen(PORT, () => console.log(`HTTP on ${PORT}`));

