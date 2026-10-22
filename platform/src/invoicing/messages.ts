// What the salesman reads. English only for now (Malayalam is added after a native-speaker review).
// Codes match docs/whatsapp-invoicing/brief.md.
const M = {
  M01: "This number is not registered for invoicing. Please contact your supervisor.",
  M02: "Your account is not active. Please contact your supervisor.",
  M03: "Hello {name}. Tap the button below to create an invoice.",
  M04: "No customers are assigned to you. Please contact your supervisor.",
  M05: "Please enter a quantity greater than zero.",
  M06: "Please enter a valid price.",
  M07: "The price you entered for {product} is {entered}. The maximum allowed is {max} (before VAT). Please enter {max} or less.",
  M08: "Please add at least one product before creating the invoice.",
  M09: "{product} cannot be invoiced right now because no price limit is set. Please contact your supervisor.",
  M11: "Received. Your invoice is in the queue (position {n}). It will arrive here in about {minutes} minutes. Please do not submit it again.",
  M13: "Invoice {number} for {customer}. Total {total}. ZATCA cleared.",
  M14: "This request was already received (reference {ref}). It was not created again.",
  M15: "A similar invoice was created at {time} ({number}). A new one needs supervisor approval. Your request has been sent to your supervisor.",
  M16: "The system is busy. Your request is saved and will be processed automatically. You do not need to do anything.",
  M17: "ZATCA did not accept this invoice. Reason: {reason}. Please contact the accounts team with reference {ref}. Do not create it again.",
  M18: "We could not create your invoice. It was not issued. Please contact the accounts team with reference {ref}.",
  M20: "You are not allowed to invoice this customer. Please contact your supervisor.",
  M21: "This customer or product is not ready for invoicing yet ({what}). Please contact the accounts team.",
  M22: "This form has expired. Please start again by tapping the button below.",
  M23: "You have reached today's invoice limit. Please contact your supervisor.",
  M24: "Please use the invoice button. Messages cannot be used to create invoices.",
  M26: "Your invoice is created and cleared, but the PDF is delayed. It will arrive here shortly.",
  M27: "Invoice {number} is created. Waiting for ZATCA clearance. Do not create it again.",
  M28: "You can add up to {max} products in one invoice. Please create a second invoice for the rest.",
  M29: "Your supervisor did not approve this invoice. Please contact your supervisor.",
  M30: "Your supervisor approved this invoice. It is now in the queue. Please do not submit it again.",
  M31: "Invoicing is paused for a short time. Please try again later.",
} as const;

export type MsgCode = keyof typeof M;

export function msg(code: MsgCode, vars: Record<string, string | number> = {}): string {
  return M[code].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}
