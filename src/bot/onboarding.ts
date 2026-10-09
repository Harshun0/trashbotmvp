/**
 * Onboarding state machine.
 *
 * States:  ASK_ROLE → ASK_NAME → ASK_CITY → ASK_ALERTS → DONE
 *
 * Rules:
 * - Code drives every transition. LLM only extracts name/city from free text.
 * - Interactive button_reply is the canonical input for role and alert choice.
 * - "restart" or "menu" keywords reopen the flow from ASK_ROLE.
 * - A DONE user who says "hi" / "hello" gets a short registered-user menu.
 * - Unexpected input in any step repeats the current question with a short hint.
 * - Duplicate webhook → same Party state → enqueueReply deduplication → no second send.
 */
import { prisma } from "@/lib/prisma";
import type { Party } from "@prisma/client";
import type { InternalInboundMessage } from "@/providers/types";
import { enqueueReply, buildButtons, buildText } from "./helpers";
import { callLLM } from "./llm";
import { routeRegisteredUser } from "./listings";
import { getPendingQuote, handleSellerQuoteReply } from "./quotes";
import { z } from "zod";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BotContext {
  orgId: string;
  contact: { id: string; waPhone: string };
  conversation: { id: string; lastInboundAt: Date | null };
  parsed: InternalInboundMessage;
}

// ─── Button ID constants — single source of truth ─────────────────────────────
// These are set when building buttons AND read when parsing button_reply.id.
// Keep them in sync here rather than as magic strings scattered across handlers.

export const BTN = {
  ROLE_SELLER:  "role_seller",
  ROLE_BUYER:   "role_buyer",
  ROLE_BOTH:    "role_both",
  ALERT_ALL:    "alert_all",
  ALERT_MATCH:  "alert_match",
  ALERT_NONE:   "alert_none",

  // Phase 2 — listings & requirements
  LISTING_PUBLISH:    "listing_publish",
  LISTING_ADD_PHOTO:  "listing_add_photo",
  LISTING_EDIT:       "listing_edit",
  REQ_ADD_DETAILS:    "req_add_details",
  REQ_CLOSE:          "req_close",
  MENU_LIST_PRODUCT:  "menu_list_product",
  MENU_MY_LISTINGS:   "menu_my_listings",
  MENU_REQUEST_PRODUCT: "menu_request_product",
  MENU_MY_REQUESTS:   "menu_my_requests",
  MENU_MY_ACTIVITY:   "menu_my_activity",

  // Phase 3 — matching. Interested button id is "match_interested_<matchId>".
  MATCH_INTERESTED_PREFIX: "match_interested_",
} as const;

// ─── Entry point (called from worker) ────────────────────────────────────────

export async function handleOnboarding(ctx: BotContext): Promise<void> {
  const { orgId, contact, conversation, parsed } = ctx;

  // Upsert Party for this contact
  let party = await prisma.party.findUnique({
    where: { contactId: contact.id },
  });
  if (!party) {
    party = await prisma.party.create({
      data: {
        organizationId: orgId,
        contactId: contact.id,
        onboardingStep: "ASK_ROLE",
      },
    });
  }

  // Global keyword overrides
  const rawText = extractText(parsed).toLowerCase().trim();
  if (["restart", "menu", "/menu", "/start"].includes(rawText)) {
    await prisma.party.update({
      where: { id: party.id },
      data: { onboardingStep: "ASK_ROLE" },
    });
    await sendAskRole(ctx, party.id);
    return;
  }

  // Route to the current step handler
  switch (party.onboardingStep) {
    case "ASK_ROLE":
      await handleAskRole(ctx, party);
      break;
    case "ASK_NAME":
      await handleAskName(ctx, party);
      break;
    case "ASK_CITY":
      await handleAskCity(ctx, party);
      break;
    case "ASK_ALERTS":
      await handleAskAlerts(ctx, party);
      break;
    case "DONE":
      await handleDone(ctx, party);
      break;
  }
}

// ─── Step: ASK_ROLE ───────────────────────────────────────────────────────────

