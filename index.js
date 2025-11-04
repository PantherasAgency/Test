import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "10mb" }));

// tiny sleep helper
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.get("/", (_req, res) => res.json({ ok: true }));

// POST /seedream/generate  { prompt: "...", size: "2048*2048" }
app.post("/seedream/generate", async (req, res) => {
  try {
    const { prompt, size = "1024*1024" } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    // 1) Submit task to WaveSpeed (this returns requestId)
    const submitResp = await fetch("https://api.wavespeed.ai/api/v3/bytedance/seedream-v4", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.WAVESPEED_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        enable_base64_output: false,
        enable_sync_mode: false,    // async job, we will poll
        prompt,
        size
      })
    });

    const submitJson = await submitResp.json();
    if (!submitResp.ok) {
      return res.status(submitResp.status).json(submitJson);
    }

    const requestId = submitJson?.requestId || submitJson?.data?.requestId;
    if (!requestId) return res.status(500).json({ error: "No requestId from WaveSpeed", raw: submitJson });

    // 2) Poll for result
    let resultJson = null;
    for (let i = 0; i < 30; i++) { // ~60s max (30 * 2s)
      const r = await fetch(`https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${process.env.WAVESPEED_API_KEY}` }
      });
      resultJson = await r.json();

      // Common patterns: status can be "succeeded"/"completed", and images live in data.output or images
      const status = resultJson?.status || resultJson?.data?.status;
      if (status && ["succeeded", "completed", "success"].includes(status)) break;
      if (resultJson?.images || resultJson?.data?.images || resultJson?.output) break;

      await sleep(2000); // wait 2s, then ask again
    }

    // Try to extract a URL in a few common shapes
    const images =
      resultJson?.images ||
      resultJson?.data?.images ||
      resultJson?.data?.output ||
      resultJson?.output ||
      [];

    const imageUrl = Array.isArray(images) ? images[0] : (images?.url || null);

    return res.json({
      success: true,
      requestId,
      imageUrl,
      raw: resultJson
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Seedream generate failed", detail: String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Seedream proxy listening on ${port}`));
