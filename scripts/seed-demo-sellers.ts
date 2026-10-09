/**
 * One-off script to create a handful of demo sellers for testing the
 * broadcast-to-sellers flow and the admin dashboard, before real sellers are
 * added via the "Add seller" form on /dashboard/sellers.
 *
 * These use fake phone numbers — they will show up in the dashboard and
 * match on city, but any WhatsApp message sent to them will fail at the
 * provider level (logged, dead-lettered, never crashes). Replace with real
 * numbers via the dashboard form when you have them.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/seed-demo-sellers.ts
 */
import { prisma } from "@/lib/prisma";

const DEMO_SELLERS = [
  { name: "Demo Seller — Mumbai Recyclers", city: "Mumbai", waPhone: "+919900010001" },
  { name: "Demo Seller — Pune Scrap Co", city: "Pune", waPhone: "+919900010002" },
  { name: "Demo Seller — Delhi Waste Traders", city: "Delhi", waPhone: "+919900010003" },
  { name: "Demo Seller — Bangalore Metals", city: "Bangalore", waPhone: "+919900010004" },
];

async function main() {
  const org = await prisma.organization.findFirst();
  if (!org) {
    console.error("No organization found — create one first.");
    process.exit(1);
  }

  for (const seller of DEMO_SELLERS) {
    const contact = await prisma.contact.upsert({
      where: { organizationId_waPhone: { organizationId: org.id, waPhone: seller.waPhone } },
      create: { organizationId: org.id, waPhone: seller.waPhone, optInSource: "AGENT_ADDED", optInScope: "service" },
      update: {},
    });

    await prisma.party.upsert({
      where: { contactId: contact.id },
      create: {
        organizationId: org.id,
        contactId: contact.id,
        role: "SELLER",
        name: seller.name,
        city: seller.city,
        onboardingStep: "DONE",
        alertPreference: "ALL",
        alertsOptedInAt: new Date(),
      },
      update: { role: "SELLER", name: seller.name, city: seller.city, onboardingStep: "DONE" },
    });

    console.info(`Demo seller ready: ${seller.name} (${seller.city})`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
