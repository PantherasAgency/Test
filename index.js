// index.js
const express = require('express');
const fetch = require('node-fetch'); // Railway has it, but import explicitly for sanity

// --- ENV ---
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const WAVESPEED_API_KEY = process.env.WAVESPEED_API_KEY;

// sanity checks
if (!AIRTABLE_TOKEN) console.error('Missing AIRTABLE_TOKEN');
if (!WAVESPEED_API_KEY) console.error('Missing WAVESPEED_API_KEY');

// tiny helpers
const wait = ms => new Promise(r => setTimeout(r, ms));

const app = express();
app.use(express.json());

// health
app.get('/', (_req, res) => res.type('text/plain').send('running'));

/**
 * GET /v1/automations/webhookSeedanceEditGen
 * Query: baseId, recordId, tableIdOrName, fieldName
 */
app.get('/v1/automations/webhookSeedanceEditGen', async (req, res) => {
  const {
    baseId,
    recordId,
    tableIdOrName = 'IMG GEN',       // adjust if your table is different
    fieldName = 'Attachments'         // the Airtable attachments column
  } = req.query;

  console.log('[seedance-edit] received:', { baseId, recordId, tableIdOrName, fieldName });

  if (!baseId || !recordId) {
    return res.status(400).json({ ok: false, error: 'baseId and recordId are required' });
  }

  // 1) Read the record so we can grab the input image(s)
  const recordUrl = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}/${encodeURIComponent(recordId)}`;
  let record;
  try {
    const recResp = await fetch(recordUrl, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
    });
    const recJson = await recResp.json();
    if (!recResp.ok) {
      console.error('[airtable-read] error:', recJson);
      return res.status(502).json({ ok: false, step: 'read', error: recJson });
    }
    record = recJson;
  } catch (e) {
    console.error('[airtable-read] exception:', e);
    return res.status(502).json({ ok: false, step: 'read', error: String(e) });
  }

  // You said the first 4 images are sources. Pull URLs from the Attachments column.
  const attachments = (record.fields?.[fieldName] || [])
    .filter(a => a && a.url)
    .slice(0, 4)
    .map(a => a.url);

  if (attachments.length === 0) {
    console.warn('[seedance-edit] no source images on record');
    return res.status(200).json({ ok: true, recordId, note: 'no source images' });
  }

  // prompt: use your prompt field or hardcode one
  const prompt =
    record.fields?.prompt ||
    'Use the first 4 images as a source for the face and body. Use the 5th image as a source for the outfit.';

  // 2) Submit Seedream-v4/edit job
  let requestId;
  try {
    const submit = await fetch('https://api.wavespeed.ai/api/v3/bytedance/seedream-v4/edit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WAVESPEED_API_KEY}`
      },
      body: JSON.stringify({
        enable_base64_output: false,
        enable_sync_mode: false,
        images: attachments,      // array of URLs
        prompt,
        // size optional; omit to let model decide. Or: "1024*1536"
      })
    });

    const submitJson = await submit.json();
    if (!submit.ok) {
      console.error('[wavespeed-submit] error:', submit.status, submitJson);
      return res.status(502).json({ ok: false, step: 'submit', error: submitJson });
    }
    requestId = submitJson?.data?.id;
    console.log('[wavespeed-submit] requestId =', requestId);
    if (!requestId) throw new Error('no requestId from wavespeed');
  } catch (e) {
    console.error('[wavespeed-submit] exception:', e);
    return res.status(502).json({ ok: false, step: 'submit', error: String(e) });
  }

  // 3) Poll result
  let resultUrl;
  try {
    for (let i = 0; i < 120; i++) { // up to ~2 minutes
      const poll = await fetch(`https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`, {
        headers: { Authorization: `Bearer ${WAVESPEED_API_KEY}` }
      });
      const pollJson = await poll.json();

      if (!poll.ok) {
        console.error('[wavespeed-poll] error:', poll.status, pollJson);
        return res.status(502).json({ ok: false, step: 'poll', error: pollJson });
      }

      const status = pollJson?.data?.status;
      if (status === 'completed') {
        const outs = pollJson?.data?.outputs || [];
        resultUrl = outs[0];
        console.log('[wavespeed-poll] completed:', resultUrl);
        break;
      }
      if (status === 'failed') {
        console.error('[wavespeed-poll] failed:', pollJson?.data?.error);
        return res.status(502).json({ ok: false, step: 'poll', error: pollJson?.data?.error });
      }
      await wait(1000);
    }
  } catch (e) {
    console.error('[wavespeed-poll] exception:', e);
    return res.status(502).json({ ok: false, step: 'poll', error: String(e) });
  }

  if (!resultUrl) {
    return res.status(504).json({ ok: false, step: 'poll', error: 'timeout waiting for result' });
  }

  // 4) Write output back to Airtable Attachments field
  try {
    const patch = await fetch(recordUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          [fieldName]: [{ url: resultUrl }],
          Status: 'Success',
          err_msg: ''
        }
      })
    });

    const patchJson = await patch.json();
    if (!patch.ok) {
      console.error('[airtable-write] error:', patch.status, patchJson);
      return res.status(502).json({ ok: false, step: 'write', error: patchJson });
    }
  } catch (e) {
    console.error('[airtable-write] exception:', e);
    return res.status(502).json({ ok: false, step: 'write', error: String(e) });
  }

  res.json({ ok: true, recordId });
});

// keep Node from dying on unhandled stuff
process.on('unhandledRejection', err => {
  console.error('[unhandledRejection]', err);
});
process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log('HTTP listening on', PORT);
});
