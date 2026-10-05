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

所有写接口（创建订单、确认/分配/出运/签收/关闭/取消、创建与更新海关申报、运输轨迹、开票、收款、创建与决策审批、发布 outbox 事件）都接受 `Idempotency-Key` 请求头（也兼容 `X-Idempotency-Key`），领域服务函数同样接受 `{ key }` 选项。

```bash
curl -X POST -H 'x-tenant-id: tenant-acme' -H 'Idempotency-Key: fin-2026-10-05-001' \
  -d '{"invoiceId":"INV-...","amount":500,"method":"bank_transfer","reference":"BANK-001"}' \
  http://localhost:4120/api/payments
```

语义约定：

- **同租户 + 同键 + 同请求体**：重放首个请求保存的业务结果，审计、库存、信用额度、收款和 outbox 不会再次产生任何可观察变化。
- **同键 + 不同请求体**：拒绝并返回 `409`（指纹为操作名 + 规范化请求体的 SHA-256，键名、字段顺序无关）。
- **处理中**：键在执行前被同步占位为 `in_flight`，并发重复请求要么拿到已完成结果，要么收到 `409` 处理中冲突。
- **异常半完成**：失败请求标记为 `failed`，允许用完全相同的请求体重试；重试会复用已产生的中间产物（如授信不足时已创建的待审批单），不会重复创建。
- **重启边界**：幂等记录保存在内存中，进程重启后失效；订单 reference 唯一、收款 reference 唯一、按订单开票/按订单建申报等既有规则作为重启后的兜底去重。生产部署应把 `state.idempotency` 替换为持久化存储。
- 通过 `GET /api/idempotency` 可查看本租户的键、操作、指纹与状态（`in_flight` / `completed` / `failed`），结果快照不外泄。
