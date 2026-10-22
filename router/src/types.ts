/** A service that receives WhatsApp events (expense capture, invoicing, ...). Managed from the admin screen later. */
export interface Target {
  id: string;
  name: string;
  /** https address of the service's webhook */
  url: string;
  /** sent as X-Router-Secret so the service can refuse calls that did not come through the router */
  secret?: string;
  enabled: boolean;
  /** receives every sender that no service has claimed (e.g. the existing expense capture), so nobody is cut off */
  isDefault?: boolean;
}

/** Which service owns which WhatsApp number. One number belongs to exactly one service. */
export interface NumberRoute {
  phone: string; // digits only, e.g. 966501234567
  targetId: string;
  /** false = registered but switched off (e.g. a frozen salesman): dropped, never sent to the default service */
  enabled?: boolean;
}

export interface Registry {
  targets(): Promise<Target[]>;
  routes(): Promise<NumberRoute[]>;
}

/** Remembers message ids so a Meta retry is never forwarded twice. */
export interface SeenStore {
  /** true if the id was already seen; otherwise records it and returns false */
  seen(id: string): Promise<boolean>;
  /** forget ids again when the forward failed, so Meta's retry is accepted */
  forget(ids: string[]): Promise<void>;
}

export interface RouterDeps {
  appSecret: string;
  registry: Registry;
  seen: SeenStore;
  fetch: typeof fetch;
  timeoutMs?: number;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface WaEvent {
  /** the person the event is about: the sender of a message, or the recipient of a status */
  phone: string;
  /** wamid of the message or status */
  id: string;
  kind: "message" | "status";
}
