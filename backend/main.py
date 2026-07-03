from __future__ import annotations

import base64
import json
import os
import re
import sqlite3
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ai.agent import ReturnAgent

DB_DIR = ROOT / "db"
DB_PATH = DB_DIR / "returns.sqlite3"
UPLOAD_DIR = ROOT / "backend" / "uploads"
ENV_PATH = ROOT / ".env"

TABLES = {"portal_users", "return_requests", "orders", "document_uploads", "ai_messages"}
SESSIONS: dict[str, dict] = {}
SESSION_TTL_SECONDS = 30 * 60


def load_env() -> None:
  if not ENV_PATH.exists():
    return
  for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
    if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
      continue
    key, value = line.split("=", 1)
    os.environ.setdefault(key.strip(), value.strip())


def connect() -> sqlite3.Connection:
  conn = sqlite3.connect(DB_PATH)
  conn.row_factory = sqlite3.Row
  return conn


def init_db() -> None:
  DB_DIR.mkdir(exist_ok=True)
  UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

  with connect() as conn:
    conn.executescript(
      """
      CREATE TABLE IF NOT EXISTS portal_users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL,
        full_name TEXT NOT NULL,
        email TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        customer_username TEXT NOT NULL,
        order_number TEXT UNIQUE NOT NULL,
        product_name TEXT NOT NULL,
        product_model TEXT,
        product_value REAL NOT NULL,
        purchase_date TEXT NOT NULL,
        warranty_months INTEGER NOT NULL DEFAULT 12,
        warranty_end_date TEXT,
        is_under_warranty INTEGER NOT NULL DEFAULT 1,
        payment_status TEXT NOT NULL DEFAULT 'paid',
        payment_method TEXT NOT NULL DEFAULT 'UPI',
        payment_reference TEXT,
        return_request_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS return_requests (
        id TEXT PRIMARY KEY,
        customer_name TEXT NOT NULL,
        customer_contact TEXT,
        product_name TEXT NOT NULL,
        product_value REAL,
        invoice_provided INTEGER NOT NULL DEFAULT 0,
        warranty_provided INTEGER NOT NULL DEFAULT 0,
        payment_confirmation_provided INTEGER NOT NULL DEFAULT 0,
        product_provided INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'Intake',
        owner TEXT,
        reminder_sent_at TEXT,
        reminder_count INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        customer_username TEXT,
        order_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS document_uploads (
        id TEXT PRIMARY KEY,
        return_request_id TEXT NOT NULL,
        document_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_url TEXT NOT NULL,
        file_size INTEGER,
        mime_type TEXT,
        ai_verified INTEGER NOT NULL DEFAULT 0,
        ai_verdict TEXT,
        ai_notes TEXT,
        uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ai_messages (
        id TEXT PRIMARY KEY,
        return_request_id TEXT,
        customer_username TEXT NOT NULL,
        message_type TEXT NOT NULL DEFAULT 'email',
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      """
    )
    if conn.execute("SELECT COUNT(*) FROM portal_users").fetchone()[0] == 0:
      seed_db(conn)
    ensure_sample_invoice(conn)


