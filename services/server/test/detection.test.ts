import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { tokenMatches } from '../src/auth.js';
import { looksLikeQuestion, QuestionDetector } from '../src/questions.js';
import { PcmTurnDetector } from '../src/transcription.js';

test('production refuses an empty or short access token and non-TLS providers', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /APP_ACCESS_TOKEN/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_ACCESS_TOKEN: '123' }), /APP_ACCESS_TOKEN/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_ACCESS_TOKEN: 'a'.repeat(32), LLM_BASE_URL: 'http://example.test/v1' }), /TLS/);
  assert.equal(tokenMatches('secret', 'secret'), true);
  assert.equal(tokenMatches('secret', 'wrong'), false);
  assert.equal(tokenMatches('secret'), false);
});

test('question detection recognizes Chinese/English prompts and avoids obvious candidate speech', () => {
  for (const input of ['你会怎么优化性能', '请介绍一下你的项目', '做个自我介绍', '谈谈项目中的难点', 'Explain the trade-off in this design.', 'Design a rate limiter.', 'Can you describe your role?']) assert.equal(looksLikeQuestion(input), true, input);
  for (const input of ['我会先看一下监控指标', '我的问题是团队怎么合作？', 'I think we should measure it first.', '谢谢，今天就到这里']) assert.equal(looksLikeQuestion(input), false, input);
});

test('unpunctuated ASR requests trigger answers with spoken Chinese prompt variants', () => {
  for (const input of [
    '你好请你简单讲一下 Transformer 的架构吧',
    '请你简单介绍 Transformer 的架构',
    '麻烦您具体解释 Redis 的持久化机制',
    '接下来谈一谈你的项目经历',
    '请讲一讲你在项目中负责的部分',
    '说一说 HTTP 和 HTTPS 的区别',
    '聊一下你最近遇到的技术难点',
    '解释下 MySQL 的事务隔离级别',
  ]) assert.equal(looksLikeQuestion(input), true, input);
});

test('candidate explanations and quoted prompts remain text-filtered before speaker gating', () => {
  for (const input of [
    '我来简单讲一下 Transformer 的架构',
    '好的我先介绍一下项目背景',
    '首先我会分析如何降低接口延迟',
    '我们当时讨论了怎么解决缓存穿透',
    '具体来说我们采用了 Redis 缓存来处理这个问题',
    '对于这个问题，我认为需要先解释一下业务背景',
    'Let me explain how we reduced latency.',
    'We need to consider how to scale the database.',
  ]) assert.equal(looksLikeQuestion(input), false, input);
  assert.equal(looksLikeQuestion('首先请你介绍一下项目背景'), true);
});

test('unpunctuated 怎样 questions trigger while candidate answers remain filtered', () => {
  for (const input of [
    '如果 SQL 查询很慢导致 API 响应超时你会怎样定位并解决问题',
    '如果 c o 查询很慢导致 api 响应应超时你会怎样定位并解决问',
  ]) assert.equal(looksLikeQuestion(input), true, input);
  for (const input of [
    '我会这样定位并解决问题先检查慢查询日志',
    '我会考虑怎样通过索引优化 SQL 查询',
  ]) assert.equal(looksLikeQuestion(input), false, input);
});

test('spoken interviewer requests and yes/no follow-ups work without ASR punctuation', () => {
  for (const input of [
    '我想问一下你会如何设计缓存',
    '我想了解你的项目有哪些难点',
    '我想了解你的项目',
    '你用过 Redis 吗',
    '你在项目中负责哪部分',
    '能详细一点吗',
    '给我讲解一下 Redis 持久化',
    'Have you worked with Kubernetes',
    'Do you have experience with Redis',
    'So, have you used Redis in production',
    'I want to ask about your project',
    'I would like to ask about your experience',
  ]) assert.equal(looksLikeQuestion(input), true, input);
  for (const input of [
    '我会先确认你用过 Redis 吗这个问题的范围',
    '我来讲解一下 Redis 持久化',
    '我的问题是团队怎么合作',
    '我想问候一下团队',
    'I think we should explain the previous design',
    'I would explain how we used Redis',
    'I have worked with Kubernetes',
    'You have worked with Kubernetes',
    'We used Redis in production',
    '谢谢今天就聊到这里',
  ]) assert.equal(looksLikeQuestion(input), false, input);
});

test('question decisions expose skip reasons and keep accept deduplication semantics', () => {
  const detector = new QuestionDetector();
  assert.deepEqual(detector.evaluate('谢谢今天就到这里', 100), { accepted: false, reason: 'not_question' });
  const first = '你用过 Redis 吗';
  assert.deepEqual(detector.evaluate(first, 100), { accepted: true, reason: 'accepted' });
  assert.deepEqual(detector.evaluate(first, 500), { accepted: false, reason: 'duplicate' });
  assert.equal(detector.accept(first, 30100), true);
  assert.deepEqual(detector.evaluate(first, 30200), { accepted: false, reason: 'duplicate' });
  detector.rememberAnswer('我会先确认为什么接口延迟在高并发时明显增加，然后分析指标。');
  assert.deepEqual(detector.evaluate('为什么接口延迟在高并发时明显增加', 31000), { accepted: false, reason: 'answer_echo' });
  assert.equal(detector.accept('请介绍一下缓存穿透的处理方式', 31100), true);
});

test('company motivation question remains accepted as a third distinct question', () => {
  const detector = new QuestionDetector();
  assert.equal(detector.accept('请介绍一下你的项目', 100), true);
  assert.equal(detector.accept('项目中遇到哪些难点', 5000), true);
  assert.equal(looksLikeQuestion('你为什么选择星河'), true);
  assert.deepEqual(detector.evaluate('你为什么选择星河', 10000), { accepted: true, reason: 'accepted' });
});

test('detection suppresses repeated questions and text echoed from generated answers', () => {
  const detector = new QuestionDetector();
  assert.equal(detector.accept('请解释一下数据库索引为什么会失效？', 100), true);
  assert.equal(detector.accept('请解释一下数据库索引为什么会失效', 500), false);
  assert.equal(detector.accept('请解释一下数据库索引为什么会失效', 31000), true);
  detector.rememberAnswer('我会先确认为什么接口延迟在高并发时明显增加，然后分析指标。');
  assert.equal(detector.accept('为什么接口延迟在高并发时明显增加？', 32000), false);
});

test('client VAD commits after speech followed by silence and clears pure silence', () => {
  const detector = new PcmTurnDetector(0.01, 400);
  const speech = Buffer.alloc(4800); // 100 ms @24k mono PCM16
  for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(10000, i);
  const silence = Buffer.alloc(4800);
  assert.equal(detector.push(speech), undefined);
  for (let i = 0; i < 3; i++) assert.equal(detector.push(silence), undefined);
  assert.equal(detector.push(silence), 'commit');
  for (let i = 0; i < 29; i++) assert.equal(detector.push(silence), undefined);
  assert.equal(detector.push(silence), 'clear');
});
