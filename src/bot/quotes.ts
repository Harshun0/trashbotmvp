/**
 * Seller quote collection — the buyer-only pivot.
 *
 * Sellers no longer self-onboard or create listings via the bot (that flow in
 * listings.ts is left in place but unused). Instead, sellers are added
 * directly to the backend (admin dashboard "Add seller" form or
 * scripts/seed-demo-sellers.ts) with just name/city/phone, onboardingStep
 * preset to DONE.
 *
 * When a buyer's Requirement has every required field, broadcastRequirementToSellers
 * finds every seller Party whose city matches the requirement's location and:
 *  - creates a PENDING Quote row for them (idempotent — unique per requirement+seller)
 *  - sends them a message asking to quote (interactive inside the 24h window,
 *    an approved template outside it)
 *
 * Any inbound message from a seller who has a PENDING quote is routed here
 * (from onboarding.ts, ahead of the old listings.ts seller flow) to collect
 * price / deliverByDays / quality / optional photos, in that order.
 */
import { prisma } from "@/lib/prisma";
import type { Party, Requirement, Quote } from "@prisma/client";
import { getProvider } from "@/providers";
import { getStorage } from "@/lib/storage";
import { env } from "@/lib/env";
import { enqueueReply, buildText, isWithin24h } from "./helpers";
import { allowAlert, allowLLMCall } from "./rate-limit";
import { extractQuoteDetails } from "./extractor";
import type { BotContext } from "./onboarding";

const MAX_QUOTE_PHOTOS = 3;

// ─── Broadcast ──────────────────────────────────────────────────────────────

function citiesMatch(sellerCity: string, requirementLocation: string): boolean {
  const a = sellerCity.trim().toLowerCase();
  const b = requirementLocation.trim().toLowerCase();
  return a === b || a.includes(b) || b.includes(a);
}

async function findSellersInLocation(orgId: string, location: string): Promise<Party[]> {
  const sellers = await prisma.party.findMany({
    where: {
      organizationId: orgId,
      role: { in: ["SELLER", "BOTH"] },
      onboardingStep: "DONE",
      city: { not: null },
    },
  });
  return sellers.filter((s) => s.city && citiesMatch(s.city, location));
}

function requirementSummaryText(req: Requirement): string {
  const parts = [req.product];
  if (req.quantity != null) parts.push(`${req.quantity} ${req.unit ?? ""}`.trim());
  if (req.location) parts.push(`in ${req.location}`);
  if (req.deadlineDays != null) parts.push(`within ${req.deadlineDays} day(s)`);
  return parts.join(", ");
}

/**
 * Call once a Requirement has every field needed to broadcast (product,
 * quantity, location, maxPrice, deadlineDays). Idempotent — sets
 * requirement.broadcastAt so it only runs once per requirement.
 */
export async function broadcastRequirementToSellers(orgId: string, requirement: Requirement): Promise<number> {
  if (requirement.broadcastAt || !requirement.location) return 0;

  const sellers = await findSellersInLocation(orgId, requirement.location);
  let sentCount = 0;

  for (const seller of sellers) {
    const quote = await prisma.quote.upsert({
      where: { requirementId_sellerPartyId: { requirementId: requirement.id, sellerPartyId: seller.id } },
      create: { organizationId: orgId, requirementId: requirement.id, sellerPartyId: seller.id },
      update: {},
    });

    const sent = await sendQuoteRequest(orgId, seller, requirement, quote.id);
    if (sent) sentCount += 1;
  }

  await prisma.requirement.update({ where: { id: requirement.id }, data: { broadcastAt: new Date() } });
  console.info("[Quotes] broadcast sent", { requirementId: requirement.id, sellers: sellers.length, sent: sentCount });

  return sentCount;
}

async function sendQuoteRequest(orgId: string, seller: Party, req: Requirement, quoteId: string): Promise<boolean> {
  if (!(await allowAlert(seller.id))) {
    console.info("[Quotes] alert cap reached, skipping broadcast to seller", { sellerId: seller.id });
    return false;
  }

  const conversation = await prisma.conversation.findUnique({
    where: { organizationId_contactId: { organizationId: orgId, contactId: seller.contactId } },
    include: { contact: true },
  });
  if (!conversation) return false;

  const body =
    `📢 Naya buyer requirement aapke area mein!\n` +
    `*${req.product}* — ${requirementSummaryText(req)}\n\n` +
    "Kya aap supply kar sakte hain? Agar haan, to price (per unit), kitne din mein de payenge, aur quality bata dijiye.";

  if (isWithin24h(conversation.lastInboundAt)) {
    await enqueueReply({
      organizationId: orgId,
      conversationId: conversation.id,
      to: conversation.contact.waPhone,
      content: buildText(body),
      dedupeKey: `quote_request_${quoteId}`,
    });
    return true;
  }

  if (!env.WA_TEMPLATE_QUOTE_REQUEST) {
    console.warn("[Quotes] seller outside 24h window and WA_TEMPLATE_QUOTE_REQUEST not configured — skipping", {
      sellerId: seller.id,
    });
    return false;
  }

  await enqueueReply({
    organizationId: orgId,
    conversationId: conversation.id,
    to: conversation.contact.waPhone,
    content: {
      type: "template",
      name: env.WA_TEMPLATE_QUOTE_REQUEST,
      language: { code: env.WA_TEMPLATE_LANGUAGE },
      components: [{ type: "body", parameters: [{ type: "text", text: req.product }] }],
    },
    dedupeKey: `quote_request_${quoteId}`,
  });
  return true;
}

