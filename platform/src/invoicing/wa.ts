// WhatsApp Cloud API client (send only). Tokens come from the environment and are never logged.
export interface WaPort {
  sendText(to: string, text: string): Promise<boolean>;
  sendFlow(to: string, p: { body: string; token: string; cta?: string }): Promise<boolean>;
  sendButtons(to: string, body: string, buttons: { id: string; title: string }[]): Promise<boolean>;
  sendDocument(to: string, d: { filename: string; base64: string; caption: string }): Promise<boolean>;
}

export interface CloudWaCfg {
  phoneNumberId: string;
  token: string;
  flowId: string;
  /** "draft" lets you test an unpublished Flow */
  flowMode?: "draft" | "published";
  graphVersion?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const digits = (s: string) => s.replace(/\D/g, "");

export class CloudWa implements WaPort {
  private cfg: CloudWaCfg;
  constructor(cfg: CloudWaCfg) {
    this.cfg = cfg;
  }

  private url(path: string) {
    return `https://graph.facebook.com/${this.cfg.graphVersion ?? "v21.0"}/${path}`;
  }

  /** retries 429 / 5xx / network errors with backoff; other 4xx fail at once */
  private async request(path: string, init: () => RequestInit, attempts = 4): Promise<Response> {
    const f = this.cfg.fetch ?? fetch;
    const sleep = this.cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let last = "";
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await f(this.url(path), init());
        if (r.status !== 429 && r.status < 500) return r;
        last = `HTTP ${r.status}`;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
      if (i < attempts - 1) await sleep(300 * 2 ** i);
    }
    throw new Error(`WhatsApp request failed: ${last}`);
  }

  private async post(body: Record<string, unknown>): Promise<boolean> {
    try {
      const r = await this.request(`${this.cfg.phoneNumberId}/messages`, () => ({
        method: "POST",
        headers: { Authorization: `Bearer ${this.cfg.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
      }));
      if (!r.ok)
        console.warn(
          JSON.stringify({ event: "wa_send_rejected", status: r.status, detail: (await r.text()).slice(0, 300) }),
        );
      return r.ok;
    } catch (e) {
      console.error(JSON.stringify({ event: "wa_send_failed", error: e instanceof Error ? e.message : String(e) }));
      return false;
    }
  }

  sendText(to: string, text: string) {
    return this.post({ to: digits(to), type: "text", text: { body: text, preview_url: false } });
  }

  sendFlow(to: string, p: { body: string; token: string; cta?: string }) {
    return this.post({
      to: digits(to),
      type: "interactive",
      interactive: {
        type: "flow",
        body: { text: p.body },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_token: p.token,
            flow_id: this.cfg.flowId,
            flow_cta: (p.cta ?? "Create invoice").slice(0, 20),
            flow_action: "data_exchange",
            ...(this.cfg.flowMode === "draft" ? { mode: "draft" } : {}),
          },
        },
      },
    });
  }

  sendButtons(to: string, body: string, buttons: { id: string; title: string }[]) {
    return this.post({
      to: digits(to),
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          buttons: buttons
            .slice(0, 3)
            .map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })),
        },
      },
    });
  }

  async sendDocument(to: string, d: { filename: string; base64: string; caption: string }): Promise<boolean> {
    try {
      const r = await this.request(`${this.cfg.phoneNumberId}/media`, () => {
        const form = new FormData();
        form.set("messaging_product", "whatsapp");
        form.set("type", "application/pdf");
        form.set("file", new Blob([Buffer.from(d.base64, "base64")], { type: "application/pdf" }), d.filename);
        return { method: "POST", headers: { Authorization: `Bearer ${this.cfg.token}` }, body: form };
      });
      if (!r.ok) return false;
      const { id } = (await r.json()) as { id?: string };
      if (!id) return false;
      return this.post({
        to: digits(to),
        type: "document",
        document: { id, filename: d.filename, caption: d.caption },
      });
    } catch (e) {
      console.error(JSON.stringify({ event: "wa_document_failed", error: e instanceof Error ? e.message : String(e) }));
      return false;
    }
  }
}
