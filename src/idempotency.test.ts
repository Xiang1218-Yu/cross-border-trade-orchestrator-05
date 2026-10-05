import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allocateOrder, confirmOrder, createCustomsDeclaration, createOrder, decideApproval, generateInvoice, IdempotencyConflictError, IdempotencyInProgressError, publishOutbox, recordPayment, requestFingerprint, runIdempotent, state, updateCustoms
} from './domain.js';

const tenant = 'tenant-acme';
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const auditCount = (action: string, entityId: string) => state.audit.filter(item => item.action === action && item.entityId === entityId).length;
const outboxCount = (topic: string, aggregateId: string) => state.outbox.filter(item => item.topic === topic && item.aggregateId === aggregateId).length;
const newOrder = (key?: string) => createOrder(tenant, { customerId: 'CUS-001', reference: unique('IDEM'), origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 2, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] }, 'tester', key);

test('createOrder with same key and same body replays the stored result without duplicating side effects', () => {
  const key = unique('key');
  const input = { customerId: 'CUS-001', reference: unique('IDEM'), origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 2, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] };
  const first = createOrder(tenant, input, 'tester', key);
  const second = createOrder(tenant, input, 'tester', key);
  assert.equal(second.id, first.id);
  assert.equal(state.orders.filter(item => item.id === first.id).length, 1);
  assert.equal(auditCount('order.created', first.id), 1);
  assert.equal(outboxCount('order.created', first.id), 1);
  const record = state.idempotency.find(item => item.key === key);
  assert.equal(record?.status, 'completed');
  assert.ok(record?.fingerprint);
});

test('same key with a different body is rejected as a conflict', () => {
  const key = unique('key');
  const input = { customerId: 'CUS-001', reference: unique('IDEM'), origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 2, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] };
  createOrder(tenant, input, 'tester', key);
  assert.throws(() => createOrder(tenant, { ...input, destination: '鹿特丹' }, 'tester', key), IdempotencyConflictError);
  // 相同键用于不同动作同样冲突
  assert.throws(() => confirmOrder(tenant, 'ORD-whatever', 'tester', key), IdempotencyConflictError);
});

test('confirmOrder replay charges customer credit exactly once', () => {
  const key = unique('key');
  const order = newOrder();
  const customer = state.customers.find(item => item.id === 'CUS-001')!;
  const creditBefore = customer.creditUsed;
  const first = confirmOrder(tenant, order.id, 'tester', key);
  const second = confirmOrder(tenant, order.id, 'tester', key);
  assert.equal(second.version, first.version);
  assert.equal(customer.creditUsed, creditBefore + order.totalAmount);
  assert.equal(auditCount('order.confirmed', order.id), 1);
  assert.equal(outboxCount('order.confirmed', order.id), 1);
});

test('allocateOrder replay reserves inventory exactly once', () => {
  const key = unique('key');
  const order = newOrder();
  confirmOrder(tenant, order.id, 'tester');
  const reservedBefore = state.inventory.filter(item => item.tenantId === tenant).reduce((sum, item) => sum + item.reserved, 0);
  const first = allocateOrder(tenant, order.id, 'tester', key);
  const second = allocateOrder(tenant, order.id, 'tester', key);
  assert.equal(second.version, first.version);
  assert.equal(state.inventory.filter(item => item.tenantId === tenant).reduce((sum, item) => sum + item.reserved, 0), reservedBefore + 2);
  assert.equal(state.reservations.filter(item => item.orderId === order.id).length, 1);
});

test('recordPayment replay posts a single payment and a single outbox event', () => {
  const key = unique('key');
  const order = newOrder();
  confirmOrder(tenant, order.id, 'tester');
  allocateOrder(tenant, order.id, 'tester');
  const invoice = generateInvoice(tenant, order.id, 'tester');
  const input = { invoiceId: invoice.id, amount: 100, method: 'bank_transfer' as const, reference: unique('PAY') };
  const first = recordPayment(tenant, input, 'finance', key);
  const second = recordPayment(tenant, input, 'finance', key);
  assert.equal(second.id, first.id);
  assert.equal(state.payments.filter(item => item.reference === input.reference).length, 1);
  assert.equal(state.invoices.find(item => item.id === invoice.id)?.paid, 100);
  assert.equal(auditCount('payment.recorded', invoice.id), 1);
  assert.equal(outboxCount('payment.recorded', invoice.id), 1);
});