def seed_db(conn: sqlite3.Connection) -> None:
  conn.executescript(
    """
    INSERT INTO portal_users (id, username, password, role, full_name, email) VALUES
      ('user_admin', 'admin', 'admin', 'admin', 'Store Associate', 'associate@local.store'),
      ('user_rajesh', 'rajesh', 'rajesh123', 'customer', 'Rajesh Kumar', 'rajesh.kumar@example.com'),
      ('user_anita', 'anita', 'anita123', 'customer', 'Anita Desai', 'anita.desai@example.com'),
      ('user_vikram', 'vikram', 'vikram123', 'customer', 'Vikram Singh', 'vikram.singh@example.com');

    INSERT INTO orders (
      id, customer_username, order_number, product_name, product_model, product_value,
      purchase_date, warranty_months, warranty_end_date, is_under_warranty,
      payment_status, payment_method, payment_reference, return_request_id
    ) VALUES
      ('order_rajesh_speaker', 'rajesh', 'ORD-RET-1001', 'Bluetooth Speaker', 'BassBox Mini X2', 8000,
       '2026-06-12', 12, '2027-06-12', 1, 'paid', 'UPI', 'UPI-RAJ-8000', 'return_rajesh_speaker'),
      ('order_anita_headphones', 'anita', 'ORD-RET-1002', 'Wireless Headphones', 'AirTune Pro', 5200,
       '2026-05-28', 12, '2027-05-28', 1, 'paid', 'Card', 'CARD-ANITA-5200', NULL),
      ('order_vikram_router', 'vikram', 'ORD-RET-1003', 'Wi-Fi Router', 'NetWave AX1800', 3400,
       '2025-01-18', 12, '2026-01-18', 0, 'paid', 'UPI', 'UPI-VIK-3400', NULL);

    INSERT INTO return_requests (
      id, customer_name, customer_contact, product_name, product_value,
      invoice_provided, warranty_provided, payment_confirmation_provided, product_provided,
      reason, status, owner, notes, customer_username, order_id
    ) VALUES (
      'return_rajesh_speaker', 'Rajesh Kumar', 'rajesh.kumar@example.com', 'Bluetooth Speaker', 8000,
      1, 0, 0, 1,
      'Customer reports intermittent Bluetooth connectivity and wants a return.',
      'Awaiting Info', 'Priya Nair',
      'Product and invoice received during intake. Warranty details and original payment confirmation are pending.',
      'rajesh', 'order_rajesh_speaker'
    );

    INSERT INTO document_uploads (
      id, return_request_id, document_type, file_name, file_url, file_size, mime_type,
      ai_verified, ai_verdict, ai_notes
    ) VALUES
      ('doc_rajesh_invoice', 'return_rajesh_speaker', 'invoice', 'invoice-rajesh-bluetooth-speaker.pdf', '', 156000,
       'application/pdf', 0, 'unclear',
       'Seed invoice ready for text extraction.'),
      ('doc_rajesh_product', 'return_rajesh_speaker', 'product_photo', 'bluetooth-speaker-photo.jpg', '', 90000,
       'image/jpeg', 1, 'valid',
       'Product photo received and linked to the return request.');
    """
  )


def ensure_sample_invoice(conn: sqlite3.Connection) -> None:
  sample = UPLOAD_DIR / "sample-rajesh-invoice.txt"
  if not sample.exists():
    sample.write_text(
      "\n".join(
        [
          "invoice_number: INV-RAJ-1001",
          "invoice_date: 2026-06-12",
          "vendor_name: Retail Electronics Store",
          "gst_number: 29ABCDE1234F1Z5",
          "total_amount: 8000",
          "customer_name: Rajesh Kumar",
          "product_name: Bluetooth Speaker",
        ]
      ),
      encoding="utf-8",
    )
  conn.execute(
    """
    UPDATE document_uploads
    SET file_name = 'sample-rajesh-invoice.txt',
        file_url = 'http://127.0.0.1:8000/uploads/sample-rajesh-invoice.txt',
        mime_type = 'text/plain',
        ai_verified = 0,
        ai_verdict = 'unclear',
        ai_notes = 'Seed invoice ready for text extraction.'
    WHERE id = 'doc_rajesh_invoice'
    """
  )


def rows_to_json(rows: list[sqlite3.Row]) -> list[dict]:
  return [dict(row) for row in rows]


def clean_identifier(value: str) -> str:
  if not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]*", value):
    raise ValueError("Invalid identifier")
  return value


def make_id(prefix: str) -> str:
  return f"{prefix}_{os.urandom(8).hex()}"


def create_session(user: dict) -> str:
  token = make_id("session")
  SESSIONS[token] = {
    "user": {key: value for key, value in user.items() if key != "password"},
    "expires_at": time.time() + SESSION_TTL_SECONDS,
  }
  return token


def validate_session(token: str | None) -> dict | None:
  if not token:
    return None
  session = SESSIONS.get(token)
  if not session or session["expires_at"] < time.time():
    SESSIONS.pop(token, None)
    return None
  session["expires_at"] = time.time() + SESSION_TTL_SECONDS
  return session["user"]


