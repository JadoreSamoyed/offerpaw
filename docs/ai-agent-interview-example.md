# AI Agent 面试练习：退款超时，能直接重试吗？

[返回中文说明](../README.zh-CN.md) · [Back to English README](../README.md)

这是供你口述作答的虚构练习题，打开网页即可练习。

This fictional scenario is a written exercise for practicing your answer aloud.

## 先自己回答 / Try it yourself

Agent 调用退款接口后超时，没有拿到结果。用户还在等：能不能直接再调用一次？你会先查什么，如何避免同一笔业务退款被执行两遍？

An agent calls a refund API, but the request times out. The user is waiting. Can it simply call again? What would you check, and how would you avoid executing the same refund twice?

先用一分钟说出你的处理顺序，再展开下面的参考思路。无需安装项目或填写真实订单信息。

Explain your next steps aloud before opening the discussion. No installation or real order details are needed.

<details>
<summary>展开参考思路 / Reveal the discussion</summary>

1. **超时表示结果未知。** 服务端可能已完成退款，只是响应没送到。先保留原业务操作记录，不把它标成“已失败”或“已成功”。
2. **查原操作的状态。** 用业务操作 ID、已知退款 ID 等查单，并结合服务端通知或记录核对。一次“未查到”也未必等于没执行，可能仍在处理或尚未可见。
3. **重试需要服务端幂等保证。** 接口支持幂等、保证仍有效且符合其重试规则时，同一业务操作必须沿用首次调用的同一个幂等键和相同参数。键应在首次调用前持久化，重启或再次调用工具时仍能取回；不要让 Agent 每次生成新键。
4. **按确认的状态继续。** 已成功就返回现有结果；处理中就等待并按规则查询。状态仍未知、幂等期限已过或接口不支持安全重试时，先核对或转人工处理，不盲目再发起一笔退款。幂等不能只靠提示词保证。

**English recap:** A timeout leaves the outcome unknown. Look up the original operation and reconcile its status; “not found” alone may be inconclusive. Retry only under the provider's valid idempotency and retry contract, with the **original operation's same persisted key and unchanged parameters**. Return an existing success, wait for pending work, and reconcile unresolved outcomes rather than creating another refund. The agent's prompt alone cannot enforce this.

具体幂等范围、有效期和错误处理取决于接口约定。可参考 Stripe 的[幂等请求说明](https://docs.stripe.com/api/idempotent_requests)及[网络错误与重试说明](https://docs.stripe.com/error-low-level#network-errors)；这里引用其机制作为实例，不表示所有退款接口行为相同。

Provider contracts differ. The linked Stripe documentation is an implementation example, not a universal refund API guarantee.

</details>

## 再追问一步 / Follow-up

两个 Agent worker 同时处理同一笔退款，怎样让它们识别为同一个业务操作？如果原请求根本没带幂等键，超时后临时补一个新键能解决什么、又解决不了什么？

How would two workers recognize the same refund operation? If the original request had no idempotency key, what would adding a new key after the timeout fail to protect against?
