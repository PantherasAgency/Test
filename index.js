app.get('/v1/automations/webhookSeedanceEditGen', async (req, res) => {
  const { baseId, recordId, tableIdOrName, fieldName } = req.query;

  console.log('[seedance-edit] received:', {
    baseId, recordId,
    tableIdOrName: tableIdOrName || '(missing)',
    fieldName: fieldName || '(missing)'
  });

  if (!baseId || !recordId || !tableIdOrName || !fieldName) {
    return res.status(400).json({ ok:false, error:'Missing baseId/recordId/tableIdOrName/fieldName' });
  }

  try {
    const testImageUrl = 'https://picsum.photos/1024'; // proof-of-life

    const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}/${encodeURIComponent(recordId)}`;
    const body = { fields: { [fieldName]: [{ url: testImageUrl }] } };

    const r = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const text = await r.text();
    if (!r.ok) throw new Error(`Airtable PATCH failed: ${r.status} ${text}`);

    console.log('[seedance-edit] wrote attachment to', fieldName);
    return res.json({ ok:true, recordId, wrote: fieldName });
  } catch (err) {
    console.error('[seedance-edit] error:', err);
    return res.status(500).json({ ok:false, error: err.message });
  }
});