async function handleAskRole(ctx: BotContext, party: Party): Promise<void> {
  const buttonId = extractButtonId(ctx.parsed);
  const text = extractText(ctx.parsed).toLowerCase();

  if (buttonId === BTN.ROLE_BOTH || text.includes("dono") || text.includes("both")) {
    console.info("[Onboarding] step", { contactId: party.contactId, step: "ASK_ROLE", input: buttonId ?? "text", next: "ASK_NAME/BOTH" });
    await prisma.party.update({
      where: { id: party.id },
      data: { role: "BOTH", onboardingStep: "ASK_NAME" },
    });
    await sendAskName(ctx, party.id);
    return;
  }

  if (buttonId === BTN.ROLE_SELLER || text.includes("seller") || text.includes("sell")) {
    console.info("[Onboarding] step", { contactId: party.contactId, step: "ASK_ROLE", input: buttonId ?? "text", next: "ASK_NAME/SELLER" });
    await prisma.party.update({
      where: { id: party.id },
      data: { role: "SELLER", onboardingStep: "ASK_NAME" },
    });
    await sendAskName(ctx, party.id);
    return;
  }

  if (buttonId === BTN.ROLE_BUYER || text.includes("buyer") || text.includes("buy") || text.includes("khareed")) {
    console.info("[Onboarding] step", { contactId: party.contactId, step: "ASK_ROLE", input: buttonId ?? "text", next: "ASK_NAME/BUYER" });
    await prisma.party.update({
      where: { id: party.id },
      data: { role: "BUYER", onboardingStep: "ASK_NAME" },
    });
    await sendAskName(ctx, party.id);
    return;
  }

  // Unexpected input — repeat the question
  console.info("[Onboarding] step", { contactId: party.contactId, step: "ASK_ROLE", input: buttonId ?? "text", next: "ASK_ROLE(repeat)" });
  await sendAskRole(ctx, party.id);
}

// ─── Step: ASK_NAME ───────────────────────────────────────────────────────────

async function handleAskName(ctx: BotContext, party: Party): Promise<void> {
  const rawText = extractText(ctx.parsed).trim();
  if (!rawText) {
    console.info("[Onboarding] step", { contactId: party.contactId, step: "ASK_NAME", input: "empty", next: "ASK_NAME(hint)" });
    await sendAskName(ctx, party.id, true);
    return;
  }

  const extracted = await callLLM<{ name: string }>({
    system:
      "You are a data extractor. The user just provided their name in a WhatsApp message. " +
      "Return JSON with a single field 'name' containing only the person's name, cleaned up. " +
      "No extra text.",
    user: rawText,
    schema: z.object({ name: z.string().min(1) }),
  });

  const name = extracted?.name ?? rawText;
  console.info("[Onboarding] step", { contactId: party.contactId, step: "ASK_NAME", input: "text", next: "ASK_CITY" });

  await prisma.party.update({
    where: { id: party.id },
    data: { name, onboardingStep: "ASK_CITY" },
  });
  await sendAskCity(ctx, party.id);
}

// ─── Step: ASK_CITY ───────────────────────────────────────────────────────────

async function handleAskCity(ctx: BotContext, party: Party): Promise<void> {
  const rawText = extractText(ctx.parsed).trim();
  if (!rawText) {
    console.info("[Onboarding] step", { contactId: party.contactId, step: "ASK_CITY", input: "empty", next: "ASK_CITY(hint)" });
    await sendAskCity(ctx, party.id, true);
    return;
  }

  const extracted = await callLLM<{ city: string }>({
    system:
      "You are a data extractor. The user just provided their city in a WhatsApp message. " +
      "Return JSON with a single field 'city' containing only the city name, cleaned up. " +
      "No extra text.",
    user: rawText,
    schema: z.object({ city: z.string().min(1) }),
  });

  const city = extracted?.city ?? rawText;
  console.info("[Onboarding] step", { contactId: party.contactId, step: "ASK_CITY", input: "text", next: "ASK_ALERTS" });

  await prisma.party.update({
    where: { id: party.id },
    data: { city, onboardingStep: "ASK_ALERTS" },
  });
  await sendAskAlerts(ctx, party.id);
}

// ─── Step: ASK_ALERTS ────────────────────────────────────────────────────────

