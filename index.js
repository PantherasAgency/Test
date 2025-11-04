import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

app.post("/generate", async (req, res) => {
  const prompt = req.body.prompt;
  if (!prompt) return res.status(400).send("Prompt missing");

  const r = await fetch("https://api.wavespeed.ai/v1/run/bytedance/seedream-v4", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.263e7f254b4d0c373f2af8f7a32a2f2504698ef3d2598038b6feff32dd6cca56}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ prompt })
  });

  const data = await r.json();
  res.json(data);
});

app.listen(3000, () => console.log("Server up"));
