import Container from '@/shared/ui/Container';

import styles from './FooterSkeleton.module.scss';

const contactLines = [0, 1, 2];
const menuLines = [0, 1, 2, 3, 4];

export function FooterSkeleton() {
  return (
    <section className={styles.footer} aria-hidden="true">
      <div className={styles.bgGradient}>
        <Container>
          <div className={styles.content}>
            <div className={styles.logo}>
              <span />
            </div>
            <div className={styles.contactsList}>
              {contactLines.map((item) => (
                <span key={item} />
              ))}
            </div>
            <div className={styles.desc}>
              <span />
              <span />
              <span />
            </div>
            <div className={styles.menu}>
              <div className={styles.col}>
                <strong />
                {menuLines.map((item) => (
                  <span key={item} />
                ))}
              </div>
              <div className={styles.col}>
                <strong />
                {menuLines.slice(0, 2).map((item) => (
                  <span key={item} />
                ))}
              </div>
            </div>
            <div className={styles.button} />
            <div className={styles.socials}>
              <span />
              <i />
            </div>
            <div className={styles.bottom}>
              <span />
            </div>
          </div>
        </Container>
      </div>
    </section>
  );
}
