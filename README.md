# CrossBorder Flow｜跨境供应链履约与结算编排服务

一个纯后端、Node.js + TypeScript 的复杂业务项目。它把跨境订单、库存锁定、分段运输、海关申报、计费开票、收款核销、异常审批、审计和事件投递串成一个可追踪的履约闭环。

## 业务边界

- **订单编排**：订单状态机、信用额度校验、幂等创建、乐观版本控制。
- **库存与分配**：按仓库和 SKU 锁定库存；防止超卖；分配结果写入订单时间线。
- **跨境运输**：支持多段运输和里程碑事件，基于事件自动更新预计到达时间和延误状态。
- **海关合规**：申报单、单证完整性校验、查验/放行/退回，未放行订单禁止出运。
- **计费结算**：按重量、燃油附加费、关务服务费、优先级计算应收；生成发票并支持部分收款和核销。
- **异常与审批**：信用超额、海关退回、运输延误等异常进入审批流；审批决定会影响订单动作。
- **可观测性**：审计事件、Outbox 事件、运营指标、订单全链路时间线。

## 启动

```bash
cd "/Users/tog/Documents/ChatGPT/play/professional-platforms/cross-border-trade-orchestrator"
npm install
npm run dev
```

默认监听 `http://localhost:4120`。

## 演示租户与请求头

所有业务 API 默认要求 `x-tenant-id: tenant-acme`。演示数据已经包含订单、库存、运输段、海关申报、发票和一笔部分收款。

```bash
curl -H 'x-tenant-id: tenant-acme' http://localhost:4120/api/operations/summary
```

## 幂等请求

所有写操作（创建订单、确认/分配/出运/签收/关闭/取消、创建申报、更新申报、运输轨迹、开票、记录付款、创建/决策审批、发布 outbox 事件）都支持通过 `Idempotency-Key`（或 `X-Idempotency-Key`）请求头携带幂等键：

```bash
curl -X POST -H 'x-tenant-id: tenant-acme' -H 'Idempotency-Key: fin-retry-9f3c' \
  -d '{"invoiceId":"INV-...","amount":500,"method":"bank_transfer","reference":"BANK-001"}' \
  http://localhost:4120/api/payments
```

**语义**：同一租户下，相同幂等键 + 相同请求体（按键名规范化后的 SHA-256 指纹）返回首次执行的业务结果，审计、库存、信用额度、收款和 outbox 事件都只产生一次可观察变化；相同键但请求体不同返回 `409` 冲突；首次请求仍在处理中返回 `409` 并提示稍后重试。可通过 `GET /api/idempotency` 查看键的指纹、状态（`processing` / `completed` / `failed`）和缓存结果。

**边界**：

- **内存重启**：幂等记录保存在进程内存中，重启后丢失。重启后的重复请求由既有业务唯一性规则兜底（订单 reference、收款 reference、每单一条申报、每单一张发票）。
- **异常半完成**：执行抛错时记录为 `failed` 并缓存错误，相同键重试直接重放同一错误，不重复执行已发生的副作用（例如授信不足时已创建的审批不会因重试而重复生成）。确需重试必须更换幂等键。
- **并发提交**：首个到达的请求执行，其余相同键请求在处理期间得到 `409` 处理中，完成后得到缓存结果。若进程在执行中途崩溃，记录停留在 `processing`，后续相同键请求持续得到 `409`，需人工介入或更换键。
- **已有 reference 规则**：幂等键是增强而非替代——未携带键时，订单 reference 和收款 reference 的去重规则仍然生效；携带不同键但 reference 相同依然会被拒绝。
