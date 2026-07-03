export type ReturnStatus =
  | 'Intake'
  | 'Awaiting Info'
  | 'Under Validation'
  | 'Ready for Manager Review'
  | 'Approved'
  | 'Rejected';

export type DocumentType = 'invoice' | 'warranty' | 'payment_proof' | 'product_photo';

export interface PortalUser {
  id: string;
  username: string;
  password: string;
  role: 'admin' | 'customer';
  full_name: string;
  email: string | null;
  created_at: string;
}

export interface ReturnRequest {
  id: string;
  customer_name: string;
  customer_contact: string | null;
  product_name: string;
  product_value: number | null;
  invoice_provided: boolean;
  warranty_provided: boolean;
  payment_confirmation_provided: boolean;
  product_provided: boolean;
  reason: string | null;
  status: ReturnStatus;
  owner: string | null;
  reminder_sent_at: string | null;
  reminder_count: number;
  notes: string | null;
  customer_username: string | null;
  order_id: string | null;
  created_at: string;
  updated_at: string;
}

export type ReturnRequestInput = Omit<
  ReturnRequest,
  'id' | 'created_at' | 'updated_at' | 'reminder_sent_at' | 'reminder_count'
>;

export interface AiMessage {
  id: string;
  return_request_id: string | null;
  customer_username: string;
  message_type: 'reminder' | 'summary' | 'email';
  content: string;
  created_at: string;
}

export interface Order {
  id: string;
  customer_username: string;
  order_number: string;
  product_name: string;
  product_model: string | null;
  product_value: number;
  purchase_date: string;
  warranty_months: number;
  warranty_end_date: string | null;
  is_under_warranty: boolean;
  payment_status: 'paid' | 'pending' | 'refunded';
  payment_method: 'UPI' | 'Card' | 'Cash' | 'EMI';
  payment_reference: string | null;
  return_request_id: string | null;
  created_at: string;
}

export interface DocumentUpload {
  id: string;
  return_request_id: string;
  document_type: DocumentType;
  file_name: string;
  file_url: string;
  file_size: number | null;
  mime_type: string | null;
  ai_verified: boolean;
  ai_verdict: 'valid' | 'invalid' | 'unclear' | null;
  ai_notes: string | null;
  uploaded_at: string;
}

type TableName = 'portal_users' | 'return_requests' | 'orders' | 'document_uploads' | 'ai_messages';

type TableMap = {
  portal_users: PortalUser;
  return_requests: ReturnRequest;
  orders: Order;
  document_uploads: DocumentUpload;
  ai_messages: AiMessage;
};

type QueryResult<T> = { data: T | null; error: { message: string } | null };

export const REQUIRED_DOCS = [
  {
    key: 'invoice_provided',
    uploadType: 'invoice',
    label: 'Invoice',
    description: 'Original purchase invoice for AI validation.',
  },
  {
    key: 'warranty_provided',
    uploadType: 'warranty',
    label: 'Warranty',
    description: 'Warranty card or warranty proof.',
  },
  {
    key: 'payment_confirmation_provided',
    uploadType: 'payment_proof',
    label: 'Payment Proof',
    description: 'UPI, card, EMI, or cash payment proof.',
  },
  {
    key: 'product_provided',
    uploadType: 'product_photo',
    label: 'Product Photo',
    description: 'Clear photo of the product being returned.',
  },
] as const;

const API_BASE = (import.meta.env.VITE_BACKEND_URL as string | undefined) || 'http://127.0.0.1:8000';
const SESSION_TOKEN_KEY = 'return_tracker_session_token';

class LocalQuery<T extends TableName> implements PromiseLike<QueryResult<TableMap[T][]>> {
  private filters: Array<{ column: string; value: unknown }> = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private action: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: Partial<TableMap[T]> | Partial<TableMap[T]>[] | null = null;

  constructor(private table: T) {}

  select(_columns = '*') {
    return this;
  }

  insert(payload: Partial<TableMap[T]> | Partial<TableMap[T]>[]) {
    this.action = 'insert';
    this.payload = payload;
    return this;
  }

  update(payload: Partial<TableMap[T]>) {
    this.action = 'update';
    this.payload = payload;
    return this;
  }

