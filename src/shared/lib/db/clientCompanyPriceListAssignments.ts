/** Only related ownership fields change; prices, items, public links and history
 * remain untouched. Call on the company transaction after its row is locked. */
export async function writeClientCompanyPriceListAssignments(
  client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  companyId: number,
  input: { managerId: number | null; supportManagerId: number | null },
) {
  await client.query(
    `update wholesale_price_lists
     set manager_id = $2,
         support_manager_id = $3,
         updated_at = now()
     where client_company_id = $1
       and (manager_id is distinct from $2::bigint or support_manager_id is distinct from $3::bigint)`,
    [companyId, input.managerId, input.supportManagerId],
  );
}
