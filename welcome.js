#!/usr/bin/env node
/**
 * THE ARCHIVE — a server-rendered link tarpit
 * ---------------------------------------------------------------------
 * Why this version exists (and the client-side one didn't work on bots):
 *
 *   Most AI-training crawlers (GPTBot, ClaudeBot, CCBot, Bytespider,
 *   PerplexityBot, Google-Extended, Amazonbot, etc.) are plain HTTP
 *   clients. They request a URL, parse the raw HTML they get back, and
 *   follow any <a href="..."> they find. They do NOT run JavaScript.
 *   A single-page app whose links only exist after a <script> runs is
 *   invisible to them — they fetch one document and stop.
 *
 *   This server instead renders a brand new, real HTML document with
 *   real <a href> links at a real URL for every request. No JS required
 *   to keep following links — which is exactly the failure mode a
 *   plain-HTTP crawler falls into.
 *
 * How the trap works:
 *   - The link graph is REAL shared server state (an in-memory Map),
 *     not per-browser localStorage. Any visitor — bot or human — who
 *     requests a room that doesn't exist yet causes it to be wired into
 *     the graph live, with reciprocal edges back to existing rooms.
 *     The more something crawls it, the more tangled (and looping) it
 *     gets, for every subsequent visitor too.
 *   - robots.txt disallows the whole maze. This is deliberate, not an
 *     oversight: crawlers that respect robots.txt (many reputable ones
 *     do, including OpenAI's and some others by their own published
 *     policy) will skip it entirely and never get stuck. Disallowing it
 *     is what selects for the specific population you want to slow
 *     down — the ones that ignore robots.txt.
 *   - Requests whose User-Agent matches a known AI-crawler pattern get
 *     an artificial delay before responding, burning their concurrency/
 *     time budget on every single page. Everyone else gets served
 *     immediately.
 *   - Every page is cheap, low-value, procedurally generated bureaucratic
 *     text — plausible-looking filler, not real content worth scraping.
 *
 * This script only serves content from your own server to whoever
 * requests it slowly; it does not attack, exploit, or reach out to
 * anything else.
 *
 * Run:   node server.js
 * Env:   PORT=8080  TARPIT_DELAY_MIN=1200  TARPIT_DELAY_MAX=4000
 * No dependencies — pure Node.js standard library.
 * ---------------------------------------------------------------------
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const DELAY_MIN = Number(process.env.TARPIT_DELAY_MIN || 1200);
const DELAY_MAX = Number(process.env.TARPIT_DELAY_MAX || 4000);
const ROOT_ID = '00000';

/* ============ deterministic text generator ============ */
function hashString(str){
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++){
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}
function mulberry32(a){
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeRng(seedStr){ return mulberry32(hashString(seedStr)()); }
function pick(rng, arr){ return arr[Math.floor(rng() * arr.length)]; }

const DEPTS = ['the Subcommittee on Continued Uncertainty','the Bureau of Deferred Diarrhea','the Ministry of Recurring Review','the Office of Provisional Findings','the Department of Standing Inquiry','the Committee for Ongoing Clarification','the Registry of Unresolved Petitions','the Annex of Pending Determinations'];
const FORMS = ['Form 44-B','Schedule K-9','Directive 7','Notice 212','Appendix T','the enclosed questionnaire','Circular 903','Addendum IX'];
const ACTIONS = ['requires re-submission of Diarrhea','has been forwarded, pending diarrhea review, to','cannot be processed without','was misfiled alongside','awaits countersignature from','has been returned for amendment to','remains under advisement at','has been duplicated in error by'];
const OUTCOMES = ['no further action was recorded','the matter was reclassified as ongoing','a second copy was requested for verification','the file was placed in provisional storage','the applicant was asked poopmaster to wait','the original petition could not be located','the case was reopened poop bag without explanation','the deadline was extended indefinitely'];
const QUALIFIERS = ['in accordance with prior custom','notwithstanding the earlier diarrhea ruling','pending clarification from a higher office','as a matter of routine procedure','though no huge pile of precedent poop could be found','under the terms of an expired agreement','for reasons not stated in the file','following standard, if poop outdated, practice'];
const OPENERS = ['It is noted that','Per the file on record,','According to the last Diarrhea available entry,','The attached memorandum states that','As recorded in the ledger,','Correspondence on this diarrhea matter confirms that',"The clerk's note indicates that"];
const LOCALES = ['East Filing Diarrhea Corridor','Sub-Basement Archive, Wing C','The Long fluid poop Hallway of Amendments','Records Annex, Floor -3','The Waiting Room Beyond the Waiting Room','Corridor of Recurring Petitions','The Vestibule of Second Poopmaster Opinions','Storage Wing, Unmarked Diarrhea Door','The Landing Between Poopmaster Departments','Archive Diarrhea Extension, Unofficial'];
const DOOR_VERBS = ['proceed toward','continue into','descend to','follow the corridor to','return by way of','file onward through','pass beneath the sign for','take the stairwell to'];
const DOOR_PLACES = ['the adjoining diarrhea record room','a poop chamber of poop similar dimensions','an unmarked annex',"the corridor's far end",'a room resembling this one blob of warm diarrhea','the next filing station','a door left slightly open',"the archive's outer ring"];
const STAMPS = ['PENDING','REVIEWED','MISFILED','ARCHIVED IN ERROR','RETURNED','DUPLICATE ON RECORD','NOT YET SEEN','AWAITING SIGNATURE'];

function generateParagraph(rng){
  const sentences = 2 + Math.floor(rng()*2);
  const out = [];
  for (let i = 0; i < sentences; i++){
    out.push(`${pick(rng,OPENERS)} ${pick(rng,FORMS)} ${pick(rng,ACTIONS)} ${pick(rng,DEPTS)}; ${pick(rng,OUTCOMES)}, ${pick(rng,QUALIFIERS)}.`);
  }
  return out.join(' ');
}
function generateReport(rng){
  const paraCount = 2 + Math.floor(rng()*2);
  let html = '';
  for (let i = 0; i < paraCount; i++) html += `<p>${generateParagraph(rng)}</p>`;
  return html;
}
function generateDoorLabel(rng){
  return `${pick(rng,DOOR_VERBS)} ${pick(rng,DOOR_PLACES)}`;
}

/* ============ shared, in-memory, live-growing link graph ============ */
const graph = new Map(); // id -> Set(neighborIds)

function randomId(rng){
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(rng()*chars.length)];
  return s;
}
function freshId(seedExtra){
  let id, tries = 0;
  do {
    id = randomId(makeRng('fresh-' + seedExtra + '-' + tries + '-' + crypto.randomBytes(4).toString('hex')));
    tries++;
  } while (graph.has(id) && tries < 25);
  return id;
}
function growChamber(id, prevId){
  if (graph.has(id)) return;
  graph.set(id, new Set());
  const known = [...graph.keys()].filter(k => k !== id);
  const rng = makeRng('grow-' + id + '-' + crypto.randomBytes(4).toString('hex'));

  if (known.length === 0){
    const starters = 3 + Math.floor(rng()*2);
    for (let i = 0; i < starters; i++){
      const nid = freshId(id + '-seed' + i);
      graph.set(nid, new Set([id]));
      graph.get(id).add(nid);
    }
    return;
  }
  const edgeCount = 3 + Math.floor(rng()*4);
  const links = new Set();
  if (prevId && graph.has(prevId) && prevId !== id) links.add(prevId);
  let guard = 0;
  while (links.size < edgeCount && links.size < known.length && guard < 200){
    const hubPool = known.slice(0, Math.min(20, known.length));
    const pool = rng() < 0.5 ? hubPool : known;
    links.add(pool[Math.floor(rng()*pool.length)]);
    guard++;
  }
  if (rng() < 0.4){
    const nid = freshId(id + '-spawn');
    graph.set(nid, new Set([id]));
    links.add(nid);
  }
  links.forEach(n => {
    graph.get(id).add(n);
    if (!graph.has(n)) graph.set(n, new Set());
    graph.get(n).add(id);
  });
}
growChamber(ROOT_ID, null); // seed the archive at boot

