/** Incremental SSE parser. Handles UTF-8 upstream separately and split CRLF boundaries. */
export class SseParser {
  private pending = '';
  private data: string[] = [];
  private eventSize = 0;
  push(chunk: string, final = false): string[] {
    this.pending += chunk;
    if (this.pending.length > 131072) throw new Error('SSE frame exceeds limit.');
    const output: string[] = [];
    while (this.pending.length) {
      const match = /\r\n|\r|\n/.exec(this.pending);
      if (!match) break;
      if (match[0] === '\r' && match.index === this.pending.length - 1 && !final) break;
      const line = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      this.line(line, output);
    }
    if (final) {
      if (this.pending) this.line(this.pending, output);
      this.pending = '';
      this.line('', output);
    }
    return output;
  }
  private line(line: string, output: string[]) {
    if (!line) {
      if (this.data.length) output.push(this.data.join('\n'));
      this.data = []; this.eventSize = 0;
    } else if (line.startsWith('data:')) {
      const data = line.slice(5).replace(/^ /, '');
      this.eventSize += data.length;
      if (this.eventSize > 131072) throw new Error('SSE event exceeds limit.');
      this.data.push(data);
    }
  }
}
