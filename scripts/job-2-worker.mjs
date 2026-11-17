import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  constants,
  createCipheriv,
  publicEncrypt,
  randomBytes,
} from "node:crypto";

const jobUrl = process.env.MEGA_JOB_2_MCP_URL;
const clipUrl = "https://hq.mega.dev/media/two-places/dispatch-1-028eeb49.mp3";
const publicKey = readFileSync(
  fileURLToPath(new URL("./job-2-artifact-public.pem", import.meta.url)),
  "utf8",
);

const exchanges = [];
let nextId = 0;

function mask(value) {
  if (value) console.log(`::add-mask::${String(value)}`);
}

function scrub(value) {
  if (typeof value === "string") {
    try {
      return JSON.stringify(scrub(JSON.parse(value)));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:step|receipt|token)$/i.test(key) ? "<REDACTED>" : scrub(item),
      ]),
    );
  }
  return value;
}

function parseResponse(text, contentType) {
  if (!text.trim()) return null;
  if (contentType?.includes("text/event-stream")) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    return data ? JSON.parse(data) : null;
  }
  return JSON.parse(text);
}

async function rpc(method, params) {
  if (!jobUrl) throw new Error("MEGA_JOB_2_MCP_URL secret is missing");
  const request = {
    jsonrpc: "2.0",
    ...(method.startsWith("notifications/") ? {} : { id: ++nextId }),
    method,
    ...(params === undefined ? {} : { params }),
  };

  let status = 0;
  let reply = null;
  let recorded = false;
  try {
    const response = await fetch(jobUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
    status = response.status;
    reply = parseResponse(await response.text(), response.headers.get("content-type"));
    exchanges.push({ request: scrub(request), status, reply: scrub(reply) });
    recorded = true;
    if (!response.ok) throw new Error(`MCP HTTP ${status} for ${method}`);
    if (reply?.error) throw new Error(`MCP error for ${method}`);
    return reply;
  } catch (error) {
    if (!recorded) {
      exchanges.push({
        request: scrub(request),
        status,
        reply: scrub(reply),
        error: String(error?.message ?? "request failed"),
      });
    }
    throw error;
  }
}

function parseToolPayload(reply, name) {
  const result = reply?.result;
  if (!result || result.isError) throw new Error(`MCP tool ${name} failed`);
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error(`MCP tool ${name} returned no text result`);
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function callTool(name, arguments_) {
  return parseToolPayload(
    await rpc("tools/call", { name, arguments: arguments_ }),
    name,
  );
}

function checkToolContract(tools) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const expected = {
    transcribe: ["url"],
    memo_write: ["text", "step"],
    memo_search: ["step"],
    submit: ["result", "skillVersion", "step"],
  };
  for (const [name, required] of Object.entries(expected)) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Required MCP tool is missing: ${name}`);
    for (const field of required) {
      if (!tool.inputSchema?.required?.includes(field)) {
        throw new Error(`MCP schema changed: ${name}.${field} is not required`);
      }
      if (tool.inputSchema?.properties?.[field]?.type !== "string") {
        throw new Error(`MCP schema changed: ${name}.${field} is not a string`);
      }
    }
  }
  const query = byName.get("memo_search")?.inputSchema?.properties?.query;
  if (query && query.type !== "string") {
    throw new Error("MCP schema changed: memo_search.query is not a string");
  }
}

function findSegments(payload) {
  const candidates = [
    payload?.segments,
    payload?.transcript?.segments,
    payload?.data?.segments,
  ];
  return candidates.find(Array.isArray) ?? null;
}

function segmentText(segment) {
  const value = segment?.text ?? segment?.transcript ?? segment?.content;
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .join(" ")
      .trim();
  }
  return "";
}

function offsetSeconds(offset) {
  if (typeof offset === "number" && Number.isFinite(offset)) return offset;
  if (offset && typeof offset === "object") {
    if (typeof offset.seconds === "number") return offset.seconds;
    if (typeof offset.totalSeconds === "number") return offset.totalSeconds;
  }
  if (typeof offset !== "string") return NaN;
  const value = offset.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const parts = value.split(":");
  if (parts.length === 2 && parts.every((part) => /^\d+(?:\.\d+)?$/.test(part))) {
    return Number(parts[0]) * 60 + Number(parts[1]);
  }
  if (parts.length === 3 && parts.every((part) => /^\d+(?:\.\d+)?$/.test(part))) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  }
  return NaN;
}

function formatOffset(segment) {
  const raw = segment?.offset ?? segment?.start ?? segment?.startOffset ?? segment?.time;
  const seconds = offsetSeconds(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error("Transcription segment has no usable offset");
  }
  const wholeSeconds = Math.floor(seconds);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

const findingPattern =
  /\b(?:fault(?:s|ed)?|fail(?:ed|ure|ures)?|freez(?:e|es|ing|en)|froze|stall(?:s|ed|ing)?|hold(?:s|ing)?|held|reset(?:s|ting)?|restart(?:ed|s)?|reboot(?:ed|s)?|timeout|timed out|hung|hang(?:s|ing)?|stuck|dropped|dropout|offline|outage|went blank|black(?:ed)? out)\b/i;

function sentenceNotes(segment) {
  const text = segmentText(segment);
  if (!text) return [];
  const sentences = text.match(/[^.!?;]+[.!?;]?/g) ?? [text];
  const offset = formatOffset(segment);
  return sentences
    .map((sentence) => sentence.trim().replace(/\s+/g, " "))
    .filter((sentence) => sentence && findingPattern.test(sentence))
    .map((sentence) => `${sentence} @${offset}`);
}

function extractMemoNotes(payload) {
  const candidates = [
    payload?.notes,
    payload?.memos,
    payload?.entries,
    payload?.results,
    payload?.matches,
    payload?.items,
  ];
  const list = candidates.find(Array.isArray);
  if (list) {
    return list
      .map((item) => (typeof item === "string" ? item : item?.text ?? item?.note ?? ""))
      .filter(Boolean);
  }
  const text = typeof payload?.text === "string" ? payload.text : "";
  if (text) return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return [];
}

function encryptPayload(payload) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const wrappedKey = publicEncrypt(
    {
      key: publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    key,
  );
  return {
    version: 1,
    wrappedKey: wrappedKey.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function emitEncrypted(payload) {
  const encoded = Buffer.from(JSON.stringify(encryptPayload(payload))).toString("base64");
  const chunkSize = 2400;
  const chunks = encoded.match(new RegExp(`.{1,${chunkSize}}`, "g")) ?? [""];
  chunks.forEach((chunk, index) => {
    console.log(`JOB2_ENCRYPTED_RESULT_PART=${index + 1}/${chunks.length} ${chunk}`);
  });
}

async function runJob() {
  if (!jobUrl) throw new Error("MEGA_JOB_2_MCP_URL secret is missing");
  mask(jobUrl);

  const initialized = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "github-actions-job-2-worker", version: "1.0" },
  });
  await rpc("notifications/initialized");

  const toolReply = await rpc("tools/list", {});
  const tools = toolReply?.result?.tools ?? [];
  checkToolContract(tools);

  const skillReply = await rpc("resources/read", {
    uri: "skill://voice-to-memo/SKILL.md",
  });
  const skillText = skillReply?.result?.contents?.find(
    (item) => item.uri === "skill://voice-to-memo/SKILL.md",
  )?.text;
  if (
    typeof skillText !== "string" ||
    !skillText.includes("name: voice-to-memo") ||
    !skillText.includes('version: "1"') ||
    !skillText.includes("one note per finding")
  ) {
    throw new Error("Job skill is missing or has changed from version 1");
  }

  const transcription = await callTool("transcribe", { url: clipUrl });
  let step = transcription?.step;
  mask(step);
  if (!step) throw new Error("transcribe returned no step token");
  const segments = findSegments(transcription);
  if (!segments) throw new Error("transcribe returned no segments array");

  const notes = segments.flatMap(sentenceNotes);
  if (notes.length === 0) {
    throw new Error("No incident-like transcription segments were found; no notes were submitted");
  }
  if (notes.some((note) => !/@\d+:\d{2}$/.test(note))) {
    throw new Error("A generated note did not end with exactly one @m:ss offset");
  }

  for (const text of notes) {
    const written = await callTool("memo_write", { text, step });
    step = written?.step;
    mask(step);
    if (!step) throw new Error("memo_write returned no step token");
  }

  let search = await callTool("memo_search", { step });
  step = search?.step;
  mask(step);
  if (!step) throw new Error("memo_search returned no step token");
  let stored = extractMemoNotes(search);
  let missing = notes.filter((note) => !stored.includes(note));
  if (missing.length > 0) {
    for (const text of missing) {
      const written = await callTool("memo_write", { text, step });
      step = written?.step;
      mask(step);
      if (!step) throw new Error("memo_write returned no step token during confirmation");
    }
    search = await callTool("memo_search", { step });
    step = search?.step;
    mask(step);
    if (!step) throw new Error("memo_search returned no step token after repair");
    stored = extractMemoNotes(search);
    missing = notes.filter((note) => !stored.includes(note));
  }
  if (missing.length > 0) throw new Error("memo_search still misses one or more findings");

  const resultText = notes.join("\n");
  const submitted = await callTool("submit", {
    result: resultText,
    skillVersion: "1",
    step,
  });
  if (submitted?.status !== "accepted" || typeof submitted?.receipt !== "string") {
    throw new Error("Job 2 submit did not return an accepted result and receipt");
  }
  mask(submitted.receipt);
  return {
    status: submitted.status,
    result: submitted.result,
    receipt: submitted.receipt,
    notes,
    exchangeLog: exchanges,
    server: initialized?.result?.serverInfo ?? null,
  };
}

try {
  const payload = await runJob();
  emitEncrypted(payload);
} catch (error) {
  emitEncrypted({
    status: "failed",
    error: String(error?.message ?? "worker failed"),
    exchangeLog: exchanges,
  });
  process.exitCode = 1;
}