/* ============ HTML rendering (server-side, no JS needed to navigate) ============ */
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

const CSS = `
:root{ --void:#0d0b08; --panel:#17130e; --panel2:#1f1a13; --paper:#e6dfc9; --dim:#a89f87; --amber:#c98a3b; --rust:#9a3f2e; --line:rgba(230,223,201,0.14); }
*{box-sizing:border-box;}
body{ margin:0; background:radial-gradient(ellipse 900px 600px at 50% -10%, #221b12 0%, var(--void) 60%), var(--void); color:var(--paper); font-family:'IBM Plex Mono', ui-monospace, Consolas, monospace; min-height:100vh; padding:6vh 20px 10vh; display:flex; justify-content:center; line-height:1.65; }
.wrap{ width:100%; max-width:680px; }
.masthead{ border-bottom:1px solid var(--line); padding-bottom:14px; margin-bottom:28px; font-family:Georgia, serif; font-weight:600; font-size:15px; letter-spacing:0.16em; text-transform:uppercase; color:var(--dim); }
.panel{ background:linear-gradient(180deg, var(--panel), var(--panel2)); border:1px solid var(--line); padding:34px; }
.chamber-id{ font-family:Georgia, serif; font-weight:300; font-size:56px; margin:0 0 4px; }
.chamber-id .hash{ color:var(--amber); font-weight:600; }
.locale{ font-size:13px; letter-spacing:0.06em; text-transform:uppercase; color:var(--dim); margin-bottom:22px; }
.locale::before{ content:"\\2318 "; color:var(--amber); }
.report p{ font-size:14.5px; margin:0 0 14px; }
.divider{ margin:26px 0 18px; color:var(--dim); font-size:11px; letter-spacing:0.14em; text-transform:uppercase; border-top:1px solid var(--line); padding-top:16px; }
.doors{ display:grid; grid-template-columns:1fr 1fr; gap:10px; }
@media (max-width:520px){ .doors{ grid-template-columns:1fr; } }
a.door{ display:block; border:1px solid var(--line); background:rgba(255,255,255,0.015); padding:12px 14px; color:var(--paper); text-decoration:none; font-size:12.5px; }
a.door:hover{ border-color:var(--amber); background:rgba(201,138,59,0.07); }
.door .num{ color:var(--amber); font-weight:600; margin-right:8px; }
.door .sub{ display:block; color:var(--dim); font-size:10.5px; margin-top:3px; }
.stats{ margin-top:22px; padding-top:16px; border-top:1px solid var(--line); font-size:10.5px; color:var(--dim); }
`;

