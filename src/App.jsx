import { useState, useRef, useCallback } from "react";

// ── helpers ────────────────────────────────────────────────────────────────────
const KIE_BASE = "https://api.kie.ai/api/v1";

let _jszip = null;
async function getJSZip() {
  if (_jszip) return _jszip;
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
  _jszip = window.JSZip;
  return _jszip;
}

async function downloadZip(outputs, batchVersion, toast) {
  if (!outputs.length) return;
  toast("Building ZIP…", "info");
  try {
    const JSZip = await getJSZip();
    const zip = new JSZip();
    await Promise.all(
      outputs.map(async (out) => {
        try {
          const res = await fetch(out.url);
          const blob = await res.blob();
          zip.file(`${out.path}/${out.name}`, blob);
        } catch {}
      })
    );
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ads_${todayStr()}_${batchVersion}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    toast("ZIP downloaded! 🎉", "success");
  } catch (e) {
    toast("ZIP failed: " + e.message, "error");
  }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

// Extract all positions of a className in raw HTML
function findClassPositions(html, className) {
  const needle = `class="${className}"`;
  const positions = [];
  let idx = 0;
  while ((idx = html.indexOf(needle, idx)) !== -1) { positions.push(idx); idx++; }
  return positions;
}

// Extract inner text of the next tag after a position, stripping child tags
function extractTagText(html, fromPos) {
  const open = html.indexOf(">", fromPos);
  if (open === -1) return "";
  const close = html.indexOf("<", open);
  if (close === -1) return "";
  return html.slice(open + 1, close).trim();
}

// Extract all text inside a block starting at pos, stripping all HTML tags & buttons
function extractBlockText(html, startPos) {
  // Find the opening > of the div
  const divOpen = html.indexOf(">", startPos);
  if (divOpen === -1) return "";
  // Walk forward counting div depth to find the matching close
  let depth = 1, i = divOpen + 1;
  while (i < html.length && depth > 0) {
    if (html[i] === "<") {
      if (html.slice(i, i + 2) === "</") { depth--; i += 2; }
      else if (html.slice(i, i + 4) === "<!--") { i = html.indexOf("-->", i) + 3; }
      else { depth++; i++; }
    } else { i++; }
  }
  const inner = html.slice(divOpen + 1, i - "</div>".length);
  // Strip all tags and decode common entities
  return inner
    .replace(/<button[\s\S]*?<\/button>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#\d+;/g, "")
    .replace(/\s{2,}/g, " ").trim();
}

// Find first <p> text inside a block at pos
function extractFirstPText(html, blockStart) {
  const divOpen = html.indexOf(">", blockStart);
  if (divOpen === -1) return "";
  const blockEnd = blockStart + 5000; // reasonable limit
  const pStart = html.indexOf("<p>", divOpen);
  if (pStart === -1 || pStart > blockEnd) return "";
  const pEnd = html.indexOf("</p>", pStart);
  if (pEnd === -1) return "";
  return html.slice(pStart + 3, pEnd)
    .replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
}

function parseHTMLPrompts(html) {
  const sections = [];

  // ── FORMAT 1: BunkerAI Batch ──────────────────────────────────────────────
  // .sec divs contain .sec-title; .pb divs are siblings grouped by position
  const secPositions = findClassPositions(html, "sec");
  const pbPositions  = findClassPositions(html, "pb");

  if (secPositions.length > 0 && pbPositions.length > 0) {
    secPositions.forEach((secPos, i) => {
      // Extract section title from .sec-title inside this .sec
      const titleIdx = html.indexOf('class="sec-title"', secPos);
      const title = titleIdx !== -1 ? extractTagText(html, titleIdx) : `Section ${i + 1}`;
      const sectionEnd = secPositions[i + 1] || html.length;
      const prompts = [];
      pbPositions.forEach((pbPos) => {
        if (pbPos > secPos && pbPos < sectionEnd) {
          const txt = extractBlockText(html, pbPos);
          if (txt.length > 30) prompts.push(txt);
        }
      });
      if (prompts.length) sections.push({ title, prompts });
    });
  }

  // ── FORMAT 2: Dandy / ad-card ─────────────────────────────────────────────
  // Each .ad-card is a section; .prompt-box contains a <p> with the prompt
  if (sections.length === 0) {
    const adCardPositions    = findClassPositions(html, "ad-card");
    const promptBoxPositions = findClassPositions(html, "prompt-box");

    if (adCardPositions.length > 0 && promptBoxPositions.length > 0) {
      adCardPositions.forEach((cardPos, i) => {
        const titleIdx = html.indexOf('class="card-title"', cardPos);
        const cardEnd  = adCardPositions[i + 1] || html.length;
        const title    = titleIdx !== -1 && titleIdx < cardEnd
          ? extractTagText(html, titleIdx)
          : `Ad ${i + 1}`;
        const prompts = [];
        promptBoxPositions.forEach((pbPos) => {
          if (pbPos > cardPos && pbPos < cardEnd) {
            const txt = extractFirstPText(html, pbPos);
            if (txt.length > 20) prompts.push(txt);
          }
        });
        if (prompts.length) sections.push({ title, prompts });
      });
    }
  }

  // ── FORMAT 3: Generic <section> / [data-section] ─────────────────────────
  if (sections.length === 0) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const sectionEls = doc.querySelectorAll("section, [data-section], article, .prompt-section");
    sectionEls.forEach((el, i) => {
      const title =
        el.getAttribute("data-section") ||
        el.querySelector("h1,h2,h3,h4")?.textContent?.trim() ||
        `Section ${i + 1}`;
      const prompts = [];
      el.querySelectorAll("p, li, .prompt, [data-prompt]").forEach((p) => {
        const t = p.textContent.trim();
        if (t.length > 20) prompts.push(t);
      });
      if (prompts.length) sections.push({ title, prompts });
    });
  }

  // ── FORMAT 4: h2/h3 heading-delimited ────────────────────────────────────
  if (sections.length === 0) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    doc.querySelectorAll("h2, h3").forEach((h) => {
      const title = h.textContent.trim();
      const prompts = [];
      let next = h.nextElementSibling;
      while (next && !["H2", "H3"].includes(next.tagName)) {
        next.querySelectorAll("p, li").forEach((p) => {
          const t = p.textContent.trim();
          if (t.length > 20) prompts.push(t);
        });
        next = next.nextElementSibling;
      }
      if (prompts.length) sections.push({ title, prompts });
    });
  }

  // ── FORMAT 5: Last resort — all <p> ──────────────────────────────────────
  if (sections.length === 0) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const prompts = [];
    doc.querySelectorAll("p").forEach((p) => {
      const t = p.textContent.trim();
      if (t.length > 20) prompts.push(t);
    });
    if (prompts.length) sections.push({ title: "Prompts", prompts });
  }

  return sections;
}

