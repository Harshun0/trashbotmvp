/**
 * Phase 2 listing/requirement flow tests.
 *
 * Covers:
 *  1. Seller: product-only message → DRAFT created, asks quantity+unit
 *  2. Seller: quantity+unit added → asks price
 *  3. Seller: price added → asks location
 *  4. Seller: location added → sends summary with Publish/Add photo/Edit
 *  5. Seller: Publish button → status OPEN, replies with code
 *  6. Seller: "close LST-0001" → status CLOSED
 *  7. Buyer: requirement message → OPEN Requirement + Add details/Close request buttons
 *  8. Media: inbound image → downloadMedia + storage.upload + ListingMedia saved
 *  9. Media: storage not configured → media id still saved, seller told it was noted
 * 10. Role mismatch: seller sends buyer-style message → polite mismatch reply
 * 11. "other" intent → registered-user menu with role-specific buttons
 * 12. extractIntent returns null → fixed rephrase reply, never crashes
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    listing: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    requirement: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    listingMedia: {
      count: vi.fn(),
      create: vi.fn(),
    },
    requirementMedia: {
      create: vi.fn(),
    },
    message: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    party: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    quote: {
      upsert: vi.fn(),
    },
    conversation: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/queues", () => ({
  sendQueue: { add: vi.fn() },
  webhookQueue: { add: vi.fn() },
  sweeperQueue: { add: vi.fn(), upsertJobScheduler: vi.fn() },
}));

vi.mock("@/bot/extractor", () => ({ extractIntent: vi.fn() }));
vi.mock("@/bot/rate-limit", () => ({
  allowLLMCall: vi.fn().mockResolvedValue(true),
  allowAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/providers", () => ({ getProvider: vi.fn() }));
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { sendQueue } from "@/queues";
import { routeRegisteredUser } from "@/bot/listings";
import { extractIntent } from "@/bot/extractor";
import { allowLLMCall } from "@/bot/rate-limit";
import { getProvider } from "@/providers";
import { getStorage } from "@/lib/storage";
import type { InternalInboundMessage } from "@/providers/types";
import type { Party } from "@prisma/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = ReturnType<typeof vi.fn<any>>;

const listing = prisma.listing as unknown as {
  findFirst: MockFn; findUnique: MockFn; findMany: MockFn; count: MockFn; create: MockFn; update: MockFn;
};
const requirement = prisma.requirement as unknown as {
  findFirst: MockFn; findMany: MockFn; create: MockFn; update: MockFn;
};
const listingMedia = prisma.listingMedia as unknown as { count: MockFn; create: MockFn };
const message = prisma.message as unknown as { findMany: MockFn; create: MockFn };
const party = prisma.party as unknown as { findMany: MockFn };
const quote = prisma.quote as unknown as { upsert: MockFn };
const conversation = prisma.conversation as unknown as { findUnique: MockFn };
const queueAdd = sendQueue.add as MockFn;
const mockedExtractIntent = extractIntent as unknown as MockFn;
const mockedAllowLLMCall = allowLLMCall as unknown as MockFn;
const mockedGetProvider = getProvider as unknown as MockFn;
const mockedGetStorage = getStorage as unknown as MockFn;

const ORG = "org_main";
const CONTACT = { id: "contact_1", waPhone: "+919900000001" };
const CONV = { id: "conv_1", lastInboundAt: new Date() };

function sellerParty(overrides: Partial<Party> = {}): Party {
  return {
    id: "party_1",
    organizationId: ORG,
    contactId: CONTACT.id,
    role: "SELLER",
    name: "Rahul",
    city: "Mumbai",
    company: null,
    onboardingStep: "DONE",
    alertPreference: "NONE",
    alertsOptedInAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Party;
}

function buyerParty(overrides: Partial<Party> = {}): Party {
  return { ...sellerParty({ role: "BUYER", ...overrides }) };
}

function bothParty(overrides: Partial<Party> = {}): Party {
  return { ...sellerParty({ role: "BOTH", ...overrides }) };
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

function imageMsg(mediaId = "wamedia_1", msgId = "wamid_img"): InternalInboundMessage {
  return {
    kind: "message",
    providerEventId: `msg_${msgId}`,
    providerId: msgId,
    fromPhone: CONTACT.waPhone,
    toPhone: "+919900000000",
    timestamp: new Date(),
    contentType: "image",
    content: { id: mediaId, mime_type: "image/jpeg" },
  };
}

function ctx(parsed: InternalInboundMessage) {
  return { orgId: ORG, contact: CONTACT, conversation: CONV, parsed };
}

function extracted(overrides: Record<string, unknown> = {}) {
  return {
    intent: "create_listing",
    product: null,
    category: null,
    quantity: null,
    unit: null,
    price: null,
    location: null,
    listingCode: null,
    missing: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queueAdd.mockResolvedValue(undefined);
  mockedAllowLLMCall.mockResolvedValue(true);
  message.findMany.mockResolvedValue([]);
  message.create.mockResolvedValue({ id: "msg_out_1" });
});

// ─── 1-4. Seller step-by-step ────────────────────────────────────────────────

describe("Seller flow — progressive field collection", () => {
  it("product-only message → creates DRAFT, asks quantity+unit", async () => {
    listing.findFirst.mockResolvedValue(null); // no existing draft/open
    listing.count.mockResolvedValue(0);
    listing.findUnique.mockResolvedValue(null); // code free
    const created = {
      id: "listing_1", code: "LST-0001", product: "cement", category: null,
      quantity: null, unit: null, pricePerUnit: null, location: null, status: "DRAFT",
    };
    listing.create.mockResolvedValue(created);
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "create_listing", product: "cement" }));

    await routeRegisteredUser(ctx(textMsg("100 ton cement bags sell karna hai")), sellerParty());

    expect(listing.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ product: "cement", code: "LST-0001" }) })
    );
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("quantity") }) }),
      expect.anything()
    );
  });

  it("quantity+unit added to draft → asks price", async () => {
    const draft = {
      id: "listing_1", code: "LST-0001", product: "cement", category: null,
      quantity: null, unit: null, pricePerUnit: null, location: null, status: "DRAFT",
    };
    listing.findFirst.mockResolvedValue(draft);
    listing.update.mockResolvedValue({ ...draft, quantity: 100, unit: "ton" });
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "add_details", quantity: 100, unit: "ton" }));

    await routeRegisteredUser(ctx(textMsg("100 ton")), sellerParty());

    expect(listing.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ quantity: 100, unit: "ton" }) })
    );
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("Price") }) }),
      expect.anything()
    );
  });

  it("price added → asks location", async () => {
    const draft = {
      id: "listing_1", code: "LST-0001", product: "cement", category: null,
      quantity: 100, unit: "ton", pricePerUnit: null, location: null, status: "DRAFT",
    };
    listing.findFirst.mockResolvedValue(draft);
    listing.update.mockResolvedValue({ ...draft, pricePerUnit: 35 });
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "add_details", price: 35 }));

    await routeRegisteredUser(ctx(textMsg("35 per ton")), sellerParty());

    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("available") }) }),
      expect.anything()
    );
  });

  it("location added (all fields present) → sends summary with Publish/Add photo/Edit", async () => {
    const draft = {
      id: "listing_1", code: "LST-0001", product: "cement", category: null,
      quantity: 100, unit: "ton", pricePerUnit: 35, location: null, status: "DRAFT",
    };
    listing.findFirst.mockResolvedValue(draft);
    listing.update.mockResolvedValue({ ...draft, location: "Mumbai" });
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "add_details", location: "Mumbai" }));

    await routeRegisteredUser(ctx(textMsg("Mumbai")), sellerParty());

    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({
        content: expect.objectContaining({
          interactive: expect.objectContaining({
            action: expect.objectContaining({
              buttons: expect.arrayContaining([
                expect.objectContaining({ reply: expect.objectContaining({ title: "Publish" }) }),
                expect.objectContaining({ reply: expect.objectContaining({ title: "Add photo" }) }),
                expect.objectContaining({ reply: expect.objectContaining({ title: "Edit" }) }),
              ]),
            }),
          }),
        }),
      }),
      expect.anything()
    );
  });
});

// ─── 5. Publish button ────────────────────────────────────────────────────────

describe("Seller flow — Publish button", () => {
  it("publishes the draft listing and replies with the code", async () => {
    const draft = {
      id: "listing_1", code: "LST-0001", product: "cement",
      quantity: 100, unit: "ton", pricePerUnit: 35, location: "Mumbai", status: "DRAFT",
    };
    listing.findFirst.mockResolvedValue(draft);
    listing.update.mockResolvedValue({ ...draft, status: "OPEN" });

    await routeRegisteredUser(ctx(btnMsg("listing_publish", "Publish")), sellerParty());

    expect(listing.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "listing_1" }, data: { status: "OPEN" } })
    );
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("LST-0001") }) }),
      expect.anything()
    );
  });

  it("no DRAFT found (already published) → replies instead of staying silent", async () => {
    listing.findFirst.mockResolvedValue(null);

    await routeRegisteredUser(ctx(btnMsg("listing_publish", "Publish")), sellerParty());

    expect(listing.update).not.toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("already") }) }),
      expect.anything()
    );
  });

  it("seller already has an OPEN listing and sends a new product message → creates a NEW draft, doesn't mutate the OPEN one (regression)", async () => {
    // getDraftListing (strict DRAFT) must return null even though an OPEN listing exists —
    // routeRegisteredUser must not fall back to the OPEN listing here.
    listing.findFirst.mockResolvedValue(null);
    listing.count.mockResolvedValue(1); // one existing (OPEN) listing in the org
    listing.findUnique.mockResolvedValue(null); // LST-0002 is free
    const newDraft = {
      id: "listing_2", code: "LST-0002", product: "steel", category: null,
      quantity: null, unit: null, pricePerUnit: null, location: null, status: "DRAFT",
    };
    listing.create.mockResolvedValue(newDraft);
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "create_listing", product: "steel" }));

    await routeRegisteredUser(ctx(textMsg("50 ton steel bechna hai")), sellerParty());

    expect(listing.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ code: "LST-0002", product: "steel" }) })
    );
    expect(listing.update).not.toHaveBeenCalled();
  });
});

// ─── 6. Close listing ─────────────────────────────────────────────────────────

describe("Seller flow — close listing", () => {
  it("'close LST-0001' → status CLOSED", async () => {
    const open = { id: "listing_1", code: "LST-0001", status: "OPEN" };
    listing.findFirst.mockResolvedValue(open);
    listing.update.mockResolvedValue({ ...open, status: "CLOSED" });
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "close_listing", listingCode: "LST-0001" }));

    await routeRegisteredUser(ctx(textMsg("close LST-0001")), sellerParty());

    expect(listing.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "listing_1" }, data: { status: "CLOSED" } })
    );
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("LST-0001") }) }),
      expect.anything()
    );
  });

  it("no matching listing found → asks for the listing code instead of crashing", async () => {
    listing.findFirst.mockResolvedValue(null);
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "close_listing", listingCode: "LST-9999" }));

    await routeRegisteredUser(ctx(textMsg("close LST-9999")), sellerParty());

    expect(listing.update).not.toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalled();
  });
});

// ─── 7. Buyer requirement ─────────────────────────────────────────────────────

describe("Buyer flow — progressive field collection + broadcast", () => {
  it("product-only message → creates OPEN Requirement, asks quantity+unit", async () => {
    requirement.findFirst.mockResolvedValue(null);
    requirement.create.mockResolvedValue({
      id: "req_1", product: "cement", quantity: null, unit: null, maxPrice: null, location: null, deadlineDays: null, broadcastAt: null, status: "OPEN",
    });
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "create_requirement", product: "cement" }));

    await routeRegisteredUser(ctx(textMsg("mujhe cement chahiye")), buyerParty());

    expect(requirement.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ product: "cement" }) })
    );
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("quantity") }) }),
      expect.anything()
    );
  });

  it("quantity+unit added → asks budget", async () => {
    const draft = { id: "req_1", product: "cement", quantity: null, unit: null, maxPrice: null, location: null, deadlineDays: null, broadcastAt: null, status: "OPEN" };
    requirement.findFirst.mockResolvedValue(draft);
    requirement.update.mockResolvedValue({ ...draft, quantity: 50, unit: "ton" });
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "add_details", quantity: 50, unit: "ton" }));

    await routeRegisteredUser(ctx(textMsg("50 ton")), buyerParty());

    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("Budget") }) }),
      expect.anything()
    );
  });

  it("budget added → asks location", async () => {
    const draft = { id: "req_1", product: "cement", quantity: 50, unit: "ton", maxPrice: null, location: null, deadlineDays: null, broadcastAt: null, status: "OPEN" };
    requirement.findFirst.mockResolvedValue(draft);
    requirement.update.mockResolvedValue({ ...draft, maxPrice: 40 });
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "add_details", price: 40 }));

    await routeRegisteredUser(ctx(textMsg("40 per ton")), buyerParty());

    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("city") }) }),
      expect.anything()
    );
  });

  it("location added → asks deadline", async () => {
    const draft = { id: "req_1", product: "cement", quantity: 50, unit: "ton", maxPrice: 40, location: null, deadlineDays: null, broadcastAt: null, status: "OPEN" };
    requirement.findFirst.mockResolvedValue(draft);
    requirement.update.mockResolvedValue({ ...draft, location: "Pune" });
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "add_details", location: "Pune" }));

    await routeRegisteredUser(ctx(textMsg("Pune")), buyerParty());

    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("din") }) }),
      expect.anything()
    );
  });

  it("deadline added (all fields present) → broadcasts to matching sellers and confirms", async () => {
    const draft = { id: "req_1", product: "cement", quantity: 50, unit: "ton", maxPrice: 40, location: "Pune", deadlineDays: null, broadcastAt: null, status: "OPEN" };
    requirement.findFirst.mockResolvedValue(draft);
    const complete = { ...draft, deadlineDays: 3 };
    requirement.update.mockResolvedValue(complete);
    party.findMany.mockResolvedValue([
      { id: "seller_1", contactId: "seller_contact_1", city: "Pune", role: "SELLER", onboardingStep: "DONE" },
    ]);
    conversation.findUnique.mockResolvedValue({ id: "conv_seller_1", lastInboundAt: new Date(), contact: { waPhone: "+919900000099" } });
    quote.upsert.mockResolvedValue({ id: "quote_1" });
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "add_details", deadlineDays: 3 }));

    await routeRegisteredUser(ctx(textMsg("3 din mein")), buyerParty());

    expect(quote.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requirementId_sellerPartyId: { requirementId: "req_1", sellerPartyId: "seller_1" } },
      })
    );
    expect(requirement.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "req_1" }, data: { broadcastAt: expect.any(Date) } })
    );
    // Buyer gets a confirmation that sellers were contacted
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("seller") }) }),
      expect.anything()
    );
  });

  it("no matching sellers in the location → still confirms, doesn't crash", async () => {
    const draft = { id: "req_2", product: "steel", quantity: 10, unit: "ton", maxPrice: 50, location: "Nowhere City", deadlineDays: null, broadcastAt: null, status: "OPEN" };
    requirement.findFirst.mockResolvedValue(draft);
    requirement.update.mockResolvedValue({ ...draft, deadlineDays: 2 });
    party.findMany.mockResolvedValue([]);
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "add_details", deadlineDays: 2 }));

    await expect(routeRegisteredUser(ctx(textMsg("2 din")), buyerParty())).resolves.toBeUndefined();

    expect(queueAdd).toHaveBeenCalled();
  });

  it("editing an already-broadcast requirement → sends the button summary, doesn't re-broadcast", async () => {
    const draft = { id: "req_3", product: "cement", quantity: 50, unit: "ton", maxPrice: 40, location: "Pune", deadlineDays: 3, broadcastAt: new Date(), status: "OPEN" };
    requirement.findFirst.mockResolvedValue(draft);
    requirement.update.mockResolvedValue({ ...draft, maxPrice: 45 });

    mockedExtractIntent.mockResolvedValue(extracted({ intent: "add_details", price: 45 }));

    await routeRegisteredUser(ctx(textMsg("budget 45 kar do")), buyerParty());

    expect(party.findMany).not.toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({
        content: expect.objectContaining({
          interactive: expect.objectContaining({
            action: expect.objectContaining({
              buttons: expect.arrayContaining([
                expect.objectContaining({ reply: expect.objectContaining({ title: "Add details" }) }),
                expect.objectContaining({ reply: expect.objectContaining({ title: "Close request" }) }),
              ]),
            }),
          }),
        }),
      }),
      expect.anything()
    );
  });
});

// ─── 8-9. Media handling ──────────────────────────────────────────────────────

describe("Seller flow — photo upload", () => {
  it("downloads media, uploads to storage, saves ListingMedia with storageUrl", async () => {
    const openListing = { id: "listing_1", code: "LST-0001", status: "OPEN" };
    listing.findFirst
      .mockResolvedValueOnce(null)       // getDraftListing (no DRAFT)
      .mockResolvedValueOnce(openListing); // fallback to OPEN listing
    listingMedia.count.mockResolvedValue(0);
    listingMedia.create.mockResolvedValue({ id: "media_1" });

    const buffer = Buffer.from("fake-image-bytes");
    mockedGetProvider.mockReturnValue({
      downloadMedia: vi.fn().mockResolvedValue({ buffer, mimeType: "image/jpeg" }),
    });
    const uploadMock = vi.fn().mockResolvedValue({ url: "https://cdn.example.com/img.jpg" });
    mockedGetStorage.mockReturnValue({ upload: uploadMock });

    await routeRegisteredUser(ctx(imageMsg("wamedia_1")), sellerParty());

    expect(uploadMock).toHaveBeenCalledWith(buffer, "image/jpeg");
    expect(listingMedia.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          listingId: "listing_1",
          whatsappMediaId: "wamedia_1",
          storageUrl: "https://cdn.example.com/img.jpg",
        }),
      })
    );
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("LST-0001") }) }),
      expect.anything()
    );
  });

  it("storage not configured → still saves the media id and tells the seller it was noted", async () => {
    const openListing = { id: "listing_1", code: "LST-0001", status: "OPEN" };
    listing.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(openListing);
    listingMedia.count.mockResolvedValue(0);
    listingMedia.create.mockResolvedValue({ id: "media_1" });

    mockedGetProvider.mockReturnValue({
      downloadMedia: vi.fn().mockResolvedValue({ buffer: Buffer.from("x"), mimeType: "image/jpeg" }),
    });
    mockedGetStorage.mockReturnValue(null); // not configured

    await routeRegisteredUser(ctx(imageMsg("wamedia_2")), sellerParty());

    expect(listingMedia.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ whatsappMediaId: "wamedia_2", storageUrl: undefined }),
      })
    );
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("note") }) }),
      expect.anything()
    );
  });
});

// ─── 10. Role mismatch ────────────────────────────────────────────────────────

describe("Role mismatch", () => {
  it("seller sends a buyer-style message → polite mismatch reply, no DB writes", async () => {
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "create_requirement", product: "cement" }));

    await routeRegisteredUser(ctx(textMsg("mujhe 50 ton cement chahiye")), sellerParty());

    expect(listing.create).not.toHaveBeenCalled();
    expect(requirement.create).not.toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("Seller") }) }),
      expect.anything()
    );
  });
});

// ─── 11. "other" intent menu ──────────────────────────────────────────────────

describe("Other intent", () => {
  it("seller gets 'List a product' / 'My listings' menu", async () => {
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "other" }));

    await routeRegisteredUser(ctx(textMsg("thanks!")), sellerParty());

    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({
        content: expect.objectContaining({
          interactive: expect.objectContaining({
            action: expect.objectContaining({
              buttons: expect.arrayContaining([
                expect.objectContaining({ reply: expect.objectContaining({ title: "List a product" }) }),
                expect.objectContaining({ reply: expect.objectContaining({ title: "My listings" }) }),
              ]),
            }),
          }),
        }),
      }),
      expect.anything()
    );
  });
});

// ─── 12. Extractor failure ─────────────────────────────────────────────────────

describe("Extractor failure", () => {
  it("extractIntent returns null → fixed rephrase reply, never throws", async () => {
    mockedExtractIntent.mockResolvedValue(null);

    await expect(
      routeRegisteredUser(ctx(textMsg("asdkjaslkdj")), sellerParty())
    ).resolves.toBeUndefined();

    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("Samajh nahi paya") }) }),
      expect.anything()
    );
  });
});

// ─── 13. "dashboard" keyword → magic link, no LLM call ────────────────────────

describe("Dashboard link keyword", () => {
  it("seller sends 'dashboard' → gets a /dashboard/magic link, no extractIntent call", async () => {
    await routeRegisteredUser(ctx(textMsg("dashboard")), sellerParty());

    expect(mockedExtractIntent).not.toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({
        content: expect.objectContaining({ body: expect.stringContaining("/dashboard/magic?token=") }),
      }),
      expect.anything()
    );
  });

  it("is case-insensitive", async () => {
    await routeRegisteredUser(ctx(textMsg("Dashboard")), buyerParty());

    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({
        content: expect.objectContaining({ body: expect.stringContaining("/dashboard/magic?token=") }),
      }),
      expect.anything()
    );
  });
});

// ─── 14. Product-mismatch regression ──────────────────────────────────────────
// A second, different product mentioned while a draft/open row already exists
// must create a NEW row, never silently overwrite the old one's product.

describe("Product mismatch — new product while one is already in progress", () => {
  it("seller: existing DRAFT is 'cement', message mentions 'steel' → creates a new listing, doesn't touch the cement draft", async () => {
    const cementDraft = {
      id: "listing_1", code: "LST-0001", product: "cement",
      quantity: null, unit: null, pricePerUnit: null, location: null, status: "DRAFT",
    };
    listing.findFirst.mockResolvedValue(cementDraft);
    listing.count.mockResolvedValue(1);
    listing.findUnique.mockResolvedValue(null);
    const steelDraft = { id: "listing_2", code: "LST-0002", product: "steel", quantity: null, unit: null, pricePerUnit: null, location: null, status: "DRAFT" };
    listing.create.mockResolvedValue(steelDraft);
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "add_details", product: "steel" }));

    await routeRegisteredUser(ctx(textMsg("50 ton steel bhi bechna hai")), sellerParty());

    expect(listing.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ product: "steel", code: "LST-0002" }) })
    );
    expect(listing.update).not.toHaveBeenCalled();
  });

  it("buyer: existing OPEN requirement is 'Pp bags', message mentions 'plastic bottle' → creates a new requirement, doesn't rename the old one", async () => {
    const ppBagsReq = {
      id: "req_1", product: "Pp bags", quantity: null, unit: null, maxPrice: null, location: null, status: "OPEN",
    };
    requirement.findFirst.mockResolvedValue(ppBagsReq);
    const bottleReq = { id: "req_2", product: "plastic bottle", quantity: 10, unit: "tons", maxPrice: null, location: null, status: "OPEN" };
    requirement.create.mockResolvedValue(bottleReq);
    mockedExtractIntent.mockResolvedValue(
      extracted({ intent: "create_requirement", product: "plastic bottle", quantity: 10, unit: "tons" })
    );

    await routeRegisteredUser(ctx(textMsg("mujhe 10 tons plastic bottle khareedna hai")), buyerParty());

    expect(requirement.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ product: "plastic bottle" }) })
    );
    expect(requirement.update).not.toHaveBeenCalled();
    // The new requirement is missing budget — reply must ask for it, and must
    // never mention the stale "Pp bags" product from the old requirement.
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("Budget") }) }),
      expect.anything()
    );
    expect(queueAdd).not.toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("Pp bags") }) }),
      expect.anything()
    );
  });

  it("buyer: same product mentioned again → still updates the existing requirement (not a regression)", async () => {
    const existing = { id: "req_1", product: "cement", quantity: null, unit: null, maxPrice: null, location: null, status: "OPEN" };
    requirement.findFirst.mockResolvedValue(existing);
    requirement.update.mockResolvedValue({ ...existing, quantity: 50, unit: "ton" });
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "add_details", quantity: 50, unit: "ton" }));

    await routeRegisteredUser(ctx(textMsg("50 ton")), buyerParty());

    expect(requirement.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "req_1" } })
    );
    expect(requirement.create).not.toHaveBeenCalled();
  });
});

// ─── 15. BOTH role ─────────────────────────────────────────────────────────────

describe("BOTH role", () => {
  it("create_listing intent → routes to seller handler even for a BOTH party", async () => {
    listing.findFirst.mockResolvedValue(null);
    requirement.findFirst.mockResolvedValue(null);
    listing.count.mockResolvedValue(0);
    listing.findUnique.mockResolvedValue(null);
    listing.create.mockResolvedValue({ id: "listing_1", code: "LST-0001", product: "cement", quantity: null, unit: null, pricePerUnit: null, location: null, status: "DRAFT" });
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "create_listing", product: "cement" }));

    await routeRegisteredUser(ctx(textMsg("cement bechna hai")), bothParty());

    expect(listing.create).toHaveBeenCalled();
    expect(requirement.create).not.toHaveBeenCalled();
  });

  it("create_requirement intent → routes to buyer handler even for a BOTH party", async () => {
    listing.findFirst.mockResolvedValue(null);
    requirement.findFirst.mockResolvedValue(null);
    requirement.create.mockResolvedValue({ id: "req_1", product: "steel", quantity: null, unit: null, maxPrice: null, location: null, status: "OPEN" });
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "create_requirement", product: "steel" }));

    await routeRegisteredUser(ctx(textMsg("mujhe steel chahiye")), bothParty());

    expect(requirement.create).toHaveBeenCalled();
    expect(listing.create).not.toHaveBeenCalled();
  });

  it("add_details with an active DRAFT listing → treated as the seller side", async () => {
    const draft = { id: "listing_1", code: "LST-0001", product: "cement", quantity: null, unit: null, pricePerUnit: null, location: null, status: "DRAFT" };
    listing.findFirst.mockResolvedValue(draft);
    requirement.findFirst.mockResolvedValue(null);
    listing.update.mockResolvedValue({ ...draft, quantity: 100, unit: "ton" });
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "add_details", quantity: 100, unit: "ton" }));

    await routeRegisteredUser(ctx(textMsg("100 ton")), bothParty());

    expect(listing.update).toHaveBeenCalled();
    expect(requirement.update).not.toHaveBeenCalled();
    expect(requirement.create).not.toHaveBeenCalled();
  });

  it("add_details with no draft listing but an open requirement → treated as the buyer side", async () => {
    listing.findFirst.mockResolvedValue(null);
    const req = { id: "req_1", product: "cement", quantity: null, unit: null, maxPrice: null, location: null, status: "OPEN" };
    requirement.findFirst.mockResolvedValue(req);
    requirement.update.mockResolvedValue({ ...req, quantity: 50, unit: "ton" });
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "add_details", quantity: 50, unit: "ton" }));

    await routeRegisteredUser(ctx(textMsg("50 ton")), bothParty());

    expect(requirement.update).toHaveBeenCalled();
    expect(listing.update).not.toHaveBeenCalled();
  });

  it("'other' intent → 3-button menu with List/Request/My activity", async () => {
    listing.findFirst.mockResolvedValue(null);
    requirement.findFirst.mockResolvedValue(null);
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "other" }));

    await routeRegisteredUser(ctx(textMsg("thanks")), bothParty());

    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({
        content: expect.objectContaining({
          interactive: expect.objectContaining({
            action: expect.objectContaining({
              buttons: expect.arrayContaining([
                expect.objectContaining({ reply: expect.objectContaining({ title: "List a product" }) }),
                expect.objectContaining({ reply: expect.objectContaining({ title: "Request a product" }) }),
                expect.objectContaining({ reply: expect.objectContaining({ title: "My activity" }) }),
              ]),
            }),
          }),
        }),
      }),
      expect.anything()
    );
  });

  it("image upload is allowed for a BOTH party (not silently dropped)", async () => {
    const openListing = { id: "listing_1", code: "LST-0001", status: "OPEN" };
    listing.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(openListing);
    listingMedia.count.mockResolvedValue(0);
    listingMedia.create.mockResolvedValue({ id: "media_1" });
    mockedGetProvider.mockReturnValue({
      downloadMedia: vi.fn().mockResolvedValue({ buffer: Buffer.from("x"), mimeType: "image/jpeg" }),
    });
    mockedGetStorage.mockReturnValue(null);

    await routeRegisteredUser(ctx(imageMsg("wamedia_both")), bothParty());

    expect(listingMedia.create).toHaveBeenCalled();
  });

  it("no role mismatch reply for create_requirement or create_listing", async () => {
    listing.findFirst.mockResolvedValue(null);
    requirement.findFirst.mockResolvedValue(null);
    requirement.create.mockResolvedValue({ id: "req_1", product: "steel", quantity: null, unit: null, maxPrice: null, location: null, status: "OPEN" });
    mockedExtractIntent.mockResolvedValue(extracted({ intent: "create_requirement", product: "steel" }));

    await routeRegisteredUser(ctx(textMsg("mujhe steel chahiye")), bothParty());

    expect(queueAdd).not.toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("registered hain, isliye") }) }),
      expect.anything()
    );
  });
});
