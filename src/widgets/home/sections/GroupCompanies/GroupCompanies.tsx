import Image from 'next/image';
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

export const GroupCompanies = async () => {
  const companies = await loadCompanies();

  return (
    <section className={styles.groupCompanies}>
      <Container>
        <h2>
          Входит в группу компаний23<br />
          <span>РОСХОЛОД</span>
        </h2>

        <div className={styles.list}>
          {companies.map((company, index) => (
            <div key={`${company.imageUrl}-${index}`} className={styles.company}>
              <div className={styles.disabled} aria-label={`Компания ${index + 1}`}>
                <Image
                  className={styles.logo}
                  src={company.imageUrl}
                  alt=""
                  width={220}
                  height={110}
                  sizes="(max-width: 450px) 140px, (max-width: 1024px) 170px, 220px"
                />
              </div>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
};