async function pollTask(taskId, apiKey, onProgress) {
  const url = `${KIE_BASE}/jobs/recordInfo?taskId=${taskId}`;
  let attempts = 0;
  while (attempts < 120) {
    await new Promise((r) => setTimeout(r, 5000));
    let json;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      json = await res.json();
    } catch (e) {
      attempts++;
      continue;
    }

    // Log every raw response so we can debug in browser console
    console.log("[StaticGod] poll attempt", attempts, JSON.stringify(json));

    const data = json?.data;
    if (!data) { attempts++; continue; }

    // Update progress (can be "0.50" string or 0.5 float or 50 int)
    const rawProg = parseFloat(data.progress ?? 0);
    onProgress(rawProg > 1 ? rawProg / 100 : rawProg);

    // Check for failure
    const sf = data.successFlag;
    if (sf === 2) throw new Error(data.errorMessage || "Generation failed");

    // Check for success — successFlag === 1
    if (sf === 1) {
      const resp = data.response;
      console.log("[StaticGod] SUCCESS response:", JSON.stringify(resp));
      if (!resp) { attempts++; continue; } // response not populated yet, keep polling
      // Handle all possible URL field shapes from different Kie.ai models
      const urls = [
        ...(Array.isArray(resp.result_urls) ? resp.result_urls : []),
        ...(Array.isArray(resp.results) ? resp.results : []),
        ...(Array.isArray(resp.image_urls) ? resp.image_urls : []),
        ...(Array.isArray(resp.imageUrls) ? resp.imageUrls : []),
        ...(resp.resultImageUrl ? [resp.resultImageUrl] : []),
        ...(resp.imageUrl ? [resp.imageUrl] : []),
        ...(typeof resp === "string" ? [resp] : []),
      ].filter(Boolean);
      console.log("[StaticGod] extracted URLs:", urls);
      if (urls.length > 0) return urls;
      // No URLs yet despite successFlag=1, keep trying a few more times
    }
    attempts++;
  }
  throw new Error("Timed out — check kie.ai dashboard for task status");
}

class VirtualFolder {
  constructor() { this.tree = {}; }
  add(path, name, url) {
    if (!this.tree[path]) this.tree[path] = [];
    this.tree[path].push({ name, url });
  }
  toList() { return Object.entries(this.tree).map(([path, files]) => ({ path, files })); }
}

