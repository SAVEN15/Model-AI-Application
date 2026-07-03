# Local Database

This folder is created for local persistence:

- `returns.sqlite3` stores users, orders, return requests, uploaded document metadata, and AI messages.
- `chroma/` stores Chroma vector context used by the local AI agent.

Both are generated automatically by:

```powershell
python backend/main.py
```
