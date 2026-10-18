import type { AdminSession } from '@/shared/lib/adminAuth';
import { assertClientCompanyWritable } from '../clientCompaniesRepo';
import { withTransaction } from '../client';
import { writeClientCompanyPriceListAssignments } from '../clientCompanyPriceListAssignments';
import { ensureSiteSchema } from '../schema';

export async function updateWholesalePriceListManagerAssignmentsForClientCompany(
  clientCompanyId: number,
  input: { managerId: number | null; supportManagerId: number | null },
  session?: AdminSession | null,
) {
  await ensureSiteSchema();
  const companyId = Number(clientCompanyId);
  if (!Number.isInteger(companyId) || companyId <= 0) return;
  await withTransaction(async (client) => {
    await assertClientCompanyWritable(companyId, session ?? { role: 'admin' }, client);
    await writeClientCompanyPriceListAssignments(client, companyId, input);
  });
}
