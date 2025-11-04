// index.js
const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 8080;   // use Railway's injected port
const HOST = "0.0.0.0";                  // bind to all interfaces

const server = http.createServer(async (req, res) => {
  // quick health check
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  // your webhook endpoint
  if (req.method === "GET" && req.url.startsWith("/v1/automations/webhookSeedanceEditGen")) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const baseId = url.searchParams.get("baseId");
      const recordId = url.searchParams.get("recordId");
      const tableIdOrName = url.searchParams.get("tableIdOrName") || "tblrTdaEKwrnLq1Jq";
      const fieldName = url.searchParams.get("fieldName") || "Attachments";

      // TODO: do your Airtable + Wavespeed work here
      // await doWork({ baseId, recordId, tableIdOrName, fieldName });

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, recordId }));
    } catch (e) {
      console.error(e);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // default root so you can verify it answers
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("running");
});

server.listen(PORT, HOST, () => {
  console.log(`HTTP listening on ${PORT}`);
});

// keep the process alive on unhandled errors instead of crashing
process.on("uncaughtException", err => console.error("uncaughtException", err));
process.on("unhandledRejection", err => console.error("unhandledRejection", err));