def destroy_session(token: str | None) -> None:
  if token:
    SESSIONS.pop(token, None)


def normalize_row(table: str, payload: dict) -> dict:
  row = dict(payload)
  row.setdefault("id", make_id(table.rstrip("s")))
  if table == "return_requests":
    row.setdefault("reminder_count", 0)
  return row


def query_table(payload: dict) -> list[dict]:
  table = payload.get("table")
  if table not in TABLES:
    raise ValueError("Invalid table")

  action = payload.get("action", "select")
  filters = payload.get("filters", [])
  order = payload.get("order")

  with connect() as conn:
    if action == "insert":
      raw_rows = payload.get("payload")
      rows = raw_rows if isinstance(raw_rows, list) else [raw_rows]
      output = []
      for raw in rows:
        row = normalize_row(table, raw or {})
        columns = [clean_identifier(column) for column in row]
        placeholders = ", ".join("?" for _ in columns)
        conn.execute(
          f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders})",
          [row[column] for column in columns],
        )
        output.append(row)
      return output

    where, params = build_where(filters)

    if action == "update":
      patch = payload.get("payload") or {}
      columns = [clean_identifier(column) for column in patch]
      set_sql = ", ".join(f"{column} = ?" for column in columns)
      if table == "return_requests":
        set_sql = f"{set_sql}, updated_at = datetime('now')" if set_sql else "updated_at = datetime('now')"
      conn.execute(f"UPDATE {table} SET {set_sql} {where}", [patch[column] for column in columns] + params)
      return rows_to_json(conn.execute(f"SELECT * FROM {table} {where}", params).fetchall())

    if action == "delete":
      deleted = rows_to_json(conn.execute(f"SELECT * FROM {table} {where}", params).fetchall())
      conn.execute(f"DELETE FROM {table} {where}", params)
      return deleted

    order_sql = ""
    if order:
      column = clean_identifier(order.get("column", "created_at"))
      direction = "ASC" if order.get("ascending", True) else "DESC"
      order_sql = f" ORDER BY {column} {direction}"
    return rows_to_json(conn.execute(f"SELECT * FROM {table} {where}{order_sql}", params).fetchall())


def build_where(filters: list[dict]) -> tuple[str, list]:
  if not filters:
    return "", []
  clauses = [f"{clean_identifier(item['column'])} = ?" for item in filters]
  params = [item.get("value") for item in filters]
  return "WHERE " + " AND ".join(clauses), params


