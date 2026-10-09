/**
 * Listing (seller) and Requirement (buyer) flows — Phase 2.
 *
 * Entry point: routeRegisteredUser(ctx, party), called from onboarding.ts
 * handleDone() for any registered user (onboardingStep DONE) message that
 * isn't a plain greeting.
 *
 * Code decides every state transition. The LLM (extractIntent) only pulls
 * fields out of free text — it never decides what happens next.
 */
import { prisma } from "@/lib/prisma";
import type { Party, Listing, Requirement } from "@prisma/client";
import { getProvider } from "@/providers";
import { getStorage } from "@/lib/storage";
import { enqueueReply, buildButtons, buildText } from "./helpers";
import { extractIntent, type ExtractedIntent, type DraftState } from "./extractor";
import { allowLLMCall } from "./rate-limit";
import { runMatchingForListing, runMatchingForRequirement, handleBuyerInterested, productsMatch } from "./matching";
import { broadcastRequirementToSellers } from "./quotes";
import { buildMagicLink } from "@/lib/magic-link";
import { BTN, extractText, extractButtonId, type BotContext } from "./onboarding";

const MAX_LISTING_PHOTOS = 5;

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function routeRegisteredUser(ctx: BotContext, party: Party): Promise<void> {
  const buttonId = extractButtonId(ctx.parsed);
  if (buttonId) {
    const handled = await handleButton(ctx, party, buttonId);
    if (handled) return;
  }

  if (ctx.parsed.contentType === "image") {
    await handleIncomingPhoto(ctx, party);
    return;
  }

  const text = extractText(ctx.parsed).trim();
  if (!text) return;

  if (text.toLowerCase() === "dashboard" && party.role) {
    const link = buildMagicLink(party.id, party.role);
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText(
        `📊 Apna dashboard dekhne ke liye ye link kholiye (15 min tak valid hai):\n${link}`
      ),
      dedupeKey: `dashboard_link_${ctx.parsed.providerId}_${party.id}`,
    });
    return;
  }

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

  // BOTH users can have a draft listing AND an open requirement at once —
  // prefer whichever is actively incomplete as the extractor's context.
  const draftListing = party.role !== "BUYER" ? await getDraftListing(ctx.orgId, party.id) : null;
  const openRequirement = party.role !== "SELLER" ? await getOpenRequirement(ctx.orgId, party.id) : null;
  const draftForExtractor = draftListing ?? openRequirement;

  const extracted = await extractIntent({
    text,
    role: party.role as "SELLER" | "BUYER" | "BOTH",
    draft: draftForExtractor ? toDraftState(draftForExtractor) : null,
    recentMessages: await getRecentMessages(ctx.conversation.id),
  });

  if (!extracted) {
    await sendRephrase(ctx, party);
    return;
  }

  console.info("[Listings] intent", {
    contactId: party.contactId,
    role: party.role,
    intent: extracted.intent,
  });

  if (party.role === "SELLER" && extracted.intent === "create_requirement") {
    await sendRoleMismatch(ctx, party);
    return;
  }
  if (party.role === "BUYER" && extracted.intent === "create_listing") {
    await sendRoleMismatch(ctx, party);
    return;
  }

  switch (extracted.intent) {
    case "create_listing":
      await handleSellerMessage(ctx, party, extracted, draftListing);
      break;
    case "create_requirement":
      await handleBuyerMessage(ctx, party, extracted, openRequirement);
      break;
    case "add_details": {
      // Ambiguous for BOTH — prefer whichever side actually has something in progress.
      const actingSeller = party.role === "SELLER" || (party.role === "BOTH" && Boolean(draftListing));
      if (actingSeller) {
        await handleSellerMessage(ctx, party, extracted, draftListing);
      } else {
        await handleBuyerMessage(ctx, party, extracted, openRequirement);
      }
      break;
    }
    case "close_listing":
      if (party.role === "BUYER") {
        await sendRoleMismatch(ctx, party);
      } else {
        await closeListing(ctx, party, extracted);
      }
      break;
    case "other":
      await handleOtherIntent(ctx, party);
      break;
  }
}

// ─── Button handling ──────────────────────────────────────────────────────────

