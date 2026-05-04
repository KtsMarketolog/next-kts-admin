import { DEFAULT_GROUP_COMPANIES } from '@/entities/site/model/defaultGroupCompanies';
import { getGroupCompanies } from '@/shared/lib/db';

export async function GET() {
  try {
    const companies = await getGroupCompanies({ activeOnly: true });
    return Response.json({ companies });
  } catch {
    return Response.json({ companies: DEFAULT_GROUP_COMPANIES });
  }
}
