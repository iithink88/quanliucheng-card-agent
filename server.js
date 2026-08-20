/* ============================================================
 * server.js — 全流程知识卡片 · 图形界面智能体（本地服务器）
 * 由扣子(Coze)工作流「全流程的风格 / 制作全流程」转换而来
 * 纯 Node 内置模块，零外部依赖（Node 18+ 自带 fetch）
 * 功能：
 *   - /api/keys        读取本机 .env 中的密钥（脱敏）
 *   - /api/set-keys    保存自定义 LLM / 自定义图模型配置到本机 .env
 *   - /api/generate    SSE 流式：调 LLM 生成全流程步骤与绘画 prompt → 调用图模型生成扁平风插画
 *   - /api/test        快速测试 LLM 连通性
 *   - /api/test-image  快速测试图模型连通性
 *   - /files/*         查看 output 目录下生成的卡片
 * ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");

const APP_DIR = __dirname;
const isPackaged = typeof process.pkg !== "undefined";
const DATA_DIR = isPackaged ? path.dirname(process.execPath) : APP_DIR;
const OUTPUT_DIR = path.join(DATA_DIR, "output");
const ENV_FILE = path.join(DATA_DIR, ".env");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const PORT = parseInt(process.env.PORT || "8790", 10);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function loadDotEnv() {
  const extra = {};
  try {
    if (fs.existsSync(ENV_FILE)) {
      const txt = fs.readFileSync(ENV_FILE, "utf-8");
      txt.split(/\r?\n/).forEach((line) => {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m) extra[m[1]] = m[2].replace(/^["']|["']$/g, "");
      });
    }
  } catch (e) { /* 忽略 */ }
  return extra;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      const ct = req.headers["content-type"] || "";
      if (ct.includes("application/json")) {
        try { resolve(JSON.parse(buf.toString("utf-8"))); }
        catch (e) { reject(e); }
      } else {
        resolve(buf.toString("utf-8"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
}

function safeJoin(base, urlPath) {
  const target = path.normalize(path.join(base, urlPath));
  if (!target.startsWith(base)) return null;
  return target;
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(data);
  });
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sendSSE(res, event, data) {
  res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
}

function normalizeApiBase(base) {
  base = (base || "").replace(/\/+$/, "");
  if (!base) return "";
  return /\/v\d+(\/|$)/i.test(base) ? base : base + "/v1";
}

/* ---------- 全流程知识卡片 systemPrompt（由扣子工作流原意精炼） ---------- */
const QUANLIUCHENG_SYSTEM = `你是一位专业的知识卡片设计师，擅长把任意主题做成「制作全流程」风格的科普知识卡片。

用户输入一个主题（如「绿茶」），你要生成一张介绍该主题「从原料到成品」完整制作/诞生流程的扁平风插画知识卡片。

请严格按照下面的 JSON 格式输出，不要输出任何额外文字，也不要加 markdown 代码块：

{
  "title": "主题名称（如：绿茶）",
  "intro": "一句话活泼简介（20字以内）",
  "steps": [
    {"name":"步骤一名称","desc":"一句话说明该步的工艺特点","icon":"🌿"},
    {"name":"步骤二名称","desc":"一句话说明该步的工艺特点","icon":"🔥"}
  ],
  "prompt": "完整图像生成提示词（中文，扁平风插画，浅绿背景，卡通简约，展示<主题>制作全流程，分N个步骤依次排列，每步有名称与配图，文字清晰，突出每一步的工艺特点）"
}

要求：
- steps 取 3~8 个，按时间/工艺先后顺序排列；每步 name 简短、desc 一句话、icon 用一个 emoji 代表该步骤。
- prompt 必须包含关键词：扁平风插画、浅绿背景、卡通简约、分步骤依次排列、每步名称+配图、文字说明清晰。
- 整体突出每一步的工艺特点。

示例：用户输入「绿茶」
{
  "title":"绿茶",
  "intro":"一片叶子的一清二白之旅",
  "steps":[
    {"name":"鲜叶采摘","desc":"戴草帽的茶农采摘一芽一叶嫩芽，旁有竹篮","icon":"🌿"},
    {"name":"摊晾萎凋","desc":"竹匾里摊开茶叶自然失水","icon":"🌬️"},
    {"name":"高温杀青","desc":"铁锅中翻炒茶叶，配铁锅与炒茶工具","icon":"🔥"},
    {"name":"揉捻造型","desc":"揉出卷曲条索，塑造茶叶形态","icon":"🤲"},
    {"name":"干燥提香","desc":"烘干提香，干茶与鲜叶对比","icon":"☀️"}
  ],
  "prompt":"扁平风插画，展示绿茶制作全流程，分为五个步骤依次排列。第一步 鲜叶采摘：戴草帽的茶农采摘一芽一叶嫩茶芽，旁有竹篮；第二步 摊晾萎凋：竹匾里摊开的茶叶自然失水；第三步 高温杀青：铁锅中翻炒茶叶，配铁锅炒茶工具；第四步 揉捻造型：卷曲形态的茶叶堆；第五步 干燥提香：干燥后的茶叶与鲜叶对比。整体背景浅绿，风格卡通简约，文字说明清晰，突出每一步的工艺特点。"
}`;

/* ---------- LLM 调用 ---------- */
async function chatCompletion(cfg, messages, opts) {
  opts = opts || {};
  const url = normalizeApiBase(cfg.base) + "/chat/completions";
  const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + (cfg.key || "") };
  const body = { model: cfg.model || "gpt-4o-mini", messages, temperature: opts.temperature != null ? opts.temperature : 0.8 };
  if (opts.json) body.response_format = { type: "json_object" };
  try {
    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await resp.text();
    if (!resp.ok) return { ok: false, error: "LLM 返回 HTTP " + resp.status + "：" + text.slice(0, 200) };
    let json; try { json = JSON.parse(text); } catch (e) { return { ok: false, error: "LLM 响应非 JSON：" + text.slice(0, 200) }; }
    const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!content) return { ok: false, error: "LLM 未返回内容" };
    return { ok: true, content };
  } catch (e) {
    return { ok: false, error: "LLM 请求失败：" + e.message };
  }
}