async function handleButton(ctx: BotContext, party: Party, buttonId: string): Promise<boolean> {
  if (buttonId.startsWith(BTN.MATCH_INTERESTED_PREFIX)) {
    const matchId = buttonId.slice(BTN.MATCH_INTERESTED_PREFIX.length);
    await handleBuyerInterested(ctx.orgId, matchId, ctx.parsed.providerId);
    return true;
  }

  switch (buttonId) {
    case BTN.LISTING_PUBLISH: {
      const listing = await getDraftListing(ctx.orgId, party.id);
      if (listing) {
        await publishListing(ctx, party, listing);
      } else {
        await enqueueReply({
          organizationId: ctx.orgId,
          conversationId: ctx.conversation.id,
          to: ctx.contact.waPhone,
          content: buildText("Ye listing already publish ho chuki hai ya mili nahi. 'My listings' bhejke check kar lijiye."),
          dedupeKey: `listing_publish_notfound_${ctx.parsed.providerId}_${party.id}`,
        });
      }
      return true;
    }
    case BTN.LISTING_ADD_PHOTO: {
      await enqueueReply({
        organizationId: ctx.orgId,
        conversationId: ctx.conversation.id,
        to: ctx.contact.waPhone,
        content: buildText(`Theek hai, photo bhej dijiye 📸 (max ${MAX_LISTING_PHOTOS})`),
        dedupeKey: `listing_photo_prompt_${ctx.parsed.providerId}_${party.id}`,
      });
      return true;
    }
    case BTN.LISTING_EDIT: {
      await enqueueReply({
        organizationId: ctx.orgId,
        conversationId: ctx.conversation.id,
        to: ctx.contact.waPhone,
        content: buildText("Kya badalna hai? Naya quantity, price ya location bata dijiye."),
        dedupeKey: `listing_edit_prompt_${ctx.parsed.providerId}_${party.id}`,
      });
      return true;
    }
    case BTN.REQ_ADD_DETAILS: {
      await enqueueReply({
        organizationId: ctx.orgId,
        conversationId: ctx.conversation.id,
        to: ctx.contact.waPhone,
        content: buildText("Aur kya detail add karni hai? Quantity, price ya location bata dijiye."),
        dedupeKey: `req_details_prompt_${ctx.parsed.providerId}_${party.id}`,
      });
      return true;
    }
    case BTN.REQ_CLOSE: {
      const req = await getOpenRequirement(ctx.orgId, party.id);
      if (req) {
        await prisma.requirement.update({ where: { id: req.id }, data: { status: "CLOSED" } });
        console.info("[Listings] requirement closed", { contactId: party.contactId, id: req.id });
      }
      await enqueueReply({
        organizationId: ctx.orgId,
        conversationId: ctx.conversation.id,
        to: ctx.contact.waPhone,
        content: buildText("Aapki request band kar di hai ✅"),
        dedupeKey: `req_closed_${ctx.parsed.providerId}_${party.id}`,
      });
      return true;
    }
    case BTN.MENU_LIST_PRODUCT: {
      await enqueueReply({
        organizationId: ctx.orgId,
        conversationId: ctx.conversation.id,
        to: ctx.contact.waPhone,
        content: buildText("Batayiye aapko kya bechna hai — product, quantity, price sab bata dijiye."),
        dedupeKey: `menu_list_${ctx.parsed.providerId}_${party.id}`,
      });
      return true;
    }
    case BTN.MENU_MY_LISTINGS:
      await sendMyListings(ctx, party);
      return true;
    case BTN.MENU_REQUEST_PRODUCT: {
      await enqueueReply({
        organizationId: ctx.orgId,
        conversationId: ctx.conversation.id,
        to: ctx.contact.waPhone,
        content: buildText("Batayiye aapko kya chahiye — product aur quantity bata dijiye."),
        dedupeKey: `menu_req_${ctx.parsed.providerId}_${party.id}`,
      });
      return true;
    }
    case BTN.MENU_MY_REQUESTS:
      await sendMyRequests(ctx, party);
      return true;
    case BTN.MENU_MY_ACTIVITY:
      await sendMyListings(ctx, party);
      await sendMyRequests(ctx, party);
      return true;
    default:
      return false;
  }
}

