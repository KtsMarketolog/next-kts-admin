import { DEFAULT_GROUP_COMPANIES } from '@/entities/site/model/defaultGroupCompanies';
import { getGroupCompanies } from '@/shared/lib/db';
import Container from '@/shared/ui/Container';
import styles from './GroupCompanies.module.scss';

async function loadCompanies() {
  try {
    return await getGroupCompanies({ activeOnly: true });
  } catch {
    return DEFAULT_GROUP_COMPANIES;
  }
}

function normalizeCompanyHref(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('/')) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export const GroupCompanies = async () => {
  const companies = await loadCompanies();

  return (
    <section className={styles.groupCompanies}>
      <Container>
        <h2>
          Входит в группу компаний<br />
          <span>РОСХОЛОД</span>
        </h2>

        <div className={styles.list}>
          {companies.map((company, index) => {
            const href = normalizeCompanyHref(company.linkUrl);
            const label = `Компания ${index + 1}`;
            const logo = (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className={styles.logo}
                src={company.imageUrl}
                alt={label}
                width={220}
                height={110}
                loading="eager"
                decoding="async"
              />
            );

            return (
              <div key={`${company.imageUrl}-${index}`} className={styles.company}>
                {href ? (
                  <a
                    className={styles.companyLink}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {logo}
                  </a>
                ) : (
                  <div className={styles.disabled}>
                    {logo}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Container>
    </section>
  );
};
