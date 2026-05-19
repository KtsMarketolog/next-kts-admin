import type { GroupCompany } from "@/entities/site/model/defaultGroupCompanies";
import Container from "@/shared/ui/Container";
import styles from "./GroupCompanies.module.scss";

export type GroupCompanyItem = Pick<GroupCompany, "imageUrl" | "linkUrl">;

type GroupCompaniesViewProps = {
  companies: GroupCompanyItem[];
};

const GROUP_TITLE = "\u0412\u0445\u043e\u0434\u0438\u0442 \u0432 \u0433\u0440\u0443\u043f\u043f\u0443 \u043a\u043e\u043c\u043f\u0430\u043d\u0438\u0439";
const GROUP_NAME = "\u0420\u041e\u0421\u0425\u041e\u041b\u041e\u0414";
const COMPANY_LABEL = "\u041a\u043e\u043c\u043f\u0430\u043d\u0438\u044f";

function normalizeCompanyHref(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("/")) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function GroupCompaniesView({ companies }: GroupCompaniesViewProps) {
  return (
    <section className={styles.groupCompanies}>
      <Container>
        <h2>
          {GROUP_TITLE}
          <br />
          <span>{GROUP_NAME}</span>
        </h2>

        <div className={styles.list}>
          {companies.map((company, index) => {
            const href = normalizeCompanyHref(company.linkUrl);
            const label = `${COMPANY_LABEL} ${index + 1}`;
            const logo = (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className={styles.logo}
                src={company.imageUrl}
                alt={label}
                width={220}
                height={110}
                loading="lazy"
                fetchPriority="low"
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
                  <div className={styles.disabled}>{logo}</div>
                )}
              </div>
            );
          })}
        </div>
      </Container>
    </section>
  );
}
