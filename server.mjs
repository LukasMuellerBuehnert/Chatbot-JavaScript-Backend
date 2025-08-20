import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Groq from "groq-sdk";

// ---------- Settings ----------
const THRESHOLD = 1.0;
const ALWAYS_LABELS = ["greeting","thanks","goodbye","smalltalk"];
const GROQ_MODEL = "llama-3.1-8b-instant";

// ---------- Helpers ----------
function fold(s=""){ s=s.toLowerCase().trim();
  return s.replaceAll("ä","ae").replaceAll("ö","oe").replaceAll("ü","ue").replaceAll("ß","ss")
          .replace(/\s+/g," "); }
function tokenize(s=""){ return (s.toLowerCase().match(/\w+/g)) || []; }

// ---------- Data ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const DATA_PATH  = path.join(__dirname, "data", "faq.jsonl");

const docs = [];
if (fs.existsSync(DATA_PATH)) {
  const lines = fs.readFileSync(DATA_PATH,"utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      if (d.url && d.title && d.text) { d._title_fold = fold(d.title); docs.push(d); }
    } catch {}
  }
}
const labelsFromData = Object.fromEntries(docs.map(d=>[d._title_fold,d]));
const LABELS = Object.keys(labelsFromData).concat(ALWAYS_LABELS);

// ---------- BM25 (leicht) ----------
const corpus = docs.map(d => tokenize(d.text));
const df = new Map();
for (const doc of corpus) for (const t of new Set(doc)) df.set(t,(df.get(t)||0)+1);
const avgdl = corpus.reduce((a,d)=>a+d.length,0)/(corpus.length||1);
const k1=1.5, b=0.75;
const idf = t => { const n=corpus.length||1, f=df.get(t)||0; return Math.log(1 + (n - f + .5)/(f + .5)); };
function bm25Scores(qTokens){
  if (!corpus.length) return [];
  const scores = new Array(corpus.length).fill(0);
  for (let i=0;i<corpus.length;i++){
    const doc = corpus[i], len = doc.length||1;
    const tf = {}; for (const t of doc) tf[t]=(tf[t]||0)+1;
    for (const t of qTokens){
      const f = tf[t]; if (!f) continue;
      const num = f*(k1+1);
      const den = f + k1*(1 - b + b*(len/avgdl));
      scores[i] += idf(t)*(num/den);
    }
  }
  return scores;
}

// ---------- Groq ----------
const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function classifyLangIntent(q){
  const labelsStr = LABELS.join(", ");
  const prompt =
    "Tasks:\n1) Detect user language (ISO-639-1 like 'de','en',...).\n" +
    `2) Classify the user's question into ONE label from this exact set: [${labelsStr}]. If nothing fits, return 'unknown'.\n` +
    'Return ONLY JSON: {"lang":"..","intent":".."}\n' +
    `User: ${q}`;
  try {
    const r = await client.chat.completions.create({
      model: GROQ_MODEL, temperature: 0,
      messages: [{role:"system",content:"Answer with valid JSON only."},{role:"user",content:prompt}]
    });
    const obj = JSON.parse(r.choices[0].message.content || "{}");
    const lang = (obj.lang||"en").toLowerCase();
    const raw  = (obj.intent||"unknown").toLowerCase().trim();
    const f    = fold(raw);
    let intent = "unknown";
    if (labelsFromData[f]) intent = f;
    else if (ALWAYS_LABELS.includes(f)) intent = f;
    return { lang, intent };
  } catch { return { lang:"en", intent:"unknown" }; }
}

async function smalltalkLLM(intent, lang){
  if (!["greeting","thanks","goodbye","smalltalk"].includes(intent)) return null;
  const r = await client.chat.completions.create({
    model: GROQ_MODEL, temperature: 0.2,
    messages: [
      { role:"system",
        content:"You are a website assistant, focus on helping the user. One very short, friendly sentence in the target language. Don’t ask how they are. If intent=smalltalk, reply short & safe. No emojis unless user used them."},
      { role:"user", content:`Target language: ${lang}\nIntent: ${intent}` }
    ]
  });
  return (r.choices?.[0]?.message?.content || "").trim();
}

async function llmAnswer(question, snippets, lang){
  const ctx = snippets.map(d=>`- ${d.text} (Quelle: ${d.url})`).join("\n");
  const sys = "You are a website assistant. Answer briefly in the requested target language. " +
              "Only use the provided excerpts; if insufficient, try commonsense if not specific facts, or say you don't know and refer to /kontakt.";
  const prompt = `Target language: ${lang}\nQuestion: ${question}\n\nExcerpts:\n${ctx}\n\nAnswer:`;
  const r = await client.chat.completions.create({
    model: GROQ_MODEL, temperature: 0.2,
    messages: [{role:"system",content:sys},{role:"user",content:prompt}]
  });
  return (r.choices?.[0]?.message?.content || "").trim();
}

// ---------- Server ----------
const app = express();

// CORS
const ALLOWED_ORIGINS = [
  "https://lukasmuellerbuehnert.github.io",
  "http://testingground.local", "http://localhost", "http://127.0.0.1",
  "http://localhost:80","http://localhost:8080","http://localhost:3000",
  "https://mdholidays.gr","https://www.mdholidays.gr",
];
app.use(cors({
  origin: (origin, cb)=>(!origin || ALLOWED_ORIGINS.includes(origin)) ? cb(null,true) : cb(new Error("CORS: "+origin)),
  methods:["POST","OPTIONS"], allowedHeaders:["Content-Type"], maxAge:3600
}));
app.use(express.json());

app.get("/healthz", (req,res)=> res.json({ ok:true, docs:docs.length, labels:LABELS.length }));
app.options("/chat",(req,res)=>res.sendStatus(204));

app.post("/chat", async (req,res)=>{
  if (!docs.length) return res.json({ answer:"Keine Wissensbasis geladen.", sources:[] });

  const message = String(req.body?.message || "");
  const { lang, intent } = await classifyLangIntent(message);

  const st = await smalltalkLLM(intent, lang);
  if (st) return res.json({ answer: st, sources: [] });

  let query = message;
  if (labelsFromData[intent]) {
    const d = labelsFromData[intent];
    query = `${message} ${d.title} ${d.text}`;
  }

  const scores = bm25Scores(tokenize(query));
  if (!scores.length || Math.max(...scores) < THRESHOLD) {
    const ans = await llmAnswer(message, [], lang);
    return res.json({ answer: ans, sources: [] });
  }
  const idx = scores.map((s,i)=>({s,i})).sort((a,b)=>b.s-a.s).slice(0,3).map(o=>o.i);
  const snippets = idx.map(i=>docs[i]);
  const ans = await llmAnswer(message, snippets, lang);
  res.json({ answer: ans, sources: snippets.map(s=>s.url) });
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, ()=> console.log("listening on", PORT));
