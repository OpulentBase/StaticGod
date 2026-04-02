import { useState, useRef, useCallback, useEffect } from "react";

// ── helpers ────────────────────────────────────────────────────────────────────
const KIE_BASE = "https://api.kie.ai/api/v1";

// load JSZip from CDN lazily
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
        } catch {
          // skip failed fetches
        }
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

function parseHTMLPrompts(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const sections = [];
  // Look for <section>, <div data-section>, <h2>/<h3> delimited blocks
  const sectionEls = doc.querySelectorAll(
    "section, [data-section], article, .prompt-section"
  );
  if (sectionEls.length > 0) {
    sectionEls.forEach((el, i) => {
      const title =
        el.getAttribute("data-section") ||
        el.querySelector("h1,h2,h3,h4")?.textContent?.trim() ||
        `Section ${i + 1}`;
      const prompts = [];
      el.querySelectorAll("p, li, .prompt, [data-prompt]").forEach((p) => {
        const txt = p.textContent.trim();
        if (txt.length > 10) prompts.push(txt);
      });
      if (prompts.length) sections.push({ title, prompts });
    });
  }
  // Fallback: h2/h3 divide sections
  if (sections.length === 0) {
    const headings = doc.querySelectorAll("h2, h3");
    if (headings.length > 0) {
      headings.forEach((h, i) => {
        const title = h.textContent.trim();
        const prompts = [];
        let next = h.nextElementSibling;
        while (next && !["H2", "H3"].includes(next.tagName)) {
          next.querySelectorAll("p, li").forEach((p) => {
            const t = p.textContent.trim();
            if (t.length > 10) prompts.push(t);
          });
          if (prompts.length === 0 && next.textContent.trim().length > 10)
            prompts.push(next.textContent.trim());
          next = next.nextElementSibling;
        }
        if (prompts.length) sections.push({ title, prompts });
      });
    }
  }
  // Last fallback: just grab all <p> and <li>
  if (sections.length === 0) {
    const prompts = [];
    doc.querySelectorAll("p, li").forEach((p) => {
      const t = p.textContent.trim();
      if (t.length > 10) prompts.push(t);
    });
    if (prompts.length) sections.push({ title: "Prompts", prompts });
  }
  return sections;
}

async function pollTask(taskId, apiKey, onProgress) {
  const url = `${KIE_BASE}/jobs/detail?taskId=${taskId}`;
  let attempts = 0;
  while (attempts < 120) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const json = await res.json();
    const data = json.data;
    if (!data) throw new Error("No task data returned");
    onProgress(data.progress ?? 0);
    if (data.successFlag === 1) {
      const urls = data.response?.result_urls || data.response?.results || [];
      return urls;
    }
    if (data.successFlag === 2) {
      throw new Error(data.errorMessage || "Generation failed");
    }
    attempts++;
  }
  throw new Error("Timed out waiting for generation");
}

// ── virtual FS ─────────────────────────────────────────────────────────────────
class VirtualFolder {
  constructor() {
    this.tree = {}; // path -> [{name, url, blob}]
  }
  add(path, name, url) {
    if (!this.tree[path]) this.tree[path] = [];
    this.tree[path].push({ name, url });
  }
  toList() {
    return Object.entries(this.tree).map(([path, files]) => ({ path, files }));
  }
}

