import { docs, LABELS, labelsFromData, tokenize, bm25Scores,
         classifyLangIntent, smalltalkLLM, llmAnswer, THRESHOLD } from "./_utils.mjs";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")    return res.status(405).json({error:"Method not allowed"});

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

  const top = scores.map((s,i)=>({s,i})).sort((a,b)=>b.s-a.s).slice(0,3).map(o=>o.i);
  const snippets = top.map(i=>docs[i]);
  const ans = await llmAnswer(message, snippets, lang);
  return res.json({ answer: ans, sources: snippets.map(s=>s.url) });
}