// ─── Seller flow ──────────────────────────────────────────────────────────────

async function handleSellerMessage(
  ctx: BotContext,
  party: Party,
  extracted: ExtractedIntent,
  draft: Listing | null
): Promise<void> {
  let listing = draft;

  // A different product than the current draft means a NEW listing, not an
  // edit of the old one — otherwise a seller starting a second product while
  // the first draft is still open would silently overwrite it.
  const isDifferentProduct =
    listing && extracted.product && !productsMatch(listing.product, extracted.product);

  if (!listing || isDifferentProduct) {
    if (!extracted.product) {
      await sendNeedProduct(ctx, party, "sell");
      return;
    }
    const code = await generateListingCode(ctx.orgId);
    listing = await prisma.listing.create({
      data: {
        organizationId: ctx.orgId,
        sellerPartyId: party.id,
        code,
        product: extracted.product,
        category: extracted.category ?? undefined,
        quantity: extracted.quantity ?? undefined,
        unit: extracted.unit ?? undefined,
        pricePerUnit: extracted.price ?? undefined,
        location: extracted.location ?? undefined,
      },
    });
    console.info("[Listings] draft created", { contactId: party.contactId, code: listing.code });
  } else {
    listing = await prisma.listing.update({
      where: { id: listing.id },
      data: {
        product: extracted.product ?? listing.product,
        category: extracted.category ?? listing.category ?? undefined,
        quantity: extracted.quantity ?? (listing.quantity as unknown as number | null) ?? undefined,
        unit: extracted.unit ?? listing.unit ?? undefined,
        pricePerUnit:
          extracted.price ?? (listing.pricePerUnit as unknown as number | null) ?? undefined,
        location: extracted.location ?? listing.location ?? undefined,
      },
    });
    console.info("[Listings] draft updated", { contactId: party.contactId, code: listing.code });
  }

  await askNextOrSummary(ctx, party, listing);
}

async function askNextOrSummary(ctx: BotContext, party: Party, listing: Listing): Promise<void> {
  if (listing.quantity == null || !listing.unit) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText("Kitni quantity hai aur kis unit mein? Jaise: *100 ton* ya *50 bags*"),
      dedupeKey: `listing_ask_qty_${ctx.parsed.providerId}_${listing.id}`,
    });
    return;
  }
  if (listing.pricePerUnit == null) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText(`Price kya rakhna hai per ${listing.unit}? Jaise: *35 per ${listing.unit}*`),
      dedupeKey: `listing_ask_price_${ctx.parsed.providerId}_${listing.id}`,
    });
    return;
  }
  if (!listing.location) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText("Product kahan available hai? Shehar ka naam bata dijiye."),
      dedupeKey: `listing_ask_location_${ctx.parsed.providerId}_${listing.id}`,
    });
    return;
  }
  await sendListingSummary(ctx, party, listing);
}

async function sendListingSummary(ctx: BotContext, party: Party, listing: Listing): Promise<void> {
  const body =
    `📦 *${listing.product}*\n` +
    `Quantity: ${listing.quantity} ${listing.unit}\n` +
    `Price: ₹${listing.pricePerUnit} per ${listing.unit}\n` +
    `Location: ${listing.location}\n\n` +
    "Sab sahi hai? Publish kar doon?";
  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildButtons(body, [
      { id: BTN.LISTING_PUBLISH, title: "Publish" },
      { id: BTN.LISTING_ADD_PHOTO, title: "Add photo" },
      { id: BTN.LISTING_EDIT, title: "Edit" },
    ]),
    dedupeKey: `listing_summary_${ctx.parsed.providerId}_${listing.id}`,
  });
}

async function publishListing(ctx: BotContext, party: Party, listing: Listing): Promise<void> {
  const updated = await prisma.listing.update({
    where: { id: listing.id },
    data: { status: "OPEN" },
  });
  console.info("[Listings] published", { contactId: party.contactId, code: updated.code });
  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText(
      `✅ Publish ho gaya! Aapki listing ka code hai *${updated.code}*. Buyers isse jald hi dekh paayenge.`
    ),
    dedupeKey: `listing_published_${ctx.parsed.providerId}_${listing.id}`,
  });

  try {
    await runMatchingForListing(ctx.orgId, updated);
  } catch (err) {
    console.error("[Matching] failed for listing", { code: updated.code, err: (err as Error).message });
  }
}