  delete() {
    this.action = 'delete';
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderBy = { column, ascending: options?.ascending ?? true };
    return this;
  }

  async maybeSingle(): Promise<QueryResult<TableMap[T] | null>> {
    const result = await this.execute();
    return { data: result.data?.[0] ?? null, error: result.error };
  }

  async single(): Promise<QueryResult<TableMap[T]>> {
    const result = await this.execute();
    const row = result.data?.[0] ?? null;
    return row ? { data: row, error: null } : { data: null, error: { message: 'No row found' } };
  }

  then<TResult1 = QueryResult<TableMap[T][]>, TResult2 = never>(
    onfulfilled?: ((value: QueryResult<TableMap[T][]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<QueryResult<TableMap[T][]>> {
    return post<QueryResult<TableMap[T][]>>('/api/query', {
      table: this.table,
      action: this.action,
      filters: this.filters,
      order: this.orderBy,
      payload: this.payload,
    });
  }
}

export const localDb = {
  from<T extends TableName>(table: T) {
    return new LocalQuery(table);
  },
};

export function getSessionToken() {
  return sessionStorage.getItem(SESSION_TOKEN_KEY);
}

export function clearSessionToken() {
  const token = getSessionToken();
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  if (token) {
    void post<{ success: boolean }>('/api/logout', { token }, false);
  }
}

export async function authenticate(username: string, password: string): Promise<
  | { success: true; token: string; user: PortalUser }
  | { success: false; error: string }
> {
  const response = await post<
    | { success: true; token: string; user: PortalUser }
    | { success: false; error: string }
  >('/api/login', { username, password }, false);

  if (response.success) {
    sessionStorage.setItem(SESSION_TOKEN_KEY, response.token);
  }
  return response;
}

export async function validateSession(): Promise<
  | { success: true; user: PortalUser }
  | { success: false; error: string }
> {
  const token = getSessionToken();
  if (!token) return { success: false, error: 'No active session' };
  return post('/api/session/validate', { token }, false);
}

export function getMissingDocs(request: ReturnRequest): typeof REQUIRED_DOCS[number][] {
  return REQUIRED_DOCS.filter((doc) => !request[doc.key]);
}

export function completenessPercent(request: ReturnRequest): number {
  const complete = REQUIRED_DOCS.length - getMissingDocs(request).length;
  return Math.round((complete / REQUIRED_DOCS.length) * 100);
}

export async function uploadDocument(file: File, _path: string): Promise<{ url: string; error: string | null }> {
  const dataUrl = await readFileAsDataUrl(file);
  const response = await post<QueryResult<{ url: string; path: string }>>('/api/upload', {
    file_name: file.name,
    mime_type: file.type,
    data_url: dataUrl,
  });

  if (response.error || !response.data) return { url: '', error: response.error?.message ?? 'Upload failed' };
  return { url: response.data.url, error: null };
}

export async function verifyDocument(documentUploadId: string): Promise<{
  success: boolean;
  error?: string;
  [key: string]: unknown;
}> {
  return post('/api/verify-document', { document_upload_id: documentUploadId });
}

type AiEmailResult =
  | { success: true; content: string; customer_email?: string }
  | { success: false; error?: string };

export async function callAiEmail(returnRequestId: string, action: 'email' | 'summary'): Promise<AiEmailResult> {
  const response = await post<AiEmailResult>('/api/ai-email', {
    return_request_id: returnRequestId,
    action,
  });

  if (response.success && response.content) return response;
  if (!response.success) return { success: false, error: response.error ?? 'AI agent did not return content' };
  return { success: false, error: 'AI agent did not return content' };
}

export async function sendEmail(payload: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  return_request_id?: string;
  customer_username?: string;
  message_type?: 'reminder' | 'summary' | 'email';
}): Promise<{
  success: boolean;
  email_sent?: boolean;
  send_error?: string | null;
  error?: string;
}> {
  return post('/api/send-email', payload);
}

async function post<T>(path: string, body: unknown, includeAuth = true): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getSessionToken();
  if (includeAuth && token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    cache: 'no-store',
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (payload) return payload as T;
    return { data: null, error: { message: `Local backend error ${response.status}` } } as T;
  }

  return payload as T;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}