// ─── Seller reply handling ───────────────────────────────────────────────────

/** Most recent PENDING quote for this seller, if any — checked before the old listings.ts seller flow. */
export async function getPendingQuote(orgId: string, sellerPartyId: string): Promise<(Quote & { requirement: Requirement }) | null> {
  return prisma.quote.findFirst({
    where: { organizationId: orgId, sellerPartyId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    include: { requirement: true },
  });
}

export async function handleSellerQuoteReply(
  ctx: BotContext,
  party: Party,
  quote: Quote & { requirement: Requirement }
): Promise<void> {
  if (ctx.parsed.contentType === "image") {
    await handleQuotePhoto(ctx, quote);
    return;
  }

  const text = extractTextFromParsed(ctx);
  if (!text) return;

  if (!(await allowLLMCall(party.id))) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText("Thoda ruk jaiye, ek minute mein phir se try kariye 🙏"),
      dedupeKey: `rate_limit_${ctx.parsed.providerId}_${party.id}`,
    });
    return;
  }

  const extracted = await extractQuoteDetails({
    text,
    requirementSummary: requirementSummaryText(quote.requirement),
    draft: {
      price: quote.price != null ? Number(quote.price) : null,
      deliverByDays: quote.deliverByDays,
      quality: quote.quality,
    },
  });

  if (!extracted) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText("Samajh nahi paya 🙏 Thoda seedha bata dijiye, jaise: *35 per kg, 3 din mein, A grade*."),
      dedupeKey: `quote_rephrase_${ctx.parsed.providerId}_${quote.id}`,
    });
    return;
  }

  const updated = await prisma.quote.update({
    where: { id: quote.id },
    data: {
      price: extracted.price ?? (quote.price != null ? Number(quote.price) : undefined),
      deliverByDays: extracted.deliverByDays ?? quote.deliverByDays ?? undefined,
      quality: extracted.quality ?? quote.quality ?? undefined,
    },
  });

  console.info("[Quotes] updated", { quoteId: quote.id, sellerId: party.id });

  await askNextOrDone(ctx, updated);
}

async function askNextOrDone(ctx: BotContext, quote: Quote): Promise<void> {
  if (quote.price == null) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText("Price kya rakhenge (per unit)?"),
      dedupeKey: `quote_ask_price_${quote.id}`,
    });
    return;
  }
  if (quote.deliverByDays == null) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText("Kitne din mein de payenge?"),
      dedupeKey: `quote_ask_days_${quote.id}`,
    });
    return;
  }
  if (!quote.quality) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText("Quality kaisi hai? (Photo bhejna optional hai)"),
      dedupeKey: `quote_ask_quality_${quote.id}`,
    });
    return;
  }

  await prisma.quote.update({ where: { id: quote.id }, data: { status: "SUBMITTED" } });
  console.info("[Quotes] submitted", { quoteId: quote.id });

  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText("✅ Dhanyawad! Aapka quote note kar liya hai. Agar photo bhejni ho to abhi bhej dijiye, warna bas itna hi."),
    dedupeKey: `quote_submitted_${quote.id}`,
  });
}

async function handleQuotePhoto(ctx: BotContext, quote: Quote): Promise<void> {
  const mediaCount = await prisma.quoteMedia.count({ where: { quoteId: quote.id } });
  if (mediaCount >= MAX_QUOTE_PHOTOS) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText(`Is quote ke liye already ${MAX_QUOTE_PHOTOS} photos aa chuki hain.`),
      dedupeKey: `quote_photo_max_${ctx.parsed.providerId}_${quote.id}`,
    });
    return;
  }

  const imageContent = ctx.parsed.content as { id?: string } | null;
  const mediaId = imageContent?.id;
  if (!mediaId) return;

  let storageUrl: string | null = null;
  let mimeType: string | null = null;
  try {
    const provider = getProvider();
    const { buffer, mimeType: mt } = await provider.downloadMedia(mediaId);
    mimeType = mt;
    const storage = getStorage();
    if (storage) {
      const uploaded = await storage.upload(buffer, mt);
      storageUrl = uploaded.url;
    }
  } catch (err) {
    console.error("[Quotes] media download failed", { quoteId: quote.id, err: (err as Error).message });
  }

  await prisma.quoteMedia.create({
    data: { quoteId: quote.id, whatsappMediaId: mediaId, storageUrl: storageUrl ?? undefined, mimeType: mimeType ?? undefined },
  });

  console.info("[Quotes] photo saved", { quoteId: quote.id, stored: Boolean(storageUrl) });

  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText(storageUrl ? "📸 Photo add ho gayi!" : "📸 Photo note kar li hai."),
    dedupeKey: `quote_photo_saved_${ctx.parsed.providerId}_${quote.id}`,
  });
}

function extractTextFromParsed(ctx: BotContext): string {
  const c = ctx.parsed.content as Record<string, unknown> | null;
  if (!c) return "";
  if (ctx.parsed.contentType === "text") return ((c as { body?: string }).body ?? "").trim();
  if (ctx.parsed.contentType === "interactive") {
    const interactive = c as { button_reply?: { title?: string }; list_reply?: { title?: string } };
    return (interactive.button_reply?.title ?? interactive.list_reply?.title ?? "").trim();
  }
  return "";
}
