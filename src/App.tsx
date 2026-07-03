import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  localDb,
  ReturnRequest,
  ReturnStatus,
  ReturnRequestInput,
  PortalUser,
  AiMessage,
  Order,
  DocumentUpload,
  DocumentType,
  REQUIRED_DOCS,
  getMissingDocs,
  completenessPercent,
  callAiEmail,
  sendEmail,
  verifyDocument,
  uploadDocument,
  authenticate,
  validateSession,
  clearSessionToken,
} from './lib/localApi';
import {
  STATUS_FLOW,
  statusStyles,
  statusDot,
  formatCurrency,
  formatDate,
  formatDateTime,
} from './lib/ui';
import {
  Plus, Search, ArrowLeft, ArrowRight, Package, FileText, ShieldCheck, Receipt,
  Sparkles, CheckCircle2, AlertTriangle, UserCog, ClipboardList, Store,
  Filter, X, Copy, Check, Clock, IndianRupee, LogOut, Mail,
  Lock, User, Loader2, Upload, FileCheck, FileX, ShoppingCart, Eye,
  ShieldAlert, CreditCard, Calendar,
} from 'lucide-react';

const AI_MODEL_DETAILS = {
  provider: 'Google Gemini',
  model: 'gemini-2.5-flash',
  reason: 'Used for fast multimodal invoice checks and concise customer email generation.',
};

const DOC_ICONS: Record<DocumentType, typeof Package> = {
  product_photo: Package,
  invoice: FileText,
  warranty: ShieldCheck,
  payment_proof: Receipt,
};

