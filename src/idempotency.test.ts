import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateOrder, confirmOrder, createCustomsDeclaration, createOrder, decideApproval, dispatchOrder, generateInvoice, IdempotencyConflict, listIdempotency, publishOutbox, recordPayment, state, updateCustoms } from './domain.js';

const TENANT = 'tenant-acme';
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const orderInput = (reference: string) => ({ customerId: 'CUS-001', reference, origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 2, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
const newOrder = () => createOrder(TENANT, orderInput(`IDEM-SEED-${uniq()}`), 'tester');

test('create order: same key and same body replays the stored result with no extra side effects', () => {
  const key = `order-create-${uniq()}`;
  const input = orderInput(`IDEM-${uniq()}`);
  const first = createOrder(TENANT, input, 'tester', { key });
  const replay = createOrder(TENANT, input, 'tester', { key });
  assert.equal(replay.id, first.id);
  assert.equal(state.orders.filter(item => item.reference === input.reference).length, 1);
  assert.equal(state.audit.filter(item => item.action === 'order.created' && item.entityId === first.id).length, 1);
  assert.equal(state.outbox.filter(item => item.topic === 'order.created' && item.aggregateId === first.id).length, 1);
  const record = listIdempotency(TENANT).find(item => item.key === key);
  assert.equal(record?.status, 'completed');
  assert.equal(record?.action, 'order.create');
  assert.ok(record?.fingerprint);
});

test('same key with a different body is rejected, even after a failed attempt', () => {
  const key = `order-conflict-${uniq()}`;
  createOrder(TENANT, orderInput(`IDEM-A-${uniq()}`), 'tester', { key });
  assert.throws(() => createOrder(TENANT, orderInput(`IDEM-B-${uniq()}`), 'tester', { key }), IdempotencyConflict);
  const failedKey = `order-failed-${uniq()}`;
  assert.throws(() => createOrder(TENANT, { customerId: 'CUS-001' }, 'tester', { key: failedKey }), /不能为空/);
  assert.equal(listIdempotency(TENANT).find(item => item.key === failedKey)?.status, 'failed');
  assert.throws(() => createOrder(TENANT, orderInput(`IDEM-C-${uniq()}`), 'tester', { key: failedKey }), IdempotencyConflict);
});

test('confirm replay charges customer credit exactly once', () => {
  const order = newOrder();
  const customer = state.customers.find(item => item.id === order.customerId)!;
  const usedBefore = customer.creditUsed;
  const key = `confirm-${uniq()}`;
  confirmOrder(TENANT, order.id, 'tester', { key });
  const replay = confirmOrder(TENANT, order.id, 'tester', { key });
  assert.equal(replay.status, 'confirmed');
  assert.equal(customer.creditUsed, usedBefore + order.totalAmount);
  assert.equal(state.audit.filter(item => item.action === 'order.confirmed' && item.entityId === order.id).length, 1);
});

test('allocate replay reserves inventory exactly once', () => {
  const order = newOrder();
  confirmOrder(TENANT, order.id, 'tester');
  const lot = state.inventory.find(item => item.sku === 'SENSOR-X9' && item.warehouse === 'SHANGHAI-FTZ')!;
  const reservedBefore = lot.reserved;
  const key = `allocate-${uniq()}`;
  allocateOrder(TENANT, order.id, 'tester', { key });
  allocateOrder(TENANT, order.id, 'tester', { key });
  assert.equal(lot.reserved, reservedBefore + 2);
  assert.equal(state.reservations.filter(item => item.orderId === order.id).length, 1);
});

test('customs declaration and dispatch replay do not duplicate declarations or shipments', () => {
  const order = newOrder();
  confirmOrder(TENANT, order.id, 'tester');
  allocateOrder(TENANT, order.id, 'tester');
  const declarationKey = `customs-${uniq()}`;
  const declaration = createCustomsDeclaration(TENANT, { orderId: order.id }, 'tester', { key: declarationKey });
  const replayedDeclaration = createCustomsDeclaration(TENANT, { orderId: order.id }, 'tester', { key: declarationKey });
  assert.equal(replayedDeclaration.id, declaration.id);
  assert.equal(state.customs.filter(item => item.orderId === order.id).length, 1);
  updateCustoms(TENANT, declaration.id, { documentRefs: declaration.requiredDocuments, status: 'submitted' }, 'tester');
  updateCustoms(TENANT, declaration.id, { status: 'cleared' }, 'tester');
  const dispatchKey = `dispatch-${uniq()}`;
  dispatchOrder(TENANT, order.id, 'tester', { key: dispatchKey });
  dispatchOrder(TENANT, order.id, 'tester', { key: dispatchKey });
  assert.equal(state.shipments.filter(item => item.orderId === order.id).length, 1);
  assert.equal(state.outbox.filter(item => item.topic === 'shipment.created' && item.aggregateId === order.id).length, 1);
});

test('payment replay settles the invoice exactly once and rejects amount changes under the same key', () => {
  const order = newOrder();
  confirmOrder(TENANT, order.id, 'tester');
  allocateOrder(TENANT, order.id, 'tester');
  const invoice = generateInvoice(TENANT, order.id, 'tester');
  const key = `payment-${uniq()}`;
  const input = { invoiceId: invoice.id, amount: 100, method: 'bank_transfer' as const, reference: `PAY-${uniq()}` };
  const first = recordPayment(TENANT, input, 'finance', { key });
  const replay = recordPayment(TENANT, input, 'finance', { key });
  assert.equal(replay.id, first.id);
  const stored = state.invoices.find(item => item.id === invoice.id)!;
  assert.equal(stored.paid, 100);
  assert.equal(state.payments.filter(item => item.reference === input.reference).length, 1);
  assert.throws(() => recordPayment(TENANT, { ...input, amount: 200 }, 'finance', { key }), IdempotencyConflict);
});

test('approval decision replay decides exactly once', () => {
  const order = createOrder(TENANT, { customerId: 'CUS-002', reference: `IDEM-CREDIT-${uniq()}`, origin: '深圳', destination: '洛杉矶', items: [{ description: '控制模块', sku: 'CONTROL-M2', quantity: 10, unitPrice: 420, weightKg: 2, hsCode: '8537.10' }] }, 'tester');
  assert.throws(() => confirmOrder(TENANT, order.id, 'tester'), /需要审批/);
  assert.throws(() => confirmOrder(TENANT, order.id, 'tester'), /需要审批/);
  const approvals = state.approvals.filter(item => item.orderId === order.id && item.type === 'credit_override');
  assert.equal(approvals.length, 1, 'failed confirm retries reuse the pending approval instead of creating duplicates');
  const key = `decide-${uniq()}`;
  const decided = decideApproval(TENANT, approvals[0].id, { status: 'approved', comment: '额度复核通过' }, 'finance', { key });
  const replay = decideApproval(TENANT, approvals[0].id, { status: 'approved', comment: '额度复核通过' }, 'finance', { key });
  assert.equal(replay.decidedAt, decided.decidedAt);
  assert.equal(state.audit.filter(item => item.action === 'approval.decided' && item.entityId === approvals[0].id).length, 1);
});

test('a failed attempt can be retried with the identical body once the blocker is gone', () => {
  const order = newOrder();
  confirmOrder(TENANT, order.id, 'tester');
  allocateOrder(TENANT, order.id, 'tester');
  const key = `dispatch-retry-${uniq()}`;
  assert.throws(() => dispatchOrder(TENANT, order.id, 'tester', { key }), /海关申报尚未放行/);
  assert.equal(listIdempotency(TENANT).find(item => item.key === key)?.status, 'failed');
  const declaration = createCustomsDeclaration(TENANT, { orderId: order.id }, 'tester');
  updateCustoms(TENANT, declaration.id, { documentRefs: declaration.requiredDocuments, status: 'submitted' }, 'tester');
  updateCustoms(TENANT, declaration.id, { status: 'cleared' }, 'tester');
  const dispatched = dispatchOrder(TENANT, order.id, 'tester', { key });
  assert.equal(dispatched.status, 'dispatched');
  assert.equal(listIdempotency(TENANT).find(item => item.key === key)?.status, 'completed');
  assert.equal(state.shipments.filter(item => item.orderId === order.id).length, 1);
});

test('outbox publish replay records a single attempt', () => {
  const order = newOrder();
  const event = state.outbox.find(item => item.topic === 'order.created' && item.aggregateId === order.id)!;
  const key = `publish-${uniq()}`;
  publishOutbox(TENANT, event.id, 'worker', { key });
  const replay = publishOutbox(TENANT, event.id, 'worker', { key });
  assert.equal(replay.status, 'published');
  const stored = state.outbox.find(item => item.id === event.id)!;
  assert.equal(stored.attempts, 1);
  assert.equal(state.audit.filter(item => item.action === 'outbox.published' && item.entityId === event.id).length, 1);
});
