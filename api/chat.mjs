import {
  docs, labelsFromData, tokenize, bm25Scores,
  classifyLangIntent, smalltalkLLM, llmAnswer,
  THRESHOLD, applyCORS
} from "./_utils.mjs";

export default async function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  if (!docs.length) return res.json({ answer: "Keine Wissensbasis geladen.", sources: [] });

  const message = String(req.body?.message || "");

  // 1) Sprache + Intent
  const { lang, intent } = await classifyLangIntent(message);

  // 2) Smalltalk direkt
  const st = await smalltalkLLM(intent, lang);
  if (st) return res.json({ answer: st, sources: [] });

  // 3) Query boosten
  let query = message;
  if (labelsFromData[intent]) {
    const d = labelsFromData[intent];
    query = `${message} ${d.title} ${d.text}`;
  }

  // 4) BM25 Top-3 oder Fallback
  const scores = bm25Scores(tokenize(query));
  if (!scores.length) {
    const ans = await llmAnswer(message, [], lang);
    return res.json({ answer: ans, sources: [] });
  }
  const top = scores.map((s,i)=>({s,i})).sort((a,b)=>b.s-a.s).slice(0,3).map(o=>o.i);
  if (scores[top[0]] < THRESHOLD) {
    const ans = await llmAnswer(message, [], lang);
    return res.json({ answer: ans, sources: [] });
  }

  const snippets = top.map(i => docs[i]);

  // 5) Finale Antwort
  const ans = await llmAnswer(message, snippets, lang);
  return res.json({ answer: ans, sources: snippets.map(s => s.url) });
}