async function closeListing(
  ctx: BotContext,
  party: Party,
  extracted: ExtractedIntent
): Promise<void> {
  const listing = extracted.listingCode
    ? await prisma.listing.findFirst({
        where: {
          organizationId: ctx.orgId,
          sellerPartyId: party.id,
          code: { equals: extracted.listingCode, mode: "insensitive" },
        },
      })
    : await prisma.listing.findFirst({
        where: { organizationId: ctx.orgId, sellerPartyId: party.id, status: "OPEN" },
        orderBy: { createdAt: "desc" },
      });

  if (!listing) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText("Mujhe aapki koi open listing nahi mili. Listing code bata dijiye, jaise *LST-0001*."),
      dedupeKey: `close_notfound_${ctx.parsed.providerId}_${party.id}`,
    });
    return;
  }

  await prisma.listing.update({ where: { id: listing.id }, data: { status: "CLOSED" } });
  console.info("[Listings] closed", { contactId: party.contactId, code: listing.code });
  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText(`✅ *${listing.code}* band kar di. Badhai ho! 🎉`),
    dedupeKey: `close_done_${ctx.parsed.providerId}_${listing.id}`,
  });
}

async function sendMyListings(ctx: BotContext, party: Party): Promise<void> {
  const listings = await prisma.listing.findMany({
    where: { organizationId: ctx.orgId, sellerPartyId: party.id, status: { in: ["OPEN", "DRAFT"] } },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  if (listings.length === 0) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText("Aapki abhi koi listing nahi hai. Bechna shuru karne ke liye product bata dijiye!"),
      dedupeKey: `my_listings_empty_${ctx.parsed.providerId}_${party.id}`,
    });
    return;
  }
  const lines = listings.map((l) => `*${l.code}* — ${l.product} (${l.status})`);
  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText(lines.join("\n")),
    dedupeKey: `my_listings_${ctx.parsed.providerId}_${party.id}`,
  });
}

// ─── Buyer flow ───────────────────────────────────────────────────────────────

async function handleBuyerMessage(
  ctx: BotContext,
  party: Party,
  extracted: ExtractedIntent,
  existing: Requirement | null
): Promise<void> {
  let requirement = existing;

  // A different product than the current open requirement means a NEW
  // requirement, not an edit of the old one — otherwise asking about a
  // second product while the first is still open would silently overwrite it.
  const isDifferentProduct =
    requirement && extracted.product && !productsMatch(requirement.product, extracted.product);

  if (!requirement || isDifferentProduct) {
    if (!extracted.product) {
      await sendNeedProduct(ctx, party, "buy");
      return;
    }
    requirement = await prisma.requirement.create({
      data: {
        organizationId: ctx.orgId,
        buyerPartyId: party.id,
        product: extracted.product,
        category: extracted.category ?? undefined,
        quantity: extracted.quantity ?? undefined,
        unit: extracted.unit ?? undefined,
        maxPrice: extracted.price ?? undefined,
        location: extracted.location ?? undefined,
        deadlineDays: extracted.deadlineDays ?? undefined,
      },
    });
    console.info("[Listings] requirement created", { contactId: party.contactId, id: requirement.id });
  } else {
    requirement = await prisma.requirement.update({
      where: { id: requirement.id },
      data: {
        quantity: extracted.quantity ?? (requirement.quantity as unknown as number | null) ?? undefined,
        unit: extracted.unit ?? requirement.unit ?? undefined,
        maxPrice: extracted.price ?? (requirement.maxPrice as unknown as number | null) ?? undefined,
        location: extracted.location ?? requirement.location ?? undefined,
        deadlineDays: extracted.deadlineDays ?? requirement.deadlineDays ?? undefined,
      },
    });
    console.info("[Listings] requirement updated", { contactId: party.contactId, id: requirement.id });
  }

  await askNextOrBroadcast(ctx, party, requirement);

  try {
    await runMatchingForRequirement(ctx.orgId, requirement);
  } catch (err) {
    console.error("[Matching] failed for requirement", { id: requirement.id, err: (err as Error).message });
  }
}

