# AI-Assisted Retail Return Tracker

Local-first retail return validation app.

## Architecture

```text
frontend React/Vite
  -> backend Python HTTP API
    -> AI agent
      -> SQLite database
      -> local uploaded files
      -> Chroma vector database
    -> response back to frontend
```

## Local Run

Use `npm.cmd` on Windows/TCS laptops because PowerShell may block `npm.ps1`.

Terminal 1:

```powershell
python backend/main.py
```

Terminal 2:

```powershell
npm.cmd run dev
```

Open:

```text
http://127.0.0.1:5173
```

## Demo Login

Admin:

```text
admin / admin
```

Customer:

```text
rajesh / rajesh123
```

## Local Data

- SQLite: `db/returns.sqlite3`
- Chroma: `db/chroma/`
- Uploaded files: `backend/uploads/`

The database seeds the required case study:

- Customer: Rajesh Kumar
- Product: Bluetooth Speaker
- Value: INR 8,000
- Provided: product and invoice
- Missing: warranty details and payment confirmation
- Status: Awaiting Info

## AI Agent

The agent lives in `ai/agent.py`. It:

- Reads return request, order, document, and message rows from SQLite.
- Checks uploaded document metadata from local files.
- Uses Chroma for local retrieval context.
- Calls the configured model when available.
- Falls back to deterministic local summaries/reminders when the model call is blocked.

Configured in `.env`:

```text
AI_API_KEY=...
AI_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=google/gemini-2.5-flash
```
