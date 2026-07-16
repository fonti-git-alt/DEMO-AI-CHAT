import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { OAuth2Client } from 'google-auth-library';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════════════
const INVOKE_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const MODEL = "minimaxai/minimax-m3";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const MAX_HISTORY = 20; // max messages per session before trimming

// ══════════════════════════════════════════════════════════════════════════════
// AI TOOLS
// ══════════════════════════════════════════════════════════════════════════════
const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_events",
      description: "Lista eventos del calendario en un rango de fechas.",
      parameters: {
        type: "object",
        properties: {
          time_min: { type: "string", description: "ISO 8601, ej: 2026-07-15T00:00:00-05:00" },
          time_max: { type: "string", description: "ISO 8601, ej: 2026-07-15T23:59:59-05:00" },
          max_results: { type: "number", description: "Max eventos (default: 10)" },
        },
        required: ["time_min", "time_max"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_event",
      description: "Crea un evento en el calendario. Usá cuando el cliente quiera agendar.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Título, ej: 'Reunión con Juan - Fonti Cloud'" },
          start_time: { type: "string", description: "ISO 8601, ej: 2026-07-16T15:00:00-05:00" },
          end_time: { type: "string", description: "ISO 8601, ej: 2026-07-16T16:00:00-05:00" },
          description: { type: "string", description: "Notas del evento" },
          attendee_email: { type: "string", description: "Email del cliente" },
          timezone: { type: "string", description: "Timezone (default: America/Bogota)" },
        },
        required: ["summary", "start_time", "end_time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_event",
      description: "Modifica un evento existente.",
      parameters: {
        type: "object",
        properties: {
          event_id: { type: "string", description: "ID del evento" },
          summary: { type: "string", description: "Nuevo título" },
          start_time: { type: "string", description: "Nueva fecha/hora ISO 8601" },
          end_time: { type: "string", description: "Nueva fecha/hora fin ISO 8601" },
          timezone: { type: "string", description: "Timezone (default: America/Bogota)" },
        },
        required: ["event_id"],
      },
    },
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ══════════════════════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `Sos Valentina, asistente virtual de Fonti Cloud (instala sistemas de IA para negocios).

Personalidad: amable, breve (2-3 oraciones máx), acento colombiano neutro, usás "tú" (nunca "vos").

Flujo: 1) Presentate y preguntá el nombre. 2) Preguntá a qué se dedica. 3) Entendé sus problemas con clientes. 4) Proponé agendar una llamada.

Reglas: NO vendas, NO inventes precios, respondé en español, sé concista. Si te piden agendar, usá las herramientas del calendario.

TIMEZONE OBLIGATORIO: TODAS las fechas y horas que uses SIEMPRE deben tener offset -05:00 (hora de Bogotá, Colombia). NUNCA envíes fechas sin offset. Ejemplo correcto: 2026-07-16T15:00:00-05:00. Ejemplo INCORRECTO: 2026-07-16T15:00:00 o 2026-07-16T20:00:00Z.`;

// ══════════════════════════════════════════════════════════════════════════════
// SESSION MANAGEMENT (in-memory, per user)
// ══════════════════════════════════════════════════════════════════════════════
const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      messages: [{ role: "system", content: SYSTEM_PROMPT }],
    });
  }
  return sessions.get(sessionId);
}

function trimHistory(messages) {
  // Keep system prompt (index 0) + last N messages
  if (messages.length > MAX_HISTORY + 1) {
    const system = messages[0];
    const recent = messages.slice(-(MAX_HISTORY));
    return [system, ...recent];
  }
  return messages;
}

// ══════════════════════════════════════════════════════════════════════════════
// CALENDAR (direct, no separate server needed)
// ══════════════════════════════════════════════════════════════════════════════
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const TOKENS_DIR = join(__dirname, "tokens");
const TOKENS_PATH = join(TOKENS_DIR, "google_token.json");
const ACCOUNT_PATH = join(TOKENS_DIR, "google_account.json");

