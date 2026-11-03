# AI Agent 面试练习：如何评测一个 Agent？

[返回中文说明](../README.zh-CN.md) · [Back to English README](../README.md)

这是一道虚构的面试练习，用查快递来讲 Agent 评测。

This fictional interview exercise uses shipment tracking to explain agent evaluation.

## 先自己回答 / Try it yourself

用户问：“我的快递到哪了？”你怎么判断 Agent 做得好不好？

先用这份固定测试数据：当前用户拥有订单 `2048`；物流工具返回“运输中，最近更新 10:00”，没有预计送达时间。请用一分钟讲清：怎么算通过，怎么查出问题，改完以后怎么再测。

A user asks, “Where is my parcel?” In the test fixture, the user owns order `2048`. The tracking tool returns “in transit, updated at 10:00” with no delivery estimate. Explain your success criteria, how you would diagnose failures, and how you would retest after a change.

<details>
<summary>展开参考思路 / Reveal the discussion</summary>

我会先写清楚什么叫“通过”，再准备正常和异常用例。不能只听 Agent 说“查到了”，要拿它的回答和工具记录核对。

| 看什么 | 这道题怎么检查 |
| --- | --- |
| **结果：事情办对了吗？** | 查的是当前用户的目标订单，回答与已知物流记录一致；说清“运输中、更新于 10:00”，不编一个“明天一定到”。 |
| **过程：哪一步出了问题？** | 看工具日志：工具选得是否合适，订单号等参数是否正确，回答有没有依据。检查关键要求，不强制所有正确方案都走同一套调用顺序。 |
| **边界：遇到意外怎么办？** | 有多笔订单又无法确定目标时先追问；接口超时要说明暂时没查到，不能编物流状态；无权访问的订单不能泄露信息。正常查询也要能通过，不能靠一律拒绝拿高分。 |

这套题目设计把任务结果、工具选择与参数、异常情况分开检查，可对照 [OpenAI 的评测指南](https://developers.openai.com/api/docs/guides/evaluation-best-practices)。权限还需要服务端校验，不能只依赖 Agent 的提示词。

把这些用例存成固定题集，每题写好预期行为。每次修改提示词、模型或工具后，用相同的测试数据重新跑；每轮重置环境，同一题重复几次。分别看各类用例的通过情况，再看耗时和成本，把新发现的问题补进题集。一次答对不等于稳定可靠。重复试验、隔离环境和回归测试的做法见 [Anthropic 的 Agent 评测说明](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)。

**English recap:** Define success before testing. Check the answer against the known tracking data; inspect tool selection and arguments without requiring one exact call sequence. Include ambiguous orders, tool timeouts, and unauthorized requests, with an explicit expected response for each. Test valid requests too. Keep a regression suite, reset the environment between trials, repeat cases, and compare category-level results alongside latency and cost after every change. Authorization must also be enforced by the service.

</details>

## 再追问一步 / Follow-up

两次回答都正确，一次调用两次工具，另一次调用三次，能直接判后者更差吗？如果你用另一个模型打分，怎样确认它没有把编造的“明天送达”判成好回答？

If two answers are correct but use different numbers of tool calls, is the shorter path always better? If an LLM grades the answers, how would you check that it does not reward a fabricated delivery estimate?

[继续练：退款接口超时，能直接重试吗？ / Next: can you retry a timed-out refund?](ai-agent-interview-example.md)
