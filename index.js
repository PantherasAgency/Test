const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

// health
app.get('/', (req, res) => res.send('running'));

// ---------- Seedream Edit webhook ----------
app.get('/v1/automations/webhookSeedanceEditGen', async (req, res) => {
  const {
    baseId,
    recordId,
    tableIdOrName,
    inputField = 'Attachments',     // Airtable field with input image(s)
    outputField = 'Output',         // Airtable ATTACHMENT field to write result
    prompt = 'High quality edit.',
    size = '1024*1536'              // "W*H" per Wavespeed docs
  } = req.query;

  if (!baseId || !recordId || !tableIdOrName) {
    return res.status(400).json({ ok:false, error:'baseId, recordId, tableIdOrName required' });
  }
  if (!process.env.AIRTABLE_TOKEN) {
    return res.status(500).json({ ok:false, error:'AIRTABLE_TOKEN missing' });
  }
  if (!process.env.WAVESPEED_API_KEY) {
    return res.status(500).json({ ok:false, error:'WAVESPEED_API_KEY missing' });
  }

  try {
    // 1) read record to get input image URL(s)
    const rec = await fetch(
      `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}/${encodeURIComponent(recordId)}`,
      { headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` } }
    ).then(r => r.json());

    const attachments = rec?.fields?.[inputField];
    if (!attachments || !Array.isArray(attachments) || attachments.length === 0) {
      return res.status(400).json({ ok:false, error:`No images in field '${inputField}'` });
    }

    // Seedream Edit takes an array of URLs; we’ll pass the first one by default
    const imageUrls = attachments.map(a => a.url).filter(Boolean);
    const images = imageUrls.length ? [imageUrls[0]] : [];

    // 2) submit task to Wavespeed
    const submitResp = await fetch('https://api.wavespeed.ai/api/v3/bytedance/seedream-v4/edit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.WAVESPEED_API_KEY}`
      },
      body: JSON.stringify({
        enable_base64_output: false,
        enable_sync_mode: false,
        images,
        prompt,
        size
      })
    });

    if (!submitResp.ok) {
      const t = await submitResp.text();
      throw new Error(`Seedream submit failed: ${submitResp.status} ${t}`);
    }
    const submitJson = await submitResp.json();
    const requestId = submitJson?.data?.id;
    if (!requestId) throw new Error('No requestId from Wavespeed');

    // 3) poll result with mild backoff
    const start = Date.now();
    const deadlineMs = 180000; // 3 min cap
    let delay = 1000;          // start 1s, grow gently

    while (true) {
      await new Promise(r => setTimeout(r, delay));
      const pollResp = await fetch(
        `https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`,
        { headers: { Authorization: `Bearer ${process.env.WAVESPEED_API_KEY}` } }
      );
      const pollJson = await pollResp.json();

      if (!pollResp.ok) {
        throw new Error(`Seedream poll failed: ${pollResp.status} ${JSON.stringify(pollJson)}`);
      }

      const data = pollJson?.data;
      const status = data?.status;
      if (status === 'completed') {
        const resultUrl = data?.outputs?.[0];
        if (!resultUrl) throw new Error('Completed but no outputs[0]');
        // 4) write image URL back to Airtable attachment field
        const patchBody = { fields: { [outputField]: [{ url: resultUrl }] } };
        const patch = await fetch(
          `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}/${encodeURIComponent(recordId)}`,
          {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(patchBody)
          }
        );
        const patchText = await patch.text();
        if (!patch.ok) throw new Error(`Airtable PATCH failed: ${patch.status} ${patchText}`);
        return res.json({ ok:true, recordId, wrote: outputField, url: resultUrl });
      }
      if (status === 'failed') {
        return res.status(500).json({ ok:false, error: data?.error || 'Seedream failed' });
      }

      // processing
      if (Date.now() - start > deadlineMs) {
        return res.status(504).json({ ok:false, error:'Timeout waiting for Seedream result' });
      }
      delay = Math.min(delay + 500, 5000);
    }
  } catch (err) {
    console.error('[seedream-edit] error:', err);
    res.status(500).json({ ok:false, error: String(err.message || err) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP listening on ${PORT}`);
});