async function askNextOrBroadcast(ctx: BotContext, party: Party, requirement: Requirement): Promise<void> {
  if (requirement.quantity == null || !requirement.unit) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText("Kitni quantity chahiye aur kis unit mein? Jaise: *100 ton* ya *50 bags*"),
      dedupeKey: `req_ask_qty_${ctx.parsed.providerId}_${requirement.id}`,
    });
    return;
  }
  if (requirement.maxPrice == null) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText(`Budget kya hai per ${requirement.unit}?`),
      dedupeKey: `req_ask_price_${ctx.parsed.providerId}_${requirement.id}`,
    });
    return;
  }
  if (!requirement.location) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText("Kis city mein chahiye?"),
      dedupeKey: `req_ask_location_${ctx.parsed.providerId}_${requirement.id}`,
    });
    return;
  }
  if (requirement.deadlineDays == null) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText("Kitne din mein chahiye?"),
      dedupeKey: `req_ask_deadline_${ctx.parsed.providerId}_${requirement.id}`,
    });
    return;
  }

  if (!requirement.broadcastAt) {
    let sentCount = 0;
    try {
      sentCount = await broadcastRequirementToSellers(ctx.orgId, requirement);
    } catch (err) {
      console.error("[Quotes] broadcast failed", { requirementId: requirement.id, err: (err as Error).message });
    }
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText(
        sentCount > 0
          ? `✅ Note kar liya! *${requirement.location}* ke ${sentCount} seller(s) ko bhej diya hai — jald hi quotes aana shuru ho jaayenge. Photo add karni ho to abhi bhej dijiye (optional).`
          : `✅ Note kar liya! Abhi *${requirement.location}* mein koi seller registered nahi hai, jaise hi koi add hoga use bhej dunga.`
      ),
      dedupeKey: `req_broadcast_done_${requirement.id}`,
    });
    return;
  }

  await sendRequirementSummary(ctx, party, requirement);
}

async function sendRequirementSummary(ctx: BotContext, party: Party, req: Requirement): Promise<void> {
  const lines = [`🔍 *${req.product}*`];
  if (req.quantity != null) lines.push(`Quantity: ${req.quantity}${req.unit ? " " + req.unit : ""}`);
  if (req.maxPrice != null) lines.push(`Max price: ₹${req.maxPrice}`);
  if (req.location) lines.push(`Location: ${req.location}`);
  if (req.deadlineDays != null) lines.push(`Deadline: ${req.deadlineDays} din`);
  lines.push("", "Updated! Sellers ko already bhej diya hai.");

  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildButtons(lines.join("\n"), [
      { id: BTN.REQ_ADD_DETAILS, title: "Add details" },
      { id: BTN.REQ_CLOSE, title: "Close request" },
    ]),
    dedupeKey: `req_summary_${ctx.parsed.providerId}_${req.id}`,
  });
}

async function sendMyRequests(ctx: BotContext, party: Party): Promise<void> {
  const requirements = await prisma.requirement.findMany({
    where: { organizationId: ctx.orgId, buyerPartyId: party.id, status: "OPEN" },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  if (requirements.length === 0) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText("Aapki abhi koi open request nahi hai. Kya chahiye, bata dijiye!"),
      dedupeKey: `my_requests_empty_${ctx.parsed.providerId}_${party.id}`,
    });
    return;
  }
  const lines = requirements.map((r) => `${r.product}${r.quantity ? ` — ${r.quantity} ${r.unit ?? ""}`.trim() : ""}`);
  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText(lines.join("\n")),
    dedupeKey: `my_requests_${ctx.parsed.providerId}_${party.id}`,
  });
}

// ─── Shared replies ───────────────────────────────────────────────────────────

