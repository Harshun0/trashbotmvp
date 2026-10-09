/**
 * Listing/requirement intent extractor.
 *
 * Code decides every state transition (seller/buyer flow) — this module only
 * pulls structured fields out of a free-text WhatsApp message (often Hinglish).
 * Never invents values: anything not present in the message stays null.
 *
 * On invalid JSON, schema mismatch, or LLM failure: returns null. Callers
 * must fall back to a fixed "please rephrase" reply — never crash.
 */
import { z } from "zod";
import { callLLM } from "./llm";

export const extractedIntentSchema = z.object({
  intent: z.enum([
    "create_listing",
    "add_details",
    "create_requirement",
    "close_listing",
    "other",
  ]),
  product: z.string().nullable().default(null),
  category: z.string().nullable().default(null),
  quantity: z.number().nullable().default(null),
  unit: z.string().nullable().default(null),
  price: z.number().nullable().default(null),
  location: z.string().nullable().default(null),
  listingCode: z.string().nullable().default(null),
  /** Buyer only — "kitne din mein chahiye", as a plain number of days. */
  deadlineDays: z.number().int().nullable().default(null),
  missing: z.array(z.string()).default([]),
});

export type ExtractedIntent = z.infer<typeof extractedIntentSchema>;

export interface DraftState {
  product?: string | null;
  category?: string | null;
  quantity?: number | null;
  unit?: string | null;
  price?: number | null;
  location?: string | null;
  deadlineDays?: number | null;
}

export interface ExtractorInput {
  text: string;
  /** BOTH = this user can both sell and buy — infer which one from the message itself. */
  role: "SELLER" | "BUYER" | "BOTH";
  /** The seller's open DRAFT listing or buyer's in-progress requirement, if any. */
  draft?: DraftState | null;
  /** Last ~6 messages of the conversation, oldest first, plain text. */
  recentMessages?: string[];
}

const SYSTEM_PROMPT = `You are a data extraction engine for a WhatsApp marketplace bot used by Indian commodity traders. Users write in Hinglish (Hindi written in Latin script mixed with English), e.g. "100 ton cement bags sell karna hai" or "mujhe 50 ton cement chahiye Pune me".

Extract structured fields from the user's latest message. Use the conversation context and the current draft only to understand what is already known — do NOT repeat already-known values unless the user is correcting them.

Return ONLY JSON matching this exact shape, no prose, no markdown fences:
{
  "intent": "create_listing" | "add_details" | "create_requirement" | "close_listing" | "other",
  "product": string | null,
  "category": string | null,
  "quantity": number | null,
  "unit": string | null,
  "price": number | null,
  "location": string | null,
  "listingCode": string | null,
  "deadlineDays": number | null,
  "missing": string[]
}

Rules:
- "create_listing": seller describing a new product to sell (first mention of a product, or a DIFFERENT product than the current draft).
- "add_details": adding quantity/price/location/deadline/etc to the EXISTING draft — only use this when the message is clearly continuing the SAME product as "Current draft" below (or mentions no product at all, just a number/unit/location/deadline). If the message names a different product than the current draft, use "create_listing" or "create_requirement" instead, never "add_details".
- "create_requirement": buyer describing something they want to buy (first mention of a product, or a DIFFERENT product than the current draft).
- "close_listing": user says things like "close LST-0001", "sold", "band karo" — extract listingCode if present.
- "other": greetings, menu requests, anything that isn't listing/requirement related.
- When role is "BOTH": decide "create_listing" vs "create_requirement" purely from the message's own language — selling words ("bechna", "sell", "available") mean create_listing; buying words ("chahiye", "khareedna", "buy", "need") mean create_requirement.
- "deadlineDays" is ONLY relevant for buyers (create_requirement/add_details when the context is a requirement): "kitne din mein chahiye", "kal tak", "ek hafte mein" → convert to a plain integer number of days (kal=1, ek hafte=7, "aaj hi"/"abhi"=0). Never set this for sellers.
- Never invent a value. If a field isn't mentioned in this message, set it to null.
- "price" means price per unit (for a listing) or the buyer's budget per unit (for a requirement), extract only the number (no currency symbols).
- "quantity" is a plain number (convert words like "sau" = 100 if unambiguous, otherwise null).
- "missing" lists field names (from: quantity, unit, price, location, deadlineDays) that are still needed to complete a listing/requirement, given the draft context provided.`;

function buildUserPrompt(input: ExtractorInput): string {
  const parts: string[] = [];
  parts.push(`Role: ${input.role}`);
  if (input.draft) {
    parts.push(`Current draft: ${JSON.stringify(input.draft)}`);
  }
  if (input.recentMessages && input.recentMessages.length > 0) {
    parts.push(`Recent conversation:\n${input.recentMessages.join("\n")}`);
  }
  parts.push(`Latest message: ${input.text}`);
  return parts.join("\n\n");
}

/**
 * Extract intent + fields from a user's message.
 * Returns null on any failure — caller must reply with a fixed rephrase prompt.
 */
export async function extractIntent(input: ExtractorInput): Promise<ExtractedIntent | null> {
  return callLLM<ExtractedIntent>({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(input),
    schema: extractedIntentSchema,
  });
}

// ─── Seller quote extraction ───────────────────────────────────────────────────
// A separate, simpler extractor for a seller's reply to a broadcast quote
// request: price, delivery time, quality. No intent classification needed —
// code already knows this message is a quote reply.

export const quoteDetailsSchema = z.object({
  price: z.number().nullable().default(null),
  deliverByDays: z.number().int().nullable().default(null),
  quality: z.string().nullable().default(null),
});

export type QuoteDetails = z.infer<typeof quoteDetailsSchema>;

export interface QuoteExtractorInput {
  text: string;
  /** What the buyer is looking for, for context. */
  requirementSummary: string;
  /** Fields already collected for this quote, if any. */
  draft?: Partial<QuoteDetails> | null;
}

const QUOTE_SYSTEM_PROMPT = `You are a data extraction engine for a WhatsApp bot. A seller (Indian commodity trader, writes in Hinglish) is replying to a request to quote a price for supplying a buyer's requirement.

Return ONLY JSON matching this exact shape, no prose, no markdown fences:
{
  "price": number | null,
  "deliverByDays": number | null,
  "quality": string | null
}

Rules:
- "price": the price per unit the seller is quoting. Extract only the number (no currency symbols).
- "deliverByDays": how many days the seller needs to deliver — convert phrases like "kal" (1), "2-3 din" (3), "ek hafte" (7) to a plain integer. Use the higher number for a range.
- "quality": any free-text description of product quality/grade the seller mentions (e.g. "A grade", "mixed quality"). Null if not mentioned.
- Never invent a value not present in the message.`;

function buildQuoteUserPrompt(input: QuoteExtractorInput): string {
  const parts: string[] = [`Buyer needs: ${input.requirementSummary}`];
  if (input.draft) {
    parts.push(`Already collected: ${JSON.stringify(input.draft)}`);
  }
  parts.push(`Seller's message: ${input.text}`);
  return parts.join("\n\n");
}

/** Returns null on any failure — caller must reply with a fixed rephrase prompt. */
export async function extractQuoteDetails(input: QuoteExtractorInput): Promise<QuoteDetails | null> {
  return callLLM<QuoteDetails>({
    system: QUOTE_SYSTEM_PROMPT,
    user: buildQuoteUserPrompt(input),
    schema: quoteDetailsSchema,
  });
}