class Handler(BaseHTTPRequestHandler):
  agent = ReturnAgent()

  def do_OPTIONS(self) -> None:
    self.send_response(204)
    self.send_headers()

  def do_GET(self) -> None:
    parsed = urlparse(self.path)
    if parsed.path.startswith("/uploads/"):
      self.serve_upload(parsed.path.removeprefix("/uploads/"))
      return
    if parsed.path == "/api/health":
      self.json({"ok": True, "database": str(DB_PATH), "ai_model": self.agent.model})
      return
    self.json({"error": "Not found"}, status=404)

  def do_POST(self) -> None:
    parsed = urlparse(self.path)
    body = self.read_json()

    try:
      if parsed.path == "/api/login":
        self.login(body)
      elif parsed.path == "/api/session/validate":
        self.validate_current_session(body)
      elif parsed.path == "/api/logout":
        destroy_session(body.get("token") or self.bearer_token())
        self.json({"success": True})
      elif parsed.path == "/api/query":
        if not self.require_session():
          return
        self.json({"data": query_table(body), "error": None})
      elif parsed.path == "/api/upload":
        if not self.require_session():
          return
        self.json({"data": self.save_upload(body), "error": None})
      elif parsed.path == "/api/verify-document":
        if not self.require_session():
          return
        self.json(self.agent.verify_document(body["document_upload_id"]))
      elif parsed.path == "/api/ai-email":
        if not self.require_session():
          return
        result = self.agent.generate(body["return_request_id"], body.get("action", "email"))
        self.json(result.__dict__)
      elif parsed.path == "/api/send-email":
        if not self.require_session():
          return
        self.save_local_message(body)
        self.json({
          "success": True,
          "email_sent": False,
          "send_error": "Local mode: message stored in SQLite instead of sending email.",
        })
      else:
        self.json({"error": "Not found"}, status=404)
    except Exception as exc:
      self.json({"data": None, "error": {"message": str(exc)}}, status=500)

  def do_PATCH(self) -> None:
    self.json({"error": "Use /api/query"}, status=404)

  def read_json(self) -> dict:
    length = int(self.headers.get("Content-Length", "0"))
    if length == 0:
      return {}
    return json.loads(self.rfile.read(length).decode("utf-8"))

  def login(self, body: dict) -> None:
    username = str(body.get("username", "")).strip().lower()
    password = str(body.get("password", ""))
    with connect() as conn:
      row = conn.execute(
        "SELECT * FROM portal_users WHERE username = ? AND password = ?",
        (username, password),
      ).fetchone()
    if not row:
      self.json({"success": False, "error": "Invalid username or password"}, status=401)
      return
    user = dict(row)
    token = create_session(user)
    user.pop("password", None)
    self.json({"success": True, "token": token, "user": user})

  def validate_current_session(self, body: dict) -> None:
    user = validate_session(body.get("token") or self.bearer_token())
    if not user:
      self.json({"success": False, "error": "Session expired"}, status=401)
      return
    self.json({"success": True, "user": user})

  def bearer_token(self) -> str | None:
    auth = self.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
      return auth.removeprefix("Bearer ").strip()
    return None

  def require_session(self) -> bool:
    if validate_session(self.bearer_token()):
      return True
    self.json({"data": None, "error": {"message": "Unauthorized"}}, status=401)
    return False

  def save_upload(self, body: dict) -> dict:
    filename = re.sub(r"[^a-zA-Z0-9._-]", "_", body["file_name"])
    stored_name = f"{make_id('file')}_{filename}"
    data_url = body["data_url"]
    _, encoded = data_url.split(",", 1)
    target = UPLOAD_DIR / stored_name
    target.write_bytes(base64.b64decode(encoded))
    return {"url": f"http://127.0.0.1:8000/uploads/{stored_name}", "path": str(target)}

  def save_local_message(self, body: dict) -> None:
    with connect() as conn:
      conn.execute(
        """
        INSERT INTO ai_messages (id, return_request_id, customer_username, message_type, content, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        """,
        (
          make_id("msg"),
          body.get("return_request_id"),
          body.get("customer_username") or "unknown",
          body.get("message_type") or "email",
          body.get("text") or body.get("html") or body.get("subject") or "",
        ),
      )

  def serve_upload(self, name: str) -> None:
    target = UPLOAD_DIR / Path(name).name
    if not target.exists():
      self.send_response(404)
      self.end_headers()
      return
    self.send_response(200)
    self.send_header("Access-Control-Allow-Origin", "*")
    self.end_headers()
    self.wfile.write(target.read_bytes())

  def json(self, payload: dict, status: int = 200) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    self.send_response(status)
    self.send_headers(content_type="application/json")
    self.wfile.write(body)

  def send_headers(self, content_type: str = "text/plain") -> None:
    self.send_header("Content-Type", content_type)
    self.send_header("Access-Control-Allow-Origin", "*")
    self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
    self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
    self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
    self.send_header("Pragma", "no-cache")
    self.send_header("Expires", "0")
    self.end_headers()

  def log_message(self, _format: str, *_args) -> None:
    return


def main() -> None:
  load_env()
  init_db()
  agent = ReturnAgent()
  agent.verify_document("doc_rajesh_invoice")
  agent.index_return("return_rajesh_speaker")
  Handler.agent = agent
  server = ThreadingHTTPServer(("127.0.0.1", 8000), Handler)
  print("Local backend running at http://127.0.0.1:8000")
  server.serve_forever()


if __name__ == "__main__":
  main()