async function callQuanliuchengLLM(cfg, theme) {
  const messages = [
    { role: "system", content: QUANLIUCHENG_SYSTEM },
    { role: "user", content: theme },
  ];
  for (const withFmt of [true, false]) {
    const r = await chatCompletion(cfg, messages, { json: withFmt, temperature: 0.8 });
    if (r.ok) {
      const data = extractJSON(r.content);
      if (data && data.title && data.prompt) {
        if (!Array.isArray(data.steps)) data.steps = [];
        return { ok: true, data };
      }
      return { ok: false, error: "LLM 返回内容无法解析为全流程卡片结构" };
    }
    if (withFmt) continue;
    return r;
  }
  return { ok: false, error: "LLM 调用失败" };
}

function extractJSON(content) {
  try { return JSON.parse(content); } catch (e) { /* 尝试抠出 JSON 片段 */ }
  const s = content.indexOf("{");
  const e = content.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try { return JSON.parse(content.slice(s, e + 1)); } catch (e2) { return null; }
  }
  return null;
}

/* ---------- 图模型调用 ---------- */
async function genImage(cfg, prompt) {
  const url = normalizeApiBase(cfg.base) + "/images/generations";
  const size = cfg.size || "1792x1024";
  const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + (cfg.key || "") };
  const body = { model: cfg.model || "dall-e-3", prompt, n: 1, size, response_format: "b64_json" };
  try {
    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: "图模型 HTTP " + resp.status + "：" + JSON.stringify(j).slice(0, 160) };
    const item = (j.data && j.data[0]) || {};
    if (item.b64_json) return { ok: true, dataUri: "data:image/png;base64," + item.b64_json };
    if (item.url) {
      try {
        const r2 = await fetch(item.url);
        const buf = Buffer.from(await r2.arrayBuffer());
        return { ok: true, dataUri: "data:image/png;base64," + buf.toString("base64") };
      } catch (e) { return { ok: false, error: "图模型返回 URL 但拉取失败：" + e.message }; }
    }
    return { ok: false, error: "图模型返回格式异常" };
  } catch (e) {
    return { ok: false, error: "图模型请求失败：" + e.message };
  }
}

