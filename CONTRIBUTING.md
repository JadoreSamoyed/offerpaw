# Contributing to OfferPaw / 参与 Offer汪

## Report a problem / 反馈问题

Open an issue with your operating system, Node.js version, the command or steps you ran, expected behavior and the actual result. Say whether the problem occurs in the scripted demo or with a live provider. For live-mode issues, name the provider/model without sharing credentials.

请提供操作系统、Node.js 版本、复现步骤、预期结果和实际现象，并说明使用的是预设演示还是真实模型。使用虚构简历和岗位资料构造最小复现；日志或截图中请移除密钥、访问令牌、真实简历、面试录音、私人服务地址及公司资料。

Use fictional profiles and job descriptions in examples and tests. Do not upload API keys, tokens, personal resumes, interview recordings, private service endpoints or company material in issues, pull requests or attachments.

## Make a change / 提交改动

1. Fork the repository and create a branch for one focused change.
2. Install dependencies with `npm ci` using Node.js 24.
3. Add or adjust tests when changing behavior. Keep the scripted demo usable without credentials or model downloads.
4. Run the checks below and describe the result in your pull request. Explain any check you could not run.

```sh
npm run typecheck
npm test
npm run demo:smoke
npm run build
```

`build` exports the Web app and compiles the server; it does not validate Android/iOS installation or live speech. Changes to native audio or real ASR should identify the devices, models and conditions actually tested.

每个 PR 请聚焦一个问题，说明改动原因与验证结果。涉及真机、真实语音或模型效果时，写明实际测试条件，不以预设演示或模拟上游测试代替实测。

## Source and assets / 源码与资源

Contributions to project source are under the [MIT License](LICENSE). Preserve third-party notices, identify the source and license of any added asset, and review [THIRD_PARTY.md](THIRD_PARTY.md) before proposing bundled dependencies or speech models.