// ── styles ─────────────────────────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0a0a0f;
    --surface: #111118;
    --card: #18181f;
    --border: #2a2a38;
    --accent: #ff6a00;
    --accent2: #ee0979;
    --text: #e8e8f0;
    --muted: #6b6b88;
    --green: #4cde80;
    --yellow: #f0c040;
    --red: #fc5c5c;
    --radius: 12px;
  }

  body { background: var(--bg); color: var(--text); font-family: 'Syne', sans-serif; }

  .app { min-height: 100vh; display: flex; flex-direction: column; }

  /* header */
  .header {
    display: flex; align-items: center; gap: 16px;
    padding: 20px 32px; border-bottom: 1px solid var(--border);
    background: linear-gradient(135deg, #0a0a0f 0%, #12101e 100%);
  }
  .logo-mark {
    width: 42px; height: 42px; border-radius: 10px;
    background: linear-gradient(135deg, #ff6a00, #ee0979);
    display: flex; align-items: center; justify-content: center;
    font-size: 22px; font-weight: 800; color: #fff; flex-shrink: 0;
    box-shadow: 0 0 18px rgba(238,9,121,.35);
  }
  .header h1 { font-size: 22px; font-weight: 800; letter-spacing: -1px; background: linear-gradient(90deg, #ff6a00, #ee0979); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .header p { font-size: 12px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
  .header-right { margin-left: auto; display: flex; gap: 10px; align-items: center; }
  .credits-badge {
    padding: 6px 14px; border-radius: 20px; border: 1px solid var(--border);
    font-size: 12px; color: var(--muted); font-family: 'JetBrains Mono', monospace;
  }

  /* layout */
  .layout { display: grid; grid-template-columns: 340px 1fr; flex: 1; }

  /* sidebar */
  .sidebar {
    border-right: 1px solid var(--border); padding: 24px;
    display: flex; flex-direction: column; gap: 24px;
    overflow-y: auto; max-height: calc(100vh - 83px);
  }

  .section-label {
    font-size: 10px; font-weight: 700; letter-spacing: 2px;
    color: var(--muted); text-transform: uppercase; margin-bottom: 10px;
  }

  /* form elements */
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field label { font-size: 12px; color: var(--muted); font-weight: 600; }
  input[type="text"], input[type="password"], select, textarea {
    background: var(--card); border: 1px solid var(--border); border-radius: 8px;
    color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 12px;
    padding: 10px 12px; width: 100%; outline: none; transition: border-color .2s;
  }
  input[type="text"]:focus, input[type="password"]:focus, select:focus, textarea:focus {
    border-color: var(--accent);
  }
  select option { background: var(--card); }

  /* upload zones */
  .upload-zone {
    border: 2px dashed var(--border); border-radius: var(--radius);
    padding: 20px; text-align: center; cursor: pointer;
    transition: all .2s; position: relative;
  }
  .upload-zone:hover, .upload-zone.drag { border-color: var(--accent); background: rgba(124,92,252,.05); }
  .upload-zone input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  .upload-zone .icon { font-size: 28px; margin-bottom: 6px; }
  .upload-zone p { font-size: 12px; color: var(--muted); }
  .upload-zone strong { color: var(--text); }
  .file-badge {
    display: inline-flex; align-items: center; gap: 6px;
    background: rgba(124,92,252,.15); border: 1px solid rgba(124,92,252,.3);
    border-radius: 6px; padding: 4px 10px; font-size: 11px; margin-top: 8px;
  }

  /* settings grid */
  .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

  /* buttons */
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    padding: 12px 20px; border-radius: 10px; font-family: 'Syne', sans-serif;
    font-size: 13px; font-weight: 700; cursor: pointer; border: none;
    transition: all .2s; letter-spacing: .3px;
  }
  .btn-primary {
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    color: #fff; width: 100%;
  }
  .btn-primary:hover { opacity: .9; transform: translateY(-1px); box-shadow: 0 8px 24px rgba(124,92,252,.35); }
  .btn-primary:disabled { opacity: .45; cursor: not-allowed; transform: none; box-shadow: none; }
  .btn-ghost {
    background: transparent; border: 1px solid var(--border); color: var(--muted);
    font-size: 11px; padding: 7px 14px; border-radius: 8px;
  }
  .btn-ghost:hover { border-color: var(--accent); color: var(--accent); }
  .btn-sm { padding: 6px 12px; font-size: 11px; border-radius: 7px; }

  /* main panel */
  .main { padding: 24px; overflow-y: auto; max-height: calc(100vh - 83px); display: flex; flex-direction: column; gap: 24px; }

  /* batch info */
  .batch-info {
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 16px 20px; display: flex; gap: 24px; align-items: center;
    font-family: 'JetBrains Mono', monospace; font-size: 12px;
  }
  .batch-stat { display: flex; flex-direction: column; gap: 2px; }
  .batch-stat span:first-child { color: var(--muted); font-size: 10px; }
  .batch-stat strong { color: var(--text); }

  /* prompt preview */
  .sections-preview { display: flex; flex-direction: column; gap: 12px; }
  .section-card {
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    overflow: hidden;
  }
  .section-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-bottom: 1px solid var(--border);
    cursor: pointer; user-select: none;
  }
  .section-header h3 { font-size: 13px; font-weight: 700; }
  .section-tag {
    font-size: 10px; padding: 3px 8px; border-radius: 12px;
    background: rgba(124,92,252,.15); color: var(--accent);
    font-family: 'JetBrains Mono', monospace; font-weight: 600;
  }
  .prompt-list { padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
  .prompt-item {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 10px 12px; border-radius: 8px;
    background: var(--surface); border: 1px solid var(--border);
    font-size: 11px; line-height: 1.5; color: var(--muted);
    font-family: 'JetBrains Mono', monospace;
    position: relative;
  }
  .prompt-item.running { border-color: var(--accent); }
  .prompt-item.done { border-color: var(--green); }
  .prompt-item.error { border-color: var(--red); }
  .prompt-num {
    flex-shrink: 0; width: 22px; height: 22px; border-radius: 6px;
    background: var(--card); display: flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 700; color: var(--muted);
  }
  .prompt-status { position: absolute; right: 10px; top: 10px; font-size: 10px; }

  /* progress bar */
  .progress-bar { height: 3px; background: var(--border); border-radius: 2px; overflow: hidden; }
  .progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent2)); transition: width .4s; }

  /* output grid */
  .output-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; }
  .output-card {
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    overflow: hidden;
  }
  .output-img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; background: var(--surface); }
  .output-img-placeholder {
    width: 100%; aspect-ratio: 1; background: var(--surface);
    display: flex; align-items: center; justify-content: center;
    font-size: 28px; color: var(--muted);
  }
  .output-meta { padding: 10px 12px; }
  .output-meta p { font-size: 10px; color: var(--muted); font-family: 'JetBrains Mono', monospace; line-height: 1.4; }
  .output-meta strong { color: var(--text); display: block; font-size: 11px; margin-bottom: 2px; }
  .path-tag {
    display: inline-flex; font-size: 9px; color: var(--muted); font-family: 'JetBrains Mono', monospace;
    background: var(--surface); border-radius: 4px; padding: 2px 6px; margin-top: 4px;
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* folder tree */
  .folder-tree { display: flex; flex-direction: column; gap: 4px; }
  .folder-row {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-radius: 8px; background: var(--card);
    border: 1px solid var(--border);
  }
  .folder-row .icon { font-size: 14px; }
  .folder-row p { font-size: 11px; font-family: 'JetBrains Mono', monospace; color: var(--muted); }
  .folder-row strong { font-size: 12px; color: var(--text); }

  /* toast */
  .toast-wrap { position: fixed; bottom: 24px; right: 24px; z-index: 99; display: flex; flex-direction: column; gap: 8px; }
  .toast {
    padding: 12px 18px; border-radius: 10px; font-size: 12px; font-weight: 600;
    box-shadow: 0 8px 24px rgba(0,0,0,.5); animation: slideIn .25s ease;
    max-width: 300px;
  }
  .toast-success { background: rgba(76,222,128,.15); border: 1px solid rgba(76,222,128,.3); color: var(--green); }
  .toast-error { background: rgba(252,92,92,.15); border: 1px solid rgba(252,92,92,.3); color: var(--red); }
  .toast-info { background: rgba(124,92,252,.15); border: 1px solid rgba(124,92,252,.3); color: var(--accent); }
  @keyframes slideIn { from { transform: translateX(40px); opacity: 0; } to { transform: none; opacity: 1; } }

  /* tabs */
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); padding-bottom: 0; }
  .tab {
    padding: 10px 18px; font-size: 13px; font-weight: 600; cursor: pointer;
    color: var(--muted); border: none; background: none; border-bottom: 2px solid transparent;
    margin-bottom: -1px; transition: all .2s;
  }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); }

  /* download all */
  .dl-row { display: flex; gap: 10px; align-items: center; margin-top: 4px; }

  /* spinner */
  .spin { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.2); border-top-color: #fff; border-radius: 50%; animation: spin .6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* empty state */
  .empty { text-align: center; padding: 60px 20px; color: var(--muted); }
  .empty .big { font-size: 48px; margin-bottom: 12px; }
  .empty p { font-size: 13px; line-height: 1.6; }

  /* mobile toggle */
  .sidebar-toggle {
    display: none; background: none; border: 1px solid var(--border);
    color: var(--text); border-radius: 8px; padding: 6px 12px;
    font-size: 18px; cursor: pointer; line-height: 1;
  }

  /* responsive */
  @media (max-width: 768px) {
    .header { padding: 14px 16px; gap: 10px; }
    .header h1 { font-size: 18px; }
    .header p { display: none; }
    .sidebar-toggle { display: flex; align-items: center; justify-content: center; margin-left: auto; }
    .header-right { margin-left: 0; }

    .layout { grid-template-columns: 1fr; position: relative; }

    .sidebar {
      position: fixed; top: 0; left: 0; width: 88vw; max-width: 360px;
      height: 100vh; max-height: 100vh; z-index: 200;
      background: var(--surface); border-right: 1px solid var(--border);
      transform: translateX(-110%); transition: transform .3s ease;
      padding-top: 70px;
    }
    .sidebar.open { transform: translateX(0); }

    .sidebar-overlay {
      display: none; position: fixed; inset: 0; background: rgba(0,0,0,.6);
      z-index: 199;
    }
    .sidebar-overlay.open { display: block; }

    .main { max-height: none; padding: 16px; }

    .batch-info { flex-wrap: wrap; gap: 12px; padding: 12px 14px; }

    .settings-grid { grid-template-columns: 1fr 1fr; }

    .output-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }

    .dl-row { flex-direction: column; align-items: flex-start; gap: 6px; }

    .tabs { overflow-x: auto; }
    .tab { white-space: nowrap; padding: 10px 14px; font-size: 12px; }

    .toast-wrap { bottom: 16px; right: 16px; left: 16px; }
    .toast { max-width: 100%; }
  }
