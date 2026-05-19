import { DEFAULT_GROUP_COMPANIES } from '@/entities/site/model/defaultGroupCompanies';
import { getGroupCompanies } from '@/shared/lib/db';
import { GroupCompaniesView } from './GroupCompaniesView';

async function loadCompanies() {
  try {
    return await getGroupCompanies({ activeOnly: true });
  } catch {
    return DEFAULT_GROUP_COMPANIES;
  }
}

export const GroupCompanies = async () => {
  const companies = await loadCompanies();

  return <GroupCompaniesView companies={companies} />;
};
