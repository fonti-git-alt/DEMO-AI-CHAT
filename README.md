# Fonti Cloud — Valentina

Asistente virtual de atención al cliente para Fonti Cloud. Agenda reuniones directamente en Google Calendar.

## Requisitos

- [Node.js](https://nodejs.org/) v18 o superior
- Una API key de [NVIDIA](https://build.nvidia.com/)
- Credenciales OAuth2 de [Google Cloud](https://console.cloud.google.com/) con Calendar API habilitada

## Instalación

```bash
git clone <URL_DEL_REPO>
cd DEMO-AI-CHAT
npm install
```

## Variables de entorno

Copiar `.env.example` a `.env` y completar:

```bash
cp .env.example .env
```

### NVIDIA API Key

1. Ir a https://build.nvidia.com
2. Click en `Get API Key`

### Google OAuth2

1. Ir a https://console.cloud.google.com
2. Crear proyecto → Habilitar Google Calendar API
3. Ir a Credentials → Create Credentials → OAuth client ID
4. Tipo: **Web Application**
5. En Authorized redirect URIs agregar: `http://localhost:3000/auth/google/callback`
6. Copiar Client ID y Client Secret al `.env`
7. Autorizar una vez visitando `http://localhost:3000/auth/google`

## Uso

```bash
# API (producción / deploy)
npm start

# Local (terminal interactiva)
npm run local
```

### API

```bash
# Enviar mensaje
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hola", "session_id": "test"}'

# Reiniciar sesión
curl -X POST http://localhost:3000/chat/reset \
  -H "Content-Type: application/json" \
  -d '{"session_id": "test"}'

# Estado de conexión Google
curl http://localhost:3000/auth/status
```

### Terminal local

```
🤖 Fonti Cloud — Valentina
Escribí exit para salir.

Tú: Hola
Valentina: Hola, soy Valentina de Fonti Cloud. ¿Cómo te llamás?

Tú: Juan
Valentina: ¡Hola Juan! Encantada. ¿A qué te dedicas?
```

## Stack

- Node.js + ES Modules
- NVIDIA API — MiniMax-M3 (function calling)
- Express (API server)
- Google Calendar API v3 (OAuth2)
- Google Auth Library (token refresh automático)

## Arquitectura

```
aipublic.js (Express, puerto 3000)
    ├── POST /chat              → NVIDIA API + function calling
    ├── GET  /auth/google       → OAuth2 flow
    ├── GET  /auth/status       → Estado de conexión
    └── /calendar/*             → Google Calendar API v3
```

## Notas

- La API key de NVIDIA y los tokens de Google **nunca** se suben al repositorio.
- El modelo MiniMax-M3 soporta function calling para agendar automáticamente.
- El calendario usa timezone `America/Bogota` (-05:00) por defecto.
- Los tokens de OAuth2 se guardan en `tokens/` (excluido del repo).