async function handleAskAlerts(ctx: BotContext, party: Party): Promise<void> {
  const buttonId = extractButtonId(ctx.parsed);
  const text = extractText(ctx.parsed).toLowerCase();

  let pref: "ALL" | "MATCHING_ONLY" | "NONE" | null = null;

  if (buttonId === BTN.ALERT_ALL || text.includes("all")) pref = "ALL";
  else if (buttonId === BTN.ALERT_MATCH || text.includes("match") || text.includes("matching")) pref = "MATCHING_ONLY";
  else if (buttonId === BTN.ALERT_NONE || text.includes("no alert") || text.includes("nahi")) pref = "NONE";

  if (!pref) {
    console.info("[Onboarding] step", { contactId: party.contactId, step: "ASK_ALERTS", input: buttonId ?? "text", next: "ASK_ALERTS(repeat)" });
    await sendAskAlerts(ctx, party.id, true);
    return;
  }

  console.info("[Onboarding] step", { contactId: party.contactId, step: "ASK_ALERTS", input: buttonId ?? "text", next: `DONE/${pref}` });

  await prisma.party.update({
    where: { id: party.id },
    data: {
      alertPreference: pref,
      alertsOptedInAt: pref !== "NONE" ? new Date() : null,
      onboardingStep: "DONE",
    },
  });

  await prisma.contact.update({
    where: { id: ctx.contact.id },
    data: { optInScope: pref !== "NONE" ? "service,alerts" : "service" },
  });

  await sendDone(ctx, party);
}

// ─── Step: DONE ───────────────────────────────────────────────────────────────

async function handleDone(ctx: BotContext, party: Party): Promise<void> {
  // A seller (or BOTH) replying to a broadcast quote request takes priority
  // over everything else — including a casual "hi" — since that's the one
  // thing the bot is waiting on from them right now.
  if (party.role === "SELLER" || party.role === "BOTH") {
    const pendingQuote = await getPendingQuote(ctx.orgId, party.id);
    if (pendingQuote) {
      await handleSellerQuoteReply(ctx, party, pendingQuote);
      return;
    }
  }

  const text = extractText(ctx.parsed).toLowerCase().trim();
  const greetings = ["hi", "hello", "hey", "hii", "helo", "namaste", "namaskar"];

  if (greetings.some((g) => text.startsWith(g))) {
    await sendRegisteredMenu(ctx, party);
    return;
  }

  await routeRegisteredUser(ctx, party);
}

// ─── Message builders ─────────────────────────────────────────────────────────

async function sendAskRole(ctx: BotContext, partyId: string): Promise<void> {
  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildButtons(
      "Namaste! 🙏 Main aapka marketplace assistant hoon.\n\nAap bechna chahte hain ya khareedna?",
      [
        { id: BTN.ROLE_SELLER, title: "Bechna hai 🏭" },
        { id: BTN.ROLE_BUYER,  title: "Khareedna hai 🛍️" },
        { id: BTN.ROLE_BOTH,   title: "Dono 🔄" },
      ],
      "Kabhi bhi 'restart' likh ke dobara shuru kar sakte hain"
    ),
    dedupeKey: `onboard_role_${ctx.parsed.providerId}_${partyId}`,
  });
}

async function sendAskName(ctx: BotContext, partyId: string, hint = false): Promise<void> {
  const body = hint
    ? "Bas apna name bata dijiye, jaise: *Rahul Sharma*"
    : "Badhiya! Apna name kya bataayenge? 😊";
  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText(body),
    dedupeKey: `onboard_name_${ctx.parsed.providerId}_${partyId}`,
  });
}

async function sendAskCity(ctx: BotContext, partyId: string, hint = false): Promise<void> {
  const body = hint
    ? "Apne city ka naam bata dijiye, jaise: *Mumbai*"
    : "Aap kis city se hain? 📍";
  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText(body),
    dedupeKey: `onboard_city_${ctx.parsed.providerId}_${partyId}`,
  });
}

async function sendAskAlerts(ctx: BotContext, partyId: string, hint = false): Promise<void> {
  const body = hint
    ? "Neeche diye gaye options mein se ek chuniye 👇"
    : "Ek aakhri baat — naye listings ke alerts kaise chahiye? 🔔";
  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildButtons(body, [
      { id: BTN.ALERT_ALL,   title: "Sab listings" },
      { id: BTN.ALERT_MATCH, title: "Sirf matching" },
      { id: BTN.ALERT_NONE,  title: "Alerts nahi" },
    ]),
    dedupeKey: `onboard_alerts_${ctx.parsed.providerId}_${partyId}`,
  });
}