async function handleOtherIntent(ctx: BotContext, party: Party): Promise<void> {
  const buttons =
    party.role === "SELLER"
      ? [
          { id: BTN.MENU_LIST_PRODUCT, title: "List a product" },
          { id: BTN.MENU_MY_LISTINGS, title: "My listings" },
        ]
      : party.role === "BUYER"
      ? [
          { id: BTN.MENU_REQUEST_PRODUCT, title: "Request a product" },
          { id: BTN.MENU_MY_REQUESTS, title: "My requests" },
        ]
      : [
          { id: BTN.MENU_LIST_PRODUCT, title: "List a product" },
          { id: BTN.MENU_REQUEST_PRODUCT, title: "Request a product" },
          { id: BTN.MENU_MY_ACTIVITY, title: "My activity" },
        ];

  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildButtons("Kya karna chahenge?", buttons),
    dedupeKey: `other_menu_${ctx.parsed.providerId}_${party.id}`,
  });
}

async function sendRoleMismatch(ctx: BotContext, party: Party): Promise<void> {
  const role = party.role === "SELLER" ? "Seller" : "Buyer";
  const oppositeAction = party.role === "SELLER" ? "khareedna" : "bechna";
  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText(
      `Aap humare paas *${role}* registered hain, isliye ${oppositeAction} wala message samajh nahi paya. ` +
        "Role badalna ho to 'restart' likhiye."
    ),
    dedupeKey: `role_mismatch_${ctx.parsed.providerId}_${party.id}`,
  });
}

async function sendRephrase(ctx: BotContext, party: Party): Promise<void> {
  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText(
      "Samajh nahi paya 🙏 Thoda seedha bata dijiye, jaise: *100 ton cement bechna hai* ya *50 ton cement chahiye*."
    ),
    dedupeKey: `rephrase_${ctx.parsed.providerId}_${party.id}`,
  });
}

async function sendNeedProduct(ctx: BotContext, party: Party, mode: "sell" | "buy"): Promise<void> {
  const prompt =
    mode === "sell"
      ? "Pehle batayiye aapko kya product bechna hai, jaise *cement*."
      : "Pehle batayiye aapko kya product chahiye, jaise *cement*.";
  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText(prompt),
    dedupeKey: `need_product_${ctx.parsed.providerId}_${party.id}`,
  });
}

// ─── Photo handling ───────────────────────────────────────────────────────────

async function handleIncomingPhoto(ctx: BotContext, party: Party): Promise<void> {
  if (party.role === "BUYER") {
    await handleRequirementPhoto(ctx, party);
    return;
  }

  const listing = await getDraftOrOpenListing(ctx.orgId, party.id);
  if (!listing && party.role === "BOTH") {
    await handleRequirementPhoto(ctx, party);
    return;
  }
  if (!listing) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText("Pehle product ki details bata dijiye, phir photo bhejiye."),
      dedupeKey: `photo_nolisting_${ctx.parsed.providerId}_${party.id}`,
    });
    return;
  }

  const mediaCount = await prisma.listingMedia.count({ where: { listingId: listing.id } });
  if (mediaCount >= MAX_LISTING_PHOTOS) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText(`Is listing ke liye already ${MAX_LISTING_PHOTOS} photos aa chuki hain.`),
      dedupeKey: `photo_max_${ctx.parsed.providerId}_${listing.id}`,
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
    console.error("[Listings] media download failed", {
      contactId: party.contactId,
      err: (err as Error).message,
    });
  }

  await prisma.listingMedia.create({
    data: {
      listingId: listing.id,
      whatsappMediaId: mediaId,
      storageUrl: storageUrl ?? undefined,
      mimeType: mimeType ?? undefined,
    },
  });

  console.info("[Listings] photo saved", {
    contactId: party.contactId,
    code: listing.code,
    stored: Boolean(storageUrl),
  });

  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText(
      storageUrl
        ? `📸 Photo add ho gayi *${listing.code}* mein!`
        : `📸 Photo note kar li hai *${listing.code}* ke liye.`
    ),
    dedupeKey: `photo_saved_${ctx.parsed.providerId}_${listing.id}`,
  });
}

