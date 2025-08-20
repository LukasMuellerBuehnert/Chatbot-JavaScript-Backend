import { docs, LABELS } from "./_utils.mjs";
export default function handler(req, res) {
  return res.status(200).json({ ok:true, docs: docs.length, labels: LABELS.length });
}
