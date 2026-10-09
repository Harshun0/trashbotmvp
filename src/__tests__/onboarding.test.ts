/**
 * Phase 1 onboarding state machine tests.
 *
 * All DB calls are mocked via vi.mock so no real Postgres is needed.
 * The LLM is not called in tests (GEMINI_API_KEY is not set → callLLM returns null → fallback).
 *
 * Covers:
 *  1. ASK_ROLE → button reply "Seller" → advances to ASK_NAME
 *  2. ASK_ROLE → button reply "Buyer"  → advances to ASK_NAME
 *  3. ASK_ROLE → text "seller"         → advances to ASK_NAME
 *  4. ASK_ROLE → unexpected text       → stays on ASK_ROLE, repeats question
 *  5. ASK_NAME → free text             → advances to ASK_CITY (LLM fallback)
 *  6. ASK_NAME → empty text            → stays on ASK_NAME with hint
 *  7. ASK_CITY → free text             → advances to ASK_ALERTS
 *  8. ASK_ALERTS → "All listings"      → DONE, alertPreference=ALL
 *  9. ASK_ALERTS → "Only matching"     → DONE, alertPreference=MATCHING_ONLY
 * 10. ASK_ALERTS → "No alerts"         → DONE, alertPreference=NONE
 * 11. ASK_ALERTS → unexpected          → stays, repeats
 * 12. DONE + "hi"                      → registered menu
 * 13. Any step + "restart"             → resets to ASK_ROLE
 * 14. Duplicate inbound (same providerId) → enqueueReply produces same jobId
 * 15. First message (no party yet)     → creates Party, sends ASK_ROLE
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── vi.mock must use vi.fn() inline — no variable references ────────────────
// Vitest hoists vi.mock to the top of the file; capturing outer variables
// causes "Cannot access before initialization". Use vi.fn() directly.

vi.mock("@/lib/prisma", () => ({
  prisma: {
    party: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    contact: {
      update: vi.fn(),
    },
    message: {
      create: vi.fn(),
    },
    quote: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("@/queues", () => ({
  sendQueue: { add: vi.fn() },
  webhookQueue: { add: vi.fn() },
  sweeperQueue: { add: vi.fn(), upsertJobScheduler: vi.fn() },
}));

vi.mock("@/bot/quotes", () => ({
  getPendingQuote: vi.fn().mockResolvedValue(null),
  handleSellerQuoteReply: vi.fn(),
}));

// ─── Import mocked modules AFTER vi.mock declarations ────────────────────────
import { prisma } from "@/lib/prisma";
import { sendQueue } from "@/queues";
import { handleOnboarding, extractText, extractButtonId, BTN } from "@/bot/onboarding";
import { getPendingQuote, handleSellerQuoteReply } from "@/bot/quotes";
import type { InternalInboundMessage } from "@/providers/types";
import type { Party } from "@prisma/client";

// ─── Typed mock helpers ───────────────────────────────────────────────────────

// vi.mock replaces the real module with vi.fn() stubs; we need to tell TS
// about the mock shape. Cast through unknown to avoid Prisma type mismatch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = ReturnType<typeof vi.fn<any>>;

const party = prisma.party as unknown as {
  findUnique: MockFn;
  create: MockFn;
  update: MockFn;
};
const contact = prisma.contact as unknown as { update: MockFn };
const message = prisma.message as unknown as { create: MockFn };
const queueAdd = sendQueue.add as MockFn;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG = "org_main";
const CONTACT = { id: "contact_1", waPhone: "+919900000001" };
const CONV = { id: "conv_1", lastInboundAt: new Date() };

function baseParty(
  step: Party["onboardingStep"],
  overrides: Partial<Party> = {}
): Party {
  return {
    id: "party_1",
    organizationId: ORG,
    contactId: CONTACT.id,
    role: null,
    name: null,
    city: null,
    company: null,
    onboardingStep: step,
    alertPreference: "NONE",
    alertsOptedInAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Party;
}

function textMsg(text: string, msgId = "wamid_1"): InternalInboundMessage {
  return {
    kind: "message",
    providerEventId: `msg_${msgId}`,
    providerId: msgId,
    fromPhone: CONTACT.waPhone,
    toPhone: "+919900000000",
    timestamp: new Date(),
    contentType: "text",
    content: { body: text },
  };
}

function btnMsg(id: string, title: string, msgId = "wamid_btn"): InternalInboundMessage {
  return {
    kind: "message",
    providerEventId: `msg_${msgId}`,
    providerId: msgId,
    fromPhone: CONTACT.waPhone,
    toPhone: "+919900000000",
    timestamp: new Date(),
    contentType: "interactive",
    content: { type: "button_reply", button_reply: { id, title } },
  };
}

function ctx(parsed: InternalInboundMessage) {
  return { orgId: ORG, contact: CONTACT, conversation: CONV, parsed };
}

beforeEach(() => {
  vi.clearAllMocks();
  message.create.mockResolvedValue({ id: "msg_out_1" });
  queueAdd.mockResolvedValue(undefined);
  contact.update.mockResolvedValue({});
});

// ─── extractText / extractButtonId ───────────────────────────────────────────

describe("extractText", () => {
  it("returns body from text message", () => {
    expect(extractText(textMsg("hello"))).toBe("hello");
  });

  it("returns button_reply title from interactive", () => {
    expect(extractText(btnMsg("role_seller", "Seller 🏭"))).toBe("Seller 🏭");
  });

  it("returns empty string for image message", () => {
    expect(extractText({ ...textMsg(""), contentType: "image", content: {} })).toBe("");
  });
});

describe("extractButtonId", () => {
  it("returns button id", () => {
    expect(extractButtonId(btnMsg("role_buyer", "Buyer"))).toBe("role_buyer");
  });

  it("returns null for text message", () => {
    expect(extractButtonId(textMsg("hi"))).toBeNull();
  });
});

// ─── ASK_ROLE ─────────────────────────────────────────────────────────────────

describe("ASK_ROLE step", () => {
  beforeEach(() => {
    party.findUnique.mockResolvedValue(baseParty("ASK_ROLE"));
    party.update.mockResolvedValue(baseParty("ASK_NAME"));
    party.create.mockResolvedValue(baseParty("ASK_ROLE"));
  });

  it("role_seller button → sets SELLER + ASK_NAME, enqueues ask_name", async () => {
    await handleOnboarding(ctx(btnMsg(BTN.ROLE_SELLER, "Seller", "wamid_s1")));

    expect(party.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: "SELLER", onboardingStep: "ASK_NAME" }),
      })
    );
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.anything(),
      expect.objectContaining({ jobId: expect.stringContaining("onboard_name_wamid_s1") })
    );
  });

  it("role_buyer button → sets BUYER + ASK_NAME", async () => {
    await handleOnboarding(ctx(btnMsg(BTN.ROLE_BUYER, "Buyer", "wamid_b1")));

    expect(party.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: "BUYER", onboardingStep: "ASK_NAME" }),
      })
    );
  });

  it("text 'seller' → sets SELLER + ASK_NAME", async () => {
    await handleOnboarding(ctx(textMsg("I am a seller", "wamid_txt_s")));

    expect(party.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: "SELLER" }),
      })
    );
  });

  it("text 'buyer' → sets BUYER + ASK_NAME", async () => {
    await handleOnboarding(ctx(textMsg("buyer", "wamid_txt_b")));

    expect(party.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: "BUYER" }),
      })
    );
  });

  it("role_both button → sets BOTH + ASK_NAME", async () => {
    await handleOnboarding(ctx(btnMsg(BTN.ROLE_BOTH, "Dono", "wamid_both1")));

    expect(party.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: "BOTH", onboardingStep: "ASK_NAME" }),
      })
    );
  });

  it("text 'dono' → sets BOTH + ASK_NAME", async () => {
    await handleOnboarding(ctx(textMsg("dono karna hai", "wamid_both2")));

    expect(party.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: "BOTH" }),
      })
    );
  });

  it("unexpected text → no update, enqueues ASK_ROLE question again", async () => {
    await handleOnboarding(ctx(textMsg("hmm not sure", "wamid_unk")));

    expect(party.update).not.toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.anything(),
      expect.objectContaining({ jobId: expect.stringContaining("onboard_role_wamid_unk") })
    );
  });

  it("'restart' keyword → resets step to ASK_ROLE", async () => {
    party.findUnique.mockResolvedValue(baseParty("ASK_NAME"));
    party.update.mockResolvedValue(baseParty("ASK_ROLE"));

    await handleOnboarding(ctx(textMsg("restart", "wamid_rst")));

    expect(party.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ onboardingStep: "ASK_ROLE" }),
      })
    );
    // Should also send the ASK_ROLE question
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.anything(),
      expect.objectContaining({ jobId: expect.stringContaining("onboard_role_wamid_rst") })
    );
  });
});

// ─── ASK_NAME ─────────────────────────────────────────────────────────────────

describe("ASK_NAME step", () => {
  beforeEach(() => {
    party.findUnique.mockResolvedValue(baseParty("ASK_NAME", { role: "SELLER" }));
    party.update.mockResolvedValue(baseParty("ASK_CITY"));
  });

  it("free text → sets name (raw fallback) + advances to ASK_CITY", async () => {
    await handleOnboarding(ctx(textMsg("Rahul Sharma", "wamid_nm1")));

    expect(party.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ onboardingStep: "ASK_CITY" }),
      })
    );
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.anything(),
      expect.objectContaining({ jobId: expect.stringContaining("onboard_city_wamid_nm1") })
    );
  });

  it("empty text → no update, enqueues name hint", async () => {
    await handleOnboarding(ctx(textMsg("", "wamid_nm_empty")));

    expect(party.update).not.toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({
        content: expect.objectContaining({ body: expect.stringContaining("name") }),
      }),
      expect.anything()
    );
  });
});

// ─── ASK_CITY ─────────────────────────────────────────────────────────────────

describe("ASK_CITY step", () => {
  beforeEach(() => {
    party.findUnique.mockResolvedValue(
      baseParty("ASK_CITY", { role: "SELLER", name: "Rahul" })
    );
    party.update.mockResolvedValue(baseParty("ASK_ALERTS"));
  });

  it("text 'Mumbai' → sets city + advances to ASK_ALERTS", async () => {
    await handleOnboarding(ctx(textMsg("Mumbai", "wamid_ct1")));

    expect(party.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ onboardingStep: "ASK_ALERTS" }),
      })
    );
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.anything(),
      expect.objectContaining({ jobId: expect.stringContaining("onboard_alerts_wamid_ct1") })
    );
  });
});

// ─── ASK_ALERTS ───────────────────────────────────────────────────────────────

describe("ASK_ALERTS step", () => {
  function alertParty() {
    return baseParty("ASK_ALERTS", { role: "BUYER", name: "Rahul", city: "Mumbai" });
  }

  beforeEach(() => {
    party.findUnique.mockResolvedValue(alertParty());
    party.update.mockResolvedValue({ ...alertParty(), onboardingStep: "DONE" });
  });

  it("alert_all → alertPreference=ALL + DONE + optInScope=service,alerts", async () => {
    await handleOnboarding(ctx(btnMsg(BTN.ALERT_ALL, "All listings", "wamid_al1")));

    expect(party.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ alertPreference: "ALL", onboardingStep: "DONE" }),
      })
    );
    expect(contact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ optInScope: "service,alerts" }),
      })
    );
  });

  it("alert_match → alertPreference=MATCHING_ONLY", async () => {
    await handleOnboarding(ctx(btnMsg(BTN.ALERT_MATCH, "Only matching", "wamid_al2")));

    expect(party.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ alertPreference: "MATCHING_ONLY" }),
      })
    );
  });

  it("alert_none → alertPreference=NONE + optInScope=service", async () => {
    await handleOnboarding(ctx(btnMsg(BTN.ALERT_NONE, "No alerts", "wamid_al3")));

    expect(party.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ alertPreference: "NONE" }),
      })
    );
    expect(contact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ optInScope: "service" }),
      })
    );
  });

  it("unexpected text → no update, enqueues alert hint", async () => {
    await handleOnboarding(ctx(textMsg("idk", "wamid_al_unk")));

    expect(party.update).not.toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.anything(),
      expect.objectContaining({ jobId: expect.stringContaining("onboard_alerts_wamid_al_unk") })
    );
  });
});

// ─── DONE ─────────────────────────────────────────────────────────────────────

describe("DONE step", () => {
  beforeEach(() => {
    party.findUnique.mockResolvedValue(
      baseParty("DONE", { role: "SELLER", name: "Rahul", city: "Mumbai" })
    );
    party.update.mockResolvedValue(baseParty("DONE"));
  });

  it("'hi' → sends registered menu, no step change", async () => {
    await handleOnboarding(ctx(textMsg("hi", "wamid_hi")));

    expect(party.update).not.toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({
        content: expect.objectContaining({
          body: expect.stringContaining("registered"),
        }),
      }),
      expect.objectContaining({ jobId: expect.stringContaining("menu_wamid_hi") })
    );
  });

  it("'hello' → sends registered menu", async () => {
    await handleOnboarding(ctx(textMsg("hello", "wamid_hello")));
    expect(queueAdd).toHaveBeenCalled();
  });

  it("'namaste' → sends registered menu", async () => {
    await handleOnboarding(ctx(textMsg("namaste", "wamid_nam")));
    expect(queueAdd).toHaveBeenCalled();
  });
});

// ─── DONE + pending quote (buyer-only pivot) ───────────────────────────────────

describe("DONE step — seller with a pending broadcast quote", () => {
  const mockedGetPendingQuote = getPendingQuote as unknown as ReturnType<typeof vi.fn>;
  const mockedHandleSellerQuoteReply = handleSellerQuoteReply as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    party.findUnique.mockResolvedValue(
      baseParty("DONE", { role: "SELLER", name: "Rahul", city: "Mumbai" })
    );
  });

  it("even a plain 'hi' is routed to the quote reply handler, not the registered menu", async () => {
    mockedGetPendingQuote.mockResolvedValue({ id: "quote_1", status: "PENDING" });

    await handleOnboarding(ctx(textMsg("hi", "wamid_q1")));

    expect(mockedHandleSellerQuoteReply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: "SELLER" }),
      expect.objectContaining({ id: "quote_1" })
    );
    // No registered-menu reply was sent for this message
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("no pending quote → falls through to the normal registered-menu/listings flow", async () => {
    mockedGetPendingQuote.mockResolvedValue(null);

    await handleOnboarding(ctx(textMsg("hi", "wamid_q2")));

    expect(mockedHandleSellerQuoteReply).not.toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalled();
  });
});

// ─── Duplicate webhook idempotency ────────────────────────────────────────────

describe("Duplicate webhook idempotency", () => {
  it("same providerId twice → same jobId both times (BullMQ deduplication)", async () => {
    party.findUnique.mockResolvedValue(baseParty("ASK_ROLE"));
    party.update.mockResolvedValue(baseParty("ASK_NAME"));

    const msg = btnMsg(BTN.ROLE_SELLER, "Seller", "wamid_dup1");

    await handleOnboarding(ctx(msg));
    await handleOnboarding(ctx(msg));

    const jobIds = queueAdd.mock.calls
      .map((c: unknown[]) => (c[2] as { jobId?: string })?.jobId)
      .filter((id: string | undefined): id is string =>
        typeof id === "string" && id.includes("onboard_name_wamid_dup1")
      );

    expect(jobIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(jobIds).size).toBe(1); // identical — BullMQ ignores second
  });
});

// ─── First message (new contact) ─────────────────────────────────────────────

describe("First message", () => {
  it("creates Party + sends ASK_ROLE question", async () => {
    party.findUnique.mockResolvedValue(null);
    party.create.mockResolvedValue(baseParty("ASK_ROLE"));

    await handleOnboarding(ctx(textMsg("hi", "wamid_first")));

    expect(party.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ onboardingStep: "ASK_ROLE" }),
      })
    );
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.anything(),
      expect.objectContaining({ jobId: expect.stringContaining("onboard_role_wamid_first") })
    );
  });
});
