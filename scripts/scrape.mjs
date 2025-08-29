// scripts/scrape.mjs
import fs from "fs";
import crypto from "crypto";
import cheerio from "cheerio";
import fetch from "node-fetch";

const START_URL = "https://md-hellas.gr/";         // deine Domain
const MAX_PAGES = 100;
//const ALLOW = [/^\/(about|contact|impressum|datenschutz|privacy|terms|faq|agb|shipping|returns|opening|standorte|locations)?/i];
//const DENY  = [/^\/(wp-admin|cart|checkout|login|search|tag|category|page\/\d+)/i];

const seen = new Set();
const out = [];
const statePath = "data/site-state.json";
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath,"utf8")) : {};

const ORIGIN = new URL(START_URL).origin;
const sleep = ms => new Promise(r=>setTimeout(r, ms));
const hash  = s => crypto.createHash("sha256").update(s).digest("hex");

function want(p){
  if (p.includes("?") || p.includes("#")) return false;
  if (DENY.some(re=>re.test(p))) return false;
  if (ALLOW.some(re=>re.test(p))) return true;
  return false; // eng halten
}
function extract(html, url){
  const $ = cheerio.load(html);
  $("script,style,noscript").remove();
  const title = ($("title").first().text() || url).trim();
  const text = ($("main").text() || $("body").text() || "").replace(/\s+/g," ").trim().slice(0,6000);
  return { url, title, text };
}
async function fetchSmart(url){
  const prev = state[url] || {};
  const headers = { "User-Agent":"SiteCrawler/1.0" };
  if (prev.etag) headers["If-None-Match"] = prev.etag;
  if (prev.lastModified) headers["If-Modified-Since"] = prev.lastModified;

  const res = await fetch(url, { headers });
  if (res.status === 304 && prev.text) return { unchanged:true, meta:prev };
  if (!res.ok) return null;

  const html = await res.text();
  return {
    html,
    meta: {
      etag: res.headers.get("etag") || null,
      lastModified: res.headers.get("last-modified") || null,
    }
  };
}

async function crawl(){
  const q = [START_URL];
  while (q.length && out.length < MAX_PAGES){
    const url = q.shift();
    if (seen.has(url)) continue; seen.add(url);

    const u = new URL(url);
    if (u.origin !== ORIGIN) continue;
    if (!want(u.pathname)) continue;

    const r = await fetchSmart(url);
    if (!r) continue;

    if (r.unchanged){
      out.push({ url, title: state[url].title || url, text: state[url].text || "" });
    } else {
      const doc = extract(r.html, url);
      out.push(doc);
      state[url] = { ...r.meta, hash: hash(doc.text), title: doc.title, text: doc.text };

      // neue Links sammeln
      const $ = cheerio.load(r.html);
      $("a[href]").each((_, a) => {
        try {
          const href = new URL($(a).attr("href"), ORIGIN);
          if (href.origin === ORIGIN && !seen.has(href.href)) q.push(href.href);
        } catch {}
      });
      await sleep(300); // höflich
    }
  }
}

await crawl();
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/site.jsonl", out.map(JSON.stringify).join("\n")+"\n");
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
console.log(`Saved ${out.length} docs.`);
