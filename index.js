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
      "Authorization": `Bearer ${process.env.WAVESPEED_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ prompt })
  });

  const data = await r.json();
  res.json(data);
});

app.listen(3000, () => console.log("Server up"));