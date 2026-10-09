import Link from "next/link";
import { getSession, isAdmin } from "@/lib/dashboard-session";
import { getPartyById } from "@/lib/dashboard-data";
import { LogoutButton } from "./logout-button";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  // Layout also renders for /dashboard/login, /magic, /expired where session is null —
  // those pages don't use this nav chrome, so just pass through.
  if (!session) {
    return <div className="min-h-screen bg-muted/30">{children}</div>;
  }

  const admin = isAdmin(session);
  const party = session.partyId ? await getPartyById(session.partyId) : null;

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <span className="font-semibold">Wacrm Dashboard</span>
            <nav className="flex gap-4 text-sm text-muted-foreground">
              <Link href="/dashboard" className="hover:text-foreground">Home</Link>
              {admin && (
                <>
                  <Link href="/dashboard/requirements" className="hover:text-foreground">Requirements</Link>
                  <Link href="/dashboard/quotes" className="hover:text-foreground">Quotes</Link>
                  <Link href="/dashboard/sellers" className="hover:text-foreground">Sellers</Link>
                  <Link href="/dashboard/buyers" className="hover:text-foreground">Buyers</Link>
                  <Link href="/dashboard/listings" className="hover:text-foreground">Listings (old)</Link>
                  <Link href="/dashboard/matches" className="hover:text-foreground">Matches (old)</Link>
                </>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span>{admin ? `${session.role}` : party?.name ?? session.role}</span>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