function roleLabel(role: Party["role"]): string {
  if (role === "SELLER") return "Seller";
  if (role === "BUYER") return "Buyer";
  return "Seller + Buyer";
}

function doneAction(role: Party["role"]): string {
  if (role === "SELLER") {
    return "Ab batayiye — aapko kya bechna hai, kitni quantity aur kitne mein? Bas product bata dijiye, baaki main ek-ek karke pooch lunga! 📦";
  }
  if (role === "BUYER") {
    return "Ab batayiye — aapko kya chahiye aur kitne mein? Product bata dijiye, main turant request bana dunga aur match milte hi batadunga! 🔍";
  }
  return "Ab batayiye — aapko kya bechna hai ya kya chahiye? Dono kaam kar sakta hoon — bas product bata dijiye! 📦🔍";
}

async function sendDone(ctx: BotContext, party: Party): Promise<void> {
  const alertMsg =
    party.alertPreference === "ALL"
      ? "Aapko har nayi listing ka alert milega."
      : party.alertPreference === "MATCHING_ONLY"
      ? "Aapko sirf matching products ka alert milega."
      : "Aapko koi alert nahi milega (jab chaho badal sakte ho).";

  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText(
      `✅ Perfect, ${party.name ?? "dost"}! Aapka profile ban gaya.\n\n` +
        `*Role:* ${roleLabel(party.role)}\n` +
        `*City:* ${party.city ?? "—"}\n` +
        `*Alerts:* ${alertMsg}\n\n` +
        doneAction(party.role)
    ),
    dedupeKey: `onboard_done_${ctx.parsed.providerId}_${party.id}`,
  });
}

async function sendRegisteredMenu(ctx: BotContext, party: Party): Promise<void> {
  const action =
    party.role === "SELLER"
      ? "Bas batayiye aapko kya bechna hai, kitni quantity aur kitne mein — main list kar dunga!"
      : party.role === "BUYER"
      ? "Batayiye aapko kya chahiye aur kitne mein — main dhoondh ke laata hoon!"
      : "Batayiye aapko kya bechna hai ya kya chahiye — main dono kaam kar sakta hoon!";

  await enqueueReply({
    organizationId: ctx.orgId,
    conversationId: ctx.conversation.id,
    to: ctx.contact.waPhone,
    content: buildText(
      `Namaste ${party.name ?? "dost"}! 👋\n\nAap humare paas *${roleLabel(party.role)}* registered hain.\n\n${action}\n\n_'dashboard' likhiye apna web dashboard link paane ke liye, ya 'restart' profile dobara set karne ke liye._`
    ),
    dedupeKey: `menu_${ctx.parsed.providerId}_${party.id}`,
  });
}

// ─── Payload extractors ───────────────────────────────────────────────────────

/**
 * Extract plain text from any inbound message type.
 */
export function extractText(parsed: InternalInboundMessage): string {
  const c = parsed.content as Record<string, unknown> | null;
  if (!c) return "";

  // text message
  if (parsed.contentType === "text") {
    return (c as { body?: string }).body ?? "";
  }

  // interactive button_reply or list_reply
  if (parsed.contentType === "interactive") {
    const interactive = c as {
      type?: string;
      button_reply?: { title?: string };
      list_reply?: { title?: string };
    };
    return (
      interactive.button_reply?.title ??
      interactive.list_reply?.title ??
      ""
    );
  }

  // button (template quick reply)
  if (parsed.contentType === "button") {
    return (c as { text?: string }).text ?? "";
  }

  return "";
}

/**
 * Extract button/list reply id from an interactive message.
 */
export function extractButtonId(parsed: InternalInboundMessage): string | null {
  if (parsed.contentType !== "interactive") return null;
  const c = parsed.content as {
    type?: string;
    button_reply?: { id?: string };
    list_reply?: { id?: string };
  } | null;
  if (!c) return null;
  return c.button_reply?.id ?? c.list_reply?.id ?? null;
}
