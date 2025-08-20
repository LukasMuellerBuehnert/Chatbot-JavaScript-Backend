import fs from "fs"; import path from "path"; import Groq from "groq-sdk";
export const GROQ_MODEL = "llama-3.1-8b-instant";
export const THRESHOLD = 1.0;
export const ALWAYS_LABELS = ["greeting","thanks","goodbye","smalltalk"];

export const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

export const fold = (s="") => s.toLowerCase().trim()
  .replaceAll("ä","ae").replaceAll("ö","oe").replaceAll("ü","ue").replaceAll("ß","ss")
  .replace(/\s+/g," ");
export const tokenize = (s="") => (s.toLowerCase().match(/\w+/g)) || [];

// Daten
const DATA_PATH = path.join(process.cwd(), "data", "faq.jsonl");
export const docs = [];
if (fs.existsSync(DATA_PATH)) {
  for (const line of fs.readFileSync(DATA_PATH,"utf8").split(/\r?\n/).filter(Boolean)) {
    try { const d = JSON.parse(line); if (d.url&&d.title&&d.text){ d._title_fold=fold(d.title); docs.push(d);} } catch {}
  }
}
export const labelsFromData = Object.fromEntries(docs.map(d=>[d._title_fold,d]));
export const LABELS = Object.keys(labelsFromData).concat(ALWAYS_LABELS);

// sehr leichte BM25
const corpus = docs.map(d=>tokenize(d.text));
const df = new Map(); for (const doc of corpus) for (const t of new Set(doc)) df.set(t,(df.get(t)||0)+1);
const avgdl = corpus.reduce((a,d)=>a+d.length,0)/(corpus.length||1), k1=1.5, b=0.75;
const idf = t => { const n=corpus.length||1,f=df.get(t)||0; return Math.log(1+(n-f+0.5)/(f+0.5)); };
export function bm25Scores(qTok){
  if(!corpus.length) return [];
  const scores = new Array(corpus.length).fill(0);
  for (let i=0;i<corpus.length;i++){
    const doc=corpus[i], len=doc.length||1, tf={}; for(const t of doc) tf[t]=(tf[t]||0)+1;
    for(const t of qTok){ const f=tf[t]; if(!f) continue;
      const num=f*(k1+1), den=f+k1*(1-b+b*(len/avgdl)); scores[i]+=idf(t)*(num/den);
    }
  } return scores;
}

export async function classifyLangIntent(q){
  const labelsStr = LABELS.join(", ");
  const prompt =
    "Tasks:\n1) Detect user language (ISO-639-1 like 'de','en',...).\n" +
    `2) Classify into ONE label from [${labelsStr}] or 'unknown'.\n` +
    'Return ONLY JSON: {"lang":"..","intent":".."}\n' + `User: ${q}`;
  try {
    const r = await client.chat.completions.create({
      model: GROQ_MODEL, temperature: 0,
      messages:[{role:"system",content:"Answer with valid JSON only."},{role:"user",content:prompt}]
    });
    const obj = JSON.parse(r.choices[0].message.content || "{}");
    const lang=(obj.lang||"en").toLowerCase(), raw=(obj.intent||"unknown").toLowerCase().trim();
    const f=fold(raw);
    let intent="unknown";
    if (labelsFromData[f]) intent=f; else if (ALWAYS_LABELS.includes(f)) intent=f;
    return { lang, intent };
  } catch { return { lang:"en", intent:"unknown" }; }
}

export async function smalltalkLLM(intent, lang){
  if (!ALWAYS_LABELS.includes(intent)) return null;
  const r = await client.chat.completions.create({
    model: GROQ_MODEL, temperature: 0.2,
    messages:[
      {role:"system",content:"You are a website assistant. One very short, friendly sentence in target language. No emojis unless user used them."},
      {role:"user",content:`Target language: ${lang}\nIntent: ${intent}`}
    ]
  });
  return (r.choices?.[0]?.message?.content || "").trim();
}

export async function llmAnswer(question, snippets, lang){
  const ctx = snippets.map(d=>`- ${d.text} (Quelle: ${d.url})`).join("\n");
  const sys = "You are a website assistant. Answer briefly in target language. Use only provided excerpts; otherwise say you don't know and refer to /kontakt (or use safe commonsense).";
  const prompt = `Target language: ${lang}\nQuestion: ${question}\n\nExcerpts:\n${ctx}\n\nAnswer:`;
  const r = await client.chat.completions.create({
    model: GROQ_MODEL, temperature: 0.2,
    messages:[{role:"system",content:sys},{role:"user",content:prompt}]
  });
  return (r.choices?.[0]?.message?.content || "").trim();
}
