/* functions/index.js
   Backend for SUPERHITZ — deploy with Firebase Functions.
   - Verifies Firebase ID token
   - /upload -> accepts multipart (audio + cover) and uploads to Firebase Storage; writes Firestore
   - /generate-lyrics -> calls OpenAI (if set) and returns lyrics
   - /generate-music -> calls Hugging Face MusicGen (if set) and stores result
*/

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

// init admin
admin.initializeApp();
const db = admin.firestore();
const bucket = admin.storage().bucket();

const app = express();
app.use(cors({ origin: true }));

// multer (memory)
const upload = multer({ storage: multer.memoryStorage() });

// helper: verify Firebase ID token
async function verifyToken(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Authorization header' });
  const idToken = auth.split(' ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = decoded;
    return next();
  } catch (err) {
    console.error('verifyToken error', err);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// helper: upload buffer to storage and return signed URL
async function uploadBufferToStorage(buffer, destPath, contentType = 'application/octet-stream') {
  const file = bucket.file(destPath);
  await file.save(buffer, { contentType });
  const [url] = await file.getSignedUrl({ action: 'read', expires: '03-01-2500' });
  return url;
}

// --------- Upload endpoint ----------
app.post('/upload', verifyToken, upload.fields([{ name: 'audio' }, { name: 'cover' }]), async (req, res) => {
  try {
    const uid = req.user.uid;
    const files = req.files || {};
    if (!files.audio || !files.audio[0]) return res.status(400).json({ error: 'No audio file uploaded' });

    const audio = files.audio[0];
    const cover = (files.cover && files.cover[0]) || null;

    // metadata fields
    const title = (req.body.title || '').trim() || 'Untitled';
    const artist = (req.body.artist || '').trim() || (req.user.name || req.user.email || 'Artist');
    const tags = (req.body.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    const visibility = (req.body.visibility === 'private') ? 'private' : 'public';

    // upload files to storage
    const audioDest = `tracks/${uid}_${Date.now()}_${audio.originalname.replace(/\s+/g,'_')}`;
    const audioUrl = await uploadBufferToStorage(audio.buffer, audioDest, audio.mimetype || 'audio/mpeg');

    let coverUrl = '';
    if (cover) {
      const coverDest = `covers/${uid}_${Date.now()}_${cover.originalname.replace(/\s+/g,'_')}`;
      coverUrl = await uploadBufferToStorage(cover.buffer, coverDest, cover.mimetype || 'image/jpeg');
    }

    // save metadata
    const doc = {
      title,
      artist,
      tags,
      coverUrl,
      audioUrl,
      uploaderUid: uid,
      uploaderName: req.user.name || req.user.email || 'Artist',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      visibility,
      plays: 0
    };
    const docRef = await db.collection('tracks').add(doc);

    return res.json({ ok: true, id: docRef.id, doc });
  } catch (err) {
    console.error('upload error', err);
    return res.status(500).json({ error: err.message });
  }
});

// --------- Generate lyrics (OpenAI) ----------
app.post('/generate-lyrics', verifyToken, express.json(), async (req, res) => {
  const prompt = (req.body && req.body.prompt) || '';
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  // get key from functions config
  const openaiKey = functions.config().openai ? functions.config().openai.key : null;
  try {
    if (openaiKey) {
      // call OpenAI chat completion
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are a professional songwriter. Output structured lyrics: verse and chorus and a 1-line promo.' },
            { role: 'user', content: prompt }
          ],
          max_tokens: 700,
          temperature: 0.8
        })
      });
      const data = await response.json();
      const lyrics = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : JSON.stringify(data);
      return res.json({ ok: true, lyrics, raw: data });
    } else {
      // fallback example
      const demo = `(Verse)\nSunrise over Monrovia, rhythm in our feet...\n(Chorus)\nSUPERHITZ — feel the beat...`;
      return res.json({ ok: true, lyrics: demo, note: 'OPENAI key not configured.' });
    }
  } catch (err) {
    console.error('lyrics error', err);
    return res.status(500).json({ error: err.message });
  }
});

// --------- Generate music (Hugging Face MusicGen) ----------
app.post('/generate-music', verifyToken, express.json(), async (req, res) => {
  const { prompt, style = 'afropop', durationSeconds = 30 } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  const hfKey = functions.config().huggingface ? functions.config().huggingface.key : null;
  if (!hfKey) return res.status(400).json({ error: 'Hugging Face key not configured' });

  try {
    // model selection (example)
    const model = 'facebook/musicgen-small'; // change if you prefer another model

    // call HF Inference endpoint
    const hfUrl = `https://api-inference.huggingface.co/models/${model}`;
    const payload = { inputs: prompt, parameters: { max_new_tokens: Math.min(2000, Math.max(200, Math.floor(durationSeconds * 50))) } };

    const hfResp = await fetch(hfUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hfKey}`, Accept: 'application/octet-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!hfResp.ok) {
      const text = await hfResp.text();
      console.error('HF error:', hfResp.status, text);
      return res.status(502).json({ error: 'Music provider error', details: text });
    }

    // get audio buffer
    const arrayBuffer = await hfResp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // save to storage
    const uid = req.user.uid;
    const filename = `ai-generated/${uid}_${Date.now()}.mp3`;
    const audioUrl = await uploadBufferToStorage(buffer, filename, 'audio/mpeg');

    // save track doc
    const doc = {
      title: `AI: ${prompt.slice(0,80)}`,
      artist: 'SUPERHITZ AI',
      tags: ['ai-generated', style],
      coverUrl: '',
      audioUrl,
      uploaderUid: uid,
      uploaderName: req.user.name || req.user.email || 'Artist',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      visibility: 'public',
      plays: 0
    };
    const docRef = await db.collection('tracks').add(doc);
    return res.json({ ok: true, id: docRef.id, audioUrl, doc });
  } catch (err) {
    console.error('generate-music error', err);
    return res.status(500).json({ error: err.message });
  }
});

exports.api = functions.https.onRequest(app);