`;

// ── main app ───────────────────────────────────────────────────────────────────
export default function App() {
  const [apiKey, setApiKey] = useState("");
  const [htmlFile, setHtmlFile] = useState(null);
  const [htmlContent, setHtmlContent] = useState("");
  const [refImage, setRefImage] = useState(null);
  const [refImageUrl, setRefImageUrl] = useState(""); // after upload to kie
  const [sections, setSections] = useState([]);
  const [expandedSections, setExpandedSections] = useState({});
  const [campaignName, setCampaignName] = useState("campaign");
  const [batchVersion, setBatchVersion] = useState("v1");
  const [settings, setSettings] = useState({
    model: "nano-banana-pro",
    aspect_ratio: "1:1",
    resolution: "1K",
    output_format: "png",
    concurrency: 2,
  });
  const [running, setRunning] = useState(false);
  const [promptStates, setPromptStates] = useState({}); // key: sIdx-pIdx -> {status, progress, urls}
  const [outputs, setOutputs] = useState([]); // [{path, name, url, section, prompt}]
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

  // Load HTML file
  const handleHtmlFile = (file) => {
    if (!file) return;
    setHtmlFile(file);
    const reader = new FileReader();
    reader.onload = (e) => {
      const html = e.target.result;
      setHtmlContent(html);
      const parsed = parseHTMLPrompts(html);
      setSections(parsed);
      setExpandedSections(Object.fromEntries(parsed.map((_, i) => [i, true])));
      toast(`Parsed ${parsed.reduce((a, s) => a + s.prompts.length, 0)} prompts across ${parsed.length} sections`, "success");
    };
    reader.readAsText(file);
  };

  const handleRefImage = (file) => {
    if (!file) return;
    setRefImage(file);
  };

  // Upload ref image to kie and get URL
  const uploadRefImage = async () => {
    if (!refImage || !apiKey) return null;
    try {
      const formData = new FormData();
      formData.append("file", refImage);
      const res = await fetch(`${KIE_BASE}/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      });
      const json = await res.json();
      const url = json.data?.url || json.data?.fileUrl || null;
      if (url) { setRefImageUrl(url); return url; }
      // fallback: use object URL (some models accept base64)
      return null;
    } catch {
      return null;
    }
  };

  const setPromptState = (sIdx, pIdx, update) => {
    setPromptStates((prev) => {
      const key = `${sIdx}-${pIdx}`;
      return { ...prev, [key]: { ...(prev[key] || {}), ...update } };
    });
  };

  const generateSingle = async (sIdx, pIdx, prompt, refUrl) => {
    setPromptState(sIdx, pIdx, { status: "running", progress: 0 });
    const section = sections[sIdx];
    const folderPath = `${todayStr()}/${batchVersion}/${section.title.replace(/\s+/g, "_")}`;
    const body = {
      model: settings.model,
      input: {
        prompt,
        aspect_ratio: settings.aspect_ratio,
        resolution: settings.resolution,
        output_format: settings.output_format,
      },
    };
    if (refUrl) {
      body.input.image_input = [refUrl];
      body.input.image_urls = [refUrl];
    }
    const createRes = await fetch(`${KIE_BASE}/jobs/createTask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const createJson = await createRes.json();
    if (createJson.code !== 200) throw new Error(createJson.msg || "Task creation failed");
    const taskId = createJson.data?.taskId;
    const urls = await pollTask(taskId, apiKey, (p) =>
      setPromptState(sIdx, pIdx, { progress: parseFloat(p) })
    );
    const imageUrl = urls[0];
    const fileName = `${section.title.replace(/\s+/g, "_")}_p${pIdx + 1}.${settings.output_format}`;
    vfs.add(folderPath, fileName, imageUrl);
    setOutputs((prev) => [
      ...prev,
      { path: folderPath, name: fileName, url: imageUrl, section: section.title, prompt },
    ]);
    setPromptState(sIdx, pIdx, { status: "done", progress: 1, url: imageUrl });
    return true;
  };

  const runGeneration = async () => {
    if (!apiKey) { toast("Enter your Kie.ai API key", "error"); return; }
    if (!sections.length) { toast("Upload an HTML prompt file first", "error"); return; }
    setRunning(true);
    setOutputs([]);
    setPromptStates({});
    setTab("prompts");

    let refUrl = refImageUrl;
    if (refImage && !refUrl) {
      toast("Uploading reference image…", "info");
      refUrl = await uploadRefImage();
    }

    // Flatten all prompts
    const queue = [];
    sections.forEach((sec, si) => {
      sec.prompts.forEach((p, pi) => queue.push({ sIdx: si, pIdx: pi, prompt: p }));
    });

    const concurrency = parseInt(settings.concurrency) || 2;
    let qi = 0;
    const run = async () => {
      while (qi < queue.length) {
        const item = queue[qi++];
        try {
          await generateSingle(item.sIdx, item.pIdx, item.prompt, refUrl);
        } catch (e) {
          setPromptState(item.sIdx, item.pIdx, { status: "error", error: e.message });
          toast(`Error on prompt ${item.pIdx + 1}: ${e.message}`, "error");
        }
      }
    };
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, run);
    await Promise.all(workers);
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
        {/* header */}
        <div className="header">
          <div className="logo-mark">⚡</div>
          <div>
            <h1>StaticGod</h1>
            <p>kie.ai · Nano Banana Pro · Ad Generation Studio</p>
          </div>
          <div className="header-right">
            {running && (
              <div className="credits-badge">
                <span className="spin" style={{ marginRight: 6 }} />
                {doneCount}/{totalPrompts} generated
              </div>
            )}
            {!running && doneCount > 0 && (
              <div className="credits-badge">✓ {doneCount} done · {errorCount} errors</div>
            )}
            <button className="sidebar-toggle" onClick={() => setSidebarOpen(o => !o)}>☰</button>
          </div>
        </div>

        <div className="layout">
          {/* mobile overlay */}
          <div className={`sidebar-overlay ${sidebarOpen ? "open" : ""}`} onClick={() => setSidebarOpen(false)} />
          {/* sidebar */}
          <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
            {/* API key */}
            <div>
              <div className="section-label">Authentication</div>
              <div className="field">
                <label>Kie.ai API Key</label>
                <input
                  type="password"
                  placeholder="sk-kie-…"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
            </div>

            {/* HTML upload */}
            <div>
              <div className="section-label">Prompt Template</div>
              <div
                className={`upload-zone ${htmlFile ? "done" : ""}`}
                onClick={() => htmlInputRef.current?.click()}
              >
                <input
                  ref={htmlInputRef}
                  type="file"
                  accept=".html,.htm"
                  style={{ display: "none" }}
                  onChange={(e) => handleHtmlFile(e.target.files[0])}
                />
                <div className="icon">📄</div>
                {htmlFile ? (
                  <div>
                    <strong>{htmlFile.name}</strong>
                    <div className="file-badge">✓ {totalPrompts} prompts · {sections.length} sections</div>
                  </div>
                ) : (
                  <p>Drop your <strong>.html</strong> prompt file here</p>
                )}
              </div>
            </div>

            {/* Reference image */}
            <div>
              <div className="section-label">Reference Image (optional)</div>
              <div
                className="upload-zone"
                onClick={() => refInputRef.current?.click()}
              >
                <input
                  ref={refInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={(e) => handleRefImage(e.target.files[0])}
                />
                <div className="icon">🖼</div>
                {refImage ? (
                  <div>
                    <strong>{refImage.name}</strong>
                    <p style={{ marginTop: 4 }}>Used as image reference</p>
                  </div>
                ) : (
                  <p>Upload a <strong>reference image</strong> for consistency</p>
                )}
              </div>
              {refImage && (
                <div style={{ marginTop: 8 }}>
                  <img
                    src={URL.createObjectURL(refImage)}
                    style={{ width: "100%", borderRadius: 8, maxHeight: 120, objectFit: "cover" }}
                    alt="ref"
                  />
                </div>
              )}
            </div>

            {/* Batch settings */}
            <div>
              <div className="section-label">Batch Settings</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div className="field">
                  <label>Campaign Name</label>
                  <input
                    type="text"
                    value={campaignName}
                    onChange={(e) => setCampaignName(e.target.value)}
                    placeholder="my-campaign"
                  />
                </div>
                <div className="field">
                  <label>Batch Version</label>
                  <input
                    type="text"
                    value={batchVersion}
                    onChange={(e) => setBatchVersion(e.target.value)}
                    placeholder="v1"
                  />
                </div>
              </div>
            </div>

            {/* Generation settings */}
            <div>
              <div className="section-label">Generation Settings</div>
              <div className="settings-grid">
                <div className="field">
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
                    {["1:1","16:9","9:16","4:5","5:4","3:2","2:3","4:3","3:4"].map(r => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Resolution</label>
                  <select value={settings.resolution} onChange={(e) => setSettings({ ...settings, resolution: e.target.value })}>
                    <option value="1K">1K</option>
                    <option value="2K">2K</option>
                    <option value="4K">4K</option>
                  </select>
                </div>
                <div className="field">
                  <label>Format</label>
                  <select value={settings.output_format} onChange={(e) => setSettings({ ...settings, output_format: e.target.value })}>
                    <option value="png">PNG</option>
                    <option value="jpeg">JPEG</option>
                    <option value="webp">WebP</option>
                  </select>
                </div>
                <div className="field" style={{ gridColumn: "span 2" }}>
                  <label>Concurrency (parallel jobs)</label>
                  <select value={settings.concurrency} onChange={(e) => setSettings({ ...settings, concurrency: e.target.value })}>
                    {[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* Folder preview */}
            {sections.length > 0 && (
              <div>
                <div className="section-label">Output Folder Structure</div>
                <div className="folder-tree">
                  <div className="folder-row">
                    <span className="icon">📁</span>
                    <div>
                      <strong>{todayStr()}</strong>
                      <p>date folder</p>
                    </div>
                  </div>
                  <div className="folder-row" style={{ marginLeft: 16 }}>
                    <span className="icon">📁</span>
                    <div>
                      <strong>{batchVersion || "v1"}</strong>
                      <p>batch version</p>
                    </div>
                  </div>
                  {sections.map((s, i) => (
                    <div key={i} className="folder-row" style={{ marginLeft: 32 }}>
                      <span className="icon">📂</span>
                      <div>
                        <strong>{s.title.replace(/\s+/g, "_")}</strong>
                        <p>{s.prompts.length} images</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Run button */}
            <button
              className="btn btn-primary"
              onClick={runGeneration}
              disabled={running || !sections.length || !apiKey}
            >
              {running ? (
                <><span className="spin" /> Generating {doneCount}/{totalPrompts}…</>
              ) : (
                <>⚡ Generate {totalPrompts} Ads</>
              )}
            </button>
          </aside>

          {/* main */}
          <main className="main">
            {/* batch info bar */}
            {(running || doneCount > 0) && (
              <div className="batch-info">
                <div className="batch-stat"><span>Date</span><strong>{todayStr()}</strong></div>
                <div className="batch-stat"><span>Batch</span><strong>{batchVersion}</strong></div>
                <div className="batch-stat"><span>Total Prompts</span><strong>{totalPrompts}</strong></div>
                <div className="batch-stat"><span>Done</span><strong style={{ color: "var(--green)" }}>{doneCount}</strong></div>
                <div className="batch-stat"><span>Errors</span><strong style={{ color: errorCount ? "var(--red)" : "var(--muted)" }}>{errorCount}</strong></div>
                <div className="batch-stat"><span>Progress</span><strong>{totalPrompts ? Math.round((doneCount / totalPrompts) * 100) : 0}%</strong></div>
              </div>
            )}

            {/* global progress bar */}
            {running && (
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${totalPrompts ? (doneCount / totalPrompts) * 100 : 0}%` }} />
              </div>
            )}

            {/* tabs */}
            <div className="tabs">
              <button className={`tab ${tab === "prompts" ? "active" : ""}`} onClick={() => setTab("prompts")}>
                Prompts {sections.length > 0 && `(${totalPrompts})`}
              </button>
              <button className={`tab ${tab === "outputs" ? "active" : ""}`} onClick={() => setTab("outputs")}>
                Outputs {outputs.length > 0 && `(${outputs.length})`}
              </button>
              <button className={`tab ${tab === "folders" ? "active" : ""}`} onClick={() => setTab("folders")}>
                Folders
              </button>
            </div>

            {/* PROMPTS tab */}
            {tab === "prompts" && (
              <>
                {sections.length === 0 ? (
                  <div className="empty">
                    <div className="big">📄</div>
                    <p>Upload an HTML file to see your prompt sections here.<br />
                    Each section becomes a folder. Each prompt becomes one ad.</p>
                  </div>
                ) : (
                  <div className="sections-preview">
                    {sections.map((sec, si) => (
                      <div key={si} className="section-card">
                        <div
                          className="section-header"
                          onClick={() => setExpandedSections((e) => ({ ...e, [si]: !e[si] }))}
                        >
                          <h3>{sec.title}</h3>
                          <span className="section-tag">{sec.prompts.length} prompts</span>
                        </div>
                        {expandedSections[si] && (
                          <div className="prompt-list">
                            {sec.prompts.map((p, pi) => {
                              const state = promptStates[`${si}-${pi}`] || {};
                              return (
                                <div
                                  key={pi}
                                  className={`prompt-item ${state.status || ""}`}
                                >
                                  <div className="prompt-num">{pi + 1}</div>
                                  <span style={{ flex: 1, paddingRight: 30 }}>{p}</span>
                                  <span className="prompt-status">
                                    {state.status === "running" && (
                                      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                        <span className="spin" />
                                        {Math.round((state.progress || 0) * 100)}%
                                      </span>
                                    )}
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
              </>
            )}

            {/* OUTPUTS tab */}
            {tab === "outputs" && (
              <>
                {outputs.length === 0 ? (
                  <div className="empty">
                    <div className="big">🖼</div>
                    <p>Generated images will appear here.<br />Run generation to get started.</p>
                  </div>
                ) : (
                  <>
                    <div className="dl-row">
                      <button className="btn btn-ghost" onClick={downloadAll}>
                        ⬇ Download All as ZIP ({outputs.length} images)
                      </button>
                      <span style={{ fontSize: 11, color: "var(--muted)" }}>
                        Saved as <code style={{fontFamily:"'JetBrains Mono',monospace"}}>ads_{todayStr()}_{batchVersion}.zip</code> with full folder structure
                      </span>
                    </div>
                    <div className="output-grid">
                      {outputs.map((out, i) => (
                        <div key={i} className="output-card">
                          {out.url ? (
                            <a href={out.url} target="_blank" rel="noreferrer">
                              <img className="output-img" src={out.url} alt={out.name} loading="lazy" />
                            </a>
                          ) : (
                            <div className="output-img-placeholder">⏳</div>
                          )}
                          <div className="output-meta">
                            <strong>{out.section}</strong>
                            <p>{out.prompt.slice(0, 70)}{out.prompt.length > 70 ? "…" : ""}</p>
                            <div className="path-tag">{out.path}/{out.name}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {/* FOLDERS tab */}
            {tab === "folders" && (
              <>
                {vfs.toList().length === 0 ? (
                  <div className="empty">
                    <div className="big">📁</div>
                    <p>Your organized folder structure will appear here<br />after generation completes.</p>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                    {vfs.toList().map((folder, fi) => (
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
                              <div className="output-meta">
                                <strong>{f.name}</strong>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </main>
        </div>
      </div>

      {/* toasts */}
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`}>{t.msg}</div>
        ))}
      </div>
    </>
  );
}