// ── styles ─────────────────────────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700;800;900&family=Barlow+Condensed:wght@600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  html, body, #root { height: 100%; background: #0a0a0f; }

  :root {
    --bg: #0a0a0f;
    --surface: #111118;
    --card: #16161e;
    --card2: #1c1c26;
    --border: #252530;
    --border2: #2e2e3d;
    --accent: #ff6a00;
    --accent2: #ee0979;
    --text: #eeeef5;
    --muted: #5a5a78;
    --muted2: #8888a8;
    --green: #3ecf6e;
    --red: #f05050;
    --radius: 10px;
    --header-h: 64px;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Barlow', sans-serif;
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
    /* flash fix */
    visibility: hidden;
  }
  body.ready { visibility: visible; }

  .app {
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── HEADER ── */
  .header {
    height: var(--header-h);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 28px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    z-index: 10;
  }
  .logo-wrap { display: flex; align-items: center; gap: 10px; }
  .logo-icon {
    width: 36px; height: 36px; border-radius: 9px;
    background: linear-gradient(135deg, #ff6a00, #ee0979);
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; flex-shrink: 0;
    box-shadow: 0 0 16px rgba(255,106,0,.3);
  }
  .logo-text {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 28px;
    font-weight: 800;
    letter-spacing: 1px;
    line-height: 1;
    background: linear-gradient(90deg, #ff8c00, #ff2d78);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .logo-sub {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: var(--muted);
    margin-top: 2px;
    letter-spacing: .5px;
  }
  .header-right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  .status-badge {
    display: flex; align-items: center; gap: 7px;
    padding: 5px 12px; border-radius: 20px;
    border: 1px solid var(--border2);
    font-size: 11px; color: var(--muted2);
    font-family: 'JetBrains Mono', monospace;
    background: var(--card);
  }
  .status-badge.ok { border-color: rgba(62,207,110,.3); color: var(--green); background: rgba(62,207,110,.06); }
  .hamburger {
    display: none; width: 36px; height: 36px; border-radius: 8px;
    border: 1px solid var(--border2); background: var(--card);
    color: var(--text); font-size: 16px; cursor: pointer;
    align-items: center; justify-content: center; flex-shrink: 0;
    transition: border-color .15s;
  }
  .hamburger:hover { border-color: var(--accent); color: var(--accent); }

  /* ── LAYOUT ── */
  .body-layout {
    flex: 1;
    display: grid;
    grid-template-columns: 290px 1fr;
    overflow: hidden;
    min-height: 0;
  }

  /* ── SIDEBAR ── */
  .sidebar {
    border-right: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
  }
  .sidebar-scroll {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 22px;
    scrollbar-width: thin;
    scrollbar-color: var(--border2) transparent;
  }
  .sidebar-scroll::-webkit-scrollbar { width: 4px; }
  .sidebar-scroll::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 4px; }
  .sidebar-footer {
    flex-shrink: 0;
    padding: 14px 20px;
    border-top: 1px solid var(--border);
    background: var(--surface);
  }

  /* ── SECTION LABEL ── */
  .section-label {
    font-size: 10px; font-weight: 700; letter-spacing: 1.5px;
    color: var(--muted); text-transform: uppercase;
    margin-bottom: 10px;
    display: flex; align-items: center; gap: 8px;
  }
  .section-label::after { content: ''; flex: 1; height: 1px; background: var(--border); }

  /* ── FORM ── */
  .field { display: flex; flex-direction: column; gap: 5px; }
  .field label { font-size: 11px; font-weight: 600; color: var(--muted2); letter-spacing: .3px; }
  input[type="text"], input[type="password"], select {
    background: var(--card); border: 1px solid var(--border2); border-radius: 8px;
    color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 12px;
    padding: 9px 12px; width: 100%; outline: none;
    transition: border-color .15s, box-shadow .15s;
    -webkit-appearance: none;
  }
  input:focus, select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(255,106,0,.1);
  }
  select option { background: #1c1c26; }

  /* ── UPLOAD ZONE ── */
  .upload-zone {
    border: 1.5px dashed var(--border2); border-radius: var(--radius);
    padding: 16px; text-align: center; cursor: pointer;
    transition: all .18s; position: relative; background: var(--card);
  }
  .upload-zone:hover { border-color: var(--accent); background: rgba(255,106,0,.04); }
  .upload-zone input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
  .upload-zone .uz-icon { font-size: 22px; margin-bottom: 6px; }
  .upload-zone p { font-size: 11px; color: var(--muted2); line-height: 1.5; }
  .upload-zone strong { color: var(--text); }
  .file-chip {
    display: inline-flex; align-items: center; gap: 5px;
    background: rgba(255,106,0,.1); border: 1px solid rgba(255,106,0,.22);
    border-radius: 6px; padding: 3px 9px; font-size: 11px; color: #ff8c40;
    margin-top: 6px; font-family: 'JetBrains Mono', monospace;
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ref-preview { margin-top: 8px; border-radius: 8px; overflow: hidden; border: 1px solid var(--border2); }
  .ref-preview img { width: 100%; max-height: 110px; object-fit: cover; display: block; }

  /* ── SETTINGS GRID ── */
  .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .span2 { grid-column: span 2; }

  /* ── FOLDER PREVIEW ── */
  .folder-preview { display: flex; flex-direction: column; gap: 3px; }
  .folder-row {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 10px; border-radius: 7px;
    background: var(--card); border: 1px solid var(--border);
  }
  .folder-row .fi { font-size: 13px; flex-shrink: 0; }
  .folder-row .fname { font-size: 12px; font-weight: 600; color: var(--text); font-family: 'JetBrains Mono', monospace; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .folder-row .fmeta { font-size: 10px; color: var(--muted); margin-left: auto; flex-shrink: 0; font-family: 'JetBrains Mono', monospace; }

  /* ── BUTTONS ── */
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 7px;
    padding: 11px 18px; border-radius: 9px;
    font-family: 'Barlow', sans-serif; font-size: 13px; font-weight: 700;
    cursor: pointer; border: none; transition: all .18s; letter-spacing: .2px;
  }
  .btn-primary {
    background: linear-gradient(135deg, #ff6a00, #ee0979);
    color: #fff; width: 100%; font-size: 14px; padding: 13px;
    box-shadow: 0 4px 20px rgba(255,106,0,.22);
  }
  .btn-primary:hover:not(:disabled) { opacity: .9; transform: translateY(-1px); box-shadow: 0 8px 28px rgba(255,106,0,.35); }
  .btn-primary:disabled { opacity: .3; cursor: not-allowed; transform: none; box-shadow: none; }
  .btn-ghost {
    background: var(--card2); border: 1px solid var(--border2);
    color: var(--muted2); font-size: 12px; padding: 8px 14px;
  }
  .btn-ghost:hover { border-color: var(--accent); color: var(--accent); background: rgba(255,106,0,.06); }

  /* ── MAIN PANEL ── */
  .main { display: flex; flex-direction: column; overflow: hidden; min-height: 0; background: var(--bg); }

  /* ── BATCH BAR ── */
  .batch-bar {
    flex-shrink: 0; display: flex; gap: 0;
    border-bottom: 1px solid var(--border); background: var(--surface);
    overflow-x: auto; scrollbar-width: none;
  }
  .batch-bar::-webkit-scrollbar { display: none; }
  .batch-stat {
    display: flex; flex-direction: column; gap: 1px;
    padding: 10px 20px; border-right: 1px solid var(--border); flex-shrink: 0;
  }
  .batch-stat span { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; font-weight: 700; }
  .batch-stat strong { font-size: 14px; font-weight: 700; font-family: 'JetBrains Mono', monospace; }

  /* ── PROGRESS ── */
  .progress-bar { height: 3px; background: var(--border); flex-shrink: 0; }
  .progress-fill { height: 100%; background: linear-gradient(90deg, #ff6a00, #ee0979); transition: width .5s ease; }

  /* ── TABS ── */
  .tabs {
    flex-shrink: 0; display: flex; gap: 0;
    border-bottom: 1px solid var(--border); background: var(--surface);
    padding: 0 20px;
  }
  .tab {
    padding: 13px 18px; font-size: 13px; font-weight: 600; cursor: pointer;
    color: var(--muted2); border: none; background: none;
    border-bottom: 2px solid transparent; margin-bottom: -1px;
    transition: all .15s; white-space: nowrap;
    font-family: 'Barlow', sans-serif; letter-spacing: .2px;
  }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); }

  /* ── TAB CONTENT ── */
  .tab-content {
    flex: 1; overflow-y: auto; overflow-x: hidden;
    padding: 22px 26px; display: flex; flex-direction: column; gap: 14px;
    scrollbar-width: thin; scrollbar-color: var(--border2) transparent;
    min-height: 0;
  }
  .tab-content::-webkit-scrollbar { width: 5px; }
  .tab-content::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 4px; }

  /* ── SECTION CARDS ── */
  .section-card {
    background: var(--card); border: 1px solid var(--border2);
    border-radius: var(--radius); overflow: hidden;
  }
  .section-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 13px 16px; border-bottom: 1px solid var(--border);
    cursor: pointer; user-select: none; transition: background .15s;
  }
  .section-header:hover { background: var(--card2); }
  .section-header h3 { font-size: 13px; font-weight: 700; letter-spacing: .2px; }
  .section-tag {
    font-size: 10px; padding: 2px 8px; border-radius: 10px;
    background: rgba(255,106,0,.1); color: #ff8c40;
    font-family: 'JetBrains Mono', monospace; font-weight: 600; margin-right: 8px;
  }
  .chevron { color: var(--muted); font-size: 10px; transition: transform .2s; }
  .chevron.open { transform: rotate(180deg); }

  .prompt-list { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
  .prompt-item {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 9px 10px; border-radius: 7px;
    background: var(--surface); border: 1px solid var(--border);
    font-size: 11px; line-height: 1.5; color: var(--muted2);
    font-family: 'JetBrains Mono', monospace;
    position: relative; transition: border-color .2s;
    cursor: pointer;
  }
  .prompt-item:hover { background: var(--card2); }
  .prompt-item.running { border-color: rgba(255,106,0,.45); background: rgba(255,106,0,.04); }
  .prompt-item.done { border-color: rgba(62,207,110,.4); background: rgba(62,207,110,.03); }
  .prompt-item.error { border-color: rgba(240,80,80,.4); }
  .prompt-num {
    flex-shrink: 0; width: 20px; height: 20px; border-radius: 5px;
    background: var(--card2); display: flex; align-items: center; justify-content: center;
    font-size: 9px; font-weight: 700; color: var(--muted); margin-top: 1px;
  }
  .prompt-text {
    flex: 1; padding-right: 44px; min-width: 0;
    display: -webkit-box; -webkit-box-orient: vertical;
    overflow: hidden; word-break: break-word;
  }
  .prompt-text.collapsed { -webkit-line-clamp: 2; }
  .prompt-text.expanded { -webkit-line-clamp: unset; }
  .prompt-status {
    position: absolute; right: 9px; top: 9px;
    font-size: 10px; display: flex; align-items: center; gap: 4px;
  }

  /* ── OUTPUT GRID ── */
  .dl-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .dl-hint { font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
  .output-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(185px, 1fr)); gap: 12px; }
  .output-card {
    background: var(--card); border: 1px solid var(--border2);
    border-radius: var(--radius); overflow: hidden;
    transition: border-color .18s, transform .18s, box-shadow .18s;
  }
  .output-card:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,.3); }
  .output-img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; background: var(--surface); }
  .output-img-placeholder {
    width: 100%; aspect-ratio: 1; background: var(--surface);
    display: flex; align-items: center; justify-content: center;
    font-size: 24px; color: var(--muted);
  }
  .output-meta { padding: 10px 11px; }
  .output-meta strong {
    display: block; font-size: 11px; font-weight: 700; color: var(--text);
    margin-bottom: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .output-meta p {
    font-size: 10px; color: var(--muted); font-family: 'JetBrains Mono', monospace;
    line-height: 1.4; display: -webkit-box;
    -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .path-tag {
    display: block; font-size: 9px; color: var(--muted);
    font-family: 'JetBrains Mono', monospace;
    background: var(--surface); border-radius: 4px; padding: 2px 5px; margin-top: 5px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* ── EMPTY STATE ── */
  .empty {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 60px 20px; color: var(--muted); text-align: center;
    flex: 1; min-height: 260px;
  }
  .empty-icon { font-size: 40px; margin-bottom: 14px; opacity: .55; }
  .empty h3 { font-size: 15px; font-weight: 700; color: var(--muted2); margin-bottom: 6px; }
  .empty p { font-size: 12px; line-height: 1.7; max-width: 280px; }

  /* ── TOAST ── */
  .toast-wrap {
    position: fixed; bottom: 20px; right: 20px; z-index: 999;
    display: flex; flex-direction: column; gap: 8px; pointer-events: none;
  }
  .toast {
    padding: 11px 16px; border-radius: 9px; font-size: 12px; font-weight: 600;
    box-shadow: 0 6px 24px rgba(0,0,0,.5); animation: toastIn .2s ease;
    max-width: 280px; pointer-events: all;
  }
  .toast-success { background: rgba(62,207,110,.1); border: 1px solid rgba(62,207,110,.28); color: var(--green); }
  .toast-error { background: rgba(240,80,80,.1); border: 1px solid rgba(240,80,80,.28); color: var(--red); }
  .toast-info { background: rgba(255,106,0,.1); border: 1px solid rgba(255,106,0,.28); color: #ff8c40; }
  @keyframes toastIn { from { transform: translateX(28px); opacity: 0; } to { transform: none; opacity: 1; } }

  /* ── SPINNER ── */
  .spin {
    display: inline-block; width: 13px; height: 13px;
    border: 2px solid rgba(255,255,255,.18); border-top-color: #fff;
    border-radius: 50%; animation: spin .5s linear infinite; flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── OVERLAY ── */
  .sidebar-overlay {
    display: none; position: fixed; inset: 0;
    background: rgba(0,0,0,.6); z-index: 198; backdrop-filter: blur(2px);
  }

  /* ══ MOBILE ══ */
  @media (max-width: 800px) {
    :root { --header-h: 56px; }
    body { overflow: hidden; }
    .header { padding: 0 16px; gap: 10px; }
    .logo-text { font-size: 24px; }
    .logo-sub { display: none; }
    .hamburger { display: flex; }
    .status-badge { display: none; }
    .body-layout { grid-template-columns: 1fr; }
    .sidebar {
      position: fixed; top: 0; left: 0;
      width: min(88vw, 320px); height: 100dvh;
      z-index: 199; transform: translateX(-110%);
      transition: transform .26s cubic-bezier(.4,0,.2,1);
    }
    .sidebar.open { transform: translateX(0); box-shadow: 12px 0 48px rgba(0,0,0,.65); }
    .sidebar-overlay.open { display: block; }
    .sidebar-scroll { padding: 16px; padding-top: calc(var(--header-h) + 12px); padding-bottom: 8px; }
    .sidebar-footer { padding: 12px 16px; padding-bottom: max(16px, env(safe-area-inset-bottom)); }
    .main { height: calc(100vh - var(--header-h)); }
    .batch-stat { padding: 8px 14px; }
    .tabs { padding: 0 12px; overflow-x: auto; scrollbar-width: none; }
    .tabs::-webkit-scrollbar { display: none; }
    .tab { padding: 11px 14px; font-size: 12px; }
    .tab-content { padding: 14px 16px; gap: 10px; }
    .output-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 9px; }
    .dl-row { flex-direction: column; align-items: flex-start; gap: 6px; }
    .toast-wrap { bottom: 14px; right: 12px; left: 12px; }
    .toast { max-width: 100%; }
    input[type="text"], input[type="password"], select { font-size: 16px; }
  }
  @media (max-width: 380px) {
    .output-grid { grid-template-columns: 1fr 1fr; }
  }
`;

// ── app ────────────────────────────────────────────────────────────────────────
export default function App() {
  // Flash fix — show page only after fonts are ready
  if (typeof document !== "undefined") {
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => document.body.classList.add("ready"));
    } else {
      setTimeout(() => document.body.classList.add("ready"), 250);
    }
  }

  const [apiKey, setApiKey] = useState("");
  const [htmlFile, setHtmlFile] = useState(null);
  const [refImage, setRefImage] = useState(null);
  const [refImageUrl, setRefImageUrl] = useState("");
  const [sections, setSections] = useState([]);
  const [expandedSections, setExpandedSections] = useState({});
  const [expandedPrompts, setExpandedPrompts] = useState({});
  const [batchVersion, setBatchVersion] = useState("v1");
  const [settings, setSettings] = useState({
    model: "nano-banana-pro",
    aspect_ratio: "1:1",
    resolution: "1K",
    output_format: "png", // valid values: png, jpg, webp
    concurrency: 2,
  });
  const [running, setRunning] = useState(false);
  const [promptStates, setPromptStates] = useState({});
  const [outputs, setOutputs] = useState([]);
  const [tab, setTab] = useState("prompts");
  const [toasts, setToasts] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [vfs] = useState(() => new VirtualFolder());
  const htmlInputRef = useRef();
  const refInputRef = useRef();

  const toast = useCallback((msg, type = "info") => {
    const id = Date.now();
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  const handleHtmlFile = (file) => {
    if (!file) return;
    setHtmlFile(file);
    const reader = new FileReader();
    reader.onload = (e) => {
      const parsed = parseHTMLPrompts(e.target.result);
      setSections(parsed);
      setExpandedSections(Object.fromEntries(parsed.map((_, i) => [i, true])));
      toast(`${parsed.reduce((a, s) => a + s.prompts.length, 0)} prompts · ${parsed.length} sections`, "success");
    };
    reader.readAsText(file);
  };

  const uploadRefImage = async () => {
    if (!refImage || !apiKey) return null;
    try {
      // Convert image to base64 for upload (avoids CORS issues)
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(refImage);
      });
      const res = await fetch("https://kieai.redpandaai.co/api/base64-upload", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          base64Data: base64,
          fileName: refImage.name,
          mimeType: refImage.type,
          uploadPath: "images/user-uploads",
        }),
      });
      const json = await res.json();
      const url = json.data?.fileUrl || json.data?.downloadUrl || json.data?.url || null;
      if (url) { setRefImageUrl(url); toast("Reference image uploaded ✓", "success"); return url; }
      // Fallback: try stream upload
      const fd = new FormData();
      fd.append("file", refImage);
      fd.append("uploadPath", "images/user-uploads");
      const res2 = await fetch("https://kieai.redpandaai.co/api/file-stream-upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: fd,
      });
      const json2 = await res2.json();
      const url2 = json2.data?.fileUrl || json2.data?.downloadUrl || json2.data?.url || null;
      if (url2) { setRefImageUrl(url2); toast("Reference image uploaded ✓", "success"); return url2; }
      toast("Image upload failed — ref image will be skipped", "error");
    } catch (e) {
      toast("Image upload error: " + e.message + " — ref image skipped", "error");
    }
    return null;
  };

  const setPS = (si, pi, update) =>
    setPromptStates((prev) => {
      const k = `${si}-${pi}`;
      return { ...prev, [k]: { ...(prev[k] || {}), ...update } };
    });

  const generateOne = async (si, pi, prompt, refUrl) => {
    setPS(si, pi, { status: "running", progress: 0 });
    const sec = sections[si];
    const folderPath = `${todayStr()}/${batchVersion}/${sec.title.replace(/\s+/g, "_")}`;
    // Nano Banana only accepts "png" or "jpg" (not "jpeg")
    const normalizeFormat = (fmt) => fmt === "jpeg" ? "jpg" : fmt;
    const input = {
      prompt,
      aspect_ratio: settings.aspect_ratio,
      resolution: settings.resolution,
      output_format: normalizeFormat(settings.output_format),
    };
    const body = { model: settings.model, input };
    if (refUrl) { body.input.image_input = [refUrl]; body.input.image_urls = [refUrl]; }
    const cr = await fetch(`${KIE_BASE}/jobs/createTask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const cj = await cr.json();
    if (cj.code !== 200) throw new Error(cj.msg || "Task creation failed");
    const urls = await pollTask(cj.data.taskId, apiKey, (p) => setPS(si, pi, { progress: parseFloat(p) }));
    const imageUrl = urls[0];
    if (!imageUrl) throw new Error("Task completed but no image URL returned");
    const ext = settings.output_format === "jpeg" ? "jpg" : settings.output_format;
    const fileName = `${sec.title.replace(/\s+/g, "_")}_p${pi + 1}.${ext}`;
    vfs.add(folderPath, fileName, imageUrl);
    setOutputs((prev) => [...prev, { path: folderPath, name: fileName, url: imageUrl, section: sec.title, prompt }]);
    setPS(si, pi, { status: "done", progress: 1, url: imageUrl });
  };

  const runGeneration = async () => {
    if (!apiKey) { toast("Enter your Kie.ai API key", "error"); return; }
    if (!sections.length) { toast("Upload an HTML prompt file first", "error"); return; }
    setRunning(true); setOutputs([]); setPromptStates({}); setTab("prompts");
    setSidebarOpen(false);
    let refUrl = refImageUrl;
    if (refImage && !refUrl) { toast("Uploading reference image…", "info"); refUrl = await uploadRefImage(); }
    const queue = [];
    sections.forEach((sec, si) => sec.prompts.forEach((p, pi) => queue.push({ si, pi, prompt: p })));
    const concurrency = parseInt(settings.concurrency) || 2;
    let qi = 0;
    const worker = async () => {
      while (qi < queue.length) {
        const item = queue[qi++];
        try { await generateOne(item.si, item.pi, item.prompt, refUrl); }
        catch (e) {
          setPS(item.si, item.pi, { status: "error" });
          toast(`Prompt ${item.pi + 1} failed: ${e.message}`, "error");
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    toast("All generations complete! 🎉", "success");
    setTab("outputs");
    setRunning(false);
  };

  const totalPrompts = sections.reduce((a, s) => a + s.prompts.length, 0);
  const doneCount = Object.values(promptStates).filter((s) => s.status === "done").length;
  const errorCount = Object.values(promptStates).filter((s) => s.status === "error").length;
  const downloadAll = () => downloadZip(outputs, batchVersion, toast);

  return (
    <>
      <style>{css}</style>
      <div className="app">

        {/* HEADER */}
        <header className="header">
          <div className="logo-wrap">
            <div className="logo-icon">⚡</div>
            <div>
              <div className="logo-text">StaticGod</div>
              <div className="logo-sub">Ad Generation Studio</div>
            </div>
          </div>
          <div className="header-right">
            {running && (
              <div className="status-badge">
                <span className="spin" />
                {doneCount}/{totalPrompts} generating
              </div>
            )}
            {!running && doneCount > 0 && (
              <div className="status-badge ok">✓ {doneCount} done{errorCount > 0 ? ` · ${errorCount} errors` : ""}</div>
            )}
            <button className="hamburger" onClick={() => setSidebarOpen((o) => !o)}>☰</button>
          </div>
        </header>

        <div className="body-layout">
          <div className={`sidebar-overlay ${sidebarOpen ? "open" : ""}`} onClick={() => setSidebarOpen(false)} />

          {/* SIDEBAR */}
          <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
            <div className="sidebar-scroll">

              <div>
                <div className="section-label">Authentication</div>
                <div className="field">
                  <label>Kie.ai API Key</label>
                  <input type="password" placeholder="sk-kie-…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                </div>
              </div>

              <div>
                <div className="section-label">Prompt Template</div>
                <div className="upload-zone" onClick={() => htmlInputRef.current?.click()}>
                  <input ref={htmlInputRef} type="file" accept=".html,.htm" style={{ display: "none" }} onChange={(e) => handleHtmlFile(e.target.files[0])} />
                  <div className="uz-icon">📄</div>
                  {htmlFile ? (
                    <><p><strong>{htmlFile.name}</strong></p><div className="file-chip">✓ {totalPrompts} prompts · {sections.length} sections</div></>
                  ) : (
                    <p>Drop your <strong>.html</strong> prompt file<br />or click to browse</p>
                  )}
                </div>
              </div>

              <div>
                <div className="section-label">Reference Image</div>
                <div className="upload-zone" onClick={() => refInputRef.current?.click()}>
                  <input ref={refInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { if (e.target.files[0]) setRefImage(e.target.files[0]); }} />
                  <div className="uz-icon">🖼</div>
                  {refImage
                    ? <p><strong>{refImage.name}</strong></p>
                    : <p>Optional — upload a reference<br />image for consistency</p>
                  }
                </div>
                {refImage && (
                  <div className="ref-preview">
                    <img src={URL.createObjectURL(refImage)} alt="ref" />
                  </div>
                )}
              </div>

              <div>
                <div className="section-label">Batch</div>
                <div className="field">
                  <label>Version Tag</label>
                  <input type="text" value={batchVersion} onChange={(e) => setBatchVersion(e.target.value)} placeholder="v1" />
                </div>
              </div>

              <div>
                <div className="section-label">Generation Settings</div>
                <div className="settings-grid">
                  <div className="field span2">
                    <label>Model</label>
                    <select value={settings.model} onChange={(e) => setSettings({ ...settings, model: e.target.value })}>
                      <option value="nano-banana-pro">Nano Banana Pro</option>
                      <option value="nano-banana-2">Nano Banana 2</option>
                      <option value="google/nano-banana-edit">Nano Banana Edit</option>
                      <option value="flux-kontext-pro">Flux Kontext Pro</option>
                      <option value="gpt-image/1.5-text-to-image">GPT Image 1.5</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Aspect Ratio</label>
                    <select value={settings.aspect_ratio} onChange={(e) => setSettings({ ...settings, aspect_ratio: e.target.value })}>
                      {["1:1","16:9","9:16","4:5","5:4","3:2","2:3","4:3","3:4"].map(r => <option key={r}>{r}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>Resolution</label>
                    <select value={settings.resolution} onChange={(e) => setSettings({ ...settings, resolution: e.target.value })}>
                      <option>1K</option><option>2K</option><option>4K</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Format</label>
                    <select value={settings.output_format} onChange={(e) => setSettings({ ...settings, output_format: e.target.value })}>
                      <option value="png">PNG</option>
                      <option value="jpg">JPG</option>
                      <option value="webp">WebP</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Concurrency</label>
                    <select value={settings.concurrency} onChange={(e) => setSettings({ ...settings, concurrency: e.target.value })}>
                      {[1,2,3,4,5].map(n => <option key={n}>{n}</option>)}
                    </select>
                  </div>
                </div>
              </div>

              {sections.length > 0 && (
                <div>
                  <div className="section-label">Output Folders</div>
                  <div className="folder-preview">
                    <div className="folder-row"><span className="fi">📁</span><span className="fname">{todayStr()}</span><span className="fmeta">date</span></div>
                    <div className="folder-row" style={{ marginLeft: 12 }}><span className="fi">📁</span><span className="fname">{batchVersion || "v1"}</span><span className="fmeta">batch</span></div>
                    {sections.map((s, i) => (
                      <div key={i} className="folder-row" style={{ marginLeft: 24 }}>
                        <span className="fi">📂</span>
                        <span className="fname">{s.title.slice(0, 18).replace(/\s+/g, "_")}</span>
                        <span className="fmeta">{s.prompts.length} imgs</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="sidebar-footer">
              <button className="btn btn-primary" onClick={runGeneration} disabled={running || !sections.length || !apiKey}>
                {running ? <><span className="spin" /> Generating {doneCount}/{totalPrompts}…</> : <>⚡ Generate {totalPrompts || 0} Ads</>}
              </button>
            </div>
          </aside>

          {/* MAIN */}
          <main className="main">
            {(running || doneCount > 0) && (
              <div className="batch-bar">
                <div className="batch-stat"><span>Date</span><strong>{todayStr()}</strong></div>
                <div className="batch-stat"><span>Batch</span><strong>{batchVersion}</strong></div>
                <div className="batch-stat"><span>Total</span><strong>{totalPrompts}</strong></div>
                <div className="batch-stat"><span>Done</span><strong style={{ color: "var(--green)" }}>{doneCount}</strong></div>
                {errorCount > 0 && <div className="batch-stat"><span>Errors</span><strong style={{ color: "var(--red)" }}>{errorCount}</strong></div>}
                <div className="batch-stat"><span>Progress</span><strong>{totalPrompts ? Math.round((doneCount / totalPrompts) * 100) : 0}%</strong></div>
              </div>
            )}

            {running && (
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${totalPrompts ? (doneCount / totalPrompts) * 100 : 0}%` }} />
              </div>
            )}

            <div className="tabs">
              <button className={`tab ${tab === "prompts" ? "active" : ""}`} onClick={() => setTab("prompts")}>
                Prompts{sections.length > 0 ? ` (${totalPrompts})` : ""}
              </button>
              <button className={`tab ${tab === "outputs" ? "active" : ""}`} onClick={() => setTab("outputs")}>
                Outputs{outputs.length > 0 ? ` (${outputs.length})` : ""}
              </button>
              <button className={`tab ${tab === "folders" ? "active" : ""}`} onClick={() => setTab("folders")}>
                Folders
              </button>
            </div>

            {tab === "prompts" && (
              <div className="tab-content">
                {sections.length === 0 ? (
                  <div className="empty">
                    <div className="empty-icon">📄</div>
                    <h3>No prompts loaded</h3>
                    <p>Upload an HTML template from the sidebar. Each section becomes a folder, each prompt generates one ad.</p>
                  </div>
                ) : sections.map((sec, si) => (
                  <div key={si} className="section-card">
                    <div className="section-header" onClick={() => setExpandedSections((e) => ({ ...e, [si]: !e[si] }))}>
                      <h3>{sec.title}</h3>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span className="section-tag">{sec.prompts.length} prompts</span>
                        <span className={`chevron ${expandedSections[si] !== false ? "open" : ""}`}>▼</span>
                      </div>
                    </div>
                    {expandedSections[si] !== false && (
                      <div className="prompt-list">
                        {sec.prompts.map((p, pi) => {
                          const state = promptStates[`${si}-${pi}`] || {};
                          return (
                            <div key={pi} className={`prompt-item ${state.status || ""}`} onClick={() => setExpandedPrompts(e => ({ ...e, [`${si}-${pi}`]: !e[`${si}-${pi}`] }))}>
                              <div className="prompt-num">{pi + 1}</div>
                              <span
                                className="prompt-text"
                                style={{
                                  display: "-webkit-box",
                                  WebkitBoxOrient: "vertical",
                                  WebkitLineClamp: expandedPrompts[`${si}-${pi}`] ? "unset" : 2,
                                  overflow: "hidden",
                                  wordBreak: "break-word",
                                  flex: 1,
                                  paddingRight: 44,
                                  minWidth: 0,
                                }}
                              >{p}</span>
                              <span className="prompt-status">
                                {state.status === "running" && <><span className="spin" style={{ borderTopColor: "#ff8c40" }} />{Math.round((state.progress || 0) * 100)}%</>}
                                {state.status === "done" && <span style={{ color: "var(--green)" }}>✓</span>}
                                {state.status === "error" && <span style={{ color: "var(--red)" }}>✗</span>}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {tab === "outputs" && (
              <div className="tab-content">
                {outputs.length === 0 ? (
                  <div className="empty">
                    <div className="empty-icon">🖼</div>
                    <h3>No outputs yet</h3>
                    <p>Generated images will appear here as they complete.</p>
                  </div>
                ) : (
                  <>
                    <div className="dl-row">
                      <button className="btn btn-ghost" onClick={downloadAll}>⬇ Download ZIP ({outputs.length} images)</button>
                      <span className="dl-hint">ads_{todayStr()}_{batchVersion}.zip</span>
                    </div>
                    <div className="output-grid">
                      {outputs.map((out, i) => (
                        <div key={i} className="output-card">
                          {out.url
                            ? <a href={out.url} target="_blank" rel="noreferrer"><img className="output-img" src={out.url} alt={out.name} loading="lazy" /></a>
                            : <div className="output-img-placeholder">⏳</div>
                          }
                          <div className="output-meta">
                            <strong>{out.section}</strong>
                            <p>{out.prompt.slice(0, 80)}{out.prompt.length > 80 ? "…" : ""}</p>
                            <div className="path-tag">{out.path}/{out.name}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {tab === "folders" && (
              <div className="tab-content">
                {vfs.toList().length === 0 ? (
                  <div className="empty">
                    <div className="empty-icon">📁</div>
                    <h3>No folders yet</h3>
                    <p>Your organized folder structure will appear here after generation completes.</p>
                  </div>
                ) : vfs.toList().map((folder, fi) => (
                  <div key={fi} className="section-card">
                    <div className="section-header">
                      <h3>📁 {folder.path}</h3>
                      <span className="section-tag">{folder.files.length} files</span>
                    </div>
                    <div className="output-grid" style={{ padding: 12 }}>
                      {folder.files.map((f, fj) => (
                        <div key={fj} className="output-card">
                          <a href={f.url} target="_blank" rel="noreferrer">
                            <img className="output-img" src={f.url} alt={f.name} loading="lazy" />
                          </a>
                          <div className="output-meta"><strong>{f.name}</strong></div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </main>
        </div>
      </div>

      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`}>{t.msg}</div>
        ))}
      </div>
    </>
  );
}