test('failed execution is cached: retry with the same key replays the error without duplicating approvals', () => {
  const key = unique('key');
  const order = createOrder(tenant, { customerId: 'CUS-002', reference: unique('IDEM-CREDIT'), origin: '深圳', destination: '洛杉矶', items: [{ description: '控制模块', sku: 'CONTROL-M2', quantity: 10, unitPrice: 420, weightKg: 2, hsCode: '8537.10' }] }, 'tester');
  assert.throws(() => confirmOrder(tenant, order.id, 'ops', key), /需要审批/);
  const approvalsAfterFirst = state.approvals.filter(item => item.orderId === order.id).length;
  assert.equal(approvalsAfterFirst, 1);
  let error: Error | undefined;
  try { confirmOrder(tenant, order.id, 'ops', key); } catch (caught) { error = caught as Error; }
  assert.ok(error?.message.includes(state.approvals.find(item => item.orderId === order.id)!.id));
  assert.equal(state.approvals.filter(item => item.orderId === order.id).length, 1);
  assert.equal(state.idempotency.find(item => item.key === key)?.status, 'failed');
});

test('decideApproval replay applies the decision side effects exactly once', () => {
  const key = unique('key');
  const order = createOrder(tenant, { customerId: 'CUS-002', reference: unique('IDEM-CREDIT'), origin: '深圳', destination: '洛杉矶', items: [{ description: '控制模块', sku: 'CONTROL-M2', quantity: 10, unitPrice: 420, weightKg: 2, hsCode: '8537.10' }] }, 'tester');
  assert.throws(() => confirmOrder(tenant, order.id, 'ops'));
  const approval = state.approvals.find(item => item.orderId === order.id)!;
  const customer = state.customers.find(item => item.id === 'CUS-002')!;
  const limitBefore = customer.creditLimit;
  const first = decideApproval(tenant, approval.id, { status: 'approved', comment: '额度复核通过' }, 'finance', key);
  const second = decideApproval(tenant, approval.id, { status: 'approved', comment: '额度复核通过' }, 'finance', key);
  assert.equal(second.decidedAt, first.decidedAt);
  assert.equal(customer.creditLimit, Math.max(limitBefore, customer.creditUsed + order.totalAmount));
  assert.equal(auditCount('approval.decided', approval.id), 1);
});

test('publishOutbox replay does not increment attempts twice', () => {
  const key = unique('key');
  const order = newOrder();
  const event = state.outbox.find(item => item.aggregateId === order.id && item.topic === 'order.created')!;
  const first = publishOutbox(tenant, event.id, 'worker', key);
  const second = publishOutbox(tenant, event.id, 'worker', key);
  assert.equal(first.attempts, 1);
  assert.equal(second.attempts, 1);
  assert.equal(auditCount('outbox.published', event.id), 1);
});

test('customs declaration creation is replay-safe per key', () => {
  const key = unique('key');
  const order = newOrder();
  const input = { orderId: order.id };
  const first = createCustomsDeclaration(tenant, input, 'tester', key);
  const second = createCustomsDeclaration(tenant, input, 'tester', key);
  assert.equal(second.id, first.id);
  assert.equal(state.customs.filter(item => item.orderId === order.id).length, 1);
  // 不同键仍受既有业务唯一性规则约束
  assert.throws(() => createCustomsDeclaration(tenant, input, 'tester', unique('key')), /已有海关申报/);
});

test('processing records yield a recognizable in-progress error', () => {
  const key = unique('key');
  state.idempotency.push({ id: 'IDK-TEST', tenantId: tenant, key, action: 'order.confirm', fingerprint: requestFingerprint('order.confirm', {}), status: 'processing', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  assert.throws(() => runIdempotent(tenant, key, 'order.confirm', {}, () => null), IdempotencyInProgressError);
  // 处理中的记录遇到不同请求体时仍按冲突拒绝
  assert.throws(() => runIdempotent(tenant, key, 'order.confirm', { orderId: 'ORD-1' }, () => null), IdempotencyConflictError);
});

test('fingerprint is insensitive to JSON key order but sensitive to content', () => {
  const key = unique('key');
  const order = newOrder();
  const declaration = createCustomsDeclaration(tenant, { orderId: order.id }, 'tester');
  updateCustoms(tenant, declaration.id, { documentRefs: declaration.requiredDocuments, status: 'submitted' }, 'tester', key);
  // 键顺序不同、内容相同 → 重放
  const replayed = updateCustoms(tenant, declaration.id, { status: 'submitted', documentRefs: [...declaration.requiredDocuments] }, 'tester', key);
  assert.equal(replayed.updatedAt, declaration.updatedAt);
  assert.equal(auditCount('customs.updated', declaration.id), 1);
});

test('requests without a key keep the legacy reference-based dedup behaviour', () => {
  const reference = unique('IDEM-NOKEY');
  const input = { customerId: 'CUS-001', reference, origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 1, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] };
  createOrder(tenant, input, 'tester');
  assert.throws(() => createOrder(tenant, input, 'tester'), /客户参考号已存在/);
});
