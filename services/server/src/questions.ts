export const normalize = (text: string): string => text.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');

/** Deliberately conservative: no claim of speaker identification from a mono microphone. */
export function looksLikeQuestion(text: string): boolean {
  const value = text.trim();
  if (value.length < 4 || value.length > 3000) return false;
  // These are only text cues; the session must separately gate on the speaker.
  // An answer can quote a question or contain words such as “如何” and “explain”.
  const opening = value.replace(/^(?:(?:对于这个问题|具体来说|是的|首先|然后|嗯+|啊|呃+|好的?|对)[\s，,。.!！]*)+/u, '');
  if (/^(我的|(?:我|我们)(?:觉得|认为|会|当时|之前|曾经|负责|使用|用了|采用|通过|选择|先|来|一般|通常|主要)|I (?:think|believe|would(?! like to ask\b)|will|used|worked)|We (?:used|need|would|will)|Let me|In my experience)/i.test(opening)) return false;
  return /[?？]/.test(value)
    || /(?:吗|么)[\s。.!！]*$/u.test(value)
    || /^(?:我想问(?!候)|我想了解|I (?:want|would like) to ask\b)/i.test(opening)
    || /(为什么|怎么|怎样|如何|什么|哪些|哪(?:个|种|部分|方面|里)|多少|是否|能否|有没有|能不能|谈谈|讲讲|说说|聊聊|谈一谈|讲一讲|说一说|聊一聊|(?:说|讲|谈|聊|介绍|解释|讲解|描述|分析)(?:一下|下)|自我介绍|简述|举个例子|请介绍|请描述|请设计|设计一个|实现一个)/.test(value)
    || /(?:请|麻烦)(?:你|您)?(?:简单|简要|具体|详细|大致|大概|重点)?(?:介绍|描述|解释|分析|设计|实现|比较|说明)/.test(value)
    || /^(?:(?:so|and|also|then|okay|ok)[,\s]+)*(?:have|had|do|did|are|were|would|will|could|can) you\b/i.test(opening)
    || /\b(what|why|how|when|where|which|could you|can you|tell me|describe|explain|design|implement|compare|discuss|walk me through|give (me )?an example)\b/i.test(value);
}

export type QuestionDecision =
  | { accepted: true; reason: 'accepted' }
  | { accepted: false; reason: 'not_question' | 'duplicate' | 'answer_echo' };

export class QuestionDetector {
  private recent: Array<{ normalized: string; at: number }> = [];
  private answers: string[] = [];
  rememberAnswer(text: string) {
    if (text) this.answers = [...this.answers.slice(-2), normalize(text)];
  }
  accept(text: string, now = Date.now()): boolean {
    return this.evaluate(text, now).accepted;
  }
  evaluate(text: string, now = Date.now()): QuestionDecision {
    if (!looksLikeQuestion(text)) return { accepted: false, reason: 'not_question' };
    const normalized = normalize(text);
    this.recent = this.recent.filter(item => now - item.at < 30000);
    if (this.recent.some(item => item.normalized === normalized)) return { accepted: false, reason: 'duplicate' };
    if (normalized.length >= 12 && this.answers.some(answer => answer.includes(normalized))) return { accepted: false, reason: 'answer_echo' };
    this.recent.push({ normalized, at: now });
    this.recent = this.recent.slice(-30);
    return { accepted: true, reason: 'accepted' };
  }
}