const oauth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

function loadSavedTokens() {
  if (!existsSync(TOKENS_PATH)) return null;
  try {
    const raw = readFileSync(TOKENS_PATH, "utf-8");
    const data = JSON.parse(raw);
    oauth2Client.setCredentials(data);
    return data;
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  mkdirSync(TOKENS_DIR, { recursive: true });
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

function saveAccountInfo(info) {
  mkdirSync(TOKENS_DIR, { recursive: true });
  writeFileSync(ACCOUNT_PATH, JSON.stringify(info, null, 2));
}

async function ensureAuth() {
  const tokens = loadSavedTokens();
  if (!tokens) {
    throw new Error("No hay Google Calendar conectado. Visita /auth/google para autorizar.");
  }
  if (tokens.refresh_token) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      saveTokens(credentials);
      oauth2Client.setCredentials(credentials);
    } catch (err) {
      console.error("❌ Token refresh failed:", err.message);
      throw new Error("Token refresh failed. Re-authoriza en /auth/google");
    }
  }
}

async function calendarAuthHeaders() {
  const token = oauth2Client.credentials?.access_token;
  if (!token) throw new Error("No access token");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// ─── Calendar Tool Handler ───────────────────────────────────────────────────
async function handleToolCall(toolCall) {
  const name = toolCall.function.name;
  const args = JSON.parse(toolCall.function.arguments);

  try {
    await ensureAuth();
    const headers = await calendarAuthHeaders();

    let resp;
    switch (name) {
      case "list_events": {
        const params = new URLSearchParams({
          maxResults: String(args.max_results || 10),
          orderBy: "startTime",
          singleEvents: "true",
        });
        if (args.time_min) params.set("timeMin", args.time_min);
        if (args.time_max) params.set("timeMax", args.time_max);
        resp = await fetch(
          `${GOOGLE_CALENDAR_API}/calendars/${CALENDAR_ID}/events?${params}`,
          { headers }
        );
        break;
      }
      case "create_event": {
        const eventBody = {
          summary: args.summary,
          description: args.description || "",
          start: { dateTime: args.start_time, timeZone: args.timezone || "America/Bogota" },
          end: { dateTime: args.end_time, timeZone: args.timezone || "America/Bogota" },
        };
        if (args.attendee_email) {
          eventBody.attendees = [{ email: args.attendee_email }];
        }
        resp = await fetch(
          `${GOOGLE_CALENDAR_API}/calendars/${CALENDAR_ID}/events?sendUpdates=all`,
          { method: "POST", headers, body: JSON.stringify(eventBody) }
        );
        break;
      }
      case "update_event": {
        const getResp = await fetch(
          `${GOOGLE_CALENDAR_API}/calendars/${CALENDAR_ID}/events/${args.event_id}`,
          { headers }
        );
        if (!getResp.ok) return JSON.stringify({ error: await getResp.text() });
        const event = await getResp.json();
        if (args.summary) event.summary = args.summary;
        if (args.start_time) event.start = { dateTime: args.start_time, timeZone: args.timezone || "America/Bogota" };
        if (args.end_time) event.end = { dateTime: args.end_time, timeZone: args.timezone || "America/Bogota" };
        resp = await fetch(
          `${GOOGLE_CALENDAR_API}/calendars/${CALENDAR_ID}/events/${args.event_id}?sendUpdates=all`,
          { method: "PUT", headers, body: JSON.stringify(event) }
        );
        break;
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`❌ Calendar API ${resp.status}:`, errText);
      return JSON.stringify({ error: errText });
    }

    const data = await resp.json();
    // Normalize response
    return JSON.stringify({
      id: data.id,
      summary: data.summary,
      start: data.start?.dateTime,
      end: data.end?.dateTime,
      htmlLink: data.htmlLink,
    });
  } catch (err) {
    return JSON.stringify({ error: String(err) });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// AI
// ══════════════════════════════════════════════════════════════════════════════
const aiHeaders = {
  Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
  Accept: "application/json",
};

function shouldSendTools(messages) {
  const userMessages = messages.filter((m) => m.role === "user");
  return userMessages.length >= 2;
}

async function callAI(messages, retry = 0) {
  const payload = {
    model: MODEL,
    messages,
    max_tokens: 1024,
    temperature: 1.0,
    top_p: 0.95,
    stream: false,
  };

  if (shouldSendTools(messages)) {
    payload.tools = TOOLS;
    payload.tool_choice = "auto";
  }

  try {
    const response = await axios.post(INVOKE_URL, payload, { headers: aiHeaders });
    return response.data.choices[0];
  } catch (error) {
    if (error.response?.status === 429 && retry < MAX_RETRIES) {
      console.log(`⏳ Rate limited, retry ${retry + 1}/${MAX_RETRIES}...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return callAI(messages, retry + 1);
    }
    throw error;
  }
}

async function processResponse(choice, messages) {
  const msg = choice.message;

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    messages.push(msg);

    const seen = new Set();
    const uniqueCalls = msg.tool_calls.filter((tc) => {
      const key = `${tc.function.name}:${tc.function.arguments}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    for (const toolCall of uniqueCalls) {
      const result = await handleToolCall(toolCall);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
      await new Promise((r) => setTimeout(r, 500));
    }

    const nextChoice = await callAI(messages);
    return processResponse(nextChoice, messages);
  }

  return msg.content || "(empty response)";
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES — Chat
// ══════════════════════════════════════════════════════════════════════════════

// Main chat endpoint — works with any platform
app.post("/chat", async (req, res) => {
  try {
    const { message, session_id = "default" } = req.body;

    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }

    const session = getSession(session_id);
    session.messages.push({ role: "user", content: message });
    session.messages = trimHistory(session.messages);

    console.log(`📩 [${session_id}] ${message}`);

    const choice = await callAI(session.messages);
    const reply = await processResponse(choice, session.messages);
    session.messages.push({ role: "assistant", content: reply });

    console.log(`💬 [${session_id}] ${reply}`);

    res.json({
      reply,
      session_id,
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const detail = error.response?.data || error.message;
    console.error(`❌ Chat error:`, detail);
    res.status(status).json({ error: String(detail) });
  }
});

// Reset a session
app.post("/chat/reset", (req, res) => {
  const { session_id = "default" } = req.body;
  sessions.delete(session_id);
  res.json({ reset: true, session_id });
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", model: MODEL, sessions: sessions.size });
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES — Google OAuth2
// ══════════════════════════════════════════════════════════════════════════════
const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "openid",
];

app.get("/auth/google", (_req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
  res.json({ auth_url: authUrl });
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error) return res.status(400).json({ error: `Google auth error: ${error}` });
    if (!code) return res.status(400).json({ error: "No code provided" });

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    saveTokens(tokens);

    const ticket = await oauth2Client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    const accountInfo = {
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      connected_at: new Date().toISOString(),
    };
    saveAccountInfo(accountInfo);

    console.log(`✅ Google Calendar connected: ${accountInfo.email}`);
    res.json({ message: "Google Calendar conectado", account: accountInfo });
  } catch (err) {
    console.error("❌ Auth callback failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/auth/status", (_req, res) => {
  try {
    if (!existsSync(TOKENS_PATH)) return res.json({ connected: false });
    const tokens = loadSavedTokens();
    const account = existsSync(ACCOUNT_PATH)
      ? JSON.parse(readFileSync(ACCOUNT_PATH, "utf-8"))
      : null;
    res.json({ connected: true, has_refresh_token: !!tokens?.refresh_token, account });
  } catch {
    res.json({ connected: false });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES — Calendar (direct API, same as calendar_server.js)
// ══════════════════════════════════════════════════════════════════════════════

app.post("/calendar/list", async (req, res) => {
  try {
    await ensureAuth();
    const { time_min, time_max, max_results = 10 } = req.body;
    const headers = await calendarAuthHeaders();

    const params = new URLSearchParams({
      maxResults: String(max_results),
      orderBy: "startTime",
      singleEvents: "true",
    });
    if (time_min) params.set("timeMin", time_min);
    if (time_max) params.set("timeMax", time_max);

    const resp = await fetch(
      `${GOOGLE_CALENDAR_API}/calendars/${CALENDAR_ID}/events?${params}`,
      { headers }
    );
    if (!resp.ok) throw await resp.text();

    const data = await resp.json();
    const events = (data.items || []).map((e) => ({
      id: e.id,
      summary: e.summary || "(sin título)",
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      description: e.description || "",
      attendees: (e.attendees || []).map((a) => a.email),
    }));

    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/calendar/create", async (req, res) => {
  try {
    await ensureAuth();
    const {
      summary = "Reunión - Fonti Cloud",
      start_time,
      end_time,
      description = "",
      attendee_email,
      timezone = "America/Bogota",
    } = req.body;

    const eventBody = {
      summary,
      description,
      start: { dateTime: start_time, timeZone: timezone },
      end: { dateTime: end_time, timeZone: timezone },
    };
    if (attendee_email) eventBody.attendees = [{ email: attendee_email }];

    const resp = await fetch(
      `${GOOGLE_CALENDAR_API}/calendars/${CALENDAR_ID}/events?sendUpdates=all`,
      {
        method: "POST",
        headers: await calendarAuthHeaders(),
        body: JSON.stringify(eventBody),
      }
    );
    if (!resp.ok) throw await resp.text();

    const created = await resp.json();
    res.json({
      event_id: created.id,
      html_link: created.htmlLink,
      summary: created.summary,
      start: created.start?.dateTime,
      end: created.end?.dateTime,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.put("/calendar/update", async (req, res) => {
  try {
    await ensureAuth();
    const { event_id, summary, start_time, end_time, timezone = "America/Bogota" } = req.body;
    const headers = await calendarAuthHeaders();

    const getResp = await fetch(
      `${GOOGLE_CALENDAR_API}/calendars/${CALENDAR_ID}/events/${event_id}`,
      { headers }
    );
    if (!getResp.ok) throw await getResp.text();
    const event = await getResp.json();

    if (summary) event.summary = summary;
    if (start_time) event.start = { dateTime: start_time, timeZone: timezone };
    if (end_time) event.end = { dateTime: end_time, timeZone: timezone };

    const updateResp = await fetch(
      `${GOOGLE_CALENDAR_API}/calendars/${CALENDAR_ID}/events/${event_id}?sendUpdates=all`,
      { method: "PUT", headers, body: JSON.stringify(event) }
    );
    if (!updateResp.ok) throw await updateResp.text();

    const updated = await updateResp.json();
    res.json({ event_id: updated.id, html_link: updated.htmlLink, summary: updated.summary });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.delete("/calendar/delete", async (req, res) => {
  try {
    await ensureAuth();
    const { event_id } = req.body;

    const resp = await fetch(
      `${GOOGLE_CALENDAR_API}/calendars/${CALENDAR_ID}/events/${event_id}?sendUpdates=all`,
      { method: "DELETE", headers: await calendarAuthHeaders() }
    );
    if (!resp.ok) throw await resp.text();

    res.json({ cancelled: true, event_id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  const hasTokens = existsSync(TOKENS_PATH);
  console.log(`🚀 Fonti Cloud — Valentina API running on port ${PORT}`);
  console.log(`   POST /chat          — send a message`);
  console.log(`   POST /chat/reset    — reset a session`);
  console.log(`   GET  /auth/google   — OAuth2 flow`);
  console.log(`   GET  /auth/status   — connection status`);
  console.log(`   Calendar: /calendar/{list,create,update,delete}`);
  console.log(`   Google Calendar: ${hasTokens ? "✅ Connected" : "⚠️  Not connected"}`);
});
