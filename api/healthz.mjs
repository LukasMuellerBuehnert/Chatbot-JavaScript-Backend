import { docs, LABELS, applyCORS } from "./_utils.mjs";

export default function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  return res.status(200).json({ ok:true, docs: docs.length, labels: LABELS.length });
}