function daysSincePurchase(order: Order | null): number | null {
  if (!order?.purchase_date) return null;
  const purchase = new Date(`${order.purchase_date}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - purchase.getTime()) / 86400000);
}

function returnWindowEligible(order: Order | null): boolean {
  const days = daysSincePurchase(order);
  return days !== null && days >= 0 && days <= 10;
}

type AdminCheckpoint = {
  label: string;
  complete: boolean;
  source: string;
  detail: string;
};

function invoicePassedCount(upload: DocumentUpload | undefined): number {
  const match = upload?.ai_notes?.match(/Invoice Validation:\s+(\d+)\/7/i);
  return match ? Number(match[1]) : 0;
}

function buildAdminCheckpoints(request: ReturnRequest, order: Order | null, uploads: DocumentUpload[]): AdminCheckpoint[] {
  const invoiceUpload = uploads.find((upload) => upload.document_type === 'invoice');
  const productUpload = uploads.find((upload) => upload.document_type === 'product_photo');
  const warrantyUpload = uploads.find((upload) => upload.document_type === 'warranty');
  const paymentUpload = uploads.find((upload) => upload.document_type === 'payment_proof');
  const invoiceFieldsPassed = invoicePassedCount(invoiceUpload);
  const days = daysSincePurchase(order);

  return [
    {
      label: 'Return request captured',
      complete: Boolean(request.id && request.customer_name && request.product_name),
      source: 'return_requests',
      detail: `${request.customer_name} - ${request.product_name}`,
    },
    {
      label: 'Linked order found',
      complete: Boolean(order),
      source: 'orders',
      detail: order ? `${order.order_number} for ${order.product_name}` : 'No order_id match in SQLite',
    },
    {
      label: 'Invoice uploaded',
      complete: Boolean(invoiceUpload),
      source: 'document_uploads',
      detail: invoiceUpload ? invoiceUpload.file_name : 'Missing invoice upload',
    },
    {
      label: 'Invoice fields validated',
      complete: invoiceUpload?.ai_verdict === 'valid',
      source: 'AI agent + uploaded txt invoice',
      detail: invoiceUpload ? `${invoiceFieldsPassed}/7 fields passed` : 'No invoice to validate',
    },
    {
      label: 'Product evidence received',
      complete: request.product_provided || productUpload?.ai_verdict === 'valid',
      source: 'return_requests + document_uploads',
      detail: productUpload ? productUpload.file_name : request.product_provided ? 'Marked received during intake' : 'Missing product evidence',
    },
    {
      label: 'Warranty document received',
      complete: request.warranty_provided || warrantyUpload?.ai_verdict === 'valid',
      source: 'return_requests + document_uploads',
      detail: warrantyUpload ? warrantyUpload.file_name : 'Missing customer warranty document',
    },
    {
      label: 'Payment confirmation received',
      complete: request.payment_confirmation_provided || paymentUpload?.ai_verdict === 'valid',
      source: 'return_requests + document_uploads',
      detail: paymentUpload ? paymentUpload.file_name : 'Missing original payment confirmation',
    },
    {
      label: 'SQL warranty eligibility',
      complete: Boolean(order?.is_under_warranty),
      source: 'orders',
      detail: order ? (order.is_under_warranty ? `Valid until ${formatDate(order.warranty_end_date)}` : `Expired on ${formatDate(order.warranty_end_date)}`) : 'No linked order',
    },
    {
      label: 'SQL payment status',
      complete: order?.payment_status === 'paid',
      source: 'orders',
      detail: order ? `${order.payment_status} via ${order.payment_method}` : 'No linked order',
    },
    {
      label: '10-day return window',
      complete: returnWindowEligible(order),
      source: 'orders.purchase_date',
      detail: days === null ? 'No purchase date' : `${days} day(s) since purchase; policy limit is 10 days`,
    },
    {
      label: 'Owner assigned',
      complete: Boolean(request.owner?.trim()),
      source: 'return_requests.owner',
      detail: request.owner || 'Unassigned',
    },
  ];
}


type Session = { user: PortalUser } | null;
type CustomerView = { name: 'orders' } | { name: 'return-flow'; orderId: string } | { name: 'return-detail'; requestId: string };
type AdminView = { name: 'dashboard' } | { name: 'orders' } | { name: 'returns' } | { name: 'documents' } | { name: 'db' } | { name: 'detail'; id: string } | { name: 'create' };

export default function App() {
  const [session, setSession] = useState<Session>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let active = true;

    async function checkSession() {
      const result = await validateSession();
      if (!active) return;
      setSession(result.success ? { user: result.user } : null);
      setChecking(false);
    }

    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) {
        clearSessionToken();
        setSession(null);
        setChecking(false);
      }
    }

    function handlePageHide() {
      clearSessionToken();
      setSession(null);
    }

    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('pagehide', handlePageHide);
    void checkSession();

    return () => {
      active = false;
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, []);

  async function login(username: string, password: string): Promise<string | null> {
    const result = await authenticate(username, password);
    if (!result.success) return result.error ?? 'Login failed.';
    setSession({ user: result.user });
    return null;
  }

  function logout() { clearSessionToken(); setSession(null); }

  if (checking) return <div className="min-h-screen flex items-center justify-center bg-slate-50"><Loader2 className="h-6 w-6 text-slate-400 animate-spin" /></div>;
  if (!session) return <LoginScreen onLogin={login} />;
  if (session.user.role === 'admin') return <AdminPortal user={session.user} onLogout={logout} />;
  return <CustomerPortal user={session.user} onLogout={logout} />;
}

/* ============ LOGIN ============ */
function LoginScreen({ onLogin }: { onLogin: (username: string, password: string) => Promise<string | null> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(''); setLoading(true);
    const loginError = await onLogin(username.trim().toLowerCase(), password);
    setLoading(false);
    if (loginError) setError(loginError);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-100 via-slate-50 to-blue-50 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="h-14 w-14 rounded-xl bg-slate-900 flex items-center justify-center mx-auto mb-4 shadow-lg"><Store className="h-7 w-7 text-white" /></div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">Return Tracker</h1>
          <p className="text-sm text-slate-500 mt-1">Sign in to your portal</p>
        </div>
        <div className="card p-6">
          <form onSubmit={submit} className="space-y-4">
            <div><label className="label">Username</label><div className="relative"><User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" /><input className="input pl-9" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin or customer username" autoFocus /></div></div>
            <div><label className="label">Password</label><div className="relative"><Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" /><input type="password" className="input pl-9" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter password" /></div></div>
            {error && <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div>}
            <button type="submit" disabled={loading} className="btn-primary w-full">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4 rotate-180" />}Sign In</button>
          </form>
          <div className="mt-6 pt-5 border-t border-slate-100">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Demo Credentials</p>
            <div className="space-y-1.5 text-xs text-slate-600">
              <CredRow role="Admin" user="admin" pass="admin" email="saravananam03@gmail.com" />
              <CredRow role="Customer" user="rajesh" pass="rajesh123" email="saroam03@gmail.com" />
              <CredRow role="Customer" user="anita" pass="anita123" email="anita.desai@example.com" />
              <CredRow role="Customer" user="vikram" pass="vikram123" email="vikram.singh@example.com" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CredRow({ role, user, pass, email }: { role: string; user: string; pass: string; email: string }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-slate-50 px-2.5 py-1.5">
      <div><span className="font-medium text-slate-500">{role}</span> <span className="text-slate-400 text-[10px]">{email}</span></div>
      <span className="font-mono text-slate-700">{user} / {pass}</span>
    </div>
  );
}

/* ============ SHARED ============ */
function Header({ user, onLogout, portalLabel, nav, activeNav, onNav }: any) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur-md">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-lg bg-slate-900 flex items-center justify-center"><Store className="h-5 w-5 text-white" /></div>
          <div className="leading-tight"><div className="text-sm font-semibold text-slate-900">Return Tracker</div><div className="text-[11px] text-slate-500">{portalLabel}</div></div>
        </div>
        {nav && (
          <nav className="hidden sm:flex items-center gap-1">
            {nav.map((n: any) => (
              <button key={n.key} onClick={() => onNav(n.key)} className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${activeNav === n.key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{n.label}</button>
            ))}
          </nav>
        )}
        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block"><div className="text-sm font-medium text-slate-700">{user.full_name}</div><div className="text-[11px] text-slate-400 capitalize">{user.role}</div></div>
          <div className="h-8 w-8 rounded-full bg-slate-200 flex items-center justify-center text-sm font-medium text-slate-600">{user.full_name.charAt(0).toUpperCase()}</div>
          <button onClick={onLogout} className="btn-ghost text-xs" title="Sign out"><LogOut className="h-4 w-4" /></button>
        </div>
      </div>
    </header>
  );
}

function ErrorBanner({ error, onClose }: { error: string; onClose: () => void }) {
  return <div className="mb-4 flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /><span className="flex-1">{error}</span><button onClick={onClose} className="text-red-500 hover:text-red-700"><X className="h-4 w-4" /></button></div>;
}

function StatCard({ label, value, icon: Icon, tone }: { label: string; value: number; icon: typeof Package; tone: string }) {
  const tones: Record<string, string> = { slate: 'bg-slate-100 text-slate-600', amber: 'bg-amber-100 text-amber-600', red: 'bg-red-100 text-red-600', emerald: 'bg-emerald-100 text-emerald-600', blue: 'bg-blue-100 text-blue-600' };
  return <div className="card p-4 flex items-center gap-3"><div className={`h-10 w-10 rounded-lg flex items-center justify-center ${tones[tone]}`}><Icon className="h-5 w-5" /></div><div><div className="text-2xl font-semibold text-slate-900 leading-none">{value}</div><div className="text-xs text-slate-500 mt-1">{label}</div></div></div>;
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div className="flex items-start justify-between gap-3"><dt className="text-slate-500 shrink-0">{label}</dt><dd className="text-slate-900 text-right break-words">{value}</dd></div>;
}

/* ============ CUSTOMER PORTAL ============ */
function CustomerPortal({ user, onLogout }: { user: PortalUser; onLogout: () => void }) {
  const [view, setView] = useState<CustomerView>({ name: 'orders' });
  const [orders, setOrders] = useState<Order[]>([]);
  const [requests, setRequests] = useState<ReturnRequest[]>([]);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [ordRes, reqRes, msgRes] = await Promise.all([
      localDb.from('orders').select('*').eq('customer_username', user.username).order('created_at', { ascending: false }),
      localDb.from('return_requests').select('*').eq('customer_username', user.username).order('created_at', { ascending: false }),
      localDb.from('ai_messages').select('*').eq('customer_username', user.username).order('created_at', { ascending: false }),
    ]);
    if (ordRes.error) setError(ordRes.error.message); else setOrders((ordRes.data as Order[]) ?? []);
    if (reqRes.error) setError(reqRes.error.message); else setRequests((reqRes.data as ReturnRequest[]) ?? []);
    if (msgRes.error) setError(msgRes.error.message); else setMessages((msgRes.data as AiMessage[]) ?? []);
    setLoading(false);
  }, [user.username]);

  useEffect(() => { load(); }, [load]);

  async function createReturnRequest(input: ReturnRequestInput): Promise<string | null> {
    const { data, error } = await localDb.from('return_requests').insert(input).select('id').single();
    if (error) { setError(error.message); return null; }
    await load();
    return (data as { id: string }).id;
  }

  async function refreshAfterUpload() { await load(); }

  const nav = [{ key: 'orders', label: 'My Orders' }, { key: 'returns', label: 'My Returns' }, { key: 'messages', label: 'Messages' }];
  const activeNav = view.name === 'orders' ? 'orders' : view.name === 'return-detail' ? 'returns' : 'orders';

  function handleNav(key: string) {
    if (key === 'orders') setView({ name: 'orders' });
    if (key === 'returns' && requests.length > 0) setView({ name: 'return-detail', requestId: requests[0].id });
    if (key === 'messages') setView({ name: 'orders' }); // messages shown in detail
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Header user={user} onLogout={onLogout} portalLabel="Customer Portal" nav={nav} activeNav={activeNav} onNav={handleNav} />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
        {error && <ErrorBanner error={error} onClose={() => setError(null)} />}
        {view.name === 'orders' && <OrdersPage orders={orders} loading={loading} onInitiateReturn={(orderId) => setView({ name: 'return-flow', orderId })} requests={requests} onOpenReturn={(id) => setView({ name: 'return-detail', requestId: id })} />}
        {view.name === 'return-flow' && <ReturnFlow user={user} order={orders.find((o) => o.id === view.orderId)!} onBack={() => setView({ name: 'orders' })} onCreate={createReturnRequest} onCreated={(id) => setView({ name: 'return-detail', requestId: id })} />}
        {view.name === 'return-detail' && <ReturnDetail requestId={view.requestId} requests={requests} messages={messages} onBack={() => setView({ name: 'orders' })} onRefresh={refreshAfterUpload} />}
      </main>
    </div>
  );
}

/* ---- Orders Page ---- */
function OrdersPage({ orders, loading, onInitiateReturn, requests, onOpenReturn }: { orders: Order[]; loading: boolean; onInitiateReturn: (orderId: string) => void; requests: ReturnRequest[]; onOpenReturn: (id: string) => void }) {
  const orderReturnMap = useMemo(() => { const m: Record<string, string> = {}; requests.forEach((r) => { if (r.order_id) m[r.order_id] = r.id; }); return m; }, [requests]);

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">My Orders</h1>
        <p className="text-sm text-slate-500 mt-1">View your purchase history and initiate a return for any order.</p>
      </div>
      {loading ? (
        <div className="card p-12 text-center text-sm text-slate-400">Loading your orders…</div>
      ) : orders.length === 0 ? (
        <div className="card p-12 text-center"><div className="h-14 w-14 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4"><ShoppingCart className="h-7 w-7 text-slate-400" /></div><h3 className="text-base font-medium text-slate-900">No orders found</h3><p className="text-sm text-slate-500 mt-1">Your purchase history will appear here.</p></div>
      ) : (
        <div className="grid gap-3">
          {orders.map((o) => {
            const hasReturn = !!orderReturnMap[o.id];
            return (
              <div key={o.id} className="card p-5">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div className="h-11 w-11 rounded-lg bg-slate-100 flex items-center justify-center shrink-0"><Package className="h-5.5 w-5.5 text-slate-500" /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-slate-900">{o.product_name}</span>
                        {o.product_model && <span className="text-xs text-slate-400">· {o.product_model}</span>}
                      </div>
                      <div className="text-sm text-slate-500 mt-0.5">{o.order_number} · {formatCurrency(o.product_value)}</div>
                      <div className="flex items-center gap-3 mt-2 flex-wrap">
                        <span className="flex items-center gap-1 text-xs text-slate-400"><Calendar className="h-3 w-3" />{formatDate(o.purchase_date)}</span>
                        <span className="flex items-center gap-1 text-xs text-slate-400"><CreditCard className="h-3 w-3" />{o.payment_method} · {o.payment_status}</span>
                        {o.is_under_warranty ? (
                          <span className="flex items-center gap-1 text-xs text-emerald-600 font-medium"><ShieldCheck className="h-3 w-3" />Under warranty until {formatDate(o.warranty_end_date)}</span>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-red-500 font-medium"><ShieldAlert className="h-3 w-3" />Warranty expired</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {hasReturn ? (
                      <button onClick={() => onOpenReturn(orderReturnMap[o.id])} className="btn-secondary text-xs"><Eye className="h-3.5 w-3.5" />View Return</button>
                    ) : (
                      <button onClick={() => onInitiateReturn(o.id)} className="btn-primary text-xs"><ArrowRight className="h-3.5 w-3.5" />Initiate Return</button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---- Return Flow (initiate + upload) ---- */
function ReturnFlow({ user, order, onBack, onCreate, onCreated }: { user: PortalUser; order: Order; onBack: () => void; onCreate: (input: ReturnRequestInput) => Promise<string | null>; onCreated: (id: string) => void }) {
  const [step, setStep] = useState<'reason' | 'upload'>('reason');
  const [reason, setReason] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [uploads, setUploads] = useState<DocumentUpload[]>([]);
  const [uploading, setUploading] = useState<DocumentType | null>(null);
  const [, setVerifying] = useState<string | null>(null);
  const [emailStatus, setEmailStatus] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function startReturn() {
    if (!reason.trim()) return;
    setCreating(true);
    const id = await onCreate({
      customer_name: user.full_name,
      customer_contact: user.email,
      product_name: order.product_name,
      product_value: order.product_value,
      invoice_provided: false,
      warranty_provided: false,
      payment_confirmation_provided: false,
      product_provided: false,
      reason: reason.trim(),
      status: 'Intake',
      owner: null,
      notes: `Return initiated by customer via portal. Order: ${order.order_number}.`,
      customer_username: user.username,
      order_id: order.id,
    });
    setCreating(false);
    if (id) { setRequestId(id); setStep('upload'); }
  }

  async function handleUpload(file: File, docType: DocumentType) {
    if (!requestId) return;
    setUploading(docType);
    const path = `${requestId}/${docType}-${Date.now()}-${file.name}`;
    const { url, error } = await uploadDocument(file, path);
    if (error) { setUploading(null); return; }
    const { data, error: insErr } = await localDb.from('document_uploads').insert({
      return_request_id: requestId,
      document_type: docType,
      file_name: file.name,
      file_url: url,
      file_size: file.size,
      mime_type: file.type,
    }).select('*').single();
    setUploading(null);
    if (insErr) return;
    const newUpload = data as DocumentUpload;
    setUploads((prev) => [...prev, newUpload]);
    // Trigger AI verification
    setVerifying(newUpload.id);
    const result = await verifyDocument(newUpload.id);
    setVerifying(null);
    if (result.success) {
      // Refresh uploads to get AI verdict
      const { data: refreshed } = await localDb.from('document_uploads').select('*').eq('return_request_id', requestId).order('uploaded_at', { ascending: false });
      setUploads((refreshed as DocumentUpload[]) ?? []);
      // Also refresh the return request flags
      const { data: reqData } = await localDb.from('return_requests').select('*').eq('id', requestId).maybeSingle();
      if (reqData) {
        const updated = reqData as ReturnRequest;
        const missing = getMissingDocs(updated);
        // If all docs uploaded, mark as under validation; if not, send email about missing docs
        if (missing.length > 0) {
          await sendMissingDocsEmail(updated);
        } else {
          await localDb.from('return_requests').update({ status: 'Under Validation' }).eq('id', requestId);
        }
      }
    }
  }

  async function sendMissingDocsEmail(req: ReturnRequest) {
    const html = `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Return Request — Invoice Required</h2>
      <p>Dear ${req.customer_name},</p>
      <p>Thank you for initiating a return request for <strong>${req.product_name}</strong> (Ref: ${req.id.slice(0, 8).toUpperCase()}).</p>
      <p>To proceed with your return validation, please upload a readable text invoice through the customer portal.</p>
      <p>Our AI system will scan the invoice and validate the following fields:</p>
      <ul><li>Invoice Number</li><li>Invoice Date</li><li>Vendor Name</li><li>GST Number</li><li>Total Amount</li><li>Customer Name</li><li>Product Name</li></ul>
      <p>Once the invoice is verified, your return will move to validation for manager review.</p>
      <p>Warm regards,<br>Customer Service Team</p>
    </div>`;
    await sendEmail({
      to: user.email!,
      subject: `Return Request ${req.id.slice(0, 8).toUpperCase()} — Invoice Required`,
      html,
      text: html.replace(/<[^>]*>/g, ''),
      return_request_id: req.id,
      customer_username: user.username,
      message_type: 'reminder',
    });
    setEmailStatus(`Email sent to ${user.email} — invoice upload required.`);
  }

  // invoice-only: no multi-doc check needed

  return (
    <div className="animate-fade-in max-w-2xl mx-auto">
      <button onClick={onBack} className="btn-ghost mb-4 -ml-2"><ArrowLeft className="h-4 w-4" />Back to orders</button>
      <h1 className="text-2xl font-semibold text-slate-900 tracking-tight mb-1">Return Request</h1>
      <p className="text-sm text-slate-500 mb-6">{order.product_name} · {order.order_number} · {formatCurrency(order.product_value)}</p>

      {/* Order info card */}
      <div className="card p-5 mb-5">
        <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide mb-3">Order Details</h2>
        <dl className="space-y-2.5 text-sm">
          <Meta label="Product" value={`${order.product_name}${order.product_model ? ` (${order.product_model})` : ''}`} />
          <Meta label="Value" value={formatCurrency(order.product_value)} />
          <Meta label="Purchase Date" value={formatDate(order.purchase_date)} />
          <Meta label="Warranty" value={order.is_under_warranty ? `Valid until ${formatDate(order.warranty_end_date)}` : 'Expired'} />
          <Meta label="Payment" value={`${order.payment_method} · ${order.payment_status}`} />
        </dl>
      </div>

      {step === 'reason' && (
        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">Reason for Return</h2>
          <textarea className="input min-h-[100px] resize-y" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Describe why you want to return this product…" autoFocus />
          <button onClick={startReturn} disabled={creating || !reason.trim()} className="btn-primary w-full">
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            Continue to Invoice Upload
          </button>
        </div>
      )}

      {step === 'upload' && requestId && (
        <div className="space-y-5">
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide mb-1">Upload Invoice</h2>
            <p className="text-xs text-slate-500 mb-4">Upload your invoice as a readable .txt file. The store team will validate it and respond from the admin portal.</p>

            {(() => {
              const upload = uploads.find((u) => u.document_type === 'invoice');
              const isUploading = uploading === 'invoice';
              return (
                <div className={`rounded-lg border p-4 ${upload ? (upload.ai_verdict === 'valid' ? 'border-emerald-300 bg-emerald-50' : upload.ai_verdict === 'invalid' ? 'border-red-300 bg-red-50' : 'border-blue-300 bg-blue-50') : 'border-slate-200 bg-white'}`}>
                  <div className="flex items-start gap-3 mb-3">
                    <div className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 ${upload ? (upload.ai_verdict === 'valid' ? 'bg-emerald-100 text-emerald-600' : upload.ai_verdict === 'invalid' ? 'bg-red-100 text-red-500' : 'bg-blue-100 text-blue-500') : 'bg-slate-100 text-slate-400'}`}>
                      <FileText className="h-5 w-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900">Invoice Scanner</div>
                      <div className="text-xs text-slate-500 mt-0.5">Upload invoice text file for store validation</div>
                    </div>
                  </div>
                  {upload ? (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        {upload.ai_verdict === 'valid' && <span className="badge bg-emerald-100 text-emerald-700"><CheckCircle2 className="h-3 w-3" />Received</span>}
                        {upload.ai_verdict === 'invalid' && <span className="badge bg-red-100 text-red-700"><X className="h-3 w-3" />Store review pending</span>}
                        {upload.ai_verdict === 'unclear' && <span className="badge bg-blue-100 text-blue-700"><Loader2 className="h-3 w-3 animate-spin" />Submitting</span>}
                        {!upload.ai_verified && <span className="badge bg-slate-100 text-slate-600">Pending</span>}
                      </div>
                      <div className="text-xs text-slate-500 truncate mb-2">{upload.file_name}</div>
                      <label className="cursor-pointer mt-3 inline-block">
                        <input type="file" className="hidden" accept=".txt,text/plain" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f, 'invoice'); }} />
                        <span className="btn-secondary text-xs"><Upload className="h-3.5 w-3.5" />Re-upload Invoice</span>
                      </label>
                    </div>
                  ) : isUploading ? (
                    <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Uploading and scanning invoice…</div>
                  ) : (
                    <label className="cursor-pointer block">
                      <input type="file" className="hidden" accept=".txt,text/plain" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f, 'invoice'); }} />
                      <div className="border-2 border-dashed border-slate-300 rounded-lg p-8 text-center hover:border-slate-400 transition">
                        <Upload className="h-8 w-8 text-slate-300 mx-auto mb-2" />
                        <div className="text-sm text-slate-600 font-medium">Click to upload invoice</div>
                        <div className="text-xs text-slate-400 mt-1">TXT invoice file</div>
                      </div>
                    </label>
                  )}
                </div>
              );
            })()}
            {emailStatus && <div className="mt-4 flex items-center gap-2 rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 text-sm text-blue-700"><Mail className="h-4 w-4 shrink-0" />{emailStatus}</div>}
            {uploads.find((u) => u.document_type === 'invoice' && u.ai_verdict === 'valid') && (
              <div className="mt-4 flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Invoice verified! Your return is now under validation. You can check the status in My Returns.
              </div>
            )}
          </div>
          {uploads.find((u) => u.document_type === 'invoice') && (
            <button onClick={() => onCreated(requestId)} className="btn-primary w-full">View Return Status<ArrowRight className="h-4 w-4" /></button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---- Return Detail (customer) ---- */
function ReturnDetail({ requestId, requests, messages, onBack, onRefresh }: { requestId: string; requests: ReturnRequest[]; messages: AiMessage[]; onBack: () => void; onRefresh: () => Promise<void> }) {
  const r = requests.find((x) => x.id === requestId);
  const [uploads, setUploads] = useState<DocumentUpload[]>([]);
  const [uploading, setUploading] = useState<DocumentType | null>(null);

  useEffect(() => {
    async function loadUploads() {
      const { data } = await localDb.from('document_uploads').select('*').eq('return_request_id', requestId).order('uploaded_at', { ascending: false });
      setUploads((data as DocumentUpload[]) ?? []);
    }
    loadUploads();
  }, [requestId]);

  async function handleUpload(file: File, docType: DocumentType) {
    setUploading(docType);
    const path = `${requestId}/${docType}-${Date.now()}-${file.name}`;
    const { url, error } = await uploadDocument(file, path);
    if (error) { setUploading(null); return; }
    const { data } = await localDb.from('document_uploads').insert({
      return_request_id: requestId, document_type: docType, file_name: file.name, file_url: url, file_size: file.size, mime_type: file.type,
    }).select('*').single();
    setUploading(null);
    if (data) {
      setUploads((prev) => [data as DocumentUpload, ...prev]);
      await verifyDocument((data as DocumentUpload).id);
      const { data: refreshed } = await localDb.from('document_uploads').select('*').eq('return_request_id', requestId).order('uploaded_at', { ascending: false });
      setUploads((refreshed as DocumentUpload[]) ?? []);
      await onRefresh();
    }
  }

  if (!r) return <div><button onClick={onBack} className="btn-ghost mb-4 -ml-2"><ArrowLeft className="h-4 w-4" />Back</button><div className="card p-12 text-center text-sm text-slate-400">Return request not found.</div></div>;

  const completeness = completenessPercent(r);
  const reqMessages = messages.filter((m) => m.return_request_id === requestId);

  return (
    <div className="animate-fade-in">
      <button onClick={onBack} className="btn-ghost mb-4 -ml-2"><ArrowLeft className="h-4 w-4" />Back to orders</button>
      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <div className="card p-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-start gap-3">
                <div className="h-12 w-12 rounded-lg bg-slate-100 flex items-center justify-center shrink-0"><Package className="h-6 w-6 text-slate-500" /></div>
                <div>
                  <h1 className="text-xl font-semibold text-slate-900 tracking-tight">{r.product_name}</h1>
                  <p className="text-sm text-slate-500 mt-0.5">Ref: {r.id.slice(0, 8).toUpperCase()}</p>
                  <div className="flex items-center gap-2 mt-2"><span className={`badge ${statusStyles(r.status)}`}>{r.status}</span></div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-400 mb-1">Completeness</div>
                <div className="flex items-center gap-2">
                  <div className="w-24 h-2 rounded-full bg-slate-100 overflow-hidden"><div className={`h-full rounded-full ${completeness === 100 ? 'bg-emerald-500' : completeness >= 50 ? 'bg-blue-500' : 'bg-amber-500'}`} style={{ width: `${completeness}%` }} /></div>
                  <span className="text-sm font-medium text-slate-700">{completeness}%</span>
                </div>
              </div>
            </div>
          </div>

          {/* Invoice Scanner */}
          <div className="card p-5">
            <h2 className="text-base font-semibold text-slate-900 mb-1">Invoice Scanner</h2>
            <p className="text-xs text-slate-500 mb-4">Upload your invoice as a readable .txt file. The store team will review it and respond.</p>
            {(() => {
              const upload = uploads.find((u) => u.document_type === 'invoice');
              const isUploading = uploading === 'invoice';
              return (
                <div className={`rounded-lg border p-4 ${upload ? (upload.ai_verdict === 'valid' ? 'border-emerald-300 bg-emerald-50' : upload.ai_verdict === 'invalid' ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-white') : 'border-amber-200 bg-amber-50/40'}`}>
                  <div className="flex items-start gap-3 mb-3">
                    <div className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 ${upload ? (upload.ai_verdict === 'valid' ? 'bg-emerald-100 text-emerald-600' : upload.ai_verdict === 'invalid' ? 'bg-red-100 text-red-500' : 'bg-slate-100 text-slate-400') : 'bg-amber-100 text-amber-500'}`}><FileText className="h-5 w-5" /></div>
                    <div className="flex-1 min-w-0"><div className="text-sm font-medium text-slate-900">Invoice</div><div className="text-xs text-slate-500 mt-0.5">TXT invoice file</div></div>
                  </div>
                  {upload ? (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        {upload.ai_verdict === 'valid' && <span className="badge bg-emerald-100 text-emerald-700"><CheckCircle2 className="h-3 w-3" />Received</span>}
                        {upload.ai_verdict === 'invalid' && <span className="badge bg-red-100 text-red-700"><X className="h-3 w-3" />Store review pending</span>}
                        {upload.ai_verdict === 'unclear' && <span className="badge bg-slate-100 text-slate-600">Pending</span>}
                      </div>
                      <div className="text-xs text-slate-500 truncate mb-2">{upload.file_name}</div>
                      <label className="cursor-pointer mt-3 inline-block">
                        <input type="file" className="hidden" accept=".txt,text/plain" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f, 'invoice'); }} />
                        <span className="btn-secondary text-xs"><Upload className="h-3.5 w-3.5" />Re-upload Invoice</span>
                      </label>
                    </div>
                  ) : isUploading ? (
                    <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Uploading and scanning…</div>
                  ) : (
                    <label className="cursor-pointer block">
                      <input type="file" className="hidden" accept=".txt,text/plain" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f, 'invoice'); }} />
                      <div className="border-2 border-dashed border-slate-300 rounded-lg p-6 text-center hover:border-slate-400 transition">
                        <Upload className="h-7 w-7 text-slate-300 mx-auto mb-2" />
                        <div className="text-sm text-slate-600 font-medium">Click to upload invoice</div>
                        <div className="text-xs text-slate-400 mt-1">TXT invoice file</div>
                      </div>
                    </label>
                  )}
                </div>
              );
            })()}
          </div>

          {r.reason && <div className="card p-5"><h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Return Reason</h3><p className="text-sm text-slate-700">{r.reason}</p></div>}
        </div>

        {/* Messages sidebar */}
        <div className="space-y-5">
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-slate-700 to-slate-900 flex items-center justify-center"><Sparkles className="h-4 w-4 text-white" /></div>
              <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">AI Messages</h2>
            </div>
            {reqMessages.length === 0 ? <p className="text-sm text-slate-400">No messages yet.</p> : (
              <div className="space-y-3 max-h-[500px] overflow-y-auto">
                {reqMessages.map((m) => <MessageCard key={m.id} message={m} />)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageCard({ message }: { message: AiMessage }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = message.message_type === 'summary' ? ClipboardList : message.message_type === 'reminder' ? AlertTriangle : Mail;
  const typeColor = message.message_type === 'summary' ? 'text-blue-600 bg-blue-100' : message.message_type === 'reminder' ? 'text-amber-600 bg-amber-100' : 'text-slate-600 bg-slate-100';
  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 border-b border-slate-100">
        <div className={`h-6 w-6 rounded-md flex items-center justify-center ${typeColor}`}><Icon className="h-3.5 w-3.5" /></div>
        <span className="text-xs font-medium text-slate-600 capitalize">{message.message_type}</span>
        <span className="text-xs text-slate-400 ml-auto">{formatDate(message.created_at)}</span>
      </div>
      <div className="p-3">
        <pre className={`text-xs text-slate-700 whitespace-pre-wrap font-sans leading-relaxed ${expanded ? '' : 'max-h-24 overflow-hidden'}`}>{message.content}</pre>
        {message.content.length > 200 && <button onClick={() => setExpanded((v) => !v)} className="text-xs text-blue-600 hover:text-blue-800 mt-2 font-medium">{expanded ? 'Show less' : 'Read more'}</button>}
      </div>
    </div>
  );
}

/* ============ ADMIN PORTAL ============ */
function AdminPortal({ user, onLogout }: { user: PortalUser; onLogout: () => void }) {
  const [view, setView] = useState<AdminView>({ name: 'dashboard' });
  const [requests, setRequests] = useState<ReturnRequest[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [uploads, setUploads] = useState<DocumentUpload[]>([]);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [reqRes, ordRes, upRes, msgRes] = await Promise.all([
      localDb.from('return_requests').select('*').order('created_at', { ascending: false }),
      localDb.from('orders').select('*').order('created_at', { ascending: false }),
      localDb.from('document_uploads').select('*').order('uploaded_at', { ascending: false }),
      localDb.from('ai_messages').select('*').order('created_at', { ascending: false }),
    ]);
    if (reqRes.error) setError(reqRes.error.message); else setRequests((reqRes.data as ReturnRequest[]) ?? []);
    if (ordRes.error) setError(ordRes.error.message); else setOrders((ordRes.data as Order[]) ?? []);
    setUploads((upRes.data as DocumentUpload[]) ?? []);
    setMessages((msgRes.data as AiMessage[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function updateRequest(id: string, patch: Partial<ReturnRequestInput>) {
    const { error } = await localDb.from('return_requests').update(patch).eq('id', id);
    if (error) setError(error.message); else await load();
    return !error;
  }

  async function deleteRequest(id: string) {
    const { error } = await localDb.from('return_requests').delete().eq('id', id);
    if (error) setError(error.message); else await load();
  }

  const nav = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'returns', label: 'Returns' },
    { key: 'orders', label: 'Orders' },
    { key: 'documents', label: 'Documents' },
    { key: 'db', label: 'DB Browser' },
  ];
  const activeNav = view.name === 'detail' ? 'returns' : view.name === 'create' ? 'returns' : view.name;

  function handleNav(key: string) {
    if (key === 'dashboard') setView({ name: 'dashboard' });
    if (key === 'returns') setView({ name: 'returns' });
    if (key === 'orders') setView({ name: 'orders' });
    if (key === 'documents') setView({ name: 'documents' });
    if (key === 'db') setView({ name: 'db' });
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Header user={user} onLogout={onLogout} portalLabel="Admin Portal" nav={nav} activeNav={activeNav} onNav={handleNav} />
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        {error && <ErrorBanner error={error} onClose={() => setError(null)} />}
        {view.name === 'dashboard' && <AdminDashboard requests={requests} allOrders={orders} loading={loading} onOpenReturn={(id) => setView({ name: 'detail', id })} />}
        {view.name === 'returns' && <AdminReturns requests={requests} loading={loading} onOpen={(id) => setView({ name: 'detail', id })} onCreate={() => setView({ name: 'create' })} onDelete={deleteRequest} />}
        {view.name === 'orders' && <AdminOrders orders={orders} loading={loading} />}
        {view.name === 'documents' && <AdminDocuments uploads={uploads} requests={requests} loading={loading} />}
        {view.name === 'db' && <AdminDbBrowser requests={requests} orders={orders} uploads={uploads} messages={messages} loading={loading} />}
        {view.name === 'detail' && <AdminDetail id={view.id} requests={requests} orders={orders} uploads={uploads} messages={messages} onBack={() => setView({ name: 'returns' })} onUpdate={updateRequest} onDelete={(id) => { deleteRequest(id); setView({ name: 'returns' }); }} />}
        {view.name === 'create' && <AdminCreate onBack={() => setView({ name: 'returns' })} orders={orders} onCreate={async (input) => { const { data, error } = await localDb.from('return_requests').insert(input).select('id').single(); if (error) setError(error.message); else { await load(); setView({ name: 'detail', id: (data as any).id }); } }} />}
      </main>
    </div>
  );
}

/* ---- Admin Dashboard ---- */
function AdminDashboard({ requests, allOrders, loading, onOpenReturn }: { requests: ReturnRequest[]; allOrders: Order[]; loading: boolean; onOpenReturn: (id: string) => void }) {
  const stats = useMemo(() => ({
    total: requests.length,
    awaiting: requests.filter((r) => r.status === 'Awaiting Info').length,
    ready: requests.filter((r) => r.status === 'Ready for Manager Review').length,
    incomplete: requests.filter((r) => getMissingDocs(r).length > 0 && r.status !== 'Approved' && r.status !== 'Rejected').length,
    underWarranty: allOrders.filter((o) => o.is_under_warranty).length,
    warrantyExpired: allOrders.filter((o) => !o.is_under_warranty).length,
    paidOrders: allOrders.filter((o) => o.payment_status === 'paid').length,
    pendingPayments: allOrders.filter((o) => o.payment_status === 'pending').length,
  }), [requests, allOrders]);

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">Dashboard</h1>
        <p className="text-sm text-slate-500 mt-1">Overview of return requests, warranty status, and payments. This view is read-only.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total Returns" value={stats.total} icon={ClipboardList} tone="slate" />
        <StatCard label="Awaiting Info" value={stats.awaiting} icon={Clock} tone="amber" />
        <StatCard label="Missing Documents" value={stats.incomplete} icon={AlertTriangle} tone="red" />
        <StatCard label="Ready for Review" value={stats.ready} icon={CheckCircle2} tone="emerald" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard label="Under Warranty" value={stats.underWarranty} icon={ShieldCheck} tone="emerald" />
        <StatCard label="Warranty Expired" value={stats.warrantyExpired} icon={ShieldAlert} tone="red" />
        <StatCard label="Payments Confirmed" value={stats.paidOrders} icon={CreditCard} tone="blue" />
        <StatCard label="Payments Pending" value={stats.pendingPayments} icon={AlertTriangle} tone="amber" />
      </div>

      <div className="card p-5">
        <h2 className="text-base font-semibold text-slate-900 mb-4">Recent Return Requests</h2>
        {loading ? <div className="text-sm text-slate-400 py-8 text-center">Loading…</div> : requests.length === 0 ? <div className="text-sm text-slate-400 py-8 text-center">No return requests.</div> : (
          <div className="space-y-2">
            {requests.slice(0, 5).map((r) => {
              const missing = getMissingDocs(r);
              return (
                <div key={r.id} onClick={() => onOpenReturn(r.id)} className="flex items-center justify-between rounded-lg border border-slate-100 px-4 py-3 hover:border-slate-300 hover:bg-slate-50 cursor-pointer transition">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-9 w-9 rounded-lg bg-slate-100 flex items-center justify-center shrink-0"><Package className="h-4.5 w-4.5 text-slate-500" /></div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{r.product_name}</div>
                      <div className="text-xs text-slate-500">{r.customer_name} · {formatDate(r.created_at)}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {missing.length > 0 && <span className="text-xs text-amber-600 font-medium">{missing.length} missing</span>}
                    <span className={`badge ${statusStyles(r.status)}`}>{r.status}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- Admin Returns List ---- */
function AdminReturns({ requests, loading, onOpen, onCreate, onDelete }: { requests: ReturnRequest[]; loading: boolean; onOpen: (id: string) => void; onCreate: () => void; onDelete: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ReturnStatus | 'all'>('all');
  const filtered = useMemo(() => requests.filter((r) => {
    const mq = !query || r.customer_name.toLowerCase().includes(query.toLowerCase()) || r.product_name.toLowerCase().includes(query.toLowerCase()) || (r.owner ?? '').toLowerCase().includes(query.toLowerCase());
    const ms = statusFilter === 'all' || r.status === statusFilter;
    return mq && ms;
  }), [requests, query, statusFilter]);

  return (
    <div className="animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
        <div><h1 className="text-2xl font-semibold text-slate-900 tracking-tight">Return Requests</h1><p className="text-sm text-slate-500 mt-1">Validate and track customer returns before approval.</p></div>
        <button onClick={onCreate} className="btn-primary self-start sm:self-auto"><Plus className="h-4 w-4" />New Return Request</button>
      </div>
      <div className="card p-4 mb-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1"><Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" /><input className="input pl-9" placeholder="Search customer, product, or owner…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          <div className="relative"><Filter className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" /><select className="input pl-9 pr-8 appearance-none cursor-pointer" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as ReturnStatus | 'all')}><option value="all">All statuses</option>{STATUS_FLOW.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
        </div>
      </div>
      {loading ? <div className="card p-12 text-center text-sm text-slate-400">Loading…</div> : filtered.length === 0 ? <div className="card p-12 text-center"><div className="h-14 w-14 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4"><Package className="h-7 w-7 text-slate-400" /></div><h3 className="text-base font-medium text-slate-900">No matching requests</h3></div> : (
        <div className="grid gap-3">
          {filtered.map((r) => {
            const missing = getMissingDocs(r);
            const completeness = completenessPercent(r);
            return (
              <div key={r.id} onClick={() => onOpen(r.id)} className="card p-4 hover:shadow-md hover:border-slate-300 transition-all cursor-pointer group">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div className="h-10 w-10 rounded-lg bg-slate-100 flex items-center justify-center shrink-0"><Package className="h-5 w-5 text-slate-500" /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap"><span className="font-medium text-slate-900 truncate">{r.product_name}</span><span className={`badge ${statusStyles(r.status)}`}>{r.status}</span></div>
                      <div className="text-sm text-slate-500 mt-0.5 truncate">{r.customer_name} · {formatCurrency(r.product_value)}</div>
                      <div className="flex items-center gap-3 mt-2 text-xs text-slate-400"><span className="flex items-center gap-1"><span className={`h-1.5 w-1.5 rounded-full ${statusDot(r.status)}`} />{r.owner ?? 'Unassigned'}</span><span>·</span><span>{formatDate(r.created_at)}</span>{missing.length > 0 && <><span>·</span><span className="text-amber-600 font-medium">{missing.length} doc(s) missing</span></>}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="hidden sm:flex flex-col items-end"><div className="text-xs text-slate-400 mb-1">{completeness}% complete</div><div className="w-24 h-1.5 rounded-full bg-slate-100 overflow-hidden"><div className={`h-full rounded-full ${completeness === 100 ? 'bg-emerald-500' : completeness >= 50 ? 'bg-blue-500' : 'bg-amber-500'}`} style={{ width: `${completeness}%` }} /></div></div>
                    <button onClick={(e) => { e.stopPropagation(); onDelete(r.id); }} className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-red-500 p-1"><X className="h-4 w-4" /></button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---- Admin Orders (read-only) ---- */
function AdminOrders({ orders, loading }: { orders: Order[]; loading: boolean }) {
  return (
    <div className="animate-fade-in">
      <div className="mb-6"><h1 className="text-2xl font-semibold text-slate-900 tracking-tight">All Orders</h1><p className="text-sm text-slate-500 mt-1">Backend order records with warranty and payment status. Read-only view.</p></div>
      {loading ? <div className="card p-12 text-center text-sm text-slate-400">Loading…</div> : orders.length === 0 ? <div className="card p-12 text-center text-sm text-slate-400">No orders.</div> : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold text-slate-600">Order #</th>
                  <th className="text-left px-4 py-3 font-semibold text-slate-600">Customer</th>
                  <th className="text-left px-4 py-3 font-semibold text-slate-600">Product</th>
                  <th className="text-right px-4 py-3 font-semibold text-slate-600">Value</th>
                  <th className="text-left px-4 py-3 font-semibold text-slate-600">Purchased</th>
                  <th className="text-left px-4 py-3 font-semibold text-slate-600">Warranty</th>
                  <th className="text-left px-4 py-3 font-semibold text-slate-600">Payment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {orders.map((o) => (
                  <tr key={o.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono text-xs text-slate-700">{o.order_number}</td>
                    <td className="px-4 py-3 text-slate-700">{o.customer_username}</td>
                    <td className="px-4 py-3 text-slate-900 font-medium">{o.product_name}</td>
                    <td className="px-4 py-3 text-right text-slate-700">{formatCurrency(o.product_value)}</td>
                    <td className="px-4 py-3 text-slate-500">{formatDate(o.purchase_date)}</td>
                    <td className="px-4 py-3">
                      {o.is_under_warranty ? <span className="badge bg-emerald-100 text-emerald-700"><ShieldCheck className="h-3 w-3" />Valid until {formatDate(o.warranty_end_date)}</span> : <span className="badge bg-red-100 text-red-700"><ShieldAlert className="h-3 w-3" />Expired</span>}
                    </td>
                    <td className="px-4 py-3"><span className={`badge ${o.payment_status === 'paid' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>{o.payment_method} · {o.payment_status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- Admin Documents (read-only) ---- */
function AdminDocuments({ uploads, requests, loading }: { uploads: DocumentUpload[]; requests: ReturnRequest[]; loading: boolean }) {
  return (
    <div className="animate-fade-in">
      <div className="mb-6"><h1 className="text-2xl font-semibold text-slate-900 tracking-tight">Uploaded Documents</h1><p className="text-sm text-slate-500 mt-1">All documents uploaded by customers with AI verification results. Read-only view.</p></div>
      {loading ? <div className="card p-12 text-center text-sm text-slate-400">Loading…</div> : uploads.length === 0 ? <div className="card p-12 text-center text-sm text-slate-400">No documents uploaded yet.</div> : (
        <div className="grid gap-3">
          {uploads.map((u) => {
            const req = requests.find((r) => r.id === u.return_request_id);
            const Icon = DOC_ICONS[u.document_type];
            return (
              <div key={u.id} className="card p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 ${u.ai_verdict === 'valid' ? 'bg-emerald-100 text-emerald-600' : u.ai_verdict === 'invalid' ? 'bg-red-100 text-red-500' : 'bg-slate-100 text-slate-400'}`}><Icon className="h-5 w-5" /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-slate-900 capitalize">{u.document_type.replace('_', ' ')}</span>
                        {u.ai_verdict === 'valid' && <span className="badge bg-emerald-100 text-emerald-700"><FileCheck className="h-3 w-3" />AI Verified</span>}
                        {u.ai_verdict === 'invalid' && <span className="badge bg-red-100 text-red-700"><FileX className="h-3 w-3" />AI Rejected</span>}
                        {u.ai_verdict === 'unclear' && <span className="badge bg-slate-100 text-slate-600">Pending</span>}
                      </div>
                      <div className="text-sm text-slate-500 mt-0.5 truncate">{u.file_name}</div>
                      {req && <div className="text-xs text-slate-400 mt-0.5">{req.customer_name} · {req.product_name}</div>}
                      {u.ai_notes && <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">{u.ai_notes}</p>}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs text-slate-400">{formatDateTime(u.uploaded_at)}</div>
                    <a href={u.file_url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:text-blue-800 mt-1 inline-flex items-center gap-1"><Eye className="h-3 w-3" />View file</a>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AdminDbBrowser({ requests, orders, uploads, messages, loading }: { requests: ReturnRequest[]; orders: Order[]; uploads: DocumentUpload[]; messages: AiMessage[]; loading: boolean }) {
  const [activeTable, setActiveTable] = useState<'return_requests' | 'orders' | 'document_uploads' | 'ai_messages' | 'portal_users'>('return_requests');
  const [users, setUsers] = useState<PortalUser[]>([]);

  useEffect(() => {
    async function loadUsers() {
      const { data } = await localDb.from('portal_users').select('*').order('created_at', { ascending: false });
      setUsers((data as PortalUser[]) ?? []);
    }
    loadUsers();
  }, []);

  const tables = {
    return_requests: requests,
    orders,
    document_uploads: uploads,
    ai_messages: messages,
    portal_users: users.map((user) => ({ ...user, password: '***' })),
  };
  const rows = tables[activeTable] as Record<string, unknown>[];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">Local DB Browser</h1>
        <p className="text-sm text-slate-500 mt-1">Read-only view of the SQLite tables used by the backend.</p>
      </div>
      <div className="card p-4 mb-4">
        <div className="flex flex-wrap gap-2">
          {(Object.keys(tables) as Array<keyof typeof tables>).map((table) => (
            <button key={table} onClick={() => setActiveTable(table)} className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${activeTable === table ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
              {table} ({tables[table].length})
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <div className="card p-12 text-center text-sm text-slate-400">Loading database rows...</div>
      ) : rows.length === 0 ? (
        <div className="card p-12 text-center text-sm text-slate-400">No rows in {activeTable}.</div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-auto max-h-[620px]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 border-b border-slate-200">
                <tr>
                  {columns.map((column) => <th key={column} className="text-left px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">{column}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row, index) => (
                  <tr key={`${activeTable}-${index}`} className="hover:bg-slate-50">
                    {columns.map((column) => (
                      <td key={column} className="px-3 py-2 text-slate-700 align-top max-w-[280px]">
                        <span className="block truncate" title={String(row[column] ?? '')}>{String(row[column] ?? '')}</span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- Admin Detail ---- */
function AdminDetail({ id, requests, orders, uploads, messages, onBack, onUpdate, onDelete }: { id: string; requests: ReturnRequest[]; orders: Order[]; uploads: DocumentUpload[]; messages: AiMessage[]; onBack: () => void; onUpdate: (id: string, patch: Partial<ReturnRequestInput>) => Promise<boolean>; onDelete: (id: string) => void }) {
  const r = requests.find((x) => x.id === id);
  const [editingOwner, setEditingOwner] = useState(false);
  const [ownerValue, setOwnerValue] = useState('');
  const [aiContent, setAiContent] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [emailSent, setEmailSent] = useState<string | null>(null);

  useEffect(() => { if (r) setOwnerValue(r.owner ?? ''); }, [r?.id]);

  if (!r) return <div><button onClick={onBack} className="btn-ghost mb-4 -ml-2"><ArrowLeft className="h-4 w-4" />Back</button><div className="card p-12 text-center text-sm text-slate-400">Request not found.</div></div>;

  const missing = getMissingDocs(r);
  const completeness = completenessPercent(r);
  const reqUploads = uploads.filter((u) => u.return_request_id === id);
  const reqMessages = messages.filter((m) => m.return_request_id === id);
  const linkedOrder = orders.find((order) => order.id === r.order_id) ?? null;
  const daysFromPurchase = daysSincePurchase(linkedOrder);
  const isReturnEligible = returnWindowEligible(linkedOrder);
  const adminCheckpoints = buildAdminCheckpoints(r, linkedOrder, reqUploads);
  const finishedCheckpoints = adminCheckpoints.filter((checkpoint) => checkpoint.complete).length;

  async function saveOwner() { await onUpdate(r!.id, { owner: ownerValue.trim() || null }); setEditingOwner(false); }
  async function setStatus(status: ReturnStatus) { await onUpdate(r!.id, { status }); }

  async function generateAndSendEmail() {
    setAiLoading(true); setAiError(null); setAiContent(null); setEmailSent(null);
    const result = await callAiEmail(r!.id, 'email');
    setAiLoading(false);
    if (result.success) {
      setAiContent(result.content);
      const targetEmail = result.customer_email || r!.customer_contact || '';
      // Send the actual email
      const emailResult = await sendEmail({
        to: targetEmail,
        subject: `Return Request ${r!.id.slice(0, 8).toUpperCase()} — Status Update from Store`,
        text: result.content,
        html: result.content.replace(/\n/g, '<br>'),
        return_request_id: r!.id,
        customer_username: r!.customer_username || r!.customer_name,
        message_type: 'email',
      });
      if (emailResult.email_sent) setEmailSent(`Email sent to ${targetEmail}`);
      else setEmailSent(emailResult.send_error || `Email stored in portal (not physically sent — configure RESEND_API_KEY). Target: ${targetEmail}`);
    } else {
      setAiError(result.error ?? 'Failed to generate');
    }
  }

  async function generateSummary() {
    setAiLoading(true); setAiError(null); setAiContent(null);
    const result = await callAiEmail(r!.id, 'summary');
    setAiLoading(false);
    if (result.success) setAiContent(result.content);
    else setAiError(result.error ?? 'Failed to generate');
  }

  function copyContent() { if (aiContent) { navigator.clipboard.writeText(aiContent); setCopied(true); setTimeout(() => setCopied(false), 2000); } }

  return (
    <div className="animate-fade-in">
      <button onClick={onBack} className="btn-ghost mb-4 -ml-2"><ArrowLeft className="h-4 w-4" />Back to returns</button>
      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <div className="card p-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-start gap-3">
                <div className="h-12 w-12 rounded-lg bg-slate-100 flex items-center justify-center shrink-0"><Package className="h-6 w-6 text-slate-500" /></div>
                <div>
                  <h1 className="text-xl font-semibold text-slate-900 tracking-tight">{r.product_name}</h1>
                  <p className="text-sm text-slate-500 mt-0.5">{r.customer_name} · {formatCurrency(r.product_value)}</p>
                  <div className="flex items-center gap-2 mt-2"><span className={`badge ${statusStyles(r.status)}`}>{r.status}</span><span className="text-xs text-slate-400">Ref: {r.id.slice(0, 8).toUpperCase()}</span></div>
                </div>
              </div>
              <div className="text-right"><div className="text-xs text-slate-400 mb-1">Completeness</div><div className="flex items-center gap-2"><div className="w-28 h-2 rounded-full bg-slate-100 overflow-hidden"><div className={`h-full rounded-full ${completeness === 100 ? 'bg-emerald-500' : completeness >= 50 ? 'bg-blue-500' : 'bg-amber-500'}`} style={{ width: `${completeness}%` }} /></div><span className="text-sm font-medium text-slate-700">{completeness}%</span></div></div>
            </div>
          </div>

          <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <div><h2 className="text-base font-semibold text-slate-900">Invoice Validation</h2><p className="text-xs text-slate-500 mt-0.5">AI-scanned invoice with 7-field validation, cross-checked against backend tables. {AI_MODEL_DETAILS.provider} {AI_MODEL_DETAILS.model}.</p></div>
              {missing.length > 0 && <span className="badge bg-amber-100 text-amber-800"><AlertTriangle className="h-3 w-3" />No valid invoice</span>}
            </div>
            {(() => {
              const invoiceUpload = reqUploads.find((u) => u.document_type === 'invoice');
              if (!invoiceUpload) {
                return <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-4 text-sm text-slate-500">No invoice uploaded yet. The customer needs to upload an invoice through the customer portal.</div>;
              }
              return (
                <div className={`rounded-lg border p-4 ${invoiceUpload.ai_verdict === 'valid' ? 'border-emerald-300 bg-emerald-50' : invoiceUpload.ai_verdict === 'invalid' ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-white'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    {invoiceUpload.ai_verdict === 'valid' && <span className="badge bg-emerald-100 text-emerald-700"><CheckCircle2 className="h-3 w-3" />Valid — All 7 fields passed</span>}
                    {invoiceUpload.ai_verdict === 'invalid' && <span className="badge bg-red-100 text-red-700"><X className="h-3 w-3" />Invalid - Some fields failed</span>}
                    {invoiceUpload.ai_verdict === 'unclear' && <span className="badge bg-slate-100 text-slate-600">Pending verification</span>}
                    <span className="text-xs text-slate-500 truncate">{invoiceUpload.file_name}</span>
                    <a href={invoiceUpload.file_url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:text-blue-800 inline-flex items-center gap-1 ml-auto"><Eye className="h-3 w-3" />View</a>
                  </div>
                  {invoiceUpload.ai_notes && (
                    <div className="rounded-md bg-white border border-slate-200 p-3 mt-2">
                      <div className="text-xs font-semibold text-slate-700 mb-1.5">AI Field Validation Results:</div>
                      <pre className="text-xs text-slate-600 whitespace-pre-wrap font-sans leading-relaxed">{invoiceUpload.ai_notes}</pre>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <div><h2 className="text-base font-semibold text-slate-900">Backend Eligibility Checks</h2><p className="text-xs text-slate-500 mt-0.5">Admin-only checks from SQLite order data and validation flags.</p></div>
              {isReturnEligible && linkedOrder?.is_under_warranty && linkedOrder.payment_status === 'paid' ? (
                <span className="badge bg-emerald-100 text-emerald-700"><CheckCircle2 className="h-3 w-3" />Eligible</span>
              ) : (
                <span className="badge bg-red-100 text-red-700"><AlertTriangle className="h-3 w-3" />Review Required</span>
              )}
            </div>
            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Warranty SQL Check</div>
                <div className={linkedOrder?.is_under_warranty ? 'text-emerald-700 font-medium' : 'text-red-700 font-medium'}>
                  {linkedOrder ? (linkedOrder.is_under_warranty ? `Valid until ${formatDate(linkedOrder.warranty_end_date)}` : `Expired on ${formatDate(linkedOrder.warranty_end_date)}`) : 'No linked order'}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Return Window</div>
                <div className={isReturnEligible ? 'text-emerald-700 font-medium' : 'text-red-700 font-medium'}>
                  {daysFromPurchase === null ? 'No purchase date' : `${daysFromPurchase} day(s) since purchase; ${isReturnEligible ? 'within 10-day policy' : 'past 10-day policy'}`}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Payment SQL Check</div>
                <div className={linkedOrder?.payment_status === 'paid' ? 'text-emerald-700 font-medium' : 'text-amber-700 font-medium'}>
                  {linkedOrder ? `${linkedOrder.payment_status} via ${linkedOrder.payment_method}` : 'No linked order'}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Required Evidence</div>
                <div className={missing.length === 0 ? 'text-emerald-700 font-medium' : 'text-amber-700 font-medium'}>
                  {missing.length === 0 ? 'All required evidence received' : `${missing.map((doc) => doc.label).join(', ')} missing`}
                </div>
              </div>
            </div>
          </div>

          <div className="card p-5">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">Admin Processing Checkpoints</h2>
                <p className="text-xs text-slate-500 mt-0.5">Each checkpoint is resolved from SQLite tables, uploaded files, or the local AI agent.</p>
              </div>
              <span className={`badge ${finishedCheckpoints === adminCheckpoints.length ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                {finishedCheckpoints}/{adminCheckpoints.length} finished
              </span>
            </div>
            <div className="grid gap-2">
              {adminCheckpoints.map((checkpoint) => (
                <div key={checkpoint.label} className={`rounded-lg border px-3 py-2.5 ${checkpoint.complete ? 'border-emerald-200 bg-emerald-50/60' : 'border-red-200 bg-red-50/60'}`}>
                  <div className="flex items-start gap-2">
                    {checkpoint.complete ? <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" /> : <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-slate-900">{checkpoint.label}</div>
                        <span className={`text-xs font-semibold ${checkpoint.complete ? 'text-emerald-700' : 'text-red-700'}`}>{checkpoint.complete ? 'Finished' : 'Not finished'}</span>
                      </div>
                      <div className="text-xs text-slate-600 mt-0.5">{checkpoint.detail}</div>
                      <div className="text-[11px] text-slate-400 mt-1">Source: {checkpoint.source}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* AI Assistant */}
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div className="flex items-center gap-2"><div className="h-8 w-8 rounded-lg bg-gradient-to-br from-slate-700 to-slate-900 flex items-center justify-center"><Sparkles className="h-4 w-4 text-white" /></div><div><h2 className="text-base font-semibold text-slate-900">AI Assistant</h2><p className="text-xs text-slate-500">Cross-checks all backend tables and generates status email. {AI_MODEL_DETAILS.reason}</p></div></div>
            </div>
            <div className="p-5 space-y-4">
              {/* Customer email display */}
              <div className="flex items-center gap-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2.5">
                <Mail className="h-4 w-4 text-slate-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-slate-500">Customer Email</div>
                  <div className="text-sm font-medium text-slate-900 truncate">{r.customer_contact || 'No email on file'}</div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button onClick={generateAndSendEmail} disabled={aiLoading} className="btn-primary text-xs">{aiLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}Generate Status Email to Customer</button>
                <button onClick={generateSummary} disabled={aiLoading} className="btn-secondary text-xs">{aiLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardList className="h-3.5 w-3.5" />}Generate Readiness Summary</button>
              </div>
              {aiError && <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700"><AlertTriangle className="h-4 w-4 shrink-0" />{aiError}</div>}
              {emailSent && <div className="flex items-center gap-2 rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 text-sm text-blue-700"><Mail className="h-4 w-4 shrink-0" />{emailSent}</div>}
              {aiContent && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 animate-fade-in">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-slate-600">AI-Generated Email Content</span>
                    <button onClick={copyContent} className="text-xs text-slate-500 hover:text-slate-900 flex items-center gap-1">{copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}{copied ? 'Copied' : 'Copy'}</button>
                  </div>
                  <div className="flex items-center gap-2 mb-2 text-xs text-slate-500">
                    <Mail className="h-3 w-3" />To: <span className="font-medium text-slate-700">{r.customer_contact || 'No email'}</span>
                  </div>
                  <pre className="text-xs text-slate-700 whitespace-pre-wrap font-sans leading-relaxed max-h-72 overflow-y-auto">{aiContent}</pre>
                </div>
              )}
              {reqMessages.length > 0 && (
                <div><div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Message History ({reqMessages.length})</div><div className="space-y-2 max-h-60 overflow-y-auto">{reqMessages.map((m) => (<div key={m.id} className="rounded-md border border-slate-100 px-3 py-2"><div className="flex items-center gap-2 mb-1"><span className="badge bg-slate-100 text-slate-600 capitalize text-[10px]">{m.message_type}</span><span className="text-[11px] text-slate-400">{formatDateTime(m.created_at)}</span></div><p className="text-xs text-slate-600 line-clamp-2">{m.content}</p></div>))}</div></div>
              )}
            </div>
          </div>

          {(r.reason || r.notes) && <div className="card p-5 space-y-4">{r.reason && <div><h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Return reason</h3><p className="text-sm text-slate-700">{r.reason}</p></div>}{r.notes && <div><h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Notes</h3><p className="text-sm text-slate-700 whitespace-pre-wrap">{r.notes}</p></div>}</div>}
        </div>

        <div className="space-y-5">
          <div className="card p-5"><h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide mb-3">Status</h2><div className="space-y-1.5">{STATUS_FLOW.map((s) => (<button key={s} onClick={() => setStatus(s)} className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-all ${r.status === s ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}><span className={`h-2 w-2 rounded-full ${r.status === s ? 'bg-white' : statusDot(s)}`} />{s}{r.status === s && <Check className="h-3.5 w-3.5 ml-auto" />}</button>))}</div></div>
          <div className="card p-5"><div className="flex items-center gap-2 mb-3"><UserCog className="h-4 w-4 text-slate-500" /><h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">Ownership</h2></div>{editingOwner ? (<div className="space-y-2"><input className="input" value={ownerValue} onChange={(e) => setOwnerValue(e.target.value)} placeholder="Assign to…" autoFocus /><div className="flex gap-2"><button onClick={saveOwner} className="btn-primary text-xs flex-1">Save</button><button onClick={() => setEditingOwner(false)} className="btn-secondary text-xs">Cancel</button></div></div>) : (<button onClick={() => { setOwnerValue(r.owner ?? ''); setEditingOwner(true); }} className="w-full text-left flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 hover:border-slate-300 transition"><span className={`text-sm ${r.owner ? 'text-slate-900 font-medium' : 'text-slate-400 italic'}`}>{r.owner ?? 'Unassigned'}</span><span className="text-xs text-slate-400">Edit</span></button>)}</div>
          <div className="card p-5"><h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide mb-3">Details</h2><dl className="space-y-2.5 text-sm"><Meta label="Customer Email" value={r.customer_contact || '—'} /><Meta label="Value" value={formatCurrency(r.product_value)} /><Meta label="Portal user" value={r.customer_username || '—'} /><Meta label="Created" value={formatDateTime(r.created_at)} /><Meta label="Updated" value={formatDateTime(r.updated_at)} /></dl></div>
          <button onClick={() => { if (confirm('Delete this return request?')) onDelete(r.id); }} className="btn-ghost w-full text-red-500 hover:bg-red-50 text-xs"><X className="h-3.5 w-3.5" />Delete request</button>
        </div>
      </div>
    </div>
  );
}

/* ---- Admin Create ---- */
function AdminCreate({ onBack, orders, onCreate }: { onBack: () => void; orders: Order[]; onCreate: (input: ReturnRequestInput) => Promise<void> }) {
  const [form, setForm] = useState<ReturnRequestInput>({
    customer_name: '', customer_contact: '', product_name: '', product_value: null,
    invoice_provided: false, warranty_provided: false, payment_confirmation_provided: false, product_provided: false,
    reason: '', status: 'Intake', owner: '', notes: '', customer_username: '', order_id: null,
  });
  const [saving, setSaving] = useState(false);
  function set<K extends keyof ReturnRequestInput>(key: K, value: ReturnRequestInput[K]) { setForm((f) => ({ ...f, [key]: value })); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.customer_name.trim() || !form.product_name.trim()) return;
    setSaving(true);
    await onCreate({ ...form, product_value: form.product_value === null ? null : Number(form.product_value) });
    setSaving(false);
  }

  return (
    <div className="animate-fade-in max-w-2xl mx-auto">
      <button onClick={onBack} className="btn-ghost mb-4 -ml-2"><ArrowLeft className="h-4 w-4" />Back</button>
      <h1 className="text-2xl font-semibold text-slate-900 tracking-tight mb-1">New Return Request</h1>
      <p className="text-sm text-slate-500 mb-6">Capture the customer and product details to start tracking.</p>
      <form onSubmit={submit} className="space-y-5">
        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">Customer</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <div><label className="label">Customer name *</label><input className="input" value={form.customer_name} onChange={(e) => set('customer_name', e.target.value)} required /></div>
            <div><label className="label">Contact (email/phone)</label><input className="input" value={form.customer_contact ?? ''} onChange={(e) => set('customer_contact', e.target.value)} /></div>
          </div>
          <div><label className="label">Customer portal username</label><input className="input" value={form.customer_username ?? ''} onChange={(e) => set('customer_username', e.target.value)} placeholder="Links to customer portal" /></div>
        </div>
        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">Product</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <div><label className="label">Product name *</label><input className="input" value={form.product_name} onChange={(e) => set('product_name', e.target.value)} required /></div>
            <div><label className="label">Product value (₹)</label><div className="relative"><IndianRupee className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" /><input type="number" min="0" className="input pl-9" value={form.product_value ?? ''} onChange={(e) => set('product_value', e.target.value === '' ? null : Number(e.target.value))} /></div></div>
          </div>
          <div><label className="label">Link to order (optional)</label><select className="input cursor-pointer" value={form.order_id ?? ''} onChange={(e) => set('order_id', e.target.value || null)}><option value="">No linked order</option>{orders.map((o) => <option key={o.id} value={o.id}>{o.order_number} — {o.product_name} ({o.customer_username})</option>)}</select></div>
          <div><label className="label">Reason for return</label><textarea className="input min-h-[80px] resize-y" value={form.reason ?? ''} onChange={(e) => set('reason', e.target.value)} /></div>
        </div>
        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">Invoice Status</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {REQUIRED_DOCS.map((d) => {
              const Icon = DOC_ICONS[d.uploadType];
              const checked = form[d.key] as boolean;
              return <button key={d.key} type="button" onClick={() => set(d.key, !checked)} className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-all ${checked ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}><div className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${checked ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}><Icon className="h-4.5 w-4.5" /></div><div className="flex-1 min-w-0"><div className="text-sm font-medium text-slate-900">{d.label}</div><div className="text-xs text-slate-500 mt-0.5">{d.description}</div></div><div className={`h-5 w-5 rounded-md border flex items-center justify-center shrink-0 ${checked ? 'bg-emerald-500 border-emerald-500' : 'border-slate-300'}`}>{checked && <Check className="h-3.5 w-3.5 text-white" />}</div></button>;
            })}
          </div>
          <p className="text-xs text-slate-400">Invoice validation happens automatically when a customer uploads an invoice through the customer portal. The AI checks 7 fields: Invoice Number, Date, Vendor Name, GST Number, Total Amount, Customer Name, and Product Name.</p>
        </div>
        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">Assignment</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <div><label className="label">Assign to owner</label><input className="input" value={form.owner ?? ''} onChange={(e) => set('owner', e.target.value)} /></div>
            <div><label className="label">Initial status</label><select className="input cursor-pointer" value={form.status} onChange={(e) => set('status', e.target.value as ReturnStatus)}>{STATUS_FLOW.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
          </div>
          <div><label className="label">Notes</label><textarea className="input min-h-[70px] resize-y" value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></div>
        </div>
        <div className="flex items-center justify-end gap-3 pt-2"><button type="button" onClick={onBack} className="btn-secondary">Cancel</button><button type="submit" disabled={saving} className="btn-primary">{saving ? 'Creating…' : 'Create Request'}</button></div>
      </form>
    </div>
  );
}