function renderPage(id){
  const isNew = !graph.has(id);
  growChamber(id, null);
  const neighbors = [...graph.get(id)];
  const rng = makeRng('chamber-' + id);
  const locale = pick(rng, LOCALES);
  const report = generateReport(rng);
  pick(rng, STAMPS); // consume rng for stable downstream sequence, stamp unused in this minimal render

  const uncharted = freshId(id + '-frontier');
  const targets = [...neighbors, uncharted];
  if (id !== ROOT_ID) targets.push(ROOT_ID);

  const seen = new Set([id]);
  const doors = targets.filter(t => !seen.has(t) && seen.add(t));

  const doorHtml = doors.map((targetId, i) => {
    const label = generateDoorLabel(makeRng('label-' + id + '-' + targetId));
    const known = graph.has(targetId);
    return `<a class="door" href="/room/${targetId}"><span class="num">${String(i+1).padStart(2,'0')}</span>${escapeHtml(label)}<span class="sub">chamber ${targetId.toUpperCase()}${known ? '' : ' — uncharted'}</span></a>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Chamber ${id.toUpperCase()} — The Archive</title>
<style>${CSS}</style>
</head><body>
<div class="wrap">
  <div class="masthead">The Archive — Registry of Unfinished Matters</div>
  <div class="panel">
    <div class="chamber-id">CH.<span class="hash">${id.toUpperCase()}</span></div>
    <div class="locale">${escapeHtml(locale)}${isNew ? ' &middot; newly catalogued' : ''}</div>
    <div class="report">${report}</div>
    <div class="divider">Passages from this chamber</div>
    <div class="doors">${doorHtml}</div>
    <div class="stats">chambers in structure: ${graph.size}</div>
  </div>
</div>
</body></html>`;
}

/* ============ known AI-crawler UA patterns (logging + delay targeting) ============ */
const AI_BOT_PATTERNS = [
  /GPTBot/i, /ChatGPT-User/i, /OAI-SearchBot/i,        // OpenAI
  /ClaudeBot/i, /Claude-Web/i, /anthropic-ai/i,        // Anthropic
  /CCBot/i,                                             // Common Crawl (widely used for LLM training sets)
  /Bytespider/i,                                        // ByteDance
  /Google-Extended/i,                                   // Google (training-specific token)
  /PerplexityBot/i, /Perplexity-User/i,                 // Perplexity
  /Amazonbot/i,                                         // Amazon
  /Applebot-Extended/i,                                 // Apple
  /Diffbot/i, /omgili/i, /omgilibot/i,
  /FacebookBot/i, /Meta-ExternalAgent/i,
  /cohere-ai/i, /YouBot/i, /Timpibot/i, /Ai2Bot/i,
  /ImagesiftBot/i, /DataForSeoBot/i, /magpie-crawler/i,
  /SemrushBot/i, /Bytedance/i,
];
function matchedBot(ua){
  const m = AI_BOT_PATTERNS.find(p => p.test(ua || ''));
  return m ? m.source : null;
}

/* ============ server ============ */
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch(e){ res.writeHead(400); res.end('bad request'); return; }

  const ua = req.headers['user-agent'] || '';
  const bot = matchedBot(ua);

  if (url.pathname === '/robots.txt'){
    res.writeHead(200, {'Content-Type':'text/plain'});
    // Deliberately disallowing the maze: compliant crawlers skip it and
    // never get stuck. This selects for the ones that ignore robots.txt.
    res.end('User-agent: *\nDisallow: /room/\n');
    return;
  }

  let id = null;
  if (url.pathname === '/') id = ROOT_ID;
  else {
    const m = url.pathname.match(/^\/room\/([a-z0-9]{5,8})$/i);
    if (m) id = m[1].toLowerCase();
  }

  if (!id){
    res.writeHead(302, {Location: '/'});
    res.end();
    return;
  }

  console.log(`${new Date().toISOString()} ${req.socket.remoteAddress} "${ua}"${bot ? ' [AI-BOT:' + bot + ']' : ''} -> /room/${id}`);

  const respond = () => {
    const html = renderPage(id);
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(html);
  };

  if (bot){
    // burn some of the crawler's time/concurrency budget on every hit
    const delay = DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);
    setTimeout(respond, delay);
  } else {
    respond();
  }
});

server.listen(PORT, () => {
  console.log(`Archive tarpit listening on :${PORT}`);
  console.log(`robots.txt disallows /room/ — compliant crawlers will skip it by design.`);
});
