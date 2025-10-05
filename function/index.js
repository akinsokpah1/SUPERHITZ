import functions from "firebase-functions";
import fetch from "node-fetch";

// 🔐 Environment variables (set these with Firebase CLI)
const OPENAI_API_KEY = process.env.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;
const HUGGINGFACE_API_KEY = process.env.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;

// GPT endpoint
export const gptChat = functions.https.onRequest(async (req, res) => {
  const userPrompt = req.body.prompt;
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer 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}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: userPrompt }]
      })
    });
    const data = await response.json();
    res.json({ reply: data.choices[0].message.content });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Music generation
export const musicGen = functions.https.onRequest(async (req, res) => {
  const prompt = req.body.prompt || "Afrobeat instrumental";
  try {
    const response = await fetch(
      "https://api-inference.huggingface.co/models/facebook/musicgen-small",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${HUGGINGFACE_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ inputs: prompt })
      }
    );
    const buffer = await response.arrayBuffer();
    res.set("Content-Type", "audio/mpeg");
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).send(err.message);
  }
});