/* ---------- 拼装全流程知识卡片展示页 ---------- */
function buildViewer(data, imageUri) {
  const title = data.title || "知识卡片";
  const intro = data.intro || "";
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const prompt = data.prompt || "";

  const hasImage = !!imageUri;
  const imgHtml = hasImage
    ? '<img class="qlc-img" src="' + imageUri + '" alt="' + escapeHtml(title) + '">'
    : '<div class="qlc-img-placeholder">未生成插画<br><small>未配置图模型时仅展示步骤卡片</small></div>';

  const stepsHtml = steps.length
    ? steps.map((s) => {
        const icon = s.icon || "✅";
        const name = escapeHtml(s.name || "");
        const desc = escapeHtml(s.desc || "");
        return '<li class="qlc-step"><span class="qlc-ic">' + escapeHtml(icon) + '</span>' +
          '<div class="qlc-step-txt"><b>' + name + '</b><span>' + desc + '</span></div></li>';
      }).join("")
    : '<li class="qlc-step"><span class="qlc-ic">📋</span><div class="qlc-step-txt"><b>暂无步骤</b><span>模型未返回步骤结构</span></div></li>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} · 制作全流程</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:linear-gradient(160deg,#e8f5e9,#c8e6c9);font-family:"PingFang SC","Microsoft YaHei",sans-serif;display:flex;justify-content:center;align-items:flex-start;padding:26px 10px;min-height:100vh;color:#1f3d23}
  .qlc-card{width:100%;max-width:560px;background:#fffef8;border:2px solid #7cb342;border-radius:18px;padding:22px 20px 18px;box-shadow:0 12px 30px rgba(60,120,40,.22);position:relative;overflow:hidden}
  .qlc-card:before{content:"";position:absolute;top:-40px;right:-40px;width:160px;height:160px;background:radial-gradient(circle,rgba(124,179,66,.25),transparent 70%);border-radius:50%}
  .qlc-head{text-align:center;margin-bottom:14px}
  .qlc-badge{display:inline-block;background:#7cb342;color:#fff;font-size:12px;padding:3px 12px;border-radius:99px;letter-spacing:2px}
  .qlc-title{font-size:30px;font-weight:900;color:#2e7d32;margin-top:8px;letter-spacing:2px}
  .qlc-intro{font-size:14px;color:#558b2f;margin-top:6px}
  .qlc-img-wrap{margin:6px 0 14px;border:2px dashed #a5d6a7;border-radius:14px;overflow:hidden;background:#f1f8e9;display:flex;justify-content:center;align-items:center;min-height:220px}
  .qlc-img{width:100%;height:auto;display:block}
  .qlc-img-placeholder{color:#689f38;text-align:center;line-height:1.8;padding:40px 20px;font-size:14px}
  .qlc-steps-t{font-size:15px;font-weight:800;color:#33691e;margin:6px 0 10px;display:flex;align-items:center;gap:6px}
  .qlc-steps{list-style:none;display:flex;flex-direction:column;gap:10px}
  .qlc-step{display:flex;align-items:flex-start;gap:12px;background:#f1f8e9;border:1px solid #dcedc8;border-radius:12px;padding:11px 13px}
  .qlc-ic{font-size:26px;line-height:1;flex:0 0 auto;width:42px;height:42px;display:flex;align-items:center;justify-content:center;background:#fff;border-radius:50%;box-shadow:0 2px 6px rgba(60,120,40,.18)}
  .qlc-step-txt{display:flex;flex-direction:column;gap:2px}
  .qlc-step-txt b{font-size:15.5px;color:#2e7d32}
  .qlc-step-txt span{font-size:13px;color:#4a6b3a;line-height:1.6}
  .qlc-prompt{margin-top:14px;border-top:1px dashed #c5e1a5;padding-top:10px}
  .qlc-prompt summary{cursor:pointer;font-size:13px;color:#558b2f;font-weight:700}
  .qlc-prompt p{font-size:12.5px;color:#4a6b3a;line-height:1.8;margin-top:8px;background:#f1f8e9;border-radius:8px;padding:10px}
  .qlc-foot{margin-top:14px;text-align:center;font-size:12px;color:#7a9a6a;letter-spacing:1px}
  @media(max-width:480px){.qlc-title{font-size:24px}}
</style>
</head>
<body>
<div class="qlc-card">
  <div class="qlc-head">
    <span class="qlc-badge">制作全流程</span>
    <div class="qlc-title">${escapeHtml(title)}</div>
    <div class="qlc-intro">${escapeHtml(intro)}</div>
  </div>
  <div class="qlc-img-wrap">${imgHtml}</div>
  <div class="qlc-steps-t">🧩 完整流程（${steps.length} 步）</div>
  <ul class="qlc-steps">${stepsHtml}</ul>
  <details class="qlc-prompt"><summary>🎨 查看绘画提示词（Prompt）</summary><p>${escapeHtml(prompt)}</p></details>
  <div class="qlc-foot">全流程知识卡片智能体 · ${new Date().toLocaleDateString("zh-CN")}</div>
</div>
</body>
</html>`;
}

/* ---------- /api/generate (SSE) ---------- */
async function apiGenerate(body, req, res) {
  const theme = (body.theme || "").trim();
  if (!theme) { sendSSE(res, "error", { msg: "请先输入主题" }); return; }

  const env = loadDotEnv();
  const llmCfg = {
    base: body.llm_base || env.LLM_BASE_URL,
    key: body.llm_key || env.LLM_API_KEY,
    model: body.llm_model || env.LLM_MODEL,
  };
  const imgCfg = {
    base: body.img_base || env.IMG_BASE_URL,
    key: body.img_key || env.IMG_API_KEY,
    model: body.img_model || env.IMG_MODEL,
    size: body.img_size || env.IMG_SIZE,
  };

  if (!llmCfg.base || !llmCfg.key) {
    sendSSE(res, "error", { msg: "尚未配置 LLM：点击右上角 ⚙ 填写「模型地址 / API Key / 模型名」并保存。" });
    return;
  }

  let aborted = false;
  req.on("close", () => { aborted = true; });

  sendSSE(res, "log", { msg: "正在为「" + theme + "」构思全流程知识卡片…" });
  sendSSE(res, "progress", { pct: 10, label: "调用大模型生成流程步骤" });

  const llm = await callQuanliuchengLLM(llmCfg, theme);
  if (aborted) return;
  if (!llm.ok) { sendSSE(res, "error", { msg: llm.error }); return; }

  const data = llm.data;
  sendSSE(res, "log", { msg: "✓ 文案已生成：" + (data.title || theme) + "（" + (data.steps || []).length + " 步）" });
  sendSSE(res, "progress", { pct: 40, label: "流程步骤生成完成" });

  let imageUri = null;
  const useImage = imgCfg.base && imgCfg.key;
  if (useImage) {
    sendSSE(res, "log", { msg: "正在调用图模型生成扁平风插画…" });
    sendSSE(res, "progress", { pct: 60, label: "调用图模型生成插画" });
    const r = await genImage(imgCfg, data.prompt.trim());
    if (aborted) return;
    if (r.ok) {
      imageUri = r.dataUri;
      sendSSE(res, "log", { msg: "✓ 插画绘制完成" });
    } else {
      sendSSE(res, "log", { msg: "⚠ 图片生成失败：" + r.error.slice(0, 100) + "，已生成步骤卡片。" });
    }
    sendSSE(res, "progress", { pct: 90, label: "插画生成完成" });
  } else {
    sendSSE(res, "log", { msg: "未配置图模型，仅生成步骤卡片。可在右上角 ⚙ 配置「图模型」后重试。" });
    sendSSE(res, "progress", { pct: 80, label: "生成步骤卡片" });
  }

  if (aborted) return;
  sendSSE(res, "log", { msg: "正在拼装展示页…" });
  const html = buildViewer(data, imageUri);

  const safeName = (data.title || theme).replace(/[\\/:*?"<>|]/g, "_").slice(0, 30);
  const fileName = safeName + "_" + Date.now().toString().slice(-8) + ".html";
  const filePath = path.join(OUTPUT_DIR, fileName);
  try { fs.writeFileSync(filePath, html, "utf-8"); } catch (e) { /* 忽略 */ }

  let imageFile = null;
  if (imageUri && imageUri.startsWith("data:image/png;base64,")) {
    try {
      const buf = Buffer.from(imageUri.slice("data:image/png;base64,".length), "base64");
      const imgName = safeName + "_" + Date.now().toString().slice(-8) + ".png";
      fs.writeFileSync(path.join(OUTPUT_DIR, imgName), buf);
      imageFile = "/files/" + encodeURIComponent(imgName);
    } catch (e) {}
  }

  sendSSE(res, "progress", { pct: 100, label: "完成" });
  sendSSE(res, "done", { html, file: "/files/" + encodeURIComponent(fileName), imageFile, data });
  sendSSE(res, "log", { msg: "🎉 全流程知识卡片已生成！右侧预览、下载或新窗口打开。" });
}

/* ---------- /api/set-keys ---------- */
function apiGetKeys(res) {
  const extra = loadDotEnv();
  const keys = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "IMG_BASE_URL", "IMG_API_KEY", "IMG_MODEL", "IMG_SIZE"];
  const NON_SECRET = new Set(["LLM_BASE_URL", "LLM_MODEL", "IMG_BASE_URL", "IMG_MODEL", "IMG_SIZE"]);
  const masked = {};
  keys.forEach((k) => {
    const v = extra[k] || "";
    if (NON_SECRET.has(k)) masked[k] = v;
    else masked[k] = v.length > 8 ? v.slice(0, 4) + "****" + v.slice(-2) : (v ? "****" : "");
  });
  sendJson(res, 200, { ok: true, keys: masked });
}

function apiSetKeys(body, res) {
  try {
    const keys = body.keys || {};
    if (typeof keys !== "object" || Array.isArray(keys)) {
      return sendJson(res, 400, { ok: false, error: "keys 必须是对象" });
    }
    let existing = "";
    try { if (fs.existsSync(ENV_FILE)) existing = fs.readFileSync(ENV_FILE, "utf-8"); } catch (_) {}
    const lines = existing.split(/\r?\n/);
    const updated = [];
    const written = new Set();
    const allow = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "IMG_BASE_URL", "IMG_API_KEY", "IMG_MODEL", "IMG_SIZE"];
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m && allow.includes(m[1]) && keys[m[1]] !== undefined) {
        const val = String(keys[m[1]]);
        updated.push(m[1] + '="' + val.replace(/"/g, "") + '"');
        written.add(m[1]);
      } else if (line.trim()) {
        updated.push(line);
      }
    }
    for (const [k, v] of Object.entries(keys)) {
      if (allow.includes(k) && !written.has(k) && v) updated.push(k + '="' + String(v).replace(/"/g, "") + '"');
    }
    fs.writeFileSync(ENV_FILE, updated.join("\r\n") + "\r\n", "utf-8");
    console.log("[Key 设置] 已写入 " + Object.keys(keys).join(", ") + " 到 " + ENV_FILE);
    sendJson(res, 200, { ok: true, saved: Object.keys(keys) });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

/* ---------- /api/test ---------- */
async function apiTest(body, res) {
  const env = loadDotEnv();
  const cfg = {
    base: body.llm_base || env.LLM_BASE_URL,
    key: body.llm_key || env.LLM_API_KEY,
    model: body.llm_model || env.LLM_MODEL,
  };
  if (!cfg.base || !cfg.key) return sendJson(res, 400, { ok: false, error: "缺少 LLM 配置" });
  const r = await callQuanliuchengLLM(cfg, "绿茶");
  if (r.ok) return sendJson(res, 200, { ok: true, msg: "连通成功，模型返回可解析的全流程卡片结构" });
  return sendJson(res, 502, { ok: false, error: r.error });
}

async function apiTestImage(body, res) {
  const env = loadDotEnv();
  const cfg = {
    base: body.img_base || env.IMG_BASE_URL,
    key: body.img_key || env.IMG_API_KEY,
    model: body.img_model || env.IMG_MODEL,
    size: body.img_size || env.IMG_SIZE,
  };
  if (!cfg.base || !cfg.key) return sendJson(res, 400, { ok: false, error: "缺少图像模型配置（需要 Base URL 与 API Key）" });
  if (!cfg.model) return sendJson(res, 400, { ok: false, error: "缺少图像模型名（Model）" });
  const r = await genImage(cfg, "扁平风插画，展示绿茶制作全流程，分为五个步骤依次排列，整体背景浅绿，卡通简约，文字清晰。");
  if (r.ok) return sendJson(res, 200, { ok: true, msg: "图像模型连通成功，已返回 " + (r.dataUri || "").length + " 字符的图片数据" });
  return sendJson(res, 502, { ok: false, error: r.error });
}

/* ---------- 主路由 ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "*", "Access-Control-Max-Age": "86400" });
    res.end();
    return;
  }

  if (url.pathname === "/health" || url.pathname === "/api/health") {
    return sendJson(res, 200, { status: "ok" });
  }

  if (url.pathname === "/api/keys" && req.method === "GET") return apiGetKeys(res);
  if (url.pathname === "/api/set-keys" && req.method === "POST") {
    return readBody(req).then((b) => apiSetKeys(b, res)).catch((e) => sendJson(res, 400, { ok: false, error: e.message }));
  }
  if (url.pathname === "/api/test" && req.method === "POST") {
    return readBody(req).then((b) => apiTest(b, res)).catch((e) => sendJson(res, 400, { ok: false, error: e.message }));
  }
  if (url.pathname === "/api/test-image" && req.method === "POST") {
    return readBody(req).then((b) => apiTestImage(b, res)).catch((e) => sendJson(res, 400, { ok: false, error: e.message }));
  }

  if (url.pathname === "/api/generate" && req.method === "POST") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    return readBody(req).then((b) => apiGenerate(b, req, res)).catch((e) => {
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: e.message });
      else sendSSE(res, "error", { msg: e.message });
    });
  }

  if (url.pathname.startsWith("/files/")) {
    const fp = safeJoin(OUTPUT_DIR, decodeURIComponent(url.pathname.slice("/files/".length)));
    if (!fp) { res.writeHead(403); res.end("Forbidden"); return; }
    return serveFile(res, fp);
  }

  const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const fullPath = safeJoin(APP_DIR, filePath);
  if (!fullPath) { res.writeHead(403); res.end("Forbidden"); return; }
  serveFile(res, fullPath);
});

/* ---------- 启动（端口被占用自动 +1，最多 10 次） ---------- */
let attempts = 0;
function startServer(port) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && attempts < 10) {
      attempts++;
      console.log("端口 " + port + " 被占用，尝试 " + (port + 1) + " ...");
      startServer(port + 1);
    } else {
      console.error("服务器启动失败:", err.message);
      process.exit(1);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const url = "http://127.0.0.1:" + port;
    console.log("================================================");
    console.log("  全流程知识卡片 · 智能体 已启动");
    console.log("  " + url);
    console.log("  关闭本窗口即停止服务");
    console.log("================================================");
    const cmd =
      process.platform === "win32" ? 'start "" "' + url + '"'
      : process.platform === "darwin" ? 'open "' + url + '"'
      : 'xdg-open "' + url + '"';
    const { exec } = require("child_process");
    exec(cmd, (e) => { if (e) console.log("(请手动打开浏览器访问 " + url + ")"); });
  });
}
startServer(PORT);
