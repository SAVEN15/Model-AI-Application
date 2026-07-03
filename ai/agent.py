from __future__ import annotations

import json
import os
import re
import sqlite3
import urllib.request
from urllib.parse import urlparse
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from datetime import date, datetime

import chromadb
from chromadb.api.types import Documents, EmbeddingFunction, Embeddings


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "db" / "returns.sqlite3"
CHROMA_PATH = ROOT / "db" / "chroma"
UPLOAD_DIR = ROOT / "backend" / "uploads"
REQUIRED_INVOICE_FIELDS = [
  "invoice_number",
  "invoice_date",
  "vendor_name",
  "gst_number",
  "total_amount",
  "customer_name",
  "product_name",
]


@dataclass
class AgentResult:
  success: bool
  content: str
  customer_email: str | None = None
  error: str | None = None


class ReturnAgent:
  """Local AI agent that reasons over SQLite rows, uploaded file metadata, and Chroma context."""

  def __init__(self) -> None:
    self.api_key = os.environ.get("AI_API_KEY", "")
    self.base_url = os.environ.get("AI_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")
    self.model = os.environ.get("AI_MODEL", "google/gemini-2.5-flash")
    self.chroma = chromadb.PersistentClient(path=str(CHROMA_PATH))
    self.collection = self.chroma.get_or_create_collection(
      "return_tracker_context_local",
      embedding_function=LocalEmbeddingFunction(),
    )

  def generate(self, return_request_id: str, action: str) -> AgentResult:
    context = self._load_context(return_request_id)
    if not context:
      return AgentResult(success=False, content="", error="Return request not found")

    fallback = self._fallback_summary(context) if action == "summary" else self._fallback_reminder(context)
    model_content = self._call_model(action, context, fallback)
    content = model_content or fallback
    customer_email = context.get("customer", {}).get("email") or context["request"].get("customer_contact")

    self._store_message(
      return_request_id=return_request_id,
      customer_username=context["request"].get("customer_username") or context["request"]["customer_name"],
      message_type="summary" if action == "summary" else "email",
      content=content,
    )

    if action == "email":
      with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
          """
          UPDATE return_requests
          SET reminder_sent_at = datetime('now'),
              reminder_count = COALESCE(reminder_count, 0) + 1,
              status = CASE WHEN ? > 0 THEN 'Awaiting Info' ELSE status END,
              updated_at = datetime('now')
          WHERE id = ?
          """,
          (len(context["missing_docs"]), return_request_id),
        )

    return AgentResult(success=True, content=content, customer_email=customer_email)

  def verify_document(self, document_upload_id: str) -> dict[str, Any]:
    with sqlite3.connect(DB_PATH) as conn:
      conn.row_factory = sqlite3.Row
      upload = conn.execute("SELECT * FROM document_uploads WHERE id = ?", (document_upload_id,)).fetchone()
      if not upload:
        return {"success": False, "error": "Document not found"}

      request = conn.execute(
        "SELECT * FROM return_requests WHERE id = ?",
        (upload["return_request_id"],),
      ).fetchone()
      if not request:
        return {"success": False, "error": "Return request not found"}

      doc_type = upload["document_type"]
      request_dict = dict(request)
      upload_dict = dict(upload)
      order = None
      if request_dict.get("order_id"):
        order_row = conn.execute("SELECT * FROM orders WHERE id = ?", (request_dict["order_id"],)).fetchone()
        order = dict(order_row) if order_row else None
      validation = self._validate_invoice(request_dict, upload_dict, order) if doc_type == "invoice" else self._validate_supporting_document(upload_dict)
      valid = validation["valid"]
      notes = validation["notes"]
      patch_column = {
        "invoice": "invoice_provided",
        "warranty": "warranty_provided",
        "payment_proof": "payment_confirmation_provided",
        "product_photo": "product_provided",
      }[doc_type]

      conn.execute(
        """
        UPDATE document_uploads
        SET ai_verified = 1, ai_verdict = ?, ai_notes = ?
        WHERE id = ?
        """,
        ("valid" if valid else "invalid", notes, document_upload_id),
      )
      if valid:
        conn.execute(
          f"UPDATE return_requests SET {patch_column} = 1, updated_at = datetime('now') WHERE id = ?",
          (upload["return_request_id"],),
        )
      else:
        conn.execute(
          f"UPDATE return_requests SET {patch_column} = 0, updated_at = datetime('now') WHERE id = ?",
          (upload["return_request_id"],),
        )

    self.index_return(upload["return_request_id"])
    return {"success": True, "ai_verdict": "valid" if valid else "invalid", "ai_notes": notes}

  def index_return(self, return_request_id: str) -> None:
    context = self._load_context(return_request_id)
    if not context:
      return

    text = json.dumps(context, ensure_ascii=False, default=str)
    self.collection.upsert(
      ids=[return_request_id],
      documents=[text],
      metadatas=[{"return_request_id": return_request_id, "product": context["request"]["product_name"]}],
    )

  def _load_context(self, return_request_id: str) -> dict[str, Any] | None:
    with sqlite3.connect(DB_PATH) as conn:
      conn.row_factory = sqlite3.Row
      request = conn.execute("SELECT * FROM return_requests WHERE id = ?", (return_request_id,)).fetchone()
      if not request:
        return None

      request_dict = dict(request)
      order = None
      if request_dict.get("order_id"):
        order_row = conn.execute("SELECT * FROM orders WHERE id = ?", (request_dict["order_id"],)).fetchone()
        order = dict(order_row) if order_row else None

      customer = None
      if request_dict.get("customer_username"):
        customer_row = conn.execute(
          "SELECT * FROM portal_users WHERE username = ?",
          (request_dict["customer_username"],),
        ).fetchone()
        customer = dict(customer_row) if customer_row else None

      uploads = [
        dict(row)
        for row in conn.execute(
          "SELECT * FROM document_uploads WHERE return_request_id = ? ORDER BY uploaded_at DESC",
          (return_request_id,),
        )
      ]
      messages = [
        dict(row)
        for row in conn.execute(
          "SELECT * FROM ai_messages WHERE return_request_id = ? ORDER BY created_at DESC",
          (return_request_id,),
        )
      ]

    missing_docs = self._missing_docs(request_dict)
    vector_context = self._query_chroma(request_dict["product_name"])
    return_window = self._return_window(order)

    return {
      "request": request_dict,
      "order": order,
      "customer": customer,
      "uploads": uploads,
      "messages": messages,
      "missing_docs": missing_docs,
      "return_window": return_window,
      "vector_context": vector_context,
    }

  def _query_chroma(self, query: str) -> list[str]:
    try:
      result = self.collection.query(query_texts=[query], n_results=3)
      return result.get("documents", [[]])[0]
    except Exception:
      return []

  def _missing_docs(self, request: dict[str, Any]) -> list[str]:
    docs = [
      ("invoice_provided", "Invoice"),
      ("product_provided", "Product Photo"),
      ("warranty_provided", "Warranty Details"),
      ("payment_confirmation_provided", "Payment Confirmation"),
    ]
    return [label for key, label in docs if not bool(request.get(key))]

  def _fallback_summary(self, context: dict[str, Any]) -> str:
    req = context["request"]
    order = context.get("order")
    missing = context["missing_docs"]
    return_window = context["return_window"]
    payment_ok = bool(order and order.get("payment_status") == "paid")
    warranty_ok = bool(order and order.get("is_under_warranty"))
    ready = not missing and req["status"] != "Rejected" and return_window["eligible"] and payment_ok and warranty_ok

    return "\n".join(
      [
        f"READINESS SUMMARY - {req['product_name']} ({req['customer_name']})",
        f"Reference: {req['id'][:8].upper()}",
        "",
        "VALIDATION CHECKS:",
        f"- Product value: INR {req.get('product_value') or 0}",
        f"- Invoice: {'Provided' if req.get('invoice_provided') else 'Missing'}",
        f"- Product received/photo: {'Provided' if req.get('product_provided') else 'Missing'}",
        f"- Warranty details: {'Provided' if req.get('warranty_provided') else 'Missing'}",
        f"- Payment confirmation: {'Provided' if req.get('payment_confirmation_provided') else 'Missing'}",
        f"- Local order warranty: {('Under warranty until ' + order['warranty_end_date']) if order and order.get('is_under_warranty') else ('Expired or unavailable')}",
        f"- Local order payment: {(order['payment_status'] + ' via ' + order['payment_method']) if order else 'No linked order'}",
        f"- Return window: {return_window['days_since_purchase']} day(s) since purchase; {'eligible' if return_window['eligible'] else 'not eligible'} because policy allows returns within 10 days",
        "",
        f"MISSING ITEMS: {', '.join(missing) if missing else 'None'}",
        f"VERDICT: {'READY FOR MANAGER REVIEW' if ready else 'NOT READY'}",
        f"RECOMMENDATION: {'Move to manager review.' if ready else 'Collect pending evidence before approval.'}",
      ]
    )

  def _fallback_reminder(self, context: dict[str, Any]) -> str:
    req = context["request"]
    missing = context["missing_docs"]
    missing_text = ", ".join(missing) if missing else "no pending documents"

    return "\n".join(
      [
        f"Dear {req['customer_name']},",
        "",
        f"Thank you for visiting us about your return request for the {req['product_name']}.",
        "",
        f"To continue processing your return, please provide: {missing_text}.",
        "Once received, our team will validate the request and move it for manager review if complete.",
        "",
        f"Reference ID: {req['id'][:8].upper()}",
        "",
        "Regards,",
        "Customer Service Team",
      ]
    )

  def _return_window(self, order: dict[str, Any] | None) -> dict[str, Any]:
    if not order or not order.get("purchase_date"):
      return {"eligible": False, "days_since_purchase": None, "limit_days": 10}
    try:
      purchase = datetime.strptime(order["purchase_date"], "%Y-%m-%d").date()
      today = date.today()
      days = (today - purchase).days
      return {"eligible": 0 <= days <= 10, "days_since_purchase": days, "limit_days": 10}
    except ValueError:
      return {"eligible": False, "days_since_purchase": None, "limit_days": 10}

  def _validate_invoice(self, request: dict[str, Any], upload: dict[str, Any], order: dict[str, Any] | None) -> dict[str, Any]:
    invoice_text = self._read_uploaded_text(upload)
    if not invoice_text:
      return {
        "valid": False,
        "notes": (
          "Invoice Validation: 0/7 fields passed.\n"
          "Invalid invoice: upload a readable .txt invoice containing invoice_number, invoice_date, vendor_name, "
          "gst_number, total_amount, customer_name, and product_name."
        ),
      }

    fields = self._extract_invoice_fields(invoice_text)
    checks = self._invoice_checks(fields, request, order)
    passed = sum(1 for check in checks if check["valid"])
    notes = [f"Invoice Validation: {passed}/7 fields passed."]
    notes.extend(f"{'PASS' if check['valid'] else 'FAIL'} {check['label']}: {check['message']}" for check in checks)

    return {
      "valid": passed == 7,
      "notes": "\n".join(notes),
    }

  def _validate_supporting_document(self, upload: dict[str, Any]) -> dict[str, Any]:
    valid = bool(upload["file_name"])
    label = upload["document_type"].replace("_", " ").title()
    return {
      "valid": valid,
      "notes": f"{label} received from local file store and attached to the return request." if valid else f"{label} file is missing.",
    }

  def _read_uploaded_text(self, upload: dict[str, Any]) -> str:
    file_url = upload.get("file_url") or ""
    file_name = Path(urlparse(file_url).path).name or upload.get("file_name") or ""
    if not file_name.lower().endswith(".txt"):
      return ""

    path = UPLOAD_DIR / file_name
    if not path.exists():
      return ""
    return path.read_text(encoding="utf-8", errors="ignore")

  def _extract_invoice_fields(self, invoice_text: str) -> dict[str, str]:
    ai_fields = self._extract_invoice_fields_with_model(invoice_text)
    if ai_fields:
      return ai_fields
    return self._extract_invoice_fields_locally(invoice_text)

  def _extract_invoice_fields_with_model(self, invoice_text: str) -> dict[str, str] | None:
    if not self.api_key:
      return None
    payload = {
      "model": self.model,
      "messages": [
        {
          "role": "user",
          "content": (
            "Extract invoice fields from this text. Return only valid JSON with keys: "
            "invoice_number, invoice_date, vendor_name, gst_number, total_amount, customer_name, product_name.\n\n"
            f"{invoice_text}"
          ),
        }
      ],
      "temperature": 0,
      "max_tokens": 300,
    }
    try:
      request = urllib.request.Request(
        f"{self.base_url}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"},
        method="POST",
      )
      with urllib.request.urlopen(request, timeout=30) as response:
        data = json.loads(response.read().decode("utf-8"))
      content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
      match = re.search(r"\{.*\}", content, re.DOTALL)
      if not match:
        return None
      parsed = json.loads(match.group(0))
      return {key: str(parsed.get(key, "") or "").strip() for key in REQUIRED_INVOICE_FIELDS}
    except Exception:
      return None

  def _extract_invoice_fields_locally(self, invoice_text: str) -> dict[str, str]:
    aliases = {
      "invoice_number": ["invoice number", "invoice no", "invoice id", "bill number"],
      "invoice_date": ["invoice date", "date", "bill date"],
      "vendor_name": ["vendor name", "seller", "store", "merchant"],
      "gst_number": ["gst number", "gstin", "gst"],
      "total_amount": ["total amount", "amount", "grand total", "invoice total"],
      "customer_name": ["customer name", "buyer", "billed to"],
      "product_name": ["product name", "item", "product"],
    }
    fields: dict[str, str] = {}
    for key, names in aliases.items():
      fields[key] = ""
      for name in [key, key.replace("_", " "), *names]:
        pattern = rf"(?im)^\s*{re.escape(name)}\s*[:=-]\s*(.+?)\s*$"
        match = re.search(pattern, invoice_text)
        if match:
          fields[key] = match.group(1).strip()
          break
    return fields

  def _invoice_checks(self, fields: dict[str, str], request: dict[str, Any], order: dict[str, Any] | None) -> list[dict[str, Any]]:
    expected_amount = float(request.get("product_value") or 0)
    extracted_amount = self._number(fields.get("total_amount", ""))
    expected_date = order.get("purchase_date") if order else ""

    return [
      self._presence_check("Invoice Number", fields.get("invoice_number")),
      self._presence_check("Invoice Date", fields.get("invoice_date"), expected=f"expected order date {expected_date}" if expected_date else ""),
      self._presence_check("Vendor Name", fields.get("vendor_name")),
      {
        "label": "GST Number",
        "valid": bool(re.fullmatch(r"[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]", fields.get("gst_number", "").replace(" ", "").upper())),
        "message": fields.get("gst_number") or "missing or invalid GST format",
      },
      {
        "label": "Total Amount",
        "valid": extracted_amount is not None and expected_amount > 0 and abs(extracted_amount - expected_amount) < 1,
        "message": f"found {fields.get('total_amount') or 'missing'}, expected INR {expected_amount:g}",
      },
      {
        "label": "Customer Name",
        "valid": self._contains(fields.get("customer_name", ""), request.get("customer_name", "")),
        "message": f"found {fields.get('customer_name') or 'missing'}, expected {request.get('customer_name')}",
      },
      {
        "label": "Product Name",
        "valid": self._contains(fields.get("product_name", ""), request.get("product_name", "")),
        "message": f"found {fields.get('product_name') or 'missing'}, expected {request.get('product_name')}",
      },
    ]

  def _presence_check(self, label: str, value: str | None, expected: str = "") -> dict[str, Any]:
    return {
      "label": label,
      "valid": bool(value),
      "message": f"found {value}" + (f", {expected}" if expected and value else "") if value else "missing",
    }

  def _number(self, value: str) -> float | None:
    cleaned = re.sub(r"[^0-9.]", "", value)
    try:
      return float(cleaned) if cleaned else None
    except ValueError:
      return None

  def _contains(self, actual: str, expected: str) -> bool:
    return bool(actual and expected and expected.lower() in actual.lower())

  def _call_model(self, action: str, context: dict[str, Any], fallback: str) -> str | None:
    if not self.api_key:
      return None

    prompt = {
      "role": "user",
      "content": (
        "You are a retail return processing agent. Use the JSON context to produce either a customer reminder "
        "or reviewer readiness summary. Do not mark missing documents as received.\n\n"
        f"Action: {action}\n"
        f"Context: {json.dumps(context, ensure_ascii=False, default=str)}\n\n"
        f"Fallback draft to improve:\n{fallback}"
      ),
    }
    payload = {
      "model": self.model,
      "messages": [prompt],
      "temperature": 0.3,
      "max_tokens": 500,
    }

    try:
      request = urllib.request.Request(
        f"{self.base_url}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
          "Content-Type": "application/json",
          "Authorization": f"Bearer {self.api_key}",
        },
        method="POST",
      )
      with urllib.request.urlopen(request, timeout=30) as response:
        data = json.loads(response.read().decode("utf-8"))
      return data.get("choices", [{}])[0].get("message", {}).get("content")
    except Exception:
      return None

  def _store_message(self, return_request_id: str, customer_username: str, message_type: str, content: str) -> None:
    with sqlite3.connect(DB_PATH) as conn:
      conn.execute(
        """
        INSERT INTO ai_messages (id, return_request_id, customer_username, message_type, content, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        """,
        (f"msg_{os.urandom(8).hex()}", return_request_id, customer_username, message_type, content),
      )


class LocalEmbeddingFunction(EmbeddingFunction[Documents]):
  """Offline embedding function for Chroma, suitable for locked-down laptops."""

  def __call__(self, input: Documents) -> Embeddings:
    return [self._embed(document) for document in input]

  def _embed(self, text: str) -> list[float]:
    vector = [0.0] * 64
    words = re_words(text)
    for word in words:
      bucket = sum(ord(char) for char in word) % len(vector)
      vector[bucket] += 1.0
    length = sum(value * value for value in vector) ** 0.5 or 1.0
    return [value / length for value in vector]


def re_words(text: str) -> list[str]:
  return [part.lower() for part in re.split(r"[^a-zA-Z0-9]+", text) if part]
