// _utils.mjs
import fs from "fs";
import path from "path";
import Groq from "groq-sdk";

export const THRESHOLD = 1.0;
export const ALWAYS_LABELS = ["greeting","thanks","goodbye","smalltalk"];
export const GROQ_MODEL = "llama-3.1-8b-instant";

// --- Helpers ---
export const fold = (s="") => s.toLowerCase().trim()
  .replaceAll("ä","ae").replaceAll("ö","oe").replaceAll("ü","ue").replaceAll("ß","ss")
  .replace(/\s+/g," ");

export const tokenize = (s="") => (s.toLowerCase().match(/\w+/g)) || [];

// --- JSONL Loader ---
function loadJSONL(absPath){
  if (!fs.existsSync(absPath)) return [];
  return fs.readFileSync(absPath,"utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(l => {
      try {
        const d = JSON.parse(l);
        if (d?.url && d?.title && d?.text) return d;
      } catch {}
      return null;
    })
    .filter(Boolean);
}

// --- Daten laden: FAQ + SITE (gemerged) ---
const DATA_DIR = path.join(process.cwd(), "data");
const FAQ_PATH  = path.join(DATA_DIR, "faq.jsonl");
const SITE_PATH = path.join(DATA_DIR, "site.jsonl");

const docsFaq  = loadJSONL(FAQ_PATH);
const docsSite = loadJSONL(SITE_PATH);

// merge (FAQ zuerst, dann Site). Optional: Duplikate per URL entfernen:
const byUrl = new Map();
for (const d of [...docsFaq, ...docsSite]) {
  if (!byUrl.has(d.url)) byUrl.set(d.url, d);
}
export const docs = Array.from(byUrl.values()).map(d => ({ ...d, _title_fold: fold(d.title) }));

// Labels aus ALLEN Dokumenten + feste Intents
export const labelsFromData = Object.fromEntries(docs.map(d => [d._title_fold, d]));
export const LABELS = Object.keys(labelsFromData).concat(ALWAYS_LABELS);

// --- Mini-BM25 Index auf dem gemergten Korpus ---
const corpus = docs.map(d => tokenize(d.text));
const df = new Map();
for (const doc of corpus) for (const t of new Set(doc)) df.set(t,(df.get(t)||0)+1);
const avgdl = corpus.reduce((a,d)=>a+d.length,0)/(corpus.length||1);
const k1 = 1.5, b = 0.75;
const idf = t => { const n=corpus.length||1, f=df.get(t)||0; return Math.log(1 + (n - f + 0.5)/(f + 0.5)); };

export function bm25Scores(qTokens){
  if (!corpus.length) return [];
  const scores = new Array(corpus.length).fill(0);
  for (let i=0;i<corpus.length;i++){
    const doc = corpus[i], len = doc.length || 1;
    const tf = {}; for (const t of doc) tf[t]=(tf[t]||0)+1;
    for (const t of qTokens){
      const f = tf[t]; if (!f) continue;
      const num = f * (k1 + 1);
      const den = f + k1 * (1 - b + b * (len / avgdl));
      scores[i] += idf(t) * (num / den);
    }
  }
  return scores;
}

// --- Groq Client ---
export const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

// --- LLM-Funktionen ---
export async function classifyLangIntent(q){
  const labelsStr = LABELS.join(", ");
  const prompt =
    "Tasks:\n1) Detect user language (ISO-639-1 like 'de','en',...).\n" +
    `2) Classify the user's question into ONE label from this exact set: [${labelsStr}]. If nothing fits, return 'unknown'.\n` +
    'Return ONLY JSON: {"lang":"..","intent":".."}\n' +
    `User: ${q}`;
  try {
    const r = await client.chat.completions.create({
      model: GROQ_MODEL, temperature: 0,
      messages: [
        { role:"system", content:"Answer with valid JSON only." },
        { role:"user",   content: prompt }
      ]
    });
    const obj = JSON.parse(r.choices[0].message.content || "{}");
    const lang = (obj.lang || "en").toLowerCase();
    const raw  = (obj.intent || "unknown").toLowerCase().trim();
    const f    = fold(raw);
    let intent = "unknown";
    if (labelsFromData[f]) intent = f;
    else if (ALWAYS_LABELS.includes(f)) intent = f;
    return { lang, intent };
  } catch {
    return { lang:"en", intent:"unknown" };
  }
}

export async function smalltalkLLM(intent, lang){
  if (!["greeting","thanks","goodbye","smalltalk"].includes(intent)) return null;
  const r = await client.chat.completions.create({
    model: GROQ_MODEL, temperature: 0.2,
    messages: [
      { role:"system",
        content:"You are a website assistant, focus on helping the user. One very short, friendly sentence in the target language. Don't ask how they are. If intent=smalltalk, reply short & safe. No emojis unless user used them."
      },
      { role:"user", content:`Target language: ${lang}\nIntent: ${intent}` }
    ]
  });
  return (r.choices?.[0]?.message?.content || "").trim();
}

export async function llmAnswer(question, snippets, lang){
  // Kontext knapp halten (Prompt-Budget)
  const ctx = snippets.slice(0,2) // max 2 Snippets
    .map(d => `- ${String(d.text).slice(0,900)} (Source: ${d.url})`)
    .join("\n");

  const sys =
    "You are a website assistant. Answer briefly in the requested target language. " +
    "Only use the provided excerpts; if insufficient, try commonsense if not about specific facts, or say you don't know and refer to /kontakt.";
  const prompt = `Target language: ${lang}\nQuestion: ${question}\n\nExcerpts:\n${ctx}\n\nAnswer:`;
  const r = await client.chat.completions.create({
    model: GROQ_MODEL, temperature: 0.2,
    messages: [{ role:"system", content: sys }, { role:"user", content: prompt }]
  });
  return (r.choices?.[0]?.message?.content || "").trim();
}

// --- CORS Hilfen ---
export const ALLOWED_ORIGINS = [
  "https://lukasmuellerbuehnert.github.io",
  "http://testingground.local",
  "http://localhost",
  "http://127.0.0.1",
  "http://localhost:80",
  "http://localhost:8080",
  "http://localhost:3000",
  "https://mdholidays.gr",
  "https://www.mdholidays.gr",
];

export function applyCORS(req, res){
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
