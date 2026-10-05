import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  addShipmentEvent, allocateOrder, cancelOrder, closeOrder, confirmOrder, createApproval, createCustomsDeclaration, createOrder, decideApproval, deliverOrder, dispatchOrder, generateInvoice, getOrder, IdempotencyConflictError, IdempotencyInProgressError, listAudit, listIdempotencyRecords, listOrders, listOutbox, operationSummary, publishOutbox, recordPayment, state, timeline, updateCustoms
} from './domain.js';

const port = Number(process.env.PORT ?? 4120);
const json = (res: ServerResponse, status: number, body: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); };
const readBody = async (req: IncomingMessage) => { let raw = ''; for await (const chunk of req) raw += chunk; if (!raw.trim()) return {}; try { return JSON.parse(raw); } catch { throw new Error('请求体必须是合法 JSON'); } };
const tenantId = (req: IncomingMessage) => String(req.headers['x-tenant-id'] ?? 'tenant-acme');
const actor = (req: IncomingMessage) => String(req.headers['x-actor'] ?? 'api-user');
// 幂等键：客户端通过 Idempotency-Key（或 X-Idempotency-Key）请求头携带；同一租户下相同键 + 相同请求体重放首次结果。
const idempotencyKey = (req: IncomingMessage) => { const header = req.headers['idempotency-key'] ?? req.headers['x-idempotency-key']; return header === undefined || header === '' ? undefined : String(header); };
const success = (res: ServerResponse, body: unknown, status = 200) => json(res, status, { data: body });
const failure = (res: ServerResponse, error: unknown, status = 400) => json(res, status, { error: error instanceof Error ? error.message : '请求失败' });

const server = createServer(async (req, res) => {
  const method = req.method ?? 'GET'; const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`); const path = url.pathname; const tenant = tenantId(req); const user = actor(req); const idemKey = idempotencyKey(req);
  if (method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (path === '/api/health') return success(res, { ok: true, service: 'cross-border-trade-orchestrator', now: new Date().toISOString() });
  if (!path.startsWith('/api/')) return failure(res, new Error('Not Found'), 404);
  try {
    if (method === 'GET' && path === '/api/operations/summary') return success(res, operationSummary(tenant));
    if (method === 'GET' && path === '/api/orders') return success(res, listOrders(tenant, { status: url.searchParams.get('status') ?? undefined, customerId: url.searchParams.get('customerId') ?? undefined, q: url.searchParams.get('q') ?? undefined }));
    const orderMatch = path.match(/^\/api\/orders\/([^/]+?)(?:\/(confirm|allocate|dispatch|deliver|close|cancel|timeline))?$/);
    const orderId = orderMatch?.[1]; const orderAction = orderMatch?.[2];
    if (method === 'GET' && orderId && !orderAction) return success(res, getOrder(tenant, orderId));
    if (method === 'GET' && orderId && orderAction === 'timeline') return success(res, timeline(tenant, orderId));
    if (method === 'POST' && path === '/api/orders') return success(res, createOrder(tenant, await readBody(req), user, idemKey), 201);
    if (method === 'POST' && orderId && orderAction === 'confirm') return success(res, confirmOrder(tenant, orderId, user, idemKey));
    if (method === 'POST' && orderId && orderAction === 'allocate') return success(res, allocateOrder(tenant, orderId, user, idemKey));
    if (method === 'POST' && orderId && orderAction === 'dispatch') return success(res, dispatchOrder(tenant, orderId, user, idemKey));
    if (method === 'POST' && orderId && orderAction === 'deliver') return success(res, deliverOrder(tenant, orderId, user, idemKey));
    if (method === 'POST' && orderId && orderAction === 'close') return success(res, closeOrder(tenant, orderId, user, idemKey));
    if (method === 'POST' && orderId && orderAction === 'cancel') return success(res, cancelOrder(tenant, orderId, user, idemKey));

    if (method === 'POST' && path === '/api/customs/declarations') return success(res, createCustomsDeclaration(tenant, await readBody(req), user, idemKey), 201);
    const customsId = path.match(/^\/api\/customs\/declarations\/([^/]+)$/)?.[1];
    if (method === 'PATCH' && customsId) return success(res, updateCustoms(tenant, customsId, await readBody(req), user, idemKey));
    const shipmentId = path.match(/^\/api\/shipments\/([^/]+)\/events$/)?.[1];
    if (method === 'POST' && shipmentId) return success(res, addShipmentEvent(tenant, shipmentId, await readBody(req), user, idemKey), 201);

    if (method === 'POST' && path === '/api/invoices') { const body = await readBody(req); return success(res, generateInvoice(tenant, String(body.orderId), user, idemKey), 201); }
    if (method === 'POST' && path === '/api/payments') return success(res, recordPayment(tenant, await readBody(req), user, idemKey), 201);
    if (method === 'POST' && path === '/api/approvals') return success(res, createApproval(tenant, await readBody(req), user, idemKey), 201);
    const approvalId = path.match(/^\/api\/approvals\/([^/]+)\/decision$/)?.[1];
    if (method === 'POST' && approvalId) return success(res, decideApproval(tenant, approvalId, await readBody(req), user, idemKey));
    if (method === 'GET' && path === '/api/audit/events') return success(res, listAudit(tenant, Number(url.searchParams.get('limit') ?? 100)));
    if (method === 'GET' && path === '/api/outbox') return success(res, listOutbox(tenant, (url.searchParams.get('status') as 'pending' | 'published' | null) ?? undefined));
    const eventId = path.match(/^\/api\/outbox\/([^/]+)\/publish$/)?.[1];
    if (method === 'POST' && eventId) return success(res, publishOutbox(tenant, eventId, user, idemKey));
    if (method === 'GET' && path === '/api/idempotency') return success(res, listIdempotencyRecords(tenant));
    if (method === 'GET' && path === '/api/meta') return success(res, { tenant: state.tenants.find(item => item.id === tenant), capabilities: ['orders', 'inventory-reservation', 'shipment-tracking', 'customs-compliance', 'billing', 'approvals', 'audit', 'outbox', 'idempotency'] });
    return failure(res, new Error('路由不存在'), 404);
  } catch (error) {
    if (error instanceof IdempotencyConflictError || error instanceof IdempotencyInProgressError) return failure(res, error, 409);
    return failure(res, error);
  }
});

server.listen(port, () => console.log(`cross-border trade orchestrator listening on http://localhost:${port}`));
