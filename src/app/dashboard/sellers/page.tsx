import { requireAdmin } from "@/lib/dashboard-session";
import { getOrgId, getParties } from "@/lib/dashboard-data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AddSellerForm } from "./add-seller-form";

export default async function SellersPage() {
  await requireAdmin();
  const orgId = await getOrgId();
  const sellers = orgId ? await getParties(orgId, "SELLER") : [];

  return (
    <div className="flex flex-col gap-6">
      <AddSellerForm />
      <Card>
        <CardHeader>
          <CardTitle>Sellers ({sellers.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>City</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Alerts</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sellers.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{s.name ?? "—"}</TableCell>
                  <TableCell>{s.city ?? "—"}</TableCell>
                  <TableCell>{s.contact.waPhone}</TableCell>
                  <TableCell>{s.alertPreference}</TableCell>
                </TableRow>
              ))}
              {sellers.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">Koi seller nahi hai.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