/** Buyer's optional reference photo of what they want, attached to their open Requirement. */
async function handleRequirementPhoto(ctx: BotContext, party: Party): Promise<void> {
  const requirement = await getOpenRequirement(ctx.orgId, party.id);
  if (!requirement) {
    await enqueueReply({
      organizationId: ctx.orgId,
      conversationId: ctx.conversation.id,
      to: ctx.contact.waPhone,
      content: buildText("Pehle batayiye aapko kya chahiye, phir photo bhejiye."),
      dedupeKey: `req_photo_norequirement_${ctx.parsed.providerId}_${party.id}`,
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
    console.error("[Listings] requirement media download failed", {
      contactId: party.contactId,
      err: (err as Error).message,
    });
  }

  await prisma.requirementMedia.create({
    data: {
      requirementId: requirement.id,
      whatsappMediaId: mediaId,
      storageUrl: storageUrl ?? undefined,
      mimeType: mimeType ?? undefined,
    },
  });

  console.info("[Listings] requirement photo saved", {
    contactId: party.contactId,
    requirementId: requirement.id,
    stored: Boolean(storageUrl),
  });

  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText(storageUrl ? "📸 Photo add ho gayi!" : "📸 Photo note kar li hai."),
    dedupeKey: `req_photo_saved_${ctx.parsed.providerId}_${requirement.id}`,
  });
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

async function getDraftListing(orgId: string, sellerPartyId: string): Promise<Listing | null> {
  return prisma.listing.findFirst({
    where: { organizationId: orgId, sellerPartyId, status: "DRAFT" },
    orderBy: { createdAt: "desc" },
  });
}

/** The draft being actively filled in, or (if none) the most recent OPEN listing — used as photo target and extraction context. */
async function getDraftOrOpenListing(orgId: string, sellerPartyId: string): Promise<Listing | null> {
  const draft = await getDraftListing(orgId, sellerPartyId);
  if (draft) return draft;
  return prisma.listing.findFirst({
    where: { organizationId: orgId, sellerPartyId, status: "OPEN" },
    orderBy: { createdAt: "desc" },
  });
}

async function getOpenRequirement(orgId: string, buyerPartyId: string): Promise<Requirement | null> {
  return prisma.requirement.findFirst({
    where: { organizationId: orgId, buyerPartyId, status: "OPEN" },
    orderBy: { createdAt: "desc" },
  });
}

async function generateListingCode(orgId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const count = await prisma.listing.count({ where: { organizationId: orgId } });
    const code = `LST-${String(count + 1 + attempt).padStart(4, "0")}`;
    const exists = await prisma.listing.findUnique({
      where: { organizationId_code: { organizationId: orgId, code } },
    });
    if (!exists) return code;
  }
  return `LST-${Date.now()}`;
}

function toDraftState(row: Listing | Requirement): DraftState {
  const l = row as Partial<Listing> & Partial<Requirement>;
  return {
    product: l.product ?? null,
    category: l.category ?? null,
    quantity: l.quantity != null ? Number(l.quantity) : null,
    unit: l.unit ?? null,
    price: (l.pricePerUnit ?? l.maxPrice) != null ? Number(l.pricePerUnit ?? l.maxPrice) : null,
    location: l.location ?? null,
    deadlineDays: l.deadlineDays ?? null,
  };
}

async function getRecentMessages(conversationId: string): Promise<string[]> {
  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  return messages
    .reverse()
    .map(messageToLine)
    .filter((l): l is string => Boolean(l));
}

function messageToLine(m: { direction: string; contentType: string; content: unknown }): string | null {
  const who = m.direction === "INBOUND" ? "User" : "Bot";
  const c = (m.content ?? {}) as Record<string, unknown>;
  let text = "";

  if (m.contentType === "TEXT") {
    text = (c.body as string) ?? "";
  } else if (m.contentType === "INTERACTIVE") {
    if (m.direction === "INBOUND") {
      const br = c as { button_reply?: { title?: string }; list_reply?: { title?: string } };
      text = br.button_reply?.title ?? br.list_reply?.title ?? "";
    } else {
      const ic = c as { interactive?: { body?: { text?: string } } };
      text = ic.interactive?.body?.text ?? "";
    }
  }

  return text ? `${who}: ${text}` : null;
}
