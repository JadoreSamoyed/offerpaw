export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
export const MAX_RESUME_CHARACTERS = 20000;
export const MAX_PDF_PAGES = 30;
export const MAX_DOCX_EXPANDED_BYTES = 20 * 1024 * 1024;
export type ResumeFormat = 'pdf' | 'docx' | 'txt';
export interface ExtractedResume {
  fileName: string;
  text: string;
  format: ResumeFormat;
  characters: number;
  truncated: boolean;
}

const errors = {
  unauthorized: [401, '访问令牌无效，请检查连接设置后重试。'],
  origin_denied: [403, '当前网页来源未获准访问简历提取服务。'],
  method_not_allowed: [405, '请使用 POST 上传简历文件。'],
  invalid_name: [400, '文件名无效，请重新选择简历文件。'],
  unsupported_type: [415, '仅支持 PDF、DOCX 和 TXT 简历；旧版 DOC 或图片请先转换为 DOCX 或文字版 PDF。'],
  invalid_body: [415, '请以原始文件内容上传简历。'],
  too_large: [413, '简历文件不能超过 5 MB，请压缩文件或粘贴简历文字。'],
  empty_file: [422, '文件为空，请重新选择简历文件。'],
  invalid_file: [422, '文件格式不正确或已损坏，请重新导出为 PDF、DOCX 或 TXT 后上传。'],
  encrypted_file: [422, '暂不支持加密或受密码保护的简历，请解除保护后重新上传。'],
  no_text: [422, '未提取到文字。扫描件或图片 PDF 请先进行 OCR 文字识别，或直接粘贴简历文字。'],
  invalid_encoding: [422, 'TXT 编码无法识别，请另存为 UTF-8 或带 BOM 的 UTF-16 后上传。'],
  too_many_pages: [422, 'PDF 最多支持 30 页，请仅保留简历相关页面后上传。'],
  document_too_complex: [422, '文档解压后过大或结构过于复杂，请精简文档或粘贴简历文字。'],
  busy: [503, '简历提取服务正忙，请稍后重试。'],
  timeout: [408, '简历上传或提取超时，请重试或改为粘贴简历文字。'],
  cancelled: [499, '简历上传已取消。'],
} as const;
export type ResumeErrorCode = keyof typeof errors;
export class ResumeError extends Error {
  readonly status: number;
  constructor(readonly code: ResumeErrorCode) {
    super(errors[code][1]);
    this.status = errors[code][0];
  }
}
export function safeResumeError(error: unknown): ResumeError {
  return error instanceof ResumeError ? error : new ResumeError('invalid_file');
}
export function isResumeErrorCode(code: unknown): code is ResumeErrorCode {
  return typeof code === 'string' && Object.hasOwn(errors, code);
}
