import type { WaPort } from "./invoicing/wa.ts";

export interface Sent {
  to: string;
  kind: "text" | "flow" | "buttons" | "document";
  text: string;
  extra?: unknown;
}

/** Records what would be sent to WhatsApp. Tests only. */
export class FakeWa implements WaPort {
  sent: Sent[] = [];
  ok = true;
  async sendText(to: string, text: string) {
    this.sent.push({ to, kind: "text", text });
    return this.ok;
  }
  async sendFlow(to: string, p: { body: string; token: string }) {
    this.sent.push({ to, kind: "flow", text: p.body, extra: p.token });
    return this.ok;
  }
  async sendButtons(to: string, body: string, buttons: { id: string; title: string }[]) {
    this.sent.push({ to, kind: "buttons", text: body, extra: buttons });
    return this.ok;
  }
  async sendDocument(to: string, d: { filename: string; base64: string; caption: string }) {
    this.sent.push({ to, kind: "document", text: d.caption, extra: d.filename });
    return this.ok;
  }
}

export function lastSent(wa: FakeWa): Sent {
  const m = wa.sent.at(-1);
  if (!m) throw new Error("nothing was sent");
  return m;
}
